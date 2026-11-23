import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createApplication } from '../src/server.js';
import { openBackend } from '../src/cli/backend.js';
import { interpret } from '../src/cli/commands.js';
import { LineEditor } from '../src/cli/editor.js';
import { main } from '../src/cli/main.js';
import { mascotLines, wordmarkLines } from '../src/cli/pixels.js';
import { numbersIn } from '../src/cli/provenance.js';
import { runShell } from '../src/cli/shell.js';
import { createPainter, strip, truncate, width } from '../src/cli/style.js';
import { Screen } from './fixtures/screen.js';

// No Spotlight, quarantine marks or git: these tests read only Lasso's record.
const OFFLINE = Object.freeze({ platform: 'test', gitInstalled: false, run: () => null });

const me = { id: 'human:desktop', displayName: 'Desktop', actorType: 'HUMAN_SELF' };
const bo = { id: 'human:bo', displayName: 'Bo Lindqvist', actorType: 'HUMAN_COLLABORATOR' };
const chatgpt = { id: 'agent:chatgpt', displayName: 'ChatGPT', actorType: 'AI_AGENT' };

const income = (revenue, depreciation, supplies) => 'Account,Current Period,Prior Period\n'
  + `Revenue,${revenue},3980000\nDepreciation-Direct,${depreciation},590\nOffice Supplies,${supplies},310\nPayroll tax,225,210\n`;

const MEMO = '# Q3 board memo\n\nRevenue reached 4,200,000 this quarter.\n\n'
  + 'Depreciation held at 612, and office supplies came to 438.\n\nWe hired 14 people in 2025.\n';

/**
 * Two folders: Finance, whose income statement Bo edits after a copy of it
 * was mailed out, and Reports, whose notes ChatGPT edits. A memo outside
 * both quotes the statement's first numbers.
 */
