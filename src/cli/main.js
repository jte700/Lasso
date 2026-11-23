#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// lasso: Lasso's provenance tools in a terminal.
//
//   lasso                         the interactive shell
//   lasso <command> [arguments]   one answer, then exit (verify exits 1 when a number is stale)
//   lasso --json <command> …      the answer's data as JSON, for scripts
//   … | lasso                     each line of standard input run as a command
//
// Options: --data-dir DIR (default: LASSO_DATA_DIR, then the Mac app's
// library), --no-color, --color, --no-intro, --help, --version.

import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { colorLevel, createPainter } from './style.js';
import { COMMANDS, execute, interpret } from './commands.js';
import { openBackend } from './backend.js';
import { renderError, renderEvent, renderHelp } from './views.js';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

const USAGE = `Usage: lasso [options] [command] [arguments]

  lasso                          open the interactive shell
  lasso whence <file>            where a file's exact bytes came from
  lasso verify <document>        check a document's numbers against their sources
  lasso log --since 2d           who changed what, lately
  lasso hooks install            record what Claude Code writes into your folders
  lasso help                     every command

Options:
  --data-dir <dir>   the Lasso library to read (default: the Mac app's)
  --json             print an answer's data as JSON
  --no-color         plain text; also NO_COLOR=1
  --no-intro         skip the mascot's intro
  -v, --version      print the version`;

export function parseArguments(argv) {
  const options = { dataDir: null, json: false, color: null, intro: true, help: false, version: false, words: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    // Options are read only before the command; after it, flags belong to the command.
    if (options.words.length) { options.words.push(word); continue; }
    if (word === '--data-dir') {
      if (argv[index + 1] === undefined) throw new Error('--data-dir needs a folder.');
      options.dataDir = argv[index + 1];
      index += 1;
    } else if (word.startsWith('--data-dir=')) options.dataDir = word.slice('--data-dir='.length);
    else if (word === '--json') options.json = true;
    else if (word === '--no-color' || word === '--no-colour') options.color = false;
    else if (word === '--color' || word === '--colour') options.color = true;
    else if (word === '--no-intro') options.intro = false;
    else if (word === '-h' || word === '--help') options.help = true;
    else if (word === '-v' || word === '--version') options.version = true;
    else if (word.startsWith('-') && word !== '-') throw new Error(`Unknown option ${word}.`);
    else options.words.push(word);
  }
  return options;
}

/** Quotes words with spaces back together, so `lasso whence "My File.csv"` reaches the command whole. */
export const joinWords = (words) => words.map((word) => (/\s/.test(word) && !/^["']/.test(word) ? `"${word}"` : word)).join(' ');

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stdin = process.stdin, env = process.env } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.version) { stdout.write(`lasso ${VERSION}\n`); return 0; }
  // Claude Code's hook and its setup need no library opened, so they answer at once.
  if (options.words[0] === 'hook') {
    const { runHook } = await import('./ai-hook.js');
    return runHook({ stdin, env });
  }
  if (options.words[0] === 'hooks') {
    const { runHooksCommand } = await import('./ai-hooks-install.js');
    const outcome = runHooksCommand(options.words[1] ?? 'status');
    stdout.write(`${outcome.text}\n`);
    return outcome.code;
  }
  const paint = createPainter(colorLevel({ stream: stdout, env, force: options.color }));
  const columns = stdout.columns || 100;
  if (options.help) {
    stdout.write(`${USAGE}\n\n${renderHelp(COMMANDS, paint, columns).join('\n')}\n`);
    return 0;
  }

  const interactive = !options.words.length && stdin.isTTY && stdout.isTTY && !options.json;
  if (interactive) {
    const { runShell } = await import('./shell.js');
    const intro = options.intro && !env.LASSO_NO_INTRO && env.REDUCE_MOTION !== '1';
    return runShell({ dataDir: options.dataDir, paint, version: VERSION, intro });
  }

  let backend;
  try {
    backend = openBackend({ dataDir: options.dataDir, readHistory: false });
  } catch (error) {
    process.stderr.write(`${paint.pink('✗')} ${error.message}\n`);
    return 1;
  }
  const context = { call: (method, ...args) => backend.call(method, ...args), paint, columns, cwd: process.cwd(), dataDir: backend.dataDir };
  try {
    if (options.words.length) return await runOne(joinWords(options.words), context, { stdout, json: options.json });
    // Lines from standard input, one command each.
    let code = 0;
    const lines = readline.createInterface({ input: stdin, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      code = Math.max(code, await runOne(line, context, { stdout, json: options.json }));
    }
    return code;
  } finally {
    backend.close();
  }
}

async function runOne(line, context, { stdout, json }) {
  const plan = interpret(line, { cwd: context.cwd });
  if (plan?.command?.shellOnly) return 0;
  if (plan?.command?.live) {
    try {
      return await watch(context, stdout, json);
    } catch (error) {
      stdout.write(`${json ? JSON.stringify({ error: error.message }) : renderError(error.message, context.paint, context.columns).join('\n')}\n`);
      return 1;
    }
  }
  const outcome = await execute(line, context);
  if (json) {
    stdout.write(`${JSON.stringify(outcome.error ? { error: outcome.error.message } : outcome.data ?? null, null, 2)}\n`);
  } else {
    stdout.write(`${(outcome.lines ?? []).join('\n')}\n`);
  }
  return outcome.exitCode ?? 0;
}

/** `lasso watch`: changes as they are recorded, until Ctrl+C. */
async function watch(context, stdout, json) {
  let cursor = await context.call('cursor');
  if (!json) stdout.write(`${context.paint.accent('◉')} ${context.paint.dim('Watching your folders. Ctrl+C stops.')}\n`);
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  while (!stopped) {
    const { cursor: next, events } = await context.call('events', cursor);
    cursor = next;
    for (const event of events) {
      stdout.write(json ? `${JSON.stringify(event)}\n` : `${renderEvent(event, context.paint, context.columns).join('\n')}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return 0;
}

const invokedDirectly = (() => {
  try { return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]); } catch { return false; }
})();

if (invokedDirectly) {
  process.title = 'lasso';
  main().then((code) => {
    process.exitCode = code;
    // The engine's history readers may hold the loop open; the answer is out.
    setTimeout(() => process.exit(code), 50).unref();
  }, (error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
