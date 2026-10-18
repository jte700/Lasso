import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { HttpError } from './history/errors.js';
import { normalizeProjectRootPath } from './history/service.js';
import { parseCommand } from './terminal/parser.js';
import { failure, result, text, blank, dim } from './terminal/result.js';

const systemActor = { id: 'system:workspace', displayName: 'Lasso', actorType: 'SYSTEM' };

// Relevance is calculated by the existing per-project ranker. Merge those
// scores without treating identical relative paths in different roots as one.
function compare(a, b) {
  const left = a.ranking ?? {};
  const right = b.ranking ?? {};
  const browsing = (left.tier ?? a.matchTier) === 3 && (right.tier ?? b.matchTier) === 3;
  return (left.tier ?? a.matchTier ?? 1) - (right.tier ?? b.matchTier ?? 1)
    || (right.directSpecificity ?? 0) - (left.directSpecificity ?? 0)
    || (browsing ? (right.recentScore ?? 0) - (left.recentScore ?? 0)
      || (right.frequencyScore ?? 0) - (left.frequencyScore ?? 0) : 0)
    || (right.relevanceBand ?? 0) - (left.relevanceBand ?? 0)
    || Number(right.relationship ?? false) - Number(left.relationship ?? false)
    || ((right.relevanceScore ?? b.score ?? 0) + (right.usageBoost ?? 0))
      - ((left.relevanceScore ?? a.score ?? 0) + (left.usageBoost ?? 0))
    || String(a.projectId).localeCompare(String(b.projectId))
    || String(a.id ?? a.objectId ?? a.insertText ?? '').localeCompare(String(b.id ?? b.objectId ?? b.insertText ?? ''));
}

function tag(value, project, projects = null) {
  if (!value) return value;
  const ownerId = value.projectId ?? value.dependencyCandidate?.projectId ?? value.object?.projectId;
  project = projects?.get(ownerId) ?? project;
  return { ...value, projectId: project.id, projectName: project.name, rootPath: project.rootPath,
    ...(value.object ? { object: tag(value.object, project, projects) } : {}),
    ...(value.dependencyCandidate ? { dependencyCandidate: tag(value.dependencyCandidate, project, projects) } : {}) };
}

