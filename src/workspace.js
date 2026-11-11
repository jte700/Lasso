import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { transaction } from './db.js';
import { HttpError } from './history/errors.js';
import { normalizeProjectRootPath } from './history/service.js';
import { runSliced, runSync } from './history/work.js';
import { directoryIssue, directoryNote } from './directory-issues.js';
import { workspacePredictionMethods } from './workspace-prediction.js';
import { workspaceTerminalMethods } from './workspace-terminal.js';
import { distinctRanked, tag } from './workspace-ranking.js';

const systemActor = { id: 'system:workspace', displayName: 'Lasso', actorType: 'SYSTEM' };
// An enabled folder that failed to start, for example on a drive that was not
// mounted yet, is retried when it reappears, at most this often.
const ACTIVATION_RETRY_MS = 30_000;
const UNAVAILABLE_MESSAGE = 'The folder is not available. Lasso will use it again when it reappears.';

// Where each phase of reading a folder sits on its progress bar. Reading files
// is mostly disk time; indexing parses them and takes most of the work, and
// warming reads PDFs' text for search. A re-read has no files to fetch, so its
// indexing fills the bar.
const PROGRESS_SPANS = {
  adding: { listing: [0, 0.04], reading: [0.04, 0.3], indexing: [0.3, 0.82], saving: [0.82, 0.85], warming: [0.85, 0.99] },
  updating: { listing: [0, 0.08], reading: [0.08, 0.3], indexing: [0.3, 0.82], saving: [0.82, 0.85], warming: [0.85, 0.99] },
  rereading: { indexing: [0, 0.95], saving: [0.95, 0.99] },
};

/**
 * How far one folder has got through being added, brought up to date or
 * re-read. Steps report their own units; this maps them onto one bar that
 * only moves forward, so a phase that starts over never moves it back.
 */
class DirectoryProgress {
  constructor({ kind, rootPath, name, pending }) {
    this.kind = kind;
    this.rootPath = rootPath;
    this.name = name;
    this.pending = pending;
    this.phase = 'waiting';
    this.fraction = 0;
  }

  report(step) {
    const span = PROGRESS_SPANS[this.kind][step?.phase];
    if (!span) return;
    // Listing cannot know its total, so it approaches the end of its span.
    const share = step.phase === 'listing' ? (step.files ?? 0) / ((step.files ?? 0) + 2_000)
      : step.total > 0 ? Math.min(1, step.done / step.total) : 1;
    this.phase = step.phase;
    this.fraction = Math.max(this.fraction, span[0] + (span[1] - span[0]) * share);
  }

  toJSON() {
    return { kind: this.kind, phase: this.phase, percent: Math.min(99, Math.floor(this.fraction * 100)) };
  }
}

// The code is kept so a permission macOS withheld can be told from a failure of Lasso's own.
function activationError(error) {
  const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
  return { message: missing ? UNAVAILABLE_MESSAGE : error.message, code: error?.code ?? null };
}

/** A live selection over real projects. Snapshots and writes keep their owner. */
export class WorkspaceService {
  constructor({ timeline, dependencies, terminal }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.terminal = terminal;
    this.db = timeline.db;
    this.errors = new Map();
    this.closed = false;
    this.ready = Promise.resolve();
    this.mutations = Promise.resolve();
    this.renameChecks = new Map();
    this.activationRetries = new Map();
    // Folders being added, brought up to date or re-read, by project id.
    this.indexing = new Map();
    timeline.workspace = this;
    dependencies.workspace = this;
  }

  projects() {
    return this.db.prepare(`SELECT p.id, p.name, p.root_path, p.workspace_active,
      p.current_snapshot_id, s.version FROM projects p
      LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
      WHERE p.workspace_removed = 0 ORDER BY p.created_at, p.id`).all()
      .map((p) => ({ id: p.id, name: p.name, rootPath: p.root_path,
        active: Boolean(p.workspace_active), currentSnapshotId: p.current_snapshot_id, currentVersion: p.version }));
  }

  isActive(projectId) {
    return Boolean(this.db.prepare('SELECT workspace_active FROM projects WHERE id = ?').get(projectId)?.workspace_active);
  }

