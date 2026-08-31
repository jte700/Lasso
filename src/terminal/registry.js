// TerminalCommandRegistry.
//
// One entry per command: what it is for, how it is typed, which flags it
// takes, and what its arguments complete against. The executor reads it to
// dispatch, the completion endpoint reads it to suggest, and `help` reads it to
// describe itself — so a command is declared once.

import { findCommand } from './commands/find.js';
import { traceCommand } from './commands/trace.js';
import { impactCommand } from './commands/impact.js';
import { changesCommand } from './commands/changes.js';
import { staleCommand } from './commands/stale.js';
import { historyCommand } from './commands/history.js';
import { indexCommand } from './commands/index-command.js';
import { sharesCommand, revokeShareCommand } from './commands/shares.js';
import { aliasCommand, aliasesCommand, conflictsCommand, unaliasCommand } from './commands/conflicts.js';
import { askCommand } from './commands/ask.js';
import { rulesCommand } from './commands/rules.js';
import { updateCommand } from './commands/update.js';
import { unlinkCommand } from './commands/unlink.js';

/**
 * `question` — the class of question a command answers. Every command belongs
 * to one of the four; anything that belongs to none does not belong here.
 */
export const QUESTIONS = {
  WHERE: 'WHERE did this come from?',
  WHAT_DEPENDS: 'WHAT depends on this?',
  WHAT_CHANGED: 'WHAT changed?',
  WHAT_NOW: 'WHAT should I do about it?',
  MANAGE: 'Manage the dependency system',
};

