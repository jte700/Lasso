import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { transaction } from './db.js';
import { HttpError } from './history/errors.js';
import { normalizeProjectRootPath } from './history/service.js';
import { runSliced, runSync } from './history/work.js';
import {
  currentClauseStart, LINKED_VALUES_SHOWN, namesFocusedFile, SUGGESTIONS_SHOWN, writtenBeforeCaret,
} from './dependencies/service.js';
import { dictatedNameEnds, hasSuggestions, namesInFull, softenDictatedPauses } from './dependencies/dictation.js';
import { directoryIssue, directoryNote } from './directory-issues.js';
import { offeredShareScopes } from './sharing/object-share.js';
import { matchedSourceWords, typedSentence } from './dependencies/direct-match.js';
import { parseCommand } from './terminal/parser.js';
import { failure, result, text, blank, dim } from './terminal/result.js';

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

// A source the writer focused with fn+Right need not be in the text. Chosen
// on the words being typed ("brac" for Bracket), it rests on them and its
// values replace them. Otherwise, or once those words are in an earlier
// clause, it is anchored where the clause being written starts. Either way
// the sentence never ends its scope; fn+Left or another accepted source does.
function focusedDependency(focusSource, text, cursor) {
  if (!focusSource || typeof focusSource !== 'object') return null;
  const { projectId, sourceObjectId, sourceSnapshotId, start, end } = focusSource;
  if (![projectId, sourceObjectId, sourceSnapshotId].every((value) => typeof value === 'string' && value)) return null;
  const focus = { projectId, blockIndex: 0, sourceObjectId, sourceSnapshotId, focused: true };
  const clauseStart = currentClauseStart(text, cursor);
  const typed = Number.isInteger(start) && Number.isInteger(end) && clauseStart <= start && start < end && end <= cursor;
  return typed ? { ...focus, start, end, replacesText: true } : { ...focus, start: clauseStart, end: clauseStart };
}

// Relevance is calculated by the existing per-project ranker. Merge those
// scores without treating identical relative paths in different roots as one.
// Exact ties keep the order each project produced (the sort is stable), such
// as a row's columns in sheet order. Object ids are random, so ordering ties
// by id made suggestions swap places between keystrokes.
function compare(a, b) {
  const left = a.ranking ?? {};
  const right = b.ranking ?? {};
  const browsing = (left.tier ?? a.matchTier) === 3 && (right.tier ?? b.matchTier) === 3;
  return (left.tier ?? a.matchTier ?? 1) - (right.tier ?? b.matchTier ?? 1)
    || (right.directSpecificity ?? 0) - (left.directSpecificity ?? 0)
    || (browsing ? (right.recentScore ?? 0) - (left.recentScore ?? 0)
      || (right.frequencyScore ?? 0) - (left.frequencyScore ?? 0) : 0)
    || (right.relevanceBand ?? 0) - (left.relevanceBand ?? 0)
    || (browsing ? 0 : (right.contextScore ?? 0) - (left.contextScore ?? 0))
    || Number(right.relationship ?? false) - Number(left.relationship ?? false)
    || ((right.relevanceScore ?? b.score ?? 0) + (right.usageBoost ?? 0))
      - ((left.relevanceScore ?? a.score ?? 0) + (left.usageBoost ?? 0))
    || String(a.projectId).localeCompare(String(b.projectId));
}

function tag(value, project, projects = null) {
  if (!value) return value;
  const ownerId = value.projectId ?? value.dependencyCandidate?.projectId ?? value.object?.projectId;
  project = projects?.get(ownerId) ?? project;
  return { ...value, projectId: project.id, projectName: project.name, rootPath: project.rootPath,
    // Whether a share link can be made for it; the Mac app hides Share Link when not.
    ...(typeof value.path === 'string' ? { shareable: offeredShareScopes(value.path, value.anchor).length > 0 } : {}),
    ...(value.object ? { object: tag(value.object, project, projects) } : {}),
    ...(value.dependencyCandidate ? { dependencyCandidate: tag(value.dependencyCandidate, project, projects) } : {}) };
}