  requireActive(projectId) {
    if (!this.isActive(projectId)) throw new HttpError(409, 'Enable this work directory in the Lasso menu first.');
    const project = this.timeline.getProject(projectId);
    let available = false;
    try { available = fs.statSync(project.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
    if (!available || this.errors.has(projectId)) throw new HttpError(409, 'The enabled work directory is unavailable.');
  }

  activeProjects() {
    this.followRenamedRoots();
    return this.projects().filter((p) => {
      if (!p.active || this.errors.has(p.id) || !this.serving(p)) return false;
      try { return fs.statSync(p.rootPath).isDirectory(); } catch { return false; }
    });
  }

  /**
   * Whether a folder can answer suggestions. One being read keeps answering
   * from its last index until a new version is recorded; that version's
   * index is then built in slices, and asking it first would build it at once.
   */
  serving(project) {
    return !this.indexing.has(project.id) || this.dependencies.isIndexed(project.currentSnapshotId);
  }

  revision() {
    return this.projects().map((p) => {
      let available = false;
      try { available = fs.statSync(p.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
      return `${p.id}:${Number(p.active)}:${Number(available)}:${p.currentSnapshotId}:${Number(this.serving(p))}:${this.errors.get(p.id)?.message ?? ''}`;
    }).join('|');
  }

  /** Starts reporting progress for a folder; `pending` lists one not recorded yet. */
  beginIndexing(projectId, { kind, rootPath = null, name = null, pending = false }) {
    const progress = new DirectoryProgress({ kind, rootPath, name, pending });
    this.indexing.set(projectId, progress);
    return progress;
  }

  endIndexing(projectId, progress) {
    if (this.indexing.get(projectId) === progress) this.indexing.delete(projectId);
  }

  /** Runs steps in slices, reporting to `progress` and stopping if Lasso shuts down. */
  runIndexing(steps, progress) {
    return runSliced(steps, {
      onProgress: (step) => progress.report(step),
      cancelled: () => (this.closed ? new HttpError(503, 'Lasso is shutting down.') : null),
    });
  }

  /**
   * `options.pending` also lists folders chosen but not recorded yet, for the
   * menu that shows their progress. Other clients cannot open them yet.
   */
  state(options = {}) {
    this.followRenamedRoots();
    const counts = new Map(this.timeline.listProjects().map((p) => [p.id, p.fileCount]));
    const directories = this.projects().map((p) => {
      const drive = this.timeline.drives?.projectState(p.id) ?? {};
      const serving = this.serving(p);
      // A disconnected drive kept by the user stays searchable from its saved index.
      if (drive.availability === 'offline') {
        return { ...p, ...drive, fileCount: counts.get(p.id) ?? 0, available: true, serving, error: null, issue: null, note: null };
      }
      let available = false;
      try { available = fs.statSync(p.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
      // While a folder is read, its row shows how far that has got instead of
      // the problem the read may be about to fix.
      const progress = this.indexing.get(p.id);
      if (progress && available) {
        return { ...p, ...drive, fileCount: counts.get(p.id) ?? 0, available, serving, error: null, issue: null, note: null,
          indexing: progress.toJSON() };
      }
      const failure = this.errors.get(p.id) ?? null;
      return { ...p, ...drive, fileCount: counts.get(p.id) ?? 0, available, serving,
        error: failure?.message ?? (available ? null : 'Directory is unavailable.'),
        ...this.problemsFor(p, available, failure) };
    });
    // A folder still being read for the first time has no record yet.
    for (const [id, progress] of options.pending ? this.indexing : []) {
      if (!progress.pending || directories.some((directory) => directory.id === id)) continue;
      directories.push({ id, name: progress.name, rootPath: progress.rootPath, active: true, currentSnapshotId: null,
        currentVersion: null, fileCount: 0, available: true, serving: false, pending: true,
        error: null, issue: null, note: null, indexing: progress.toJSON() });
    }
    // Connected apps are indexed as folders Lasso manages. They answer
    // suggestions like any directory but are listed with the apps.
    const connected = directories.filter((p) => this.connections?.ownsRoot(p.rootPath));
    return { directories: directories.filter((p) => !connected.includes(p)),
      connections: this.connections?.describe(connected) ?? [], revision: this.revision(),
      activeProjectIds: directories.filter((p) => p.active && p.available && !p.error && p.serving).map((p) => p.id) };
  }

  /**
   * A folder's issue, for its badge, and its note, for its tooltip. Indexing
   * problems are read only for a folder in use: a paused one is not indexed
   * again until it is switched on, which reports them afresh.
   */
  problemsFor(project, available, activationFailure) {
    const inUse = project.active && available && !activationFailure;
    const failures = inUse ? this.terminal.indexing.failures(project.id) : [];
    return {
      issue: directoryIssue({
        available,
        activationError: activationFailure,
        readerBehind: inUse && this.dependencies.indexFreshness(project.id).stale,
        failures,
      }),
      note: directoryNote(failures),
    };
  }

  /** Applies the fix the folder's issue offers. Only Lasso's own problems have one. */
  async fixIssue(projectId, actor = systemActor) {
    const directory = this.state().directories.find((entry) => entry.id === projectId);
    if (!directory) throw new HttpError(404, 'Work directory not found.');
    if (!directory.issue?.fix) throw new HttpError(409, 'There is nothing for Lasso to fix in this folder.');
    if (directory.issue.kind === 'ACTIVATION') return this.toggle(projectId, true, actor);
    const kind = directory.issue.kind === 'READER' ? 'rereading' : 'updating';
    const progress = this.beginIndexing(projectId, { kind });
    return this.enqueue(async () => {
      try {
        if (kind === 'rereading') {
          await this.runIndexing(this.dependencies.reindexSteps(projectId, actor, { reason: 'fixed from the work directory list' }), progress);
        } else {
          // A checkpoint reads every file again, so the files that failed are retried.
          await this.runIndexing(this.timeline.captureSteps(projectId, actor, {
            source: 'EXPLICIT_CHECKPOINT', prepare: (capture) => this.dependencies.ensureIndexSteps(projectId, capture.snapshot.id),
          }), progress);
          await this.runIndexing(this.dependencies.ensureIndexSteps(projectId), progress);
        }
      } finally {
        this.endIndexing(projectId, progress);
      }
      return this.state();
    }).finally(() => this.endIndexing(projectId, progress));
  }

  async restore() {
    // Reconcile independently, so an unavailable volume cannot prevent other
    // enabled folders from starting. Each is read in slices, so the menu and
    // suggestions from folders already started are served meanwhile.
    for (const p of this.projects().filter((p) => p.active)) {
      await yieldTurn();
      if (this.closed) return;
      const progress = this.beginIndexing(p.id, { kind: 'updating' });
      try { await this.activateAsync(p.id, systemActor, progress); }
      catch (error) {
        if (this.closed) return;
        this.errors.set(p.id, activationError(error));
      } finally {
        this.endIndexing(p.id, progress);
      }
    }
    this.upgradeReaders();
    // Changes counts read every enabled folder's whole value history. Read it
    // now, off the server's thread, rather than when the library first asks.
    this.readValueHistory().catch(() => {});
  }

  /** Reads the enabled folders' value history off the server's thread, once each. */
  readValueHistory() {
    return this.terminal.graph.readFolderHistories(this.activeProjects().map((project) => project.id));
  }

  /**
   * Folders indexed by an older reader are read again with the current one,
   * one at a time and behind anything the user asked for. A reading that
   * matches what is recorded only notes the reader; one that differs is
   * recorded as a new version, as Re-read Files would. Until it runs, or if
   * it fails, the folder offers Re-read Files.
   */
  upgradeReaders() {
    for (const project of this.projects()) {
      if (!project.active || this.errors.has(project.id) || !this.dependencies.indexFreshness(project.id).stale) continue;
      this.enqueue(async () => {
        if (!this.isActive(project.id) || this.errors.has(project.id)
          || !this.dependencies.indexFreshness(project.id).stale) return;
        const progress = this.beginIndexing(project.id, { kind: 'rereading' });
        try {
          await this.runIndexing(this.dependencies.reindexSteps(project.id, systemActor,
            { reason: "Lasso's file reader was updated" }), progress);
        } finally {
          this.endIndexing(project.id, progress);
        }
      }).catch((error) => {
        if (!this.closed) console.error(`Re-reading ${project.rootPath} with the current reader failed:`, error.message);
      });
    }
  }

  /** Starts an enabled folder that failed earlier and is present again. */
  retryActivation(row) {
    if (this.closed || !row.workspace_active || !this.errors.has(row.id)) return;
    if (Date.now() - (this.activationRetries.get(row.id) ?? 0) < ACTIVATION_RETRY_MS) return;
    this.activationRetries.set(row.id, Date.now());
    try { this.activate(row.id, systemActor); }
    catch (error) { this.errors.set(row.id, activationError(error)); }
  }

  /**
   * A folder renamed in place keeps its inode, and so do the files inside it.
   * Find it among its old siblings and move the directory's record there, so
   * its history, colour and enabled state stay linked. Folders recorded before
   * root identities existed are recognised by their indexed files' inodes.
   */
  followRenamedRoots() {
    const rows = this.db.prepare(`SELECT id, name, root_path, root_inode, workspace_active, workspace_removed,
      current_snapshot_id FROM projects`).all();
    const taken = new Set(rows.map((row) => row.root_path));
    const inodeOf = (target) => {
      try {
        const stat = fs.statSync(target, { bigint: true });
        return stat.isDirectory() ? stat.ino.toString() : null;
      } catch { return null; }
    };
    for (const row of rows) {
      if (row.workspace_removed) continue;
      const inode = inodeOf(row.root_path);
      if (inode) {
        if (row.root_inode !== inode) this.db.prepare('UPDATE projects SET root_inode = ? WHERE id = ?').run(inode, row.id);
        this.renameChecks.delete(row.id);
        this.retryActivation(row);
        continue;
      }
      // A deleted or ejected folder stays missing; do not list its parent on every call.
      if (Date.now() - (this.renameChecks.get(row.id) ?? 0) < 2_000) continue;
      this.renameChecks.set(row.id, Date.now());
      const files = this.timeline.snapshotFiles(row.current_snapshot_id)
        .filter((file) => file.inode != null).slice(0, 8);
      const holdsFiles = (candidate) => {
        // Atomic saves replace some inodes; unrelated folders share none.
        const matched = files.filter((file) => {
          try { return String(fs.statSync(path.join(candidate, file.path), { bigint: true }).ino) === String(file.inode); }
          catch { return false; }
        }).length;
        return files.length > 0 && matched * 2 >= files.length;
      };
      if (!row.root_inode && !files.length) continue;
      const parent = path.dirname(row.root_path);
      let entries;
      try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { continue; }
      const renamed = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name))
        .find((candidate) => !taken.has(candidate)
          && ((row.root_inode && inodeOf(candidate) === row.root_inode) || holdsFiles(candidate)));
      if (!renamed) continue;
      let root;
      try { root = fs.realpathSync(renamed); } catch { continue; }
      if (taken.has(root)) continue;
      taken.delete(row.root_path); taken.add(root);
      this.relink(row, root);
    }
  }

  relink(row, root) {
    // Keep a custom display name; a name that was just the folder's follows it.
    const name = row.name === path.basename(row.root_path) ? path.basename(root) : row.name;
    this.db.prepare('UPDATE projects SET root_path = ?, name = ? WHERE id = ?').run(root, name, row.id);
    this.timeline.unwatchProject(row.id);
    this.timeline.scanCaches.delete(row.id);
    this.errors.delete(row.id);
    this.renameChecks.delete(row.id);
    if (!row.workspace_active) return;
    try { this.activate(row.id, systemActor); }
    catch (error) { this.errors.set(row.id, activationError(error)); }
  }

  activate(projectId, actor) {
    return runSync(this.activationSteps(projectId, actor));
  }

  /** The same, in slices, reporting to `progress`. */
  activateAsync(projectId, actor, progress) {
    return this.runIndexing(this.activationSteps(projectId, actor), progress);
  }

  *activationSteps(projectId, actor) {
    const project = this.timeline.getProject(projectId);
    // An offline drive's saved index is served as it is; the drive service
    // reconciles and watches the folder again when the drive returns.
    const offline = this.timeline.drives?.projectState(projectId).availability === 'offline';
    if (!offline) {
      if (!fs.statSync(project.rootPath).isDirectory()) throw new HttpError(400, 'The work directory is unavailable.');
      yield* this.timeline.captureSteps(projectId, actor, {
        source: 'OPEN_RECONCILE', prepare: (capture) => this.dependencies.ensureIndexSteps(projectId, capture.snapshot.id),
      });
    }
    yield* this.dependencies.ensureIndexSteps(projectId);
    yield* this.dependencies.warmPredictionCacheSteps(projectId);
    this.errors.delete(projectId);
    this.activationRetries.delete(projectId);
    if (offline) return;
    this.timeline.watchProject(projectId, actor);
    if (this.timeline.config.watchProjects && !this.timeline.watchers.has(projectId)) {
      throw new HttpError(400, 'The work directory could not be watched.');
    }
  }

  enqueue(callback) {
    const operation = this.mutations.then(async () => {
      await this.ready;
      if (this.closed) throw new HttpError(503, 'Lasso is shutting down.');
      return callback();
    });
    this.mutations = operation.catch(() => {});
    return operation;
  }

  add(rootPaths, actor = systemActor) {
    if (!Array.isArray(rootPaths) || !rootPaths.length || rootPaths.some((p) => typeof p !== 'string' || !p.trim())) {
      throw new HttpError(400, 'Choose one or more work directories.');
    }
    // Validate every choice before importing, including aliases to one root.
    let roots;
    try {
      roots = [...new Set(rootPaths.map((input) => {
        try {
          const root = fs.realpathSync(normalizeProjectRootPath(input));
          if (!fs.statSync(root).isDirectory()) throw new Error();
          return root;
        } catch { throw new HttpError(400, `Work directory is unavailable: ${input}`); }
      }))];
    } catch (error) {
      return Promise.reject(error);
    }
    // Each folder is listed with its progress from the moment it is chosen,
    // under the id it will keep, while earlier ones are still being read.
    const plans = roots.map((root) => {
      const known = this.db.prepare('SELECT id, name, workspace_active, workspace_removed FROM projects WHERE root_path = ?').get(root);
      const projectId = known?.id ?? crypto.randomUUID();
      const ready = known && known.workspace_active && !known.workspace_removed && !this.errors.has(known.id);
      const progress = ready ? null : this.beginIndexing(projectId, {
        kind: known ? 'updating' : 'adding', rootPath: root, name: known?.name ?? path.basename(root),
        pending: !known || Boolean(known.workspace_removed),
      });
      return { root, projectId, progress };
    });
    const finish = () => { for (const { projectId, progress } of plans) if (progress) this.endIndexing(projectId, progress); };
    return this.enqueue(async () => {
      try {
        for (const { root, projectId, progress } of plans) {
          await yieldTurn();
          if (this.closed) throw new HttpError(503, 'Lasso is shutting down.');
          const reported = progress ?? this.beginIndexing(projectId, { kind: 'updating' });
          try { await this.addRoot(root, projectId, reported, actor); }
          finally { this.endIndexing(projectId, reported); }
        }
      } finally {
        finish();
      }
      return this.state();
    }).finally(finish);
  }

  async addRoot(root, projectId, progress, actor) {
    // The new folder's first index is built before anything hears of it.
    const imported = await this.runIndexing(this.timeline.importProjectSteps(root, actor, {
      watch: false, projectId, prepare: (result) => this.dependencies.ensureIndexSteps(result.project.id),
    }), progress);
    const id = imported.project.id;
    this.db.prepare('UPDATE projects SET workspace_active = 1, workspace_removed = 0 WHERE id = ?').run(id);
    try {
      if (imported.imported) {
        await this.runIndexing(this.dependencies.warmPredictionCacheSteps(id), progress);
        this.timeline.watchProject(id, actor);
        if (this.timeline.config.watchProjects && !this.timeline.watchers.has(id)) {
          throw new HttpError(400, 'The work directory could not be watched.');
        }
        this.errors.delete(id);
      } else {
        if (id !== projectId) {
          this.endIndexing(projectId, progress);
          this.indexing.set(id, progress);
        }
        try { await this.activateAsync(id, actor, progress); }
        finally { this.endIndexing(id, progress); }
      }
    } catch (error) {
      if (this.closed) throw error;
      this.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(id);
      this.timeline.unwatchProject(id);
      this.timeline.scanCaches.delete(id);
      this.errors.set(id, activationError(error));
      throw new HttpError(400, `Could not add the work directory: ${activationError(error).message}`);
    }
  }

  toggle(projectId, active, actor = systemActor) {
    if (typeof active !== 'boolean') throw new HttpError(400, 'Directory active state must be true or false.');
    return this.enqueue(async () => {
      this.timeline.getProject(projectId);
      if (active) {
        if (!this.isActive(projectId) || this.errors.has(projectId)) {
          // Record activation only after a successful reconcile. A failed
          // folder selection must not claim that it is ready for suggestions.
          this.db.prepare('UPDATE projects SET workspace_active = 1 WHERE id = ?').run(projectId);
          const progress = this.beginIndexing(projectId, { kind: 'updating' });
          try { await this.activateAsync(projectId, actor, progress); }
          catch (error) {
            if (this.closed) throw error;
            this.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(projectId);
            this.timeline.unwatchProject(projectId);
            this.errors.set(projectId, activationError(error));
            throw new HttpError(400, `Could not enable the work directory: ${activationError(error).message}`);
          } finally {
            this.endIndexing(projectId, progress);
          }
          this.upgradeReaders();
        }
      } else {
        this.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(projectId);
        this.timeline.unwatchProject(projectId);
        this.timeline.scanCaches.delete(projectId);
        this.errors.delete(projectId);
      }
      return this.state();
    });
  }

  /**
   * Takes a folder out of the menu without touching it on disk. Its history
   * is kept, so choosing the same folder again restores it.
   */
  remove(projectId) {
    return this.removeMany([projectId]);
  }

  /** Removes several folders in one step. An unknown id removes none of them. */
  removeMany(projectIds) {
    if (!Array.isArray(projectIds) || !projectIds.length
      || projectIds.some((id) => typeof id !== 'string' || !id.trim())) {
      throw new HttpError(400, 'Choose one or more work directories to remove.');
    }
    const ids = [...new Set(projectIds)];
    return this.enqueue(() => {
      for (const projectId of ids) this.timeline.getProject(projectId);
      const removal = this.db.prepare('UPDATE projects SET workspace_active = 0, workspace_removed = 1 WHERE id = ?');
      transaction(this.db, () => { for (const projectId of ids) removal.run(projectId); });
      for (const projectId of ids) {
        this.timeline.unwatchProject(projectId);
        this.timeline.scanCaches.delete(projectId);
        this.errors.delete(projectId);
        this.renameChecks.delete(projectId);
      }
      return this.state();
    });
  }

  sourceValuePlan(objectId) {
    const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(objectId);
    if (!owner) throw new HttpError(404, 'Indexed source not found.');
    this.requireActive(owner.project_id);
    const destinations = this.activeProjects();
    const plans = destinations.filter((project) => project.id === owner.project_id
      || this.dependencies.currentDependencies(project.id).some((d) => d.source.id === objectId))
      .map((project) => ({ project, plan: this.dependencies.planSourceValueUpdate(project.id, objectId) }));
    const original = plans.find(({ project }) => project.id === owner.project_id)?.plan;
    if (!original) throw new HttpError(409, 'The source directory is unavailable.');
    return { ...original,
      edits: plans.flatMap(({ project, plan }) => plan.edits.map((edit) => ({ ...edit,
        projectId: project.id, projectName: project.name }))),
      rewrites: plans.reduce((sum, { plan }) => sum + plan.rewrites, 0),
      relinks: plans.reduce((sum, { plan }) => sum + plan.relinks, 0),
      manual: plans.reduce((sum, { plan }) => sum + plan.manual, 0),
      alreadyCurrent: plans.reduce((sum, { plan }) => sum + plan.alreadyCurrent, 0),
      documents: plans.flatMap(({ project, plan }) => plan.documents.map((documentPath) => ({
        path: documentPath, projectId: project.id, projectName: project.name }))),
      // Pin every destination head, including folders without edits. A newly
      // linked document must invalidate a previously reviewed workspace plan.
      projects: destinations.map((project) => ({ projectId: project.id,
        snapshotId: this.timeline.getProject(project.id).currentSnapshotId })) };
  }

  applySourceValuePlan(objectId, action, actor, plan) {
    if (action === 'apply') {
      // Validate every destination before changing the first directory.
      for (const { projectId } of plan.projects) {
        this.dependencies.validateSourceValueUpdate(projectId, {
          ...plan, edits: plan.edits.filter((edit) => edit.projectId === projectId),
        }, actor);
      }
    }
    const results = [];
    for (const { projectId } of plan.projects) {
      if (!plan.edits.some((edit) => edit.projectId === projectId)) continue;
      const value = action === 'keep'
        ? this.dependencies.keepCurrentValue(projectId, objectId, actor)
        : this.dependencies.applySourceValueUpdate(projectId, objectId, actor);
      results.push({ projectId, ...value });
    }
    return { projects: results, applied: results.flatMap((r) => (r.applied ?? []).map((edit) => ({ ...edit, projectId: r.projectId }))),
      kept: results.flatMap((r) => (r.kept ?? []).map((edit) => ({ ...edit, projectId: r.projectId }))) };
  }

  search(query, options = {}) {
    return distinctRanked(this.activeProjects().flatMap((project) => this.dependencies.search(project.id, query, {
      ...options, documentPath: options.documentProjectId === project.id ? options.documentPath : null,
    }).map((object) => tag(object, project))), options.limit ?? 30);
  }
}

// Prediction and the terminal live in their own files.
Object.assign(WorkspaceService.prototype, workspacePredictionMethods, workspaceTerminalMethods);

// Kept here too for code that imports it from the workspace.
export { distinctRanked };
