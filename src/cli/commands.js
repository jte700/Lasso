// The CLI's commands: one entry each, read by the shell's slash menu, by
// /help, by one-shot `lasso <command>` and by completion. New provenance
// questions are answered by provenance.js; the rest pass through to the
// terminal layer the web workbench uses (src/terminal), drawn here.

import fs from 'node:fs';
import path from 'node:path';
import { parseCommand } from '../terminal/parser.js';
import { untilde } from './format.js';
import { mascotLines, wordmarkLines, LOOKS, MASCOT_WIDTH } from './pixels.js';
import { padEnd } from './style.js';
import { renderError, renderHelp, renderHooks, renderResult, renderStatus, renderVerify } from './views.js';
import { runHooksCommand } from './ai-hooks-install.js';
import { renderAnywhereBlame, renderAnywhereDiff, renderAnywhereLog, renderWhence } from './anywhere-views.js';
import { unescapePath } from './disk-facts.js';

const GROUPS = {
  WHERE: 'Where did this come from?',
  CHANGED: 'What changed, and who changed it?',
  TRUST: 'Can I trust this document?',
  LIBRARY: 'Your library',
  SHELL: 'This shell',
};

/** Runs a line through the terminal layer and draws its result. */
const passThrough = (name) => async (context, parsed) => {
  const result = await context.call('run', `${name} ${parsed.rest}`.trim());
  return { lines: renderResult(result, context.paint, context.columns), ok: result.ok, data: result };
};

