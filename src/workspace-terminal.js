// The workspace's terminal: commands run across every active folder, their
// completions and previews, and which sources were used recently. Installed on
// WorkspaceService by workspace.js.

import { HttpError } from './history/errors.js';
import { parseCommand } from './terminal/parser.js';
import { failure, result, text, blank, dim } from './terminal/result.js';
import { tag, distinctRanked } from './workspace-ranking.js';

export const workspaceTerminalMethods = {
  terminalSession() {
    const sessions = this.activeProjects().map((p) => this.terminal.executor.banner(p.id));
    const sum = (key) => sessions.reduce((total, session) => total + (session[key] ?? 0), 0);
    return { project: { id: 'workspace', name: 'Work directories', rootPath: `${sessions.length} enabled folders` },
      directories: sessions.length, files: sum('files'), dependencies: sum('dependencies'),
      changes: sum('changes'), stale: sum('stale'), conflicts: sum('conflicts'), failures: sum('failures'),
      version: null, commands: this.terminal.registry.names(), projects: sessions };
  },

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
  },

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
  },

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
  },

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
    if (answers.length === 1) {
      const { answer, project } = answers[0];
      return answer?.then ? answer.then(value => this.tagTerminal(value, project)) : this.tagTerminal(answer, project);
    }
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
  },

  mergeTerminal(command, answers) {
    return { ...result(command.name), ok: answers.some((a) => a.answer.ok),
      headline: `${command.name} · ${answers.length} work directories`,
      blocks: answers.flatMap(({ project, answer }) => [text(`${project.name} · ${project.rootPath}`),
        ...(answer.headline ? [text(answer.headline, answer.ok ? 'normal' : 'warn')] : []), ...answer.blocks, blank()]),
      results: answers.flatMap(({ project, answer }) => this.tagTerminal(answer, project).results),
      actions: [...new Map(answers.flatMap(({ answer }) => answer.actions).map((a) => [a.key, a])).values()],
      hints: [...new Set(answers.flatMap(({ answer }) => answer.hints))],
      data: { projects: answers.map(({ project, answer }) => ({ projectId: project.id, ...answer.data })) } };
  },

  tagTerminal(answer, project) {
    return { ...answer, projectId: project.id, results: answer.results.map((item) => ({ ...item,
      lines: [project.name, ...item.lines], ref: { ...item.ref, projectId: project.id } })) };
  },

  terminalPreview(reference) {
    if (!reference?.projectId) throw new HttpError(400, 'Choose a source with its work directory.');
    this.requireActive(reference.projectId);
    return this.terminal.executor.preview(reference.projectId, reference);
  },

  close() { this.closed = true; }
};