function buildLibrary(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-cli-test-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(sandbox, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  write('Finance/Q3/Income-Statement.csv', income(4200000, 612, 400));
  write('Reports/notes.md', '# Notes\n\nThe intro is long.\n\nKeep the appendix.\n');
  const dataDir = path.join(sandbox, 'library');
  const application = createApplication({ dataDir, watchProjects: false });
  const finance = application.timeline.importProject(path.join(sandbox, 'Finance'), me).project;
  const reports = application.timeline.importProject(path.join(sandbox, 'Reports'), me).project;
  application.dependencies.ensureIndex(finance.id);
  application.dependencies.ensureIndex(reports.id);
  const attachment = path.join(sandbox, 'Income-Statement (from email).csv');
  fs.copyFileSync(path.join(sandbox, 'Finance/Q3/Income-Statement.csv'), attachment);
  write('Finance/Q3/Income-Statement.csv', income(4215500, 684, 438));
  application.timeline.capture(finance.id, bo);
  application.dependencies.ensureIndex(finance.id);
  write('Reports/notes.md', '# Notes\n\nA shorter intro.\n\nKeep the appendix.\n');
  application.timeline.capture(reports.id, chatgpt, { source: 'AGENT_EDIT' });
  application.dependencies.ensureIndex(reports.id);
  const memo = write('memo.md', MEMO);
  return { sandbox, dataDir, attachment, memo, close: () => application.close() };
}

async function openLibrary(t) {
  const library = buildLibrary(t);
  await library.close();
  const backend = openBackend({ dataDir: library.dataDir, cwd: library.sandbox, readHistory: false, system: OFFLINE });
  t.after(() => backend.close());
  return { ...library, backend };
}

test('whence names the recorded version a copied file matches, and who replaced it', async (t) => {
  // Arrange
  const { backend, attachment } = await openLibrary(t);

  // Act
  const answer = await backend.call('whence', attachment);

  // Assert
  assert.equal(answer.matches.length, 1);
  const [match] = answer.matches;
  assert.equal(match.folder.name, 'Finance');
  assert.equal(match.path, 'Q3/Income-Statement.csv');
  assert.equal(match.version, 1);
  assert.equal(match.how, 'IMPORT');
  assert.equal(match.current, false);
  assert.equal(match.replaced.actor.name, 'Bo Lindqvist');
  assert.equal(match.replaced.version, 2);
});

test('whence says when no recorded version has a file\'s bytes, and lists files with its name', async (t) => {
  // Arrange
  const { backend, sandbox } = await openLibrary(t);
  const edited = path.join(sandbox, 'Downloads', 'Income-Statement.csv');
  fs.mkdirSync(path.dirname(edited), { recursive: true });
  fs.writeFileSync(edited, income(1, 2, 3));

  // Act
  const answer = await backend.call('whence', edited);

  // Assert
  assert.deepEqual(answer.matches, []);
  assert.deepEqual(answer.sameName.map((file) => `${file.folder}/${file.path}`), ['Finance/Q3/Income-Statement.csv']);
});

test('log lists who changed what, newest first, and narrows to AI agents', async (t) => {
  // Arrange
  const { backend } = await openLibrary(t);

  // Act
  const everything = await backend.call('log', {});
  const agents = await backend.call('log', { by: 'ai' });

  // Assert
  const edits = everything.entries.filter((entry) => entry.change === 'edited');
  assert.deepEqual(edits.map((entry) => entry.actor.name), ['ChatGPT', 'Bo Lindqvist']);
  assert.equal(edits[1].valueChanges.count, 3);
  assert.deepEqual(agents.entries.map((entry) => `${entry.folder}/${entry.path}`), ['Reports/notes.md']);
});

test('blame names who last set each cell of a file', async (t) => {
  // Arrange
  const { backend } = await openLibrary(t);

  // Act
  const answer = await backend.call('blame', 'Income-Statement.csv');

  // Assert
  const byLabel = new Map(answer.rows.map((row) => [row.label, row]));
  assert.equal(byLabel.get('Depreciation-Direct · Current Period').actor.name, 'Bo Lindqvist');
  assert.equal(byLabel.get('Depreciation-Direct · Current Period').before, '612');
  assert.equal(byLabel.get('Payroll tax · Current Period').actor.name, 'Desktop');
  assert.ok(answer.rows.every((row) => !/included rows/.test(row.label)), 'a table\'s row count is not a value anyone set');
});

test('diff shows the cells a save changed, and an earlier version when asked', async (t) => {
  // Arrange
  const { backend } = await openLibrary(t);

  // Act
  const latest = await backend.call('diff', 'Q3/Income-Statement.csv');
  const first = await backend.call('diff', 'Q3/Income-Statement.csv', { version: 'v1' });

  // Assert
  assert.equal(latest.chosen.actor.name, 'Bo Lindqvist');
  assert.deepEqual(latest.detail.table.cells.map((cell) => `${cell.row}: ${cell.before} → ${cell.after}`),
    ['Revenue: 4200000 → 4215500', 'Depreciation-Direct: 612 → 684', 'Office Supplies: 400 → 438']);
  assert.equal(first.chosen.version, 1);
  await assert.rejects(backend.call('diff', 'Q3/Income-Statement.csv', { version: 'v9' }), /did not change in version 9/);
});

test('verify finds which numbers in a document match, which are stale and which have no source', async (t) => {
  // Arrange
  const { backend, memo } = await openLibrary(t);

  // Act
  const answer = await backend.call('verify', memo);

  // Assert
  const byNumber = new Map(answer.results.map((result) => [result.number, result]));
  assert.equal(byNumber.get('4,200,000').status, 'stale');
  assert.equal(byNumber.get('4,200,000').source.currentValue, '4215500');
  assert.equal(byNumber.get('612').status, 'stale');
  assert.equal(byNumber.get('612').change.actor.name, 'Bo Lindqvist');
  assert.equal(byNumber.get('438').status, 'current');
  assert.equal(byNumber.get('14').status, 'unsourced');
  assert.equal(byNumber.has('2025'), false, 'a year names no value');
  assert.deepEqual(answer.tally, { current: 1, stale: 2, ambiguous: 0, unsourced: 1 });
});

test('watch reports each change recorded after its cursor, with the values it changed', async (t) => {
  // Arrange
  const { backend } = await openLibrary(t);

  // Act
  const { cursor, events } = await backend.call('events', 0);
  const later = await backend.call('events', cursor);

  // Assert
  const edit = events.find((event) => event.actor.name === 'Bo Lindqvist');
  assert.deepEqual(edit.files, [{ change: 'MODIFIED', path: 'Q3/Income-Statement.csv' }]);
  assert.ok(edit.values.some((value) => value.before === '612' && value.after === '684'));
  assert.equal(cursor, await backend.call('cursor'));
  assert.deepEqual(later.events, []);
});

test('a document\'s numbers leave out years, dates, list numbers and single digits', () => {
  // Arrange
  const text = '1. Revenue was 4,200 in 2024.\nOn Nov 21 we sold 7 units and 38.5% more.\nShipped on 2026-11-21, code Q3.';

  // Act
  const numbers = numbersIn(text).map((number) => number.raw);

  // Assert
  assert.deepEqual(numbers, ['4,200', '38.5%']);
});

test('one-shot lasso prints an answer, prints JSON when asked, and exits 1 when a number is stale', async (t) => {
  // Arrange
  const library = buildLibrary(t);
  await library.close();
  const run = async (...words) => {
    let text = '';
    const stdout = { columns: 100, isTTY: false, write: (chunk) => { text += chunk; return true; } };
    const code = await main(['--data-dir', library.dataDir, ...words], { stdout, stdin: { isTTY: false }, env: {} });
    return { code, text };
  };

  // Act
  const log = await run('log');
  const json = await run('--json', 'blame', 'Income-Statement.csv');
  const verified = await run('verify', library.memo);
  const unknown = await run('/frobnicate');

  // Assert
  assert.equal(log.code, 0);
  assert.match(log.text, /Bo Lindqvist edited Finance\/Q3\/Income-Statement\.csv/);
  assert.doesNotMatch(log.text, /\u001b\[/, 'piped output has no colour codes');
  assert.equal(JSON.parse(json.text).folder.name, 'Finance');
  assert.equal(verified.code, 1);
  assert.match(verified.text, /⚠ 2 stale/);
  assert.equal(unknown.code, 2);
  assert.match(unknown.text, /There is no \/frobnicate/);
});

test('the shell opens with the mascot, runs a slash command, completes from the menu and leaves on Ctrl+D', async (t) => {
  // Arrange
  const library = buildLibrary(t);
  await library.close();
  const screen = new Screen({ columns: 100 });
  const output = { columns: 100, isTTY: true, write: (chunk) => screen.write(chunk), on() {} };
  const input = new PassThrough();
  const shown = async (text, timeout = 15_000) => {
    const started = Date.now();
    while (!screen.text().includes(text)) {
      if (Date.now() - started > timeout) assert.fail(`never showed ${text}:\n${screen.text()}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const type = async (keys) => {
    for (const key of keys) {
      input.write(key);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };

  // Act
  const finished = runShell({ dataDir: library.dataDir, cwd: library.sandbox, paint: createPainter('truecolor'), version: '9.9.9',
    intro: false, input, output, historyFile: path.join(library.sandbox, 'history') });
  await shown('for commands');
  const welcome = screen.text();
  await type(['/', 'b', 'l']);
  await shown('who wrote what in a file');
  await type(['\t', 'I', 'n', 'c']);
  await shown('Q3/Income-Statement.csv');
  await type(['\t', '\r']);
  await shown('was 612');
  await type(['\u0004']);
  const code = await finished;

  // Assert
  assert.match(welcome, /Welcome back/);
  assert.match(welcome, /▀█▄██████████▄█▀/, 'the mascot\'s hat brim');
  assert.match(welcome, /Recent activity/);
  assert.match(welcome, /ChatGPT edited notes\.md/);
  assert.match(screen.text(), /› \/blame Q3\/Income-Statement\.csv/);
  assert.match(screen.text(), /Happy trails/);
  assert.equal(code, 0);
  assert.deepEqual(fs.readFileSync(path.join(library.sandbox, 'history'), 'utf8').trim().split('\n'), ['/blame Q3/Income-Statement.csv']);
});

test('the line editor moves and deletes by word and walks history, keeping the line being typed', () => {
  // Arrange
  const editor = new LineEditor({ history: ['log', 'blame model.csv'] });
  editor.insert('trace revenue');

  // Act and Assert
  editor.wordLeft();
  editor.insert('q3-');
  assert.equal(editor.text, 'trace q3-revenue');
  editor.end();
  editor.deleteWordBack();
  assert.equal(editor.text, 'trace ');
  editor.historyUp();
  assert.equal(editor.text, 'blame model.csv');
  editor.historyDown();
  assert.equal(editor.text, 'trace ');
  assert.equal(editor.commit(), 'trace ');
  assert.deepEqual(editor.history, ['log', 'blame model.csv', 'trace ']);
});

test('a typed line runs its command with or without a slash, a question asks, and other words search', () => {
  assert.equal(interpret('/blame model.csv').command.name, 'blame');
  assert.equal(interpret('blame model.csv').command.name, 'blame');
  assert.equal(interpret('which value is revenue?').command.name, 'ask');
  assert.equal(interpret('depreciation').command.name, 'find');
  assert.equal(interpret('/nope').unknown, 'nope');
});

test('the mascot and wordmark keep their shape without colour, and painted text measures as it shows', () => {
  // Arrange
  const plain = createPainter('none');
  const painted = createPainter('truecolor');

  // Act
  const mascot = mascotLines(plain);
  const word = wordmarkLines(plain);
  const green = painted.green('Revenue · Q3');

  // Assert
  assert.equal(mascot.length, 6);
  assert.match(mascot[3], /███ ██ ███/, 'the eyes are holes in the body');
  assert.equal(word[2], '█▄▄▄ █  █ ▄▄▄▀ ▄▄▄▀ ▀▄▄▀');
  assert.equal(width(green), 12);
  assert.equal(strip(truncate(green, 8)), 'Revenue…');
});