export const COMMANDS = [
  {
    name: 'whence', args: '<file>', group: GROUPS.WHERE, complete: 'disk',
    summary: 'where any file came from: Lasso\'s record, this computer, the file itself, its copies',
    examples: ['whence ~/Downloads/budget-final.xlsx'],
    async run(context, parsed) {
      const target = parsed.args.join(' ');
      if (!target) return usage(this);
      const data = await context.call('whence', target);
      return { lines: renderWhence(data, context.paint, context.columns), data };
    },
  },
  {
    name: 'trace', args: '<name>', group: GROUPS.WHERE, complete: 'terminal',
    summary: 'a value\'s source, its place in the file, and what uses it', run: passThrough('trace'),
  },
  {
    name: 'history', args: '<name>', group: GROUPS.WHERE, complete: 'terminal',
    summary: 'every recorded value of one value, oldest to newest', run: passThrough('history'),
  },
  {
    name: 'find', args: '<words>', group: GROUPS.WHERE, complete: 'terminal',
    summary: 'search files, values and passages across your folders', run: passThrough('find'),
  },
  {
    name: 'ask', args: '<question>', group: GROUPS.WHERE, complete: null,
    summary: 'a question answered only from indexed sources', run: passThrough('ask'),
  },
  {
    name: 'log', args: '[folder] [--since 2d]', group: GROUPS.CHANGED, complete: 'disk',
    summary: 'who changed what: your Lasso folders, or any folder on disk (also --by, --file)',
    async run(context, parsed) {
      const { flags } = parsed;
      const options = { by: flags.by ?? null, since: flags.since ?? null, folder: flags.folder ?? null, limit: Number(flags.limit) || 40 };
      const named = parsed.args.join(' ');
      const folder = named ? isFolder(named, context.cwd) : null;
      const data = folder ? await context.call('logAt', folder, options)
        : await context.call('log', { ...options, file: flags.file ?? (named || null) });
      return { lines: renderAnywhereLog(data, context.paint, context.columns), data };
    },
  },
  {
    name: 'diff', args: '<file> [other | v3]', group: GROUPS.CHANGED, complete: 'library',
    summary: 'two files compared, or a file\'s last change (Lasso\'s record or git)',
    examples: ['diff budget.xlsx "budget final.xlsx"'],
    async run(context, parsed) {
      const args = [...parsed.args];
      const version = args.length > 1 && /^v?\d+$/i.test(args.at(-1)) ? args.pop() : parsed.flags.version ?? null;
      if (!args.length) return usage(this);
      const data = await context.call('diff', args, { version });
      return { lines: renderAnywhereDiff(data, context.paint, context.columns), data };
    },
  },
  {
    name: 'blame', args: '<file>', group: GROUPS.CHANGED, complete: 'library',
    summary: 'who wrote what in a file, AI included: Lasso\'s record, git, or Word\'s tracked changes',
    async run(context, parsed) {
      if (!parsed.args.length) return usage(this);
      const data = await context.call('blame', parsed.args.join(' '));
      return { lines: renderAnywhereBlame(data, context.paint, context.columns), data };
    },
  },
  {
    name: 'changes', args: '[--since 7d]', group: GROUPS.CHANGED, complete: 'terminal',
    summary: 'values that changed, and what they affect', run: passThrough('changes'),
  },
  {
    name: 'watch', args: '', group: GROUPS.CHANGED, complete: null, live: true,
    summary: 'follow changes live as your folders record them (Esc stops)',
    async run(context) {
      await context.call('cursor');
      return { watch: true };
    },
  },
  {
    name: 'verify', args: '<doc> [--against file]', group: GROUPS.TRUST, complete: 'disk',
    summary: 'check every number in a report against its sources (your folders, or files you name)',
    examples: ['verify ~/Documents/Q3-board-memo.docx', 'verify memo.docx --against ~/Desktop/Accounting'],
    async run(context, parsed) {
      const target = parsed.args.join(' ');
      if (!target) return usage(this);
      const against = typeof parsed.flags.against === 'string' ? parsed.flags.against : null;
      const data = await context.call('verify', target, { against });
      return { lines: renderVerify(data, context.paint, context.columns, Date.now(), { all: Boolean(parsed.flags.all) }),
        data, exitCode: data.tally.stale ? 1 : 0 };
    },
  },
  {
    name: 'stale', args: '', group: GROUPS.TRUST, complete: null,
    summary: 'linked references that no longer agree with their source', run: passThrough('stale'),
  },
  {
    name: 'impact', args: '<file | name>', group: GROUPS.TRUST, complete: 'terminal',
    summary: 'every document, share and reference downstream of a source', run: passThrough('impact'),
  },
  {
    name: 'shares', args: '', group: GROUPS.TRUST, complete: null,
    summary: 'values and files you have shared outside Lasso', run: passThrough('shares'),
  },
  {
    name: 'update', args: '<name> [--apply]', group: GROUPS.TRUST, complete: 'terminal',
    summary: 'bring references back in line with their source', run: passThrough('update'),
  },
  {
    name: 'status', args: '', group: GROUPS.LIBRARY, complete: null,
    summary: 'your folders, files, versions and two weeks of activity',
    async run(context) {
      const data = await context.call('summary');
      if (!data) {
        return { lines: renderError('There is no Lasso library on this computer, so nothing is recorded. '
          + '/whence, /blame, /diff, /verify and /log read any file on the spot.', context.paint, context.columns), data };
      }
      return { lines: renderStatus(data, context.paint, context.columns, { dataDir: context.dataDir }), data };
    },
  },
  {
    name: 'hooks', args: '[install | remove | status]', group: GROUPS.LIBRARY, complete: null,
    summary: 'record what Claude Code writes into your Lasso folders, so /blame and /whence can say',
    async run(context, parsed) {
      const action = String(parsed.args[0] ?? 'status').toLowerCase();
      const outcome = runHooksCommand(action, { home: context.home });
      return { lines: renderHooks(outcome, context.paint, context.columns, { library: Boolean(context.dataDir) }), data: outcome,
        exitCode: outcome.code, ok: outcome.code !== 2 };
    },
  },
  {
    name: 'index', args: 'status | add <path> | failures | …', group: GROUPS.LIBRARY, complete: 'terminal',
    summary: 'what Lasso reads: add folders, see files it could not read', run: passThrough('index'),
  },
  {
    name: 'rules', args: '', group: GROUPS.LIBRARY, complete: 'terminal',
    summary: 'standing rules that flag changes', run: passThrough('rules'),
  },
  {
    name: 'help', args: '', group: GROUPS.SHELL, complete: null, summary: 'this list',
    async run(context) { return { lines: renderHelp(COMMANDS, context.paint, context.columns) }; },
  },
  {
    name: 'mascot', args: '', group: GROUPS.SHELL, complete: null, summary: 'say howdy',
    async run(context) {
      const looks = Object.values(LOOKS);
      const look = looks[Math.floor(Math.random() * looks.length)];
      const art = mascotLines(context.paint, { expression: 'happy', look });
      const words = wordmarkLines(context.paint);
      const lines = art.map((line, index) => `  ${padEnd(line, MASCOT_WIDTH)}${index >= 1 && index <= 3 ? `    ${words[index - 1]}` : ''}`);
      return { lines: [...lines, '', `  ${context.paint.accent('Howdy. Every answer here is read from your files and what Lasso recorded.')}`] };
    },
  },
  { name: 'clear', args: '', group: GROUPS.SHELL, complete: null, summary: 'clear the screen', shellOnly: true, async run() { return { clear: true }; } },
  { name: 'exit', args: '', group: GROUPS.SHELL, complete: null, summary: 'leave (or Ctrl+D)', shellOnly: true, async run() { return { exit: true }; } },
];

const BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
BY_NAME.set('quit', BY_NAME.get('exit'));
BY_NAME.set('?', BY_NAME.get('help'));

export const commandNamed = (name) => BY_NAME.get(String(name ?? '').toLowerCase()) ?? null;

function usage(command) {
  return { usage: `/${command.name} ${command.args}`, ok: false };
}

const QUESTION = /\?$|^(which|what|where|when|who|whose|how|why|is|are|does|did|was|were)\b/i;

/**
 * What a typed line runs: a slash command, a command named without its
 * slash, a question (ask), or anything else as a search (find).
 */
export function interpret(input, { cwd = process.cwd() } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const slash = raw.startsWith('/') && !isPath(raw, cwd);
  const body = quoteEscapes(slash ? raw.slice(1) : raw);
  const first = body.split(/\s+/)[0].toLowerCase();
  const command = commandNamed(first);
  if (command) return { command, parsed: parseCommand(body, booleanFlagsOf(command)) };
  if (slash) return { unknown: first };
  // A file or folder dropped in on its own: where it came from, or what changed in it.
  if (isPath(raw, cwd)) {
    const name = isFolder(raw, cwd) ? 'log' : 'whence';
    return { command: commandNamed(name), parsed: parseCommand(`${name} ${quoteEscapes(raw)}`) };
  }
  if (QUESTION.test(raw)) return { command: commandNamed('ask'), parsed: parseCommand(`ask ${body}`) };
  return { command: commandNamed('find'), parsed: parseCommand(`find ${body}`) };
}

/**
 * A line with the backslash escapes a shell uses (and Terminal writes when a
 * file is dragged in: "BEaTS\\ Lab") turned into the quotes the parser reads.
 */
export function quoteEscapes(text) {
  // Windows paths are written with backslashes; there they are not escapes.
  if (process.platform === 'win32') return text;
  let out = '';
  let quote = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
      out += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; out += character; continue; }
    if (character === '\\' && index + 1 < text.length) {
      const next = text[index + 1];
      out += next === '"' ? `'"'` : /[\s']/.test(next) ? `"${next}"` : next;
      index += 1;
      continue;
    }
    out += character;
  }
  return out;
}