export function distinctRanked(items, limit, { keepOrder = false } = {}) {
  const seen = new Set();
  // Full ties keep each directory's own ranked order, which already settles
  // them by source order (a row's columns left to right). Object ids are
  // random, so comparing them would shuffle equal suggestions between runs.
  const ordered = keepOrder ? items : items.map((item, order) => ({ item, order }))
    .sort((left, right) => compare(left.item, right.item) || left.order - right.order)
    .map(({ item }) => item);
  return ordered
    .filter((item) => {
      const key = `${item.projectId}:${item.id ?? item.objectId ?? item.dependencyCandidate?.id}:${item.insertText ?? item.text ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, limit);
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

  async predict(input = {}) {
    let prediction = await this.predictText(input);
    if (!hasSuggestions(prediction)) prediction = await this.pastEmptySource(input, prediction);
    if (input.dictated !== true || hasSuggestions(prediction)) return prediction;
    const named = await this.predictNamed(input);
    if (named) return named;
    // Dictation's pauses put sentence marks among the words being said ("The
    // other revenue. Was"); read across them, at the same offsets.
    const softened = softenDictatedPauses(input.text, Number.isInteger(input.cursor) ? input.cursor : undefined);
    if (!softened) return prediction;
    const across = { ...input, text: softened };
    const read = await this.predictText(across);
    return hasSuggestions(read) ? read : (await this.predictNamed(across)) ?? prediction;
  }

  /**
   * An accepted source describes the rest of its sentence, so suggestions
   * keep to it. One with nothing to offer for the words after it, such as a
   * heading row with no values ("OPERATING EXPENSES"), no longer holds them
   * once they name something else ("additionally, the other expen"): the
   * name gets its suggestions, as after "and". A focus chosen with fn+Right
   * is kept, and so is a source whose values were all written already.
   */
  async pastEmptySource(input, prediction) {
    if (input.focusSource || !prediction.sourceContext?.source) return prediction;
    const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
    const ends = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [])
      .map((link) => link?.end).filter((end) => Number.isInteger(end) && end <= cursor);
    if (!ends.length) return prediction;
    const boundary = Math.max(...ends);
    const released = await this.predictText({ ...input, sourceScopeBoundary: boundary });
    const namesSomething = (released.claims ?? []).some((claim) => claim.start >= boundary
      && claim.candidates?.length && !['QUANTITATIVE', 'SAMPLE_SIZE'].includes(claim.type));
    return namesSomething ? released : prediction;
  }

  /**
   * Dictation writes a name in full and goes straight on ("Other revenue
   * was"), with no moment to accept it with Tab. A source named in full among
   * the words just said is read as if it had been accepted there. Null when
   * none was, or reading it so offers nothing.
   */
  async predictNamed(input) {
    const named = await this.dictatedName(input);
    if (!named) return null;
    const pending = Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [];
    const linked = await this.predictText({ ...input, pendingDependencies: [...pending, named] });
    return hasSuggestions(linked) ? linked : null;
  }

  /** The link a dictated name would have had, had Tab accepted it; null when none was said in full. */
  async dictatedName(input) {
    if (input.focusSource) return null;
    const text = String(input.text ?? '');
    const cursor = Number.isInteger(input.cursor) ? input.cursor : text.length;
    const pending = Array.isArray(input.pendingDependencies) ? input.pendingDependencies : [];
    // Never a name already accepted, nor one in an earlier clause.
    const linkedEnd = Math.max(0, ...pending.map((link) => (Number.isInteger(link?.end) ? link.end : 0)));
    const from = Math.max(currentClauseStart(text, cursor), linkedEnd);
    for (const end of dictatedNameEnds(text, from, cursor).slice(0, 3)) {
      const said = text.slice(0, end);
      const prediction = await this.predictText({ ...input, text: said, cursor: end });
      for (const claim of prediction.claims ?? []) {
        if (claim.end !== end || claim.start < from) continue;
        const source = (claim.candidates ?? []).find((candidate) => candidate.id && candidate.snapshotId
          && candidate.projectId && namesInFull(said.slice(claim.start, claim.end), candidate.label));
        if (source) return { projectId: source.projectId, blockIndex: 0, start: claim.start, end: claim.end,
          sourceObjectId: source.id, sourceSnapshotId: source.snapshotId };
      }
    }
    return null;
  }

  async predictText(input = {}) {
    const revision = this.revision();
    const projects = this.activeProjects();
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const owners = new Map();
    const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
    // A focus chosen with fn+Right stands in for the accepted sources while it lasts.
    const focus = focusedDependency(input.focusSource, input.text, cursor);
    const pending = focus ? [focus] : (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
      .filter((link) => link && typeof link.sourceObjectId === 'string');
    for (const link of pending) {
      const owner = this.db.prepare('SELECT project_id FROM scientific_objects WHERE id = ?').get(link.sourceObjectId);
      if (owner) owners.set(link.sourceObjectId, owner.project_id);
    }
    // Resolve the newest eligible accepted source across all roots before
    // narrowing input per root. Otherwise each root treats its own older link
    // as current and one paragraph receives several conflicting source scopes.
    const documentProject = projectsById.get(input.documentProjectId);
    const contextProject = documentProject ?? projects[0];
    const availablePending = pending.filter((link) => projectsById.has(owners.get(link.sourceObjectId)));
    let linkedContext = contextProject ? this.dependencies.linkedDependencyContext(contextProject.id, {
      ...input, documentPath: documentProject ? input.documentPath : null,
      pendingDependencies: availablePending,
    }, cursor) : null;
    if (linkedContext && !projectsById.has(this.dependencies.sourceProjectId(linkedContext.source))) linkedContext = null;
    // A value is as deep as a source goes. Once the newest accepted source is
    // one ("The Bracket is 100 mm"), every directory answers the words after it.
    const settledAt = this.dependencies.settledValueEnd(input, linkedContext);
    if (settledAt >= 0) linkedContext = null;
    // A subject named after a joining word ends the accepted source's scope
    // whichever directory holds it ("Revenue was 485000 and the brack"). The
    // source's own directory checks this itself, so only the others are asked.
    const linkedOwner = linkedContext && this.dependencies.sourceProjectId(linkedContext.source);
    const namedElsewhere = linkedContext && projects.some((project) => project.id !== linkedOwner
      && this.dependencies.namesSubjectAfterJoiner(project.id, {
        ...input, documentPath: input.documentProjectId === project.id ? input.documentPath : null,
      }, cursor, linkedContext));
    // Every link ends at or before the newest, so one boundary releases them all.
    const predictionInput = namedElsewhere ? { ...input, sourceScopeBoundary: linkedContext.anchor.end }
      : settledAt >= 0 ? { ...input, sourceScopeBoundary: settledAt, settledValueEnd: settledAt } : input;
    if (namedElsewhere) linkedContext = null;
    const currentPending = linkedContext
      ? availablePending.filter((link) => link.sourceObjectId === linkedContext.source.id) : availablePending;
    const predictions = [];
    for (const project of projects) {
      await yieldTurn();
      if (this.closed || revision !== this.revision()) throw new HttpError(409, 'Work directories changed. Request fresh suggestions.');
      const ownDocument = input.documentProjectId === project.id;
      // Every accepted link still tells which values were already written.
      const scopedInput = { ...predictionInput, documentPath: ownDocument ? input.documentPath : null,
        pendingDependencies: ownDocument ? currentPending : currentPending.filter((s) => owners.get(s.sourceObjectId) === project.id),
        acceptedDependencies: availablePending.filter((link) => !link.focused) };
      predictions.push({ project, prediction: this.dependencies.predict(project.id, scopedInput) });
    }
    // An explicitly linked source narrows suggestions to that source's owner.
    const availablePredictions = predictions.filter(({ prediction }) => !prediction.sourceContext?.source
      || projectsById.has(this.dependencies.sourceProjectId(prediction.sourceContext.source)));
    const scoped = availablePredictions.filter(({ prediction }) => prediction.sourceContext?.source
      && (!linkedContext || prediction.sourceContext.source.id === linkedContext.source.id));
    // A file spelled as written ("General-Ledger.cs") is the source being
    // chosen, even after a source linked from another directory. Other
    // directories' guesses about the same words do not outrank it. The file a
    // focus chosen with fn+Right sits in is that focus, not a new choice.
    const naming = availablePredictions.filter(({ prediction }) => prediction.claims?.some((claim) => claim.asWritten
      && claim.candidates?.some((candidate) => candidate.fileReference)
      && (!linkedContext || (claim.start >= linkedContext.anchor.end && !namesFocusedFile(claim, linkedContext)))));
    const pool = naming.length ? naming : scoped.length ? scoped : availablePredictions;
    const limit = pool.some(({ prediction }) => prediction.listsEveryValue) ? LINKED_VALUES_SHOWN : SUGGESTIONS_SHOWN;
    const slots = [];
    for (const { project, prediction } of pool) {
      for (const group of ['sourceCompletions', 'workspaceCompletions']) {
        for (const value of prediction[group] ?? []) slots.push({ ...tag(value, project, projectsById), group,
          ranking: value.dependencyCandidate?.ranking ?? value.ranking,
          score: value.dependencyCandidate?.score ?? value.score ?? value.confidence });
      }
      for (const claim of prediction.claims ?? []) {
        for (const value of claim.candidates ?? []) slots.push({ ...tag(value, project, projectsById), group: 'claim', claim });
      }
      if (prediction.completion) {
        const completion = tag(prediction.completion, project, projectsById);
        slots.push({ ...completion, ranking: completion.dependencyCandidate?.ranking,
          score: completion.dependencyCandidate?.score ?? completion.score, group: 'completion' });
      }
    }
    // Directories can read different words as the subject: in "Revenue was
    // 485000. The brack" one offers the earlier value and another the part
    // being named. A claim in the clause being written wins over earlier ones.
    const clauseStart = currentClauseStart(input.text, cursor);
    const writingClaim = slots.some((slot) => slot.group === 'claim' && slot.claim.end > clauseStart);
    const inClause = writingClaim
      ? slots.filter((slot) => slot.group !== 'claim' || slot.claim.end > clauseStart) : slots;
    // A value written before the words at the caret ("rises from 6% to") is
    // not being typed. When a directory continues the sentence, other
    // directories' sources for that value give up their places to it.
    const continuing = slots.some((slot) => slot.group === 'completion')
      ? inClause.filter((slot) => slot.group !== 'claim' || !writtenBeforeCaret(slot.claim, input.text, cursor)) : inClause;
    // Directories may match different suffixes of the same phrase ("net inc"
    // and "inc", "bracket length" and "length"). The longer match is the one
    // the writer is typing, so the shorter gives up its slots before ranking;
    // otherwise its higher scores could crowd the longer match out entirely.
    const variables = continuing.filter((slot) => slot.group === 'claim' && slot.claim.type === 'STUDY_VARIABLE')
      .map((slot) => slot.claim);
    const nested = (claim) => claim.type === 'STUDY_VARIABLE' && variables.some((other) => other !== claim
      && other.start <= claim.start && other.end >= claim.end && other.end - other.start > claim.end - claim.start);
    const current = continuing.filter((slot) => slot.group !== 'claim' || !nested(slot.claim));
    // Each keeps its place in the one ranked order, which the groups below split
    // up, and the typed words its source has, which the card's preview marks.
    const sentence = typedSentence(input.text, cursor);
    // A video's moment marks the quoted words only, not every word of the sentence around them.
    // A file named by its name is matched as a whole, so its preview marks no words in it.
    const namesWholeFile = (item) => Boolean(item.fileReference ?? item.dependencyCandidate?.fileReference);
    const keepOrder = pool.length > 0 && pool.every(({ prediction }) => prediction.listsInOrder);
    const selected = distinctRanked(current, limit, { keepOrder }).map((item, rankOrder) => ({ ...item, rankOrder,
      matchedWords: namesWholeFile(item) ? [] : matchedSourceWords(item.quotedPhrase ?? sentence, [item.sourceSentence, item.replacementText, item.dependencyCandidate?.valueText,
        item.dependencyCandidate?.label, item.dependencyCandidate?.metadata?.variable, item.valueText, item.label,
        item.metadata?.variable].filter((text) => typeof text === 'string').join(' ')) }));
    // fn+Right opens a suggestion that has values below it, such as a part's measurements.
    const narrowing = (candidate) => this.dependencies.narrowsTo(candidate.projectId, candidate)
      ? { ...candidate, narrowable: true } : candidate;
    const claims = new Map();
    for (const item of selected.filter((s) => s.group === 'claim')) {
      const key = `${item.claim.start}:${item.claim.end}:${item.claim.type}`;
      if (!claims.has(key)) claims.set(key, { ...item.claim, candidates: [] });
      const { group, claim, ...candidate } = item;
      claims.get(key).candidates.push(narrowing(candidate));
    }
    const strip = ({ group, claim, ...value }) => value.dependencyCandidate
      ? { ...value, dependencyCandidate: narrowing(value.dependencyCandidate) } : value;
    const context = pool.find(({ prediction }) => prediction.sourceContext?.source) ?? pool[0];
    return { deterministic: true, generatedText: false, workspaceRevision: revision,
      sourceCompletions: selected.filter((s) => s.group === 'sourceCompletions').map(strip),
      workspaceCompletions: selected.filter((s) => s.group === 'workspaceCompletions').map(strip),
      claims: [...claims.values()], completion: selected.find((s) => s.group === 'completion')
        ? strip(selected.find((s) => s.group === 'completion')) : null,
      ...(context?.prediction.sourceContext ? { sourceContext: { ...context.prediction.sourceContext,
        ...(context.prediction.sourceContext.source ? { source: tag(context.prediction.sourceContext.source, context.project, projectsById) } : {}) } } : {}),
      ...(context?.prediction.workspaceHeading ? { workspaceHeading: context.prediction.workspaceHeading } : {}),
      ...(context?.prediction.notice && !selected.length ? { notice: context.prediction.notice } : {}) };
  }

  search(query, options = {}) {
    return distinctRanked(this.activeProjects().flatMap((project) => this.dependencies.search(project.id, query, {
      ...options, documentPath: options.documentProjectId === project.id ? options.documentPath : null,
    }).map((object) => tag(object, project))), options.limit ?? 30);
  }

  terminalSession() {
    const sessions = this.activeProjects().map((p) => this.terminal.executor.banner(p.id));
    const sum = (key) => sessions.reduce((total, session) => total + (session[key] ?? 0), 0);
    return { project: { id: 'workspace', name: 'Work directories', rootPath: `${sessions.length} enabled folders` },
      directories: sessions.length, files: sum('files'), dependencies: sum('dependencies'),
      changes: sum('changes'), stale: sum('stale'), conflicts: sum('conflicts'), failures: sum('failures'),
      version: null, commands: this.terminal.registry.names(), projects: sessions };
  }

  // A bounded, read-only summary for the native notch. Only enabled and
  // available source directories contribute evidence or notifications.
  /**
   * The notch polls this every few seconds, and building it walks every
   * active folder. Reuse it until a folder's version, state or open indexing
   * issues change, so a poll cannot hold up suggestions while typing.
   */
  activity(options = {}) {
    this.followRenamedRoots();
    // Native links belong to their host app, not a browser document. These
    // opaque IDs extend the notification set without transmitting host text.
    const sourceObjectIds = [...new Set((options.sourceObjectIds ?? [])
      .filter(id => typeof id === 'string' && id.length <= 128))].sort().slice(0, 256);
    const openIssues = this.db.prepare('SELECT COUNT(*) AS count FROM index_failures WHERE resolved_at IS NULL').get().count;
    const key = `${this.revision()}#${openIssues}#${JSON.stringify(sourceObjectIds)}`;
    if (this.activityCache?.key === key) return this.activityCache.value;
    const value = this.computeActivity(sourceObjectIds);
    this.activityCache = { key, value };
    return value;
  }

  computeActivity(sourceObjectIds = []) {
    const projects = this.activeProjects();
    const files = projects.reduce((sum, project) => sum + this.timeline.files.count(project.currentSnapshotId), 0);
    const staleSources = new Set();
    const failures = projects.reduce((sum, project) => sum + this.db.prepare(
      'SELECT COUNT(*) AS count FROM index_failures WHERE project_id = ? AND resolved_at IS NULL').get(project.id).count, 0);
    const references = new Map();
    for (const project of projects) for (const dependency of this.dependencies.currentDependencies(project.id)) {
      const counts = references.get(dependency.source.id) ?? { referenceCount: 0, unresolvedReferences: 0 };
      counts.referenceCount += 1;
      if (!['LINKED', 'PREDICTED'].includes(dependency.status)) {
        counts.unresolvedReferences += 1;
        staleSources.add(`${project.id}:${dependency.source.id}`);
      }
      references.set(dependency.source.id, counts);
    }
    for (const objectId of sourceObjectIds) {
      const counts = references.get(objectId) ?? { referenceCount: 0, unresolvedReferences: 0 };
      counts.referenceCount += 1;
      references.set(objectId, counts);
    }
    const linkedIds = new Set(references.keys());
    const recentFirst = (a, b) => String(b.changedAt).localeCompare(String(a.changedAt))
      || b.toVersion - a.toVersion || a.objectId.localeCompare(b.objectId);
    const decorate = (change, project) => ({ ...change, projectId: project.id, projectName: project.name,
      ...(references.get(change.objectId) ?? { referenceCount: 0, unresolvedReferences: 0 }) });
    // A linked whole file can change without changing its title, and a removed
    // source has no current value. Both still need a notification. Select linked
    // IDs before applying the limit so a large CSV cannot crowd them out.
    const linkedChanges = projects.flatMap(project => linkedIds.size ? this.terminal.graph.activityChanges(project.id,
      { limit: 256, objectIds: linkedIds, includeSourceChanges: true })
      .map(change => decorate(change, project)) : []).sort(recentFirst).slice(0, 256);
    const linkedById = new Map(linkedChanges.map(change => [change.objectId, change]));
    const otherChanges = projects.flatMap(project => this.terminal.graph.activityChanges(project.id,
      { limit: 8 }).filter(change => !linkedById.has(change.objectId))
      .map(change => decorate(change, project))).sort(recentFirst);
    // state() also computes detailed folder issues by resolving drawing objects.
    // Eligibility is already known here; keep that full-index work out of polls.
    const availableIds = new Set(projects.map(project => project.id));
    const unavailable = this.projects().filter(project => project.active && !availableIds.has(project.id)
      && this.timeline.drives?.projectState(project.id).availability !== 'offline').length;
    return { directories: projects.length, files, stale: staleSources.size,
      failures: failures + unavailable, changes: [...linkedChanges, ...otherChanges].slice(0, 8), linkedChanges,
      // Include links with no changes yet: the native client must distinguish
      // their first edit from old history newly exposed by adding a link.
      linkedSourceObjectIds: [...linkedIds].sort() };
  }

  terminalComplete(input, options = {}) {
    const projects = this.activeProjects();
    const completions = projects.map((p) => ({ p, value: this.terminal.executor.complete(p.id, input, options) }));
    const template = completions[0]?.value ?? this.terminal.executor.complete(null, input, options);
    const suggestions = completions.flatMap(({ p, value }) => value.suggestions.map((s) => tag(s, p)));
    const generic = ['command', 'flag', 'subcommand'].includes(template.position)
      || suggestions.every((s) => ['when', 'source type'].includes(s.kind));
    if (!projects.length || generic) return template;
    return { ...template, suggestions: distinctRanked(suggestions.map((s) => ({ ...s,
      id: s.objectId ?? s.value, detail: [s.projectName, s.detail].filter(Boolean).join(' · ') })),
      options.surface === 'search' ? 14 : 8) };
  }

  terminalRun(input, actor, options = {}) {
    const projects = this.activeProjects();
    const first = String(input ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const command = parseCommand(input, this.terminal.registry.booleanFlags(first));
    if (!command.empty && !['?', 'help', 'clear'].includes(command.name) && !this.terminal.registry.get(command.name)
      && (/\?$/.test(command.raw) || /^(which|what|where|when|who|how|why|is|are|does|did)\b/i.test(command.raw))) {
      return this.terminalRun(`ask ${command.raw}`, actor, options);
    }
    if (command.empty || ['?', 'help', 'clear'].includes(command.name) || !this.terminal.registry.get(command.name)) {
      return this.terminal.executor.run(projects[0]?.id ?? null, input, actor, options);
    }
    if (command.name === 'index' && command.args[0] === 'add') {
      const target = command.args.slice(1).join(' ').trim();
      return this.add([target], actor).then((state) => result('index', {
        headline: 'Work directory added', data: state,
      }));
    }
    if (!projects.length) return failure(command.name, 'No work directories are enabled.', {
      hints: ['Add or enable a work directory in the Lasso menu.'],
    });
    if (options.projectId) {
      this.requireActive(options.projectId);
      return this.terminal.executor.run(options.projectId, input, actor, options);
    }
    // Mutations need an explicit destination when more than one root could be
    // affected. The browser supplies a project ID from the selected result.
    const mutating = ['alias', 'unalias', 'revoke', 'unlink'].includes(command.name)
      || command.name === 'update' && (command.flags.apply || command.flags.keep || command.flags.all)
      || command.name === 'rules' && ['add', 'remove', 'enable', 'disable'].includes(command.args[0])
      || command.name === 'index' && ['remove', 'include', 'retry'].includes(command.args[0]);
    if (mutating && projects.length > 1) return failure(command.name, 'Select a work directory for this change.', {
      hints: ['Choose the destination directory in the browser, or select a result from that directory.'],
    });
    let answers = projects.map((p) => ({ project: p, answer: this.terminal.executor.run(p.id, input, actor, options) }));
    if (answers.length === 1) return this.tagTerminal(answers[0].answer, answers[0].project);
    // A lookup is answered by the directories that found something. Listing
    // every other directory's "not answerable" first would bury that answer.
    if (['ask', 'find'].includes(command.name)) {
      const found = answers.filter(({ answer }) => answer.ok && answer.data?.answered !== false
        && (command.name === 'ask' || answer.results.length > 0));
      const others = answers.length - found.length;
      const note = others ? [dim(`No result in the other ${others} work director${others === 1 ? 'y' : 'ies'}.`)] : [];
      if (found.length === 1) {
        const { project, answer } = found[0];
        const tagged = this.tagTerminal(answer, project);
        return { ...tagged, subhead: tagged.subhead ?? `${project.name} · ${project.rootPath}`,
          blocks: [...tagged.blocks, ...(note.length ? [blank(), ...note] : [])],
          data: { ...answer.data, projects: answers.map(({ project: each, answer: { data } }) => ({ projectId: each.id, ...data })) } };
      }
      if (found.length > 1) {
        answers = found;
        const merged = this.mergeTerminal(command, answers);
        return { ...merged, blocks: [...merged.blocks, ...note] };
      }
    }
    return this.mergeTerminal(command, answers);
  }

  mergeTerminal(command, answers) {
    return { ...result(command.name), ok: answers.some((a) => a.answer.ok),
      headline: `${command.name} · ${answers.length} work directories`,
      blocks: answers.flatMap(({ project, answer }) => [text(`${project.name} · ${project.rootPath}`),
        ...(answer.headline ? [text(answer.headline, answer.ok ? 'normal' : 'warn')] : []), ...answer.blocks, blank()]),
      results: answers.flatMap(({ project, answer }) => this.tagTerminal(answer, project).results),
      actions: [...new Map(answers.flatMap(({ answer }) => answer.actions).map((a) => [a.key, a])).values()],
      hints: [...new Set(answers.flatMap(({ answer }) => answer.hints))],
      data: { projects: answers.map(({ project, answer }) => ({ projectId: project.id, ...answer.data })) } };
  }

  tagTerminal(answer, project) {
    return { ...answer, projectId: project.id, results: answer.results.map((item) => ({ ...item,
      lines: [project.name, ...item.lines], ref: { ...item.ref, projectId: project.id } })) };
  }

  terminalPreview(reference) {
    if (!reference?.projectId) throw new HttpError(400, 'Choose a source with its work directory.');
    this.requireActive(reference.projectId);
    return this.terminal.executor.preview(reference.projectId, reference);
  }

  close() { this.closed = true; }
}
