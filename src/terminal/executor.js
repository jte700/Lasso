// TerminalCommandExecutor.
//
// Parses a line, dispatches it to a registered command, and hands that command
// the application services. Commands never touch the database or the file
// system directly — everything they do goes through the timeline, the
// predictive-provenance service, or the small terminal services beside them.

import { HttpError } from '../history/errors.js';
import { TerminalCommandRegistry } from './registry.js';
import { completionContext, parseCommand } from './parser.js';

// What the completion box calls each kind of thing it offers.
const HEADINGS = {
  name: 'dependency',
  nameOrPath: 'source or dependency',
  path: 'path',
  directory: 'directory',
  sourceType: 'source type',
  address: 'source address',
  duration: 'when',
  alias: 'alias',
};

// The time vocabulary the parser understands, offered rather than guessed at.
const DURATIONS = [
  { value: 'yesterday', detail: 'since the start of yesterday' },
  { value: 'today', detail: 'since midnight' },
  { value: '24h', detail: 'the last day' },
  { value: '7d', detail: 'the last week' },
  { value: '30d', detail: 'the last month' },
];
import { failure, result, text, dim, blank } from './result.js';
import { helpCommand } from './commands/help.js';
import { OUT_OF_SCOPE } from './commands/ask.js';

export class TerminalCommandExecutor {
  constructor({ timeline, dependencies, objectShares, graph, aliases, rules, indexing, registry = new TerminalCommandRegistry() }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.objectShares = objectShares;
    this.graph = graph;
    this.aliases = aliases;
    this.rules = rules;
    this.indexing = indexing;
    this.registry = registry;
  }

  context(projectId, actor, options = {}) {
    return {
      projectId,
      actor,
      timeline: this.timeline,
      dependencies: this.dependencies,
      objectShares: this.objectShares,
      graph: this.graph,
      aliases: this.aliases,
      rules: this.rules,
      indexing: this.indexing,
      registry: this.registry,
      documentPath: options.documentPath ?? null,
      writingContext: options.context ?? null,
    };
  }

  /** The banner the terminal opens with: what is indexed, and what needs review. */
  banner(projectId) {
    const status = this.indexing.status(projectId);
    const changes = this.graph.valueChanges(projectId, { limit: 50 });
    const stale = this.graph.staleDependencies(projectId, { reconcile: false });
    const conflicts = this.graph.conflicts(projectId).filter((conflict) => !conflict.resolved);
    return {
      project: { id: status.project.id, name: status.project.name, rootPath: status.project.rootPath },
      directories: status.workspace.directories,
      files: status.project.files,
      dependencies: status.project.dependencies,
      version: status.project.version,
      changes: changes.length,
      stale: stale.length,
      conflicts: conflicts.length,
      failures: status.failures.length,
      commands: this.registry.names(),
    };
  }

