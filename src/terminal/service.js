// Assembles the terminal layer over the services the application already has.
//
// Nothing here owns a second copy of the dependency graph. The graph view, the
// alias store, the rule store and the index controls all read and write the
// same tables the editor uses.

import { DependencyGraph } from './graph.js';
import { AliasService } from './aliases.js';
import { RuleService } from './rules.js';
import { IndexControlService } from './indexing.js';
import { TerminalCommandExecutor } from './executor.js';
import { TerminalCommandRegistry } from './registry.js';

export function createTerminal({ timeline, dependencies, objectShares }) {
  const db = timeline.db;
  const aliases = new AliasService(db, timeline);
  const rules = new RuleService(db, timeline);
  const indexing = new IndexControlService(db, timeline, dependencies);
  const graph = new DependencyGraph({ timeline, dependencies, objectShares, aliases });
  const registry = new TerminalCommandRegistry();
  const executor = new TerminalCommandExecutor({
    timeline, dependencies, objectShares, graph, aliases, rules, indexing, registry,
  });

  // Rules are evaluated where changes are recorded, not where they are read,
  // so the editor sees a flag as soon as the terminal would.
  const unsubscribe = timeline.onCapture((capture) => {
    if (!capture?.changed || !capture.projectId) return;
    try {
      // Preserve each recorded object version for later history queries, even
      // when the project has no rules or linked manuscript dependencies.
      dependencies.ensureIndex(capture.projectId);
      executor.evaluateRules(capture.projectId, capture);
    } catch (error) {
      console.error('Rule evaluation failed:', error.message);
    }
  });

  // The editor's suggestion ranking consults these, so an `exclude from
  // autocomplete` rule affects both surfaces.
  dependencies.suppressedPathPrefixes = (projectId) => rules.suppressedPathPrefixes(projectId);
  dependencies.aliasesForProject = (projectId) => aliases.list(projectId);

  return {
    graph,
    aliases,
    rules,
    indexing,
    registry,
    executor,
    close() {
      unsubscribe();
      graph.close();
    },
  };
}