const COMMANDS = [
  {
    name: 'find',
    summary: 'search indexed files, variables, values and source locations',
    usage: 'find <query> [--source xlsx] [--directory Finance] [--updated 30d] [--path fragment] [--all]',
    question: QUESTIONS.WHERE,
    flags: { source: 'sourceType', directory: 'directory', updated: 'duration', path: 'path', limit: null, all: null },
    arguments: ['nameOrPath'],
    examples: ['find revenue', 'find Income-Statement.csv', 'find depreciation --directory Finance'],
    run: findCommand,
  },
  {
    name: 'trace',
    summary: 'where a dependency came from and where it is used',
    usage: 'trace <dependency> [--directory Finance]',
    question: QUESTIONS.WHERE,
    flags: { directory: 'directory' },
    arguments: ['name'],
    examples: ['trace office-supplies'],
    run: traceCommand,
  },
  {
    name: 'impact',
    summary: 'every document, share and reference downstream of a source',
    usage: 'impact <source-file | dependency>',
    question: QUESTIONS.WHAT_DEPENDS,
    flags: {},
    arguments: ['nameOrPath'],
    examples: ['impact Income-Statement.xlsx', 'impact depreciation-direct'],
    run: impactCommand,
  },
  {
    name: 'changes',
    summary: 'dependency values that changed, and what they affect',
    usage: 'changes [--since yesterday|7d] [--source Finance] [--unresolved]',
    question: QUESTIONS.WHAT_CHANGED,
    flags: { since: 'duration', source: 'path', unresolved: null, limit: null },
    arguments: [],
    examples: ['changes', 'changes --since yesterday', 'changes --source Finance --unresolved'],
    run: changesCommand,
  },
  {
    name: 'stale',
    summary: 'references whose document no longer agrees with its source',
    usage: 'stale',
    question: QUESTIONS.WHAT_CHANGED,
    flags: {},
    arguments: [],
    examples: ['stale'],
    run: staleCommand,
  },
  {
    name: 'update',
    summary: 'bring references back in line with their source',
    usage: 'update <dependency> [--apply] [--keep]',
    question: QUESTIONS.WHAT_NOW,
    flags: { apply: null, all: null, keep: null },
    arguments: ['name'],
    examples: ['update depreciation-direct', 'update depreciation-direct --apply'],
    run: updateCommand,
  },
  {
    name: 'unlink',
    summary: 'retire references that should no longer be linked',
    usage: 'unlink <dependency> | --unresolved  [--apply]',
    question: QUESTIONS.WHAT_NOW,
    flags: { unresolved: null, apply: null },
    arguments: ['name'],
    examples: ['unlink --unresolved', 'unlink office-supplies --apply'],
    run: unlinkCommand,
  },
  {
    name: 'history',
    summary: 'every recorded value of a dependency',
    usage: 'history <dependency> [--at "Aug 19"]',
    question: QUESTIONS.WHERE,
    flags: { at: 'duration' },
    arguments: ['name'],
    examples: ['history depreciation-direct', 'history depreciation-direct --at "Aug 19"'],
    run: historyCommand,
  },
  {
    name: 'index',
    summary: 'operate the index: status, add, remove, refresh, failures, excluded',
    usage: 'index status | add <path> | remove <path> | include <path> | refresh [dir] | failures | retry <path> | excluded',
    question: QUESTIONS.MANAGE,
    flags: { name: null, reason: null, all: null },
    arguments: ['subcommand', 'path'],
    subcommands: ['status', 'add', 'remove', 'include', 'refresh', 'failures', 'retry', 'excluded'],
    examples: ['index status', 'index add ~/Documents/Finance', 'index failures'],
    run: indexCommand,
  },
  {
    name: 'shares',
    summary: 'dependencies shared outside the app',
    usage: 'shares [<dependency>] [--expired] [--revoked] [--all]',
    question: QUESTIONS.WHAT_DEPENDS,
    flags: { expired: null, revoked: null, all: null },
    arguments: ['name'],
    examples: ['shares', 'shares office-supplies', 'shares --revoked'],
    run: sharesCommand,
  },
  {
    name: 'revoke',
    summary: 'revoke one share by its token',
    usage: 'revoke <token>',
    question: QUESTIONS.WHAT_NOW,
    flags: {},
    arguments: [],
    hidden: true,
    examples: ['revoke <token>'],
    run: revokeShareCommand,
  },
  {
    name: 'conflicts',
    summary: 'names carried by more than one indexed source',
    usage: 'conflicts [<name>]',
    question: QUESTIONS.MANAGE,
    flags: {},
    arguments: ['name'],
    examples: ['conflicts', 'conflicts revenue'],
    run: conflictsCommand,
  },
  {
    name: 'alias',
    summary: 'pin a name to one exact source location',
    usage: 'alias <name> <path>:<location>',
    question: QUESTIONS.MANAGE,
    flags: {},
    arguments: ['aliasName', 'address'],
    examples: ['alias q3-revenue Finance/Q3/model.xlsx:Summary!B17'],
    run: aliasCommand,
  },
  {
    name: 'aliases',
    summary: 'every alias in this workspace',
    usage: 'aliases',
    question: QUESTIONS.MANAGE,
    flags: {},
    arguments: [],
    examples: ['aliases'],
    run: aliasesCommand,
  },
  {
    name: 'unalias',
    summary: 'remove an alias',
    usage: 'unalias <name>',
    question: QUESTIONS.MANAGE,
    flags: {},
    arguments: ['alias'],
    examples: ['unalias q3-revenue'],
    run: unaliasCommand,
  },
  {
    name: 'ask',
    summary: 'a question answered only from indexed sources',
    usage: 'ask <question>',
    question: QUESTIONS.WHERE,
    flags: {},
    arguments: [],
    examples: ['ask which source contains our latest depreciation assumption?'],
    run: askCommand,
  },
  {
    name: 'rules',
    summary: 'deterministic reactions to recorded changes',
    usage: 'rules list | add <when … then …> | remove <n> | enable <n> | disable <n> | flags',
    question: QUESTIONS.MANAGE,
    flags: {},
    arguments: ['subcommand'],
    subcommands: ['list', 'add', 'remove', 'enable', 'disable', 'flags'],
    examples: ['rules', 'rules add when source path starts with Finance/Q3 then flag affected dependencies'],
    run: rulesCommand,
  },
];

export class TerminalCommandRegistry {
  constructor(commands = COMMANDS) {
    this.commands = commands;
    this.byName = new Map(commands.map((command) => [command.name, command]));
  }

  get(name) { return this.byName.get(String(name ?? '').toLowerCase()) ?? null; }

  has(name) { return this.byName.has(String(name ?? '').toLowerCase()); }

  list({ includeHidden = false } = {}) {
    return this.commands.filter((command) => includeHidden || !command.hidden);
  }

  names({ includeHidden = false } = {}) {
    return this.list({ includeHidden }).map((command) => command.name);
  }

  /** Flags that take no value, so the parser does not swallow the next word. */
  booleanFlags(name) {
    const definition = this.get(name);
    if (!definition) return new Set();
    return new Set(Object.entries(definition.flags)
      .filter(([, kind]) => kind === null)
      .map(([flag]) => flag));
  }

  /** Grouped the way `help` prints them: by the question they answer. */
  byQuestion() {
    const grouped = new Map();
    for (const command of this.list()) {
      const list = grouped.get(command.question) ?? [];
      list.push(command);
      grouped.set(command.question, list);
    }
    return [...grouped.entries()];
  }
}

export { COMMANDS };