  /**
   * Runs one line. Errors from the services are returned as failed results
   * rather than thrown, because a terminal reports a refusal in the transcript
   * rather than losing the session to it.
   */
  run(projectId, input, actor, options = {}) {
    const first = String(input ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const command = parseCommand(input, this.registry.booleanFlags(first));
    if (command.empty) return result('', { headline: null, blocks: [] });

    if (command.name === '?' || command.name === 'help') {
      return helpCommand(this.context(projectId, actor, options), command);
    }
    if (command.name === 'clear') return { ...result('clear', {}), clear: true };

    const definition = this.registry.get(command.name);
    if (!definition) return this.unknown(projectId, command);

    if (!projectId) {
      return failure(command.name, 'No directory is selected.', {
        hints: ['Choose one in the sidebar, or run `index add <path>` once a workspace exists.'],
      });
    }

    try {
      return definition.run(this.context(projectId, actor, options), command);
    } catch (error) {
      if (error instanceof HttpError || Number.isInteger(error?.status)) {
        return failure(command.name, error.message, { hints: error.details ? [String(error.details)] : [] });
      }
      throw error;
    }
  }

  /**
   * An unknown first word. A question typed straight at the prompt is treated
   * as `ask`; anything else is refused with what this terminal is for, rather
   * than answered generally.
   */
  unknown(projectId, command) {
    const looksLikeQuestion = /\?$/.test(command.raw) || /^(which|what|where|when|who|how|why|is|are|does|did)\b/i.test(command.raw);
    if (looksLikeQuestion && projectId) {
      const ask = this.registry.get('ask');
      return ask.run(this.context(projectId, null), { ...command, name: 'ask', rest: command.raw, args: [] });
    }
    const close = this.registry.names().filter((name) => name.startsWith(command.name.slice(0, 2)));
    return {
      ...failure(command.name, `${command.name} is not a command in this terminal.`),
      blocks: [
        text(OUT_OF_SCOPE),
        blank(),
        dim(`Commands: ${this.registry.names().join('  ')}`),
      ],
      hints: close.length ? [`Did you mean ${close.join(' or ')}?`] : ['`?` lists everything.'],
    };
  }

  /**
   * Completion for a partially typed line. What is offered comes from the
   * registry: command names at the start, then whatever that command's next
   * argument or flag value is — a dependency name, an indexed file, a
   * directory, a duration.
   */
  complete(projectId, input, options = {}) {
    const first = String(input ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    const context = completionContext(input, this.registry.booleanFlags(first));
    const empty = { position: context.position, heading: null, fragment: context.fragment, suggestions: [] };

    if (context.position === 'command') {
      const fragment = context.fragment.toLowerCase();
      return {
        position: 'command',
        heading: 'command',
        fragment: context.fragment,
        suggestions: this.registry.list()
          .filter((command) => command.name.startsWith(fragment))
          .map((command) => ({ value: command.name, kind: 'command', detail: command.summary, preview: null })),
      };
    }

    const definition = this.registry.get(context.command);
    if (!definition) return empty;

    if (context.position === 'flag') {
      const fragment = context.fragment.toLowerCase();
      return {
        position: 'flag',
        heading: `${definition.name} flag`,
        fragment: context.fragment,
        suggestions: Object.keys(definition.flags)
          .filter((flag) => flag.startsWith(fragment))
          .map((flag) => ({ value: `--${flag}`, kind: 'flag', detail: null, preview: null })),
      };
    }

    if (!projectId) return empty;

    if (context.position === 'flagValue') {
      const kind = definition.flags[context.flag];
      if (!kind) return empty;
      return {
        position: 'flagValue',
        heading: `--${context.flag}`,
        fragment: context.fragment,
        suggestions: this.suggestionsOfKind(projectId, kind, context.fragment, options),
      };
    }

    // Each command declares what its arguments are, in order. Anything past
    // the last declared one is free text and completes nothing.
    const kind = (definition.arguments ?? [])[context.argIndex] ?? null;
    if (!kind) return empty;

    if (kind === 'subcommand') {
      const fragment = context.fragment.toLowerCase();
      return {
        position: 'subcommand',
        heading: `${definition.name} subcommand`,
        fragment: context.fragment,
        suggestions: (definition.subcommands ?? [])
          .filter((name) => name.startsWith(fragment))
          .map((name) => ({ value: name, kind: 'subcommand', detail: null, preview: null })),
      };
    }

    return {
      position: 'argument',
      heading: HEADINGS[kind] ?? 'dependency',
      fragment: context.fragment,
      suggestions: this.suggestionsOfKind(projectId, kind, context.fragment, options),
    };
  }

  /** One kind of thing the index can complete. */
  suggestionsOfKind(projectId, kind, fragment, options = {}) {
    const explicitSearch = options.surface === 'search';
    const suggestionLimit = explicitSearch ? 14 : 5;
    const rankingOptions = {
      ...options,
      minimumScore: explicitSearch || !String(fragment ?? '').trim() ? 0 : 0.8,
    };
    const shape = (suggestion) => ({
      value: suggestion.name,
      kind: suggestion.kind,
      detail: suggestion.detail,
      preview: suggestion.value ?? null,
      ...(suggestion.objectId ? { objectId: suggestion.objectId } : {}),
      ...(suggestion.objectKey ? { objectKey: suggestion.objectKey } : {}),
      ...(suggestion.path ? { path: suggestion.path } : {}),
      ...(suggestion.ranking ? { ranking: suggestion.ranking, reason: suggestion.ranking.reason } : {}),
    });

    switch (kind) {
      case 'name': return this.graph.nameSuggestions(projectId, fragment, suggestionLimit, rankingOptions).map(shape);

      case 'nameOrPath': {
        const files = this.graph.sourceSuggestions(projectId, fragment, suggestionLimit, rankingOptions);
        // With no query, browsing starts at the file level. This also avoids
        // offering several cells from one recently used spreadsheet.
        if (!String(fragment ?? '').trim()) return files.map(shape);
        const names = this.graph.nameSuggestions(projectId, fragment, suggestionLimit, rankingOptions);
        // Once a whole file name has been typed, that file is the answer —
        // listing everything inside it as "related" would bury it.
        const named = String(fragment ?? '').toLowerCase();
        const complete = named && files.some((file) => file.name.toLowerCase() === named
          || file.name.toLowerCase().endsWith(`/${named}`));
        return this.graph.rankRecommendations(projectId,
          [...files, ...(complete ? names.filter((item) => item.kind !== 'related') : names)],
          { ...rankingOptions, query: fragment, limit: suggestionLimit, diversify: true, maxPerFile: 2 }).map(shape);
      }

      case 'path': {
        const directories = this.graph.directorySuggestions(projectId, fragment, 6).map(shape);
        const files = this.graph.sourceSuggestions(projectId, fragment, suggestionLimit, rankingOptions).map(shape);
        return [...directories, ...files].slice(0, suggestionLimit);
      }

      case 'directory': return this.graph.directorySuggestions(projectId, fragment).map(shape);
      case 'sourceType': return this.graph.sourceTypeSuggestions(projectId, fragment).map(shape);
      case 'address': return this.graph.addressSuggestions(projectId, fragment, suggestionLimit, rankingOptions).map(shape);

      case 'duration': return DURATIONS
        .filter((entry) => !fragment || entry.value.startsWith(fragment.toLowerCase()))
        .map((entry) => ({ value: entry.value, kind: 'when', detail: entry.detail, preview: null }));

      case 'alias': {
        const wanted = String(fragment ?? '').toLowerCase();
        return this.graph.nameSuggestions(projectId, fragment, Number.MAX_SAFE_INTEGER, { ...rankingOptions, diversify: false })
          .filter((entry) => entry.kind === 'alias' && entry.name.startsWith(wanted)).slice(0, suggestionLimit).map(shape);
      }

      case 'aliasName':
      default: return [];
    }
  }

  /** A source preview for the highlighted result. */
  previewSource(projectId, reference) {
    if (!reference) return null;
    if (reference.kind === 'dependency' && reference.dependencyId) {
      const dependency = this.dependencies.getDependency(reference.dependencyId);
      return this.graph.objectById(projectId, dependency.source.id, dependency.source.snapshotId);
    }
    const objectId = reference.objectId
      ?? (reference.objectKey ? this.graph.objectByKey(projectId, reference.objectKey)?.id : null);
    if (!objectId) return null;
    const object = this.graph.objectById(projectId, objectId);
    return object;
  }

  preview(projectId, reference) {
    const object = this.previewSource(projectId, reference);
    return object ? this.graph.preview(projectId, object) : null;
  }

  /**
   * Runs the enabled rules against the changes recorded by a capture. Called
   * after every capture, so the terminal and the editor read the same flags.
   */
  evaluateRules(projectId, capture = null) {
    if (!this.rules.list(projectId, { enabledOnly: true })
      .some((rule) => rule.action.kind !== 'EXCLUDE_FROM_AUTOCOMPLETE')) return [];
    if (capture && !capture.event?.previousSnapshotId) return [];
    const changes = this.graph.valueChanges(projectId, {
      limit: 200,
      ...(capture ? {
        snapshotId: capture.snapshot.id,
        previousSnapshotId: capture.event.previousSnapshotId,
      } : {}),
    });
    if (!changes.length) return [];
    const shares = this.graph.shares(projectId, { status: 'active' });
    return this.rules.evaluate(projectId, { changes, shares });
  }
}
