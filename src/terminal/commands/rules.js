// rules — deterministic reactions to recorded changes.

import { ACTION, blank, dim, failure, group, result, resultItem, text } from '../result.js';
import { ACTIONS, TRIGGERS, parseRuleSentence } from '../rules.js';
import { formatMoment, plural } from './shared.js';

function ruleBlocks(rules, flags) {
  const blocks = [];
  rules.forEach((rule, position) => {
    blocks.push(group(`${position + 1}  ${rule.name}`, [
      { text: `WHEN ${rule.triggerText}`, tone: 'dim' },
      { text: `THEN ${rule.actionText}`, tone: 'dim' },
      { text: rule.enabled ? 'enabled' : 'disabled', tone: rule.enabled ? 'ok' : 'warn' },
      flags.get(rule.name) ? { text: `${plural(flags.get(rule.name), 'open flag')}`, tone: 'warn' } : null,
    ].filter(Boolean)));
  });
  return blocks;
}

export function rulesCommand(context, command) {
  const [subcommand = 'list', ...rest] = command.args;
  const argument = rest.join(' ').trim();

  if (subcommand === 'add') {
    // Everything after `rules add` is the rule sentence, optionally prefixed
    // with a quoted name.
    const sentence = command.rest.replace(/^add\s+/i, '').trim();
    const named = sentence.match(/^"([^"]+)"\s+(.*)$/) ?? sentence.match(/^'([^']+)'\s+(.*)$/);
    const parsed = parseRuleSentence(named ? named[2] : sentence);
    if (!parsed.ok) {
      return failure('rules', parsed.reason, {
        hints: [
          'rules add when source path starts with Finance/Q3 then flag affected dependencies',
          'rules add "Archive suppression" when source path starts with Archive then exclude from autocomplete',
          'rules add when a shared source changes then mark the share as potentially stale',
        ],
      });
    }
    const rule = context.rules.add(context.projectId, {
      name: named ? named[1] : null,
      sentence: named ? named[2] : sentence,
    }, context.actor);
    return result('rules', {
      headline: `Added ${rule.name}`,
      blocks: [
        text(`WHEN ${rule.triggerText}`),
        text(`THEN ${rule.actionText}`),
        blank(),
        dim('It applies from the next recorded change onward. Existing state is not re-evaluated.'),
      ],
      data: { rule },
    });
  }

  if (['remove', 'enable', 'disable'].includes(subcommand)) {
    if (!argument) return failure('rules', `rules ${subcommand} needs a rule number or name.`);
    if (subcommand === 'remove') {
      const removed = context.rules.remove(context.projectId, argument);
      return result('rules', { headline: `Removed ${removed.name}`, data: { rule: removed } });
    }
    const rule = context.rules.setEnabled(context.projectId, argument, subcommand === 'enable');
    return result('rules', {
      headline: `${rule.name} ${subcommand}d`,
      blocks: [text(`WHEN ${rule.triggerText}`), text(`THEN ${rule.actionText}`)],
      data: { rule },
    });
  }

  if (subcommand === 'flags') {
    const flags = context.rules.flags(context.projectId);
    if (!flags.length) {
      return result('rules', {
        headline: 'No open flags',
        blocks: [dim('No enabled rule has matched a recorded change yet.')],
        data: { flags: [] },
      });
    }
    return result('rules', {
      headline: plural(flags.length, 'open flag'),
      blocks: flags.map((flag) => group(flag.detail.name ?? flag.subject, [
        { text: `${flag.detail.previousValue ?? '—'} → ${flag.detail.currentValue ?? '—'}`, tone: 'warn' },
        { text: flag.detail.path ?? '', tone: 'dim' },
        { text: `raised by ${flag.rule} · ${formatMoment(flag.createdAt)}`, tone: 'dim' },
      ])),
      data: { flags },
    });
  }

  if (subcommand !== 'list') {
    return failure('rules', `rules has no subcommand ${subcommand}.`, {
      hints: ['rules list', 'rules add', 'rules remove', 'rules enable', 'rules disable', 'rules flags'],
    });
  }

  const rules = context.rules.list(context.projectId);
  if (!rules.length) {
    return result('rules', {
      headline: 'No rules',
      blocks: [
        dim('A rule is one trigger and one action, evaluated when a change is recorded.'),
        blank(),
        text('triggers'),
        ...Object.values(TRIGGERS).map((trigger) => dim(`  ${trigger.keyword}${trigger.needsValue ? ' <value>' : ''}`)),
        blank(),
        text('actions'),
        ...Object.values(ACTIONS).map((action) => dim(`  ${action.describe()}`)),
      ],
      hints: ['rules add when source path starts with Finance/Q3 then flag affected dependencies'],
      data: { rules: [] },
    });
  }

  const flagCounts = new Map();
  for (const flag of context.rules.flags(context.projectId)) {
    flagCounts.set(flag.rule, (flagCounts.get(flag.rule) ?? 0) + 1);
  }

  return result('rules', {
    headline: plural(rules.length, 'rule'),
    blocks: ruleBlocks(rules, flagCounts),
    results: rules.map((rule, position) => resultItem({
      title: `${position + 1}  ${rule.name}`,
      lines: [
        `WHEN ${rule.triggerText}`,
        `THEN ${rule.actionText}`,
        flagCounts.get(rule.name) ? plural(flagCounts.get(rule.name), 'open flag') : null,
      ],
      badge: rule.enabled ? null : 'disabled',
      tone: rule.enabled ? 'normal' : 'warn',
      ref: { kind: 'rule', ruleId: rule.id, name: rule.name, enabled: rule.enabled },
      actions: [ACTION.inspect],
    })),
    hints: ['`rules flags` lists what the enabled rules have raised.'],
    data: { rules },
  });
}
