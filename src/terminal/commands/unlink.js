// unlink — retire references that should no longer be linked.
//
// Removal is a recorded revision, not a deletion: the dependency keeps its
// history and simply stops being a link. Nothing is retired until `--apply`.

import { ACTION, blank, dim, failure, group, result, resultItem, text } from '../result.js';
import { plural, requireObject } from './shared.js';

function describe(entry) {
  return [
    { text: `"${entry.spanText}"`, tone: 'dim' },
    entry.reason ? { text: entry.reason, tone: 'warn' } : null,
  ].filter(Boolean);
}

export function unlinkCommand(context, command) {
  const name = command.args.join(' ').trim();
  const unresolvedOnly = command.flags.unresolved === true;

  if (!name && !unresolvedOnly) {
    return failure('unlink', 'unlink needs a dependency name, or --unresolved.', {
      hints: [
        'unlink --unresolved   retires claims the document no longer holds',
        'unlink office-supplies   retires every reference to one source',
      ],
    });
  }

  let objectId = null;
  let headline = 'claims the document no longer holds';
  if (name) {
    const resolved = requireObject(context, 'unlink', name);
    if (resolved.response) return resolved.response;
    objectId = resolved.object.id;
    headline = resolved.object.name;
  }

  const targets = context.dependencies.currentDependencies(context.projectId)
    .filter((dependency) => !objectId || dependency.source.id === objectId)
    .filter((dependency) => !unresolvedOnly || Boolean(dependency.statusDetails?.anchorIssue))
    .map((dependency) => ({
      dependencyId: dependency.id,
      documentPath: dependency.documentPath,
      spanText: dependency.spanText,
      status: dependency.status,
      reason: dependency.statusDetails?.anchorIssue ?? null,
    }));

  if (!targets.length) {
    return result('unlink', {
      headline: unresolvedOnly ? 'Every linked claim still resolves' : `Nothing references ${headline}`,
      blocks: [dim(unresolvedOnly
        ? 'No claim has lost the text it was linked to.'
        : 'There is nothing to retire.')],
      data: { removed: [] },
    });
  }

  if (command.flags.apply !== true) {
    return result('unlink', {
      headline: `${plural(targets.length, 'reference')} would be retired`,
      subhead: unresolvedOnly ? 'claims the document no longer holds' : headline,
      blocks: [
        ...targets.map((entry) => group(entry.documentPath, describe(entry))),
        blank(),
        text('Nothing has been retired.', 'warn'),
      ],
      results: targets.map((entry) => resultItem({
        title: entry.documentPath,
        lines: [`"${entry.spanText}"`, entry.reason ?? entry.status.toLowerCase().replace('_', ' ')],
        tone: 'warn',
        ref: { kind: 'dependency', dependencyId: entry.dependencyId, objectId, name: headline },
        actions: [ACTION.inspect],
      })),
      hints: [`\`unlink ${unresolvedOnly ? '--unresolved' : headline} --apply\` retires them.`],
      data: { targets },
    });
  }

  const removed = context.dependencies.removeReferences(context.projectId, {
    objectId,
    unresolvedOnly,
  }, context.actor);

  return result('unlink', {
    headline: `${plural(removed.removed.length, 'reference')} retired`,
    subhead: unresolvedOnly ? 'claims the document no longer held' : headline,
    blocks: [
      ...removed.removed.map((entry) => group(entry.documentPath, describe(entry))),
      blank(),
      dim('Their history is kept; they are no longer links.'),
    ],
    data: removed,
  });
}
