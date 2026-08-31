// history — every recorded value of a dependency, newest first.

import { parseSince } from '../parser.js';
import { ACTION, blank, dim, failure, fields, result, resultItem, text } from '../result.js';
import { formatDay, formatMoment, plural, requireObject } from './shared.js';

function timeColumn(entry) {
  const date = new Date(entry.recordedAt);
  if (Number.isNaN(date.getTime())) return '—';
  return `${formatDay(entry.recordedAt)} ${date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

export function historyCommand(context, command) {
  const name = command.args.join(' ').trim();
  if (!name) {
    return failure('history', 'history needs a dependency name.', { hints: ['history depreciation-direct'] });
  }

  const resolved = requireObject(context, 'history', name);
  if (resolved.response) return resolved.response;

  const versions = context.graph.history(context.projectId, resolved.object.id);
  if (!versions.length) {
    return result('history', {
      headline: resolved.object.name,
      blocks: [dim('No recorded versions. The source has only been indexed once.')],
      data: { versions: [] },
    });
  }

  // `--at "Aug 19"` inspects one recorded state rather than listing them all.
  if (command.flags.at) {
    const instant = parseSince(command.flags.at) ?? Date.parse(`${command.flags.at} ${new Date(versions[0].recordedAt).getFullYear()}`);
    if (!Number.isFinite(instant)) {
      return failure('history', `--at ${command.flags.at} is not a date this terminal understands.`);
    }
    const state = context.graph.historyAt(context.projectId, resolved.object.id, instant);
    if (!state) {
      return failure('history', `${resolved.object.name} has no recorded state at or before ${command.flags.at}.`, {
        hints: [`Earliest recorded version: ${formatMoment(versions.at(-1).recordedAt)}`],
      });
    }
    return result('history', {
      headline: `${resolved.object.name} at ${formatMoment(state.recordedAt)}`,
      blocks: [
        fields([
          ['value', state.value],
          ['source file', state.path],
          ['source location', state.locator],
          ['recorded', formatMoment(state.recordedAt)],
          ['source updated', formatMoment(state.sourceUpdatedAt)],
          ['project version', String(state.projectVersion)],
          ['document references', String(state.referenceCount)],
          state.shared ? ['shared', 'this version was shared externally'] : null,
        ]),
      ],
      data: { state },
    });
  }

  const blocks = [{
    kind: 'table',
    columns: ['when', 'value', 'source', 'references'],
    rows: versions.map((entry) => [
      timeColumn(entry),
      entry.value ?? '—',
      [entry.fileName, entry.locator].filter(Boolean).join(' · '),
      String(entry.referenceCount),
    ]),
  }];

  const shared = versions.filter((entry) => entry.shared);
  if (shared.length) {
    blocks.push(blank(), text('shared externally'));
    for (const entry of shared) {
      blocks.push(dim(`  ${timeColumn(entry)}   ${entry.value ?? '—'}   ${plural(context.graph.sharesForObject(context.projectId, resolved.object.id).filter((share) => share.sharedValue === entry.value).length, 'link')}`));
    }
  }

  return result('history', {
    headline: resolved.object.name,
    subhead: `${plural(versions.length, 'recorded version')} · ${resolved.object.path}`,
    blocks,
    results: versions.map((entry) => resultItem({
      title: timeColumn(entry),
      lines: [
        entry.path,
        entry.locator || null,
        `${plural(entry.referenceCount, 'document reference')} at this version`,
        entry.shared ? 'shared externally at this version' : null,
      ],
      value: entry.value,
      badge: entry.shared ? 'shared' : null,
      ref: {
        kind: 'objectVersion',
        objectId: resolved.object.id,
        versionId: entry.versionId,
        snapshotId: entry.snapshotId,
        name: resolved.object.name,
      },
      actions: [ACTION.inspect],
    })),
    actions: [ACTION.inspect],
    hints: [`\`history ${resolved.object.name} --at "${formatDay(versions.at(-1).recordedAt)}"\` inspects one recorded state.`],
    data: { versions },
  });
}
