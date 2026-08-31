// find — search the indexed workspace.

import { parseDuration } from '../parser.js';
import { ACTION, dim, failure, result, text } from '../result.js';
import { objectResult, plural } from './shared.js';

export function findCommand(context, command) {
  const query = command.args.join(' ').trim();
  const flags = command.flags;

  if (!query && !Object.keys(flags).length) {
    return failure('find', 'find needs something to look for.', {
      hints: ['find revenue', 'find revenue --source xlsx', 'find depreciation --directory Finance'],
    });
  }

  const updatedWithinMs = flags.updated ? parseDuration(flags.updated) : null;
  if (flags.updated && updatedWithinMs == null) {
    return failure('find', `--updated ${flags.updated} is not a duration. Use a form such as 30d, 24h or 7d.`);
  }

  const matches = context.graph.search(context.projectId, query, {
    directory: typeof flags.directory === 'string' ? flags.directory : null,
    sourceType: typeof flags.source === 'string' ? flags.source : null,
    pathFragment: typeof flags.path === 'string' ? flags.path : null,
    updatedWithinMs,
    includeContainers: flags.all === true,
    limit: Number(flags.limit) || 25,
  });

  const filters = [
    flags.source ? `source ${flags.source}` : null,
    flags.directory ? `directory ${flags.directory}` : null,
    flags.updated ? `updated within ${flags.updated}` : null,
    flags.path ? `path contains ${flags.path}` : null,
  ].filter(Boolean);

  if (!matches.length) {
    return result('find', {
      headline: 'No matches',
      subhead: filters.length ? filters.join(' · ') : null,
      blocks: [dim(query ? `Nothing indexed in this workspace matches ${query}.` : 'No indexed sources match those filters.')],
      hints: ['`index status` shows what is currently indexed.'],
    });
  }

  const exact = matches.filter((match) => match.matchKind === 'exact').length;
  const namedSource = matches.every((match) => match.matchKind === 'source');
  return result('find', {
    headline: plural(matches.length, 'match', 'matches'),
    subhead: namedSource ? `everything indexed from ${query}` : filters.length ? filters.join(' · ') : null,
    blocks: exact > 1 ? [text(`${exact} sources share the name ${query}. \`conflicts ${query}\` compares them.`, 'warn')] : [],
    results: matches.map(({ object, matchKind }) => objectResult(object, {
      graph: context.graph,
      projectId: context.projectId,
      // `exact` and `source` are what the query already said; only a looser
      // kind of match is worth labelling.
      badge: ['exact', 'source'].includes(matchKind) ? null : matchKind,
    })),
    actions: [ACTION.inspect, ACTION.impact],
    data: { query, filters },
  });
}