function distinctRanked(items, limit) {
  const seen = new Set();
  return items.sort(compare).filter((item) => {
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
      if (!p.active || this.errors.has(p.id)) return false;
      try { return fs.statSync(p.rootPath).isDirectory(); } catch { return false; }
    });
  }

  revision() {
    return this.projects().map((p) => {
      let available = false;
      try { available = fs.statSync(p.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
      return `${p.id}:${Number(p.active)}:${Number(available)}:${p.currentSnapshotId}:${this.errors.get(p.id) ?? ''}`;
    }).join('|');
  }

  state() {
    this.followRenamedRoots();
    const counts = new Map(this.timeline.listProjects().map((p) => [p.id, p.fileCount]));
    const directories = this.projects().map((p) => {
      let available = false;
      try { available = fs.statSync(p.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
      return { ...p, fileCount: counts.get(p.id) ?? 0, available,
        error: this.errors.get(p.id) ?? (available ? null : 'Directory is unavailable.') };
    });
    return { directories, revision: this.revision(),
      activeProjectIds: directories.filter((p) => p.active && p.available && !p.error).map((p) => p.id) };
  }

  async restore() {
    // Reconcile independently, so an unavailable volume cannot prevent other
    // enabled folders from starting. Yield between roots to serve the menu.
    for (const p of this.projects().filter((p) => p.active)) {
      await yieldTurn();
      if (this.closed) return;
      try { this.activate(p.id, systemActor); }
      catch (error) { this.errors.set(p.id, error.message); }
    }
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
        continue;
      }
      // A deleted or ejected folder stays missing; do not list its parent on every call.
      if (Date.now() - (this.renameChecks.get(row.id) ?? 0) < 2_000) continue;
      this.renameChecks.set(row.id, Date.now());
      const files = this.db.prepare(`SELECT path, inode FROM snapshot_files
        WHERE snapshot_id = ? AND inode IS NOT NULL ORDER BY path LIMIT 8`).all(row.current_snapshot_id);
      const holdsFiles = (candidate) => {
        // Atomic saves replace some inodes; unrelated folders share none.
        const matched = files.filter((file) => {
          try { return String(fs.statSync(path.join(candidate, file.path)).ino) === String(file.inode); }
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
    catch (error) { this.errors.set(row.id, error.message); }
  }

  activate(projectId, actor) {
    const project = this.timeline.getProject(projectId);
    if (!fs.statSync(project.rootPath).isDirectory()) throw new HttpError(400, 'The work directory is unavailable.');
    this.timeline.capture(projectId, actor, { source: 'OPEN_RECONCILE' });
    this.dependencies.ensureIndex(projectId);
    this.dependencies.warmPredictionCaches(projectId);
    this.errors.delete(projectId);
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
    return this.enqueue(async () => {
      // Validate every choice before importing, including aliases to one root.
      const roots = [...new Set(rootPaths.map((input) => {
        try {
          const root = fs.realpathSync(normalizeProjectRootPath(input));
          if (!fs.statSync(root).isDirectory()) throw new Error();
          return root;
        } catch { throw new HttpError(400, `Work directory is unavailable: ${input}`); }
      }))];
      for (const root of roots) {
        await yieldTurn();
        if (this.closed) throw new HttpError(503, 'Lasso is shutting down.');
        const imported = this.timeline.importProject(root, actor, { watch: false });
        this.db.prepare('UPDATE projects SET workspace_active = 1, workspace_removed = 0 WHERE id = ?').run(imported.project.id);
        try {
          if (imported.imported) {
            this.dependencies.ensureIndex(imported.project.id);
            this.dependencies.warmPredictionCaches(imported.project.id);
            this.timeline.watchProject(imported.project.id, actor);
            if (this.timeline.config.watchProjects && !this.timeline.watchers.has(imported.project.id)) {
              throw new HttpError(400, 'The work directory could not be watched.');
            }
            this.errors.delete(imported.project.id);
          } else this.activate(imported.project.id, actor);
        } catch (error) {
          this.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(imported.project.id);
          this.timeline.unwatchProject(imported.project.id);
          this.timeline.scanCaches.delete(imported.project.id);
          this.errors.set(imported.project.id, error.message);
          throw new HttpError(400, `Could not add the work directory: ${error.message}`);
        }
      }
      return this.state();
    });
  }

  toggle(projectId, active, actor = systemActor) {
    if (typeof active !== 'boolean') throw new HttpError(400, 'Directory active state must be true or false.');
    return this.enqueue(() => {
      this.timeline.getProject(projectId);
      if (active) {
        if (!this.isActive(projectId) || this.errors.has(projectId)) {
          // Record activation only after a successful reconcile. A failed
          // folder selection must not claim that it is ready for suggestions.
          this.db.prepare('UPDATE projects SET workspace_active = 1 WHERE id = ?').run(projectId);
          try { this.activate(projectId, actor); }
          catch (error) {
            this.db.prepare('UPDATE projects SET workspace_active = 0 WHERE id = ?').run(projectId);
            this.timeline.unwatchProject(projectId);
            this.errors.set(projectId, error.message);
            throw new HttpError(400, `Could not enable the work directory: ${error.message}`);
          }
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
    return this.enqueue(() => {
      this.timeline.getProject(projectId);
      this.db.prepare('UPDATE projects SET workspace_active = 0, workspace_removed = 1 WHERE id = ?').run(projectId);
      this.timeline.unwatchProject(projectId);
      this.timeline.scanCaches.delete(projectId);
      this.errors.delete(projectId);
      this.renameChecks.delete(projectId);
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
    const revision = this.revision();
    const projects = this.activeProjects();
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const owners = new Map();
    const pending = (Array.isArray(input.pendingDependencies) ? input.pendingDependencies.slice(0, 50) : [])
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
    const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
    const availablePending = pending.filter((link) => projectsById.has(owners.get(link.sourceObjectId)));
    let linkedContext = contextProject ? this.dependencies.linkedDependencyContext(contextProject.id, {
      ...input, documentPath: documentProject ? input.documentPath : null,
      pendingDependencies: availablePending,
    }, cursor) : null;
    if (linkedContext && !projectsById.has(this.dependencies.sourceProjectId(linkedContext.source))) linkedContext = null;
    const currentPending = linkedContext
      ? availablePending.filter((link) => link.sourceObjectId === linkedContext.source.id) : availablePending;
    const predictions = [];
    for (const project of projects) {
      await yieldTurn();
      if (this.closed || revision !== this.revision()) throw new HttpError(409, 'Work directories changed. Request fresh suggestions.');
      const ownDocument = input.documentProjectId === project.id;
      const scopedInput = { ...input, documentPath: ownDocument ? input.documentPath : null,
        pendingDependencies: ownDocument ? currentPending : currentPending.filter((s) => owners.get(s.sourceObjectId) === project.id) };
      predictions.push({ project, prediction: this.dependencies.predict(project.id, scopedInput) });
    }
    // An explicitly linked source narrows suggestions to that source's owner.
    const availablePredictions = predictions.filter(({ prediction }) => !prediction.sourceContext?.source
      || projectsById.has(this.dependencies.sourceProjectId(prediction.sourceContext.source)));
    const scoped = availablePredictions.filter(({ prediction }) => prediction.sourceContext?.source
      && (!linkedContext || prediction.sourceContext.source.id === linkedContext.source.id));
    const pool = scoped.length ? scoped : availablePredictions;
    const limit = 12;
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
    const selected = distinctRanked(slots, limit);
    const claims = new Map();
    for (const item of selected.filter((s) => s.group === 'claim')) {
      const key = `${item.claim.start}:${item.claim.end}:${item.claim.type}`;
      if (!claims.has(key)) claims.set(key, { ...item.claim, candidates: [] });
      const { group, claim, ...candidate } = item;
      claims.get(key).candidates.push(candidate);
    }
    // Directories may match different suffixes of the same phrase ("net inc"
    // and "inc"). The longer match is the one the writer is typing.
    for (const [key, claim] of claims) {
      if (claim.type !== 'STUDY_VARIABLE') continue;
      const nested = [...claims.values()].some((other) => other !== claim && other.type === 'STUDY_VARIABLE'
        && other.start <= claim.start && other.end >= claim.end && other.end - other.start > claim.end - claim.start);
      if (nested) claims.delete(key);
    }
    const strip = ({ group, claim, ...value }) => value;
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
  activity() {
    const projects = this.activeProjects();
    const changes = projects.flatMap(project => this.terminal.graph.valueChanges(project.id, { limit: 8, ownSourcesOnly: true })
      .map(change => ({ ...change, projectId: project.id, projectName: project.name })));
    changes.sort((a, b) => String(b.changedAt).localeCompare(String(a.changedAt))
      || b.toVersion - a.toVersion || a.objectId.localeCompare(b.objectId));
    const session = this.terminalSession();
    const references = new Map();
    for (const project of projects) for (const dependency of this.dependencies.currentDependencies(project.id)) {
      const counts = references.get(dependency.source.id) ?? { referenceCount: 0, unresolvedReferences: 0 };
      counts.referenceCount += 1;
      if (!['LINKED', 'PREDICTED'].includes(dependency.status)) counts.unresolvedReferences += 1;
      references.set(dependency.source.id, counts);
    }
    const unavailable = this.state().directories.filter(directory => directory.active
      && (!directory.available || directory.error)).length;
    return { directories: projects.length, files: session.files, stale: session.stale,
      failures: session.failures + unavailable, changes: changes.slice(0, 8).map(change => ({ ...change,
        ...(references.get(change.objectId) ?? { referenceCount: 0, unresolvedReferences: 0 }) })) };
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
