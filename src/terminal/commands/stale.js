// stale — dependencies whose document no longer agrees with its source.

import { ACTION, blank, dim, group, result, resultItem, text } from '../result.js';
import { plural } from './shared.js';

export function staleCommand(context, command) {
  const entries = context.graph.staleDependencies(context.projectId, {
    reconcile: command.flags.reconcile !== false,
  });

  if (!entries.length) {
    return result('stale', {
      headline: 'No stale dependencies',
      blocks: [dim('Every linked reference matches the value at its recorded source location.')],
      data: { stale: [] },
    });
  }

  const blocks = [];
  for (const entry of entries) {
    const rows = [];
    if (entry.reason === 'source file moved') {
      rows.push({ text: 'source file moved', tone: 'warn' });
      rows.push({ text: `previous source  ${entry.previousPath}`, tone: 'dim' });
      rows.push({ text: `current source   ${entry.path}`, tone: 'dim' });
    } else if (entry.reason === 'source no longer resolves') {
      rows.push({ text: 'source no longer resolves', tone: 'warn' });
      rows.push({ text: `previous source  ${entry.previousPath}`, tone: 'dim' });
    } else if (entry.documentValue != null && entry.sourceValue != null
      && entry.documentValue !== entry.sourceValue) {
      rows.push({ text: `document value   ${entry.documentValue}`, tone: 'normal' });
      rows.push({ text: `source value     ${entry.sourceValue}`, tone: 'normal' });
      rows.push({ text: [entry.path, entry.locator].filter(Boolean).join('  '), tone: 'dim' });
    } else {
      // The values agree, so the value is not what is wrong. Printing them
      // side by side here would suggest a mismatch that does not exist.
      rows.push({ text: entry.reason ?? 'source cannot be verified', tone: 'warn' });
      rows.push({ text: [entry.path, entry.locator].filter(Boolean).join('  '), tone: 'dim' });
    }
    rows.push({ text: `references       ${entry.referenceCount}`, tone: 'dim' });
    blocks.push(group(`! ${entry.name}`, rows));
  }

  const total = entries.reduce((sum, entry) => sum + entry.referenceCount, 0);
  blocks.push(blank(), text(`${plural(total, 'document reference')} still carries an older value.`, 'dim'));

  return result('stale', {
    headline: `${plural(entries.length, 'stale dependency', 'stale dependencies')}`,
    blocks,
    results: entries.map((entry) => resultItem({
      title: entry.name,
      lines: [
        entry.reason,
        entry.reason === 'source file moved' || entry.reason === 'source no longer resolves'
          ? `previous source  ${entry.previousPath}`
          : entry.documentValue !== entry.sourceValue
            ? `document ${entry.documentValue ?? '—'}  →  source ${entry.sourceValue ?? '—'}`
            : [entry.path, entry.locator].filter(Boolean).join('  '),
        `${plural(entry.referenceCount, 'reference')} in ${plural(new Set(entry.references.map((reference) => reference.documentPath)).size, 'document')}`,
      ],
      value: entry.sourceValue,
      tone: 'warn',
      ref: { kind: 'object', objectId: entry.objectId, objectKey: entry.objectKey, name: entry.name, path: entry.path },
      actions: [ACTION.updateOne, ACTION.inspect, ACTION.keep],
    })),
    actions: [ACTION.updateOne, ACTION.inspect, ACTION.keep],
    hints: ['Nothing is rewritten until you run `update <dependency>`.'],
    data: { stale: entries },
  });
}
