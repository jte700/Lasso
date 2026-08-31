// changes — what moved since a point in time.
//
// Values come from the immutable object-version history, so every change is
// attributable to the snapshot that recorded it.

import { parseSince } from '../parser.js';
import { ACTION, blank, dim, failure, group, result, resultItem, text } from '../result.js';
import { formatMoment, plural } from './shared.js';

export function changesCommand(context, command) {
  const flags = command.flags;
  const sinceFlag = flags.since ?? (command.args.length ? command.args.join(' ') : null);
  const since = sinceFlag ? parseSince(sinceFlag) : null;
  if (sinceFlag && since == null) {
    return failure('changes', `--since ${sinceFlag} is not a time. Use yesterday, today, 7d, 24h or a date.`);
  }

  const changes = context.graph.valueChanges(context.projectId, {
    since,
    sourcePrefix: typeof flags.source === 'string' ? flags.source : null,
    unresolvedOnly: flags.unresolved === true,
    limit: Number(flags.limit) || 100,
  });

  const filters = [
    sinceFlag ? `since ${sinceFlag}` : null,
    flags.source ? `source ${flags.source}` : null,
    flags.unresolved ? 'with unresolved references' : null,
  ].filter(Boolean);

  if (!changes.length) {
    return result('changes', {
      headline: 'No dependency values changed',
      subhead: filters.length ? filters.join(' · ') : null,
      blocks: [dim(since
        ? 'Nothing indexed in this workspace changed in that window.'
        : 'Every indexed value matches the value recorded at the previous version.')],
      data: { changes: [] },
    });
  }

  const affected = changes.reduce((sum, change) => sum + change.referenceCount, 0);
  const blocks = [];
  for (const change of changes.slice(0, 20)) {
    const rows = [{
      text: change.moved
        ? `moved  ${change.previousPath} → ${change.path}`
        : `${change.previousValue ?? '—'} → ${change.currentValue ?? '—'}`,
      tone: change.unresolvedReferences ? 'warn' : 'normal',
    }, {
      text: [change.fileName, change.locator].filter(Boolean).join(' · '),
      tone: 'dim',
    }];
    if (change.referenceCount) {
      rows.push({
        text: `${plural(change.referenceCount, 'reference')} affected${change.unresolvedReferences ? ` · ${change.unresolvedReferences} not yet updated` : ''}`,
        tone: change.unresolvedReferences ? 'warn' : 'dim',
      });
    }
    blocks.push(group(change.name, rows, formatMoment(change.changedAt)));
  }
  if (changes.length > 20) blocks.push(blank(), dim(`${changes.length - 20} further changes not shown — narrow with --since or --source.`));
  if (affected) blocks.push(blank(), text(`${plural(affected, 'document reference')} across ${plural(new Set(changes.flatMap((change) => context.graph.referencesTo(context.projectId, change.objectId).map((reference) => reference.documentPath))).size, 'document')}.`, 'dim'));

  return result('changes', {
    headline: `${plural(changes.length, 'dependency value', 'dependency values')} changed`,
    subhead: filters.length ? filters.join(' · ') : null,
    blocks,
    results: changes.map((change) => resultItem({
      title: change.name,
      lines: [
        change.moved ? `${change.previousPath} → ${change.path}` : `${change.previousValue ?? '—'} → ${change.currentValue ?? '—'}`,
        [change.fileName, change.locator].filter(Boolean).join(' · '),
        change.referenceCount ? `${plural(change.referenceCount, 'reference')} affected` : null,
        `version ${change.fromVersion} → ${change.toVersion} · ${formatMoment(change.changedAt)}`,
      ],
      value: change.currentValue,
      tone: change.unresolvedReferences ? 'warn' : 'normal',
      ref: { kind: 'object', objectId: change.objectId, objectKey: change.objectKey, name: change.name, path: change.path },
      actions: [ACTION.inspect, ACTION.updateOne, ACTION.keep],
    })),
    actions: [ACTION.inspect, ACTION.inspectSource, ACTION.update, ACTION.keep],
    hints: ['[Enter] reviews everything affected by the selected change.'],
    data: { changes },
  });
}