const statAt = (text, cwd) => {
  try { return fs.statSync(path.resolve(cwd, untilde(unescapePath(String(text).replace(/^(["'])(.*)\1$/, '$2'))))); } catch { return null; }
};
const isPath = (text, cwd) => /^["']?[~./]/.test(text) && Boolean(statAt(text, cwd));
/** The folder on disk a typed path names, or null. */
const isFolder = (text, cwd) => (statAt(text, cwd)?.isDirectory() ? unescapePath(String(text).replace(/^(["'])(.*)\1$/, '$2')) : null);

const BOOLEAN_FLAGS = { verify: ['all'], update: ['apply', 'all', 'keep'], find: ['all'], changes: ['unresolved'] };
const booleanFlagsOf = (command) => new Set(BOOLEAN_FLAGS[command.name] ?? []);

/**
 * Runs one typed line. Returns { lines, ok, exitCode, data } or a shell
 * request ({ clear }, { exit }, { watch }).
 */
export async function execute(input, context) {
  const plan = interpret(input, { cwd: context.cwd });
  if (!plan) return { lines: [] };
  if (plan.unknown) {
    const near = COMMANDS.filter((command) => command.name.startsWith(plan.unknown.slice(0, 2))).map((command) => `/${command.name}`);
    return { lines: renderError(`There is no /${plan.unknown}.${near.length ? ` Did you mean ${near.join(' or ')}?` : ' Try /help.'}`, context.paint, context.columns),
      ok: false, exitCode: 2 };
  }
  try {
    const outcome = await plan.command.run(context, plan.parsed);
    if (outcome.usage) {
      return { lines: renderError(`Usage: ${outcome.usage}`, context.paint, context.columns), ok: false, exitCode: 2 };
    }
    return { ok: true, exitCode: outcome.ok === false ? 1 : 0, ...outcome };
  } catch (error) {
    return { lines: renderError(error.message ?? String(error), context.paint, context.columns), ok: false, exitCode: 1, error };
  }
}

// ── completion ───────────────────────────────────────────────────────────

/** Slash commands whose names start with what was typed, for the menu. */
export function commandMatches(typed) {
  const wanted = String(typed ?? '').replace(/^\//, '').toLowerCase();
  return COMMANDS.filter((command) => command.name.startsWith(wanted))
    .map((command) => ({ value: `/${command.name}`, label: `/${command.name}`, detail: command.summary, insert: `/${command.name} ` }));
}

/**
 * Completions for the word under the caret: command names, then each
 * command's arguments (paths on disk, library files, or the terminal
 * layer's own names). Each is { label, detail, insert } where `insert` is
 * the whole line after accepting it.
 */
export async function complete(line, context) {
  const text = String(line ?? '');
  if (/^\/\S*$/.test(text)) return commandMatches(text);
  const match = text.match(/^\/?(\S+)\s+(.*)$/s);
  if (!match) return [];
  const command = commandNamed(match[1]);
  if (!command?.complete) return [];
  const argument = match[2];
  const lead = text.slice(0, text.length - argument.length);
  if (command.complete === 'disk') return pathsAfter(lead, argument, context.cwd);
  if (command.complete === 'library') {
    // Files in Lasso folders first, then files on disk, so a name answers from either.
    const onDisk = pathsAfter(lead, argument, context.cwd);
    if (/^[~./]/.test(argument) || /\s/.test(argument)) return onDisk;
    const files = await context.call('files', argument);
    const recorded = files.slice(0, 40).map((file) => ({ value: file, label: path.posix.basename(file), detail: file, insert: `${lead}${file}` }));
    return [...recorded, ...onDisk.filter((entry) => !recorded.some((file) => file.insert === entry.insert))];
  }
  const completion = await context.call('complete', `${command.name} ${argument}`);
  const fragment = completion.fragment ?? '';
  const before = text.slice(0, text.length - fragment.length);
  return (completion.suggestions ?? []).slice(0, 40).map((suggestion) => ({
    value: suggestion.value, label: suggestion.value, detail: suggestion.detail ?? suggestion.kind ?? '',
    insert: `${before}${String(suggestion.value).includes(' ') && !/^["']/.test(suggestion.value) ? `"${suggestion.value}"` : suggestion.value}`,
  }));
}

/**
 * Paths completing what follows a command: the whole of it as one path
 * ("BEaTS Lab/cl"), else its last word, for a second file or a flag's value.
 */
function pathsAfter(lead, argument, cwd) {
  const escaped = /\\ /.test(argument);
  const shown = (value, escape) => (escape ? value.replace(/ /g, '\\ ') : value);
  const whole = diskPaths(unescapePath(argument), cwd);
  if (whole.length) return whole.map((entry) => ({ ...entry, insert: lead + shown(entry.value, escaped) }));
  // The last word, where a space after a backslash belongs to the word; a second file is written escaped.
  let at = argument.length - 1;
  while (at >= 0 && !(argument[at] === ' ' && argument[at - 1] !== '\\')) at -= 1;
  if (at < 0) return [];
  const head = argument.slice(0, at + 1);
  return diskPaths(unescapePath(argument.slice(at + 1)), cwd).map((entry) => ({ ...entry, insert: lead + head + shown(entry.value, true) }));
}

/** Files and folders on disk that complete a typed path, folders first. */
export function diskPaths(typed, cwd = process.cwd()) {
  const raw = String(typed ?? '');
  const expanded = untilde(raw);
  const directory = raw.endsWith('/') ? expanded : path.dirname(expanded);
  const stem = raw.endsWith('/') ? '' : path.basename(expanded);
  const shownDirectory = raw.endsWith('/') ? raw : raw.includes('/') ? raw.slice(0, raw.lastIndexOf('/') + 1) : '';
  let entries;
  try { entries = fs.readdirSync(path.resolve(cwd, directory || '.'), { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.name.toLowerCase().startsWith(stem.toLowerCase()) && (stem.startsWith('.') || !entry.name.startsWith('.')))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 60)
    .map((entry) => {
      const value = `${shownDirectory}${entry.name}${entry.isDirectory() ? '/' : ''}`;
      return { value, label: `${entry.name}${entry.isDirectory() ? '/' : ''}`, detail: entry.isDirectory() ? 'folder' : '' };
    });
}
