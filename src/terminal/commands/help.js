// help — what the terminal is for, and everything it can be asked.

import { blank, dim, group, result, text } from '../result.js';

const KEYS = [
  ['Tab', 'complete a command or dependency name'],
  ['↑ ↓', 'command history, or move through results'],
  ['Enter', 'run, or inspect the selected result'],
  ['Esc', 'close the inspector'],
  ['Ctrl+L', 'clear'],
  ['?', 'this help'],
];

export function helpCommand(context, command) {
  const wanted = command.args[0];
  if (wanted) {
    const definition = context.registry.get(wanted);
    if (!definition) {
      return {
        ...result('help', { headline: `No command named ${wanted}.` }),
        ok: false,
        hints: [`Commands: ${context.registry.names().join(', ')}`],
      };
    }
    return result('help', {
      headline: definition.name,
      subhead: definition.summary,
      blocks: [
        text(definition.usage),
        blank(),
        dim(definition.question),
        blank(),
        text('examples'),
        ...definition.examples.map((example) => dim(`  ${example}`)),
        ...(Object.keys(definition.flags).length ? [
          blank(),
          text('flags'),
          ...Object.entries(definition.flags).map(([flag, kind]) => dim(`  --${flag}${kind ? ` <${kind === 'sourceType' ? 'type' : kind}>` : ''}`)),
        ] : []),
      ],
      data: { command: definition.name },
    });
  }

  const blocks = [
    dim('A shell over this workspace’s dependency graph. The document editor creates dependencies; this operates on them.'),
    blank(),
  ];
  for (const [question, commands] of context.registry.byQuestion()) {
    blocks.push(text(question));
    for (const definition of commands) {
      blocks.push(group(`  ${definition.name}`, [{ text: definition.summary, tone: 'dim' }]));
    }
    blocks.push(blank());
  }
  blocks.push(text('keys'), ...KEYS.map(([key, meaning]) => dim(`  ${key.padEnd(8)}${meaning}`)));

  return result('help', {
    headline: 'Lasso Dependency Shell',
    blocks,
    hints: ['`help <command>` describes one command.'],
    data: { commands: context.registry.names() },
  });
}
