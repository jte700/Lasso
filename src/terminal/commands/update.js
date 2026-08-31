// update — bring document references back in line with their source.
//
// Nothing is written until `--apply`. Running `update <name>` prints the exact
// text each document would receive, so the change is reviewed before it
// happens rather than after.

import { ACTION, blank, dim, failure, group, result, resultItem, text } from '../result.js';
import { plural, requireObject } from './shared.js';

function editRows(edit) {
  switch (edit.action) {
    case 'REWRITE': return [
      { text: `- "${edit.spanText}"`, tone: 'warn' },
      { text: `+ "${edit.nextSpanText}"`, tone: 'ok' },
    ];
    case 'RELINK': return [
      { text: `"${edit.spanText}"`, tone: 'dim' },
      { text: `relink only — ${edit.reason}`, tone: 'warn' },
    ];
    case 'ALREADY_CURRENT': return [{ text: `"${edit.spanText}"`, tone: 'dim' }, { text: 'already current', tone: 'dim' }];
    default: return [
      { text: `"${edit.spanText}"`, tone: 'dim' },
      { text: `needs a person — ${edit.reason}`, tone: 'warn' },
    ];
  }
}

export function updateCommand(context, command) {
  const name = command.args.join(' ').trim();
  if (!name) {
    return failure('update', 'update needs a dependency name.', {
      hints: ['update depreciation-direct', 'update depreciation-direct --apply'],
    });
  }

  const resolved = requireObject(context, 'update', name);
  if (resolved.response) return resolved.response;
  const { object } = resolved;

  if (command.flags.keep === true) {
    const kept = context.dependencies.keepCurrentValue(context.projectId, object.id, context.actor);
    return result('update', {
      headline: kept.kept.length
        ? `${plural(kept.kept.length, 'reference')} kept at the linked value`
        : 'Nothing to keep',
      blocks: kept.kept.length
        ? kept.kept.map((entry) => group(entry.documentPath, [{ text: `"${entry.spanText}"`, tone: 'dim' }]))
        : [dim('Every reference to this source already matches it.')],
      hints: ['These references are pinned to the version they were linked at and will not be reported stale.'],
      data: kept,
    });
  }

  const plan = context.dependencies.planSourceValueUpdate(context.projectId, object.id);
  const actionable = plan.rewrites + plan.relinks;

  if (!plan.edits.length) {
    return result('update', {
      headline: `Nothing references ${object.name}`,
      blocks: [dim('A dependency gains references when it is inserted from the document editor.')],
      data: plan,
    });
  }
  if (!actionable) {
    return result('update', {
      headline: `${object.name} is already current everywhere`,
      blocks: [
        text(`source value  ${plan.object.value ?? '—'}`),
        blank(),
        ...plan.edits.map((edit) => group(edit.documentPath, editRows(edit))),
      ],
      data: plan,
    });
  }

  const apply = command.flags.apply === true || command.flags.all === true;
  if (!apply) {
    return result('update', {
      headline: `${plural(actionable, 'reference')} would change`,
      subhead: `${object.name} → ${plan.object.value ?? '—'}`,
      blocks: [
        text(`source        ${plan.object.path}`),
        text(`source value  ${plan.object.value ?? '—'}`),
        blank(),
        ...plan.edits.map((edit) => group(edit.documentPath, editRows(edit))),
        blank(),
        text('Nothing has been written.', 'warn'),
      ],
      results: plan.edits.filter((edit) => edit.action !== 'ALREADY_CURRENT').map((edit) => resultItem({
        title: edit.documentPath,
        lines: [
          edit.blockIndex == null ? null : `block ${edit.blockIndex}`,
          `"${edit.spanText}"`,
          edit.action === 'REWRITE' ? `→ "${edit.nextSpanText}"` : edit.reason,
        ],
        value: plan.object.value,
        badge: edit.action.toLowerCase(),
        tone: edit.action === 'REWRITE' ? 'normal' : 'warn',
        ref: { kind: 'dependency', dependencyId: edit.dependencyId, objectId: object.id, name: object.name },
        actions: [ACTION.inspect],
      })),
      actions: [ACTION.update, ACTION.keep, ACTION.inspect],
      hints: [
        `\`update ${object.name} --apply\` writes these changes.`,
        `\`update ${object.name} --keep\` records that the current wording is intended.`,
      ],
      data: plan,
    });
  }

  const applied = context.dependencies.applySourceValueUpdate(context.projectId, object.id, context.actor);
  const rewritten = applied.applied.filter((entry) => entry.action === 'REWRITE');
  const relinked = applied.applied.filter((entry) => entry.action === 'RELINK');

  const blocks = [];
  for (const entry of rewritten) {
    blocks.push(group(entry.documentPath, [
      { text: `- "${entry.previousSpanText}"`, tone: 'dim' },
      { text: `+ "${entry.spanText}"`, tone: 'ok' },
    ]));
  }
  if (relinked.length) {
    blocks.push(blank(), text('relinked without changing the text'));
    for (const entry of relinked) blocks.push(group(entry.documentPath, [{ text: `"${entry.spanText}"`, tone: 'dim' }]));
  }
  if (applied.manual) {
    blocks.push(blank(), text(`${plural(applied.manual, 'reference')} still needs a person.`, 'warn'));
    for (const edit of applied.edits.filter((item) => item.action === 'MANUAL')) {
      blocks.push(group(edit.documentPath, editRows(edit)));
    }
  }

  return result('update', {
    headline: `${plural(rewritten.length, 'reference')} updated`,
    subhead: `${object.name} → ${plan.object.value ?? '—'}`,
    blocks,
    hints: [`\`trace ${object.name}\` shows the references as they now stand.`],
    data: applied,
  });
}
