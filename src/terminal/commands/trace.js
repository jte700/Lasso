// trace — where a dependency came from, and where it is used.
//
// Everything printed here is read from the recorded source location. When a
// fact is not recorded, the field says so rather than being described loosely.

import { ACTION, blank, dim, failure, fields, group, result, resultItem, text } from '../result.js';
import { formatMoment, plural, requireObject } from './shared.js';

export function traceCommand(context, command) {
  const name = command.args.join(' ').trim();
  if (!name) {
    return failure('trace', 'trace needs a dependency name.', {
      hints: ['trace office-supplies', '`find` locates a dependency by value or source.'],
    });
  }

  const resolved = requireObject(context, 'trace', name, {
    directory: typeof command.flags.directory === 'string' ? command.flags.directory : null,
  });
  if (resolved.response) return resolved.response;

  const traced = context.graph.trace(context.projectId, resolved.object);
  const documents = context.graph.referencesByDocument(context.projectId, resolved.object.id);
  const activeShares = traced.shares.filter((share) => share.status === 'active');
  const staleReferences = traced.references.filter((reference) => reference.status !== 'LINKED');

  const blocks = [
    fields([
      ['value', traced.value],
      traced.units ? ['units', traced.units] : null,
      ['source', traced.path],
      traced.sheet ? ['sheet', traced.sheet] : null,
      traced.locator ? ['location', traced.locator] : null,
      ['updated', formatMoment(traced.updatedAt)],
      ['indexed', formatMoment(traced.indexedAt)],
      ['version', `project version ${traced.projectVersion}`],
      traced.alias ? ['alias', traced.alias] : null,
      traced.definition ? ['definition', traced.definition] : null,
    ]),
  ];

  if (traced.origin?.path) {
    blocks.push(blank(), fields([['produced by', [traced.origin.path, traced.origin.anchor?.line ? `line ${traced.origin.anchor.line}` : null].filter(Boolean).join('  ')]]));
  }

  blocks.push(blank());
  if (documents.length) {
    blocks.push(text('referenced by'));
    for (const document of documents) {
      const stale = document.references.filter((reference) => reference.status !== 'LINKED').length;
      blocks.push(group(document.documentPath, document.references.map((reference) => ({
        text: reference.spanText,
        meta: reference.status === 'LINKED' ? null : reference.status.toLowerCase().replace('_', ' '),
        tone: reference.status === 'LINKED' ? 'dim' : 'warn',
      })), `${plural(document.references.length, 'reference')}${stale ? ` · ${stale} stale` : ''}`));
    }
  } else {
    blocks.push(dim('referenced by  nothing yet'));
  }

  if (traced.shares.length) {
    blocks.push(blank(), text('shared'));
    for (const share of traced.shares) {
      blocks.push(group(share.target, [{
        text: `${share.status}${share.drifted ? ' · shared value differs from current source' : ''}`,
        tone: share.status === 'active' && !share.drifted ? 'dim' : 'warn',
      }], `shared value ${share.sharedValue ?? '—'}`));
    }
  }

  blocks.push(blank());
  blocks.push(staleReferences.length
    ? text(`link ${staleReferences.length === traced.references.length ? 'is' : 'is partly'} out of date — ${plural(staleReferences.length, 'reference')} still holds an older value`, 'warn')
    : traced.references.length
      ? text('link valid — every reference matches the current source value', 'ok')
      : dim('link valid — no document references this yet'));

  return result('trace', {
    headline: traced.name,
    subhead: traced.alias && traced.alias !== traced.name ? `alias ${traced.alias}` : null,
    blocks,
    results: traced.references.map((reference) => resultItem({
      title: reference.documentName,
      lines: [
        reference.blockIndex == null ? null : `block ${reference.blockIndex}`,
        `"${reference.spanText}"`,
        reference.status === 'LINKED' ? null : `source value ${reference.sourceValue ?? '—'}`,
      ],
      value: reference.linkedValue,
      badge: reference.status === 'LINKED' ? null : reference.status.toLowerCase(),
      tone: reference.status === 'LINKED' ? 'normal' : 'warn',
      ref: { kind: 'dependency', dependencyId: reference.dependencyId, objectId: resolved.object.id, name: traced.name },
      actions: [ACTION.inspect],
    })),
    actions: [ACTION.inspect, ACTION.impact, ACTION.showSource],
    hints: activeShares.length ? [`${plural(activeShares.length, 'active share')} — \`shares ${traced.name}\``] : [],
    data: traced,
  });
}
