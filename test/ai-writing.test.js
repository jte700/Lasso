import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../src/server.js';
import { CitedText, citedPieces } from '../src/writing/cited-text.js';
import { WritingSources } from '../src/writing/source-tools.js';

const actor = { id: 'human:ai-writing', displayName: 'AI writing', actorType: 'HUMAN_SELF' };
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));

function writeProject(root) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Budget 2026.csv'), ['Category,Amount,Notes', 'Travel,4200,Site visits and the March workshop',
    'Equipment,18400,Two survey drones and a base station', 'Staff,31500,One field engineer for nine months',
    'Total,54100,Approved budget', ''].join('\n'));
  fs.writeFileSync(path.join(root, 'Kickoff notes.md'), ['# Harbour survey kickoff', '',
    'The steering group approved the budget on 3 March 2026, with travel capped at 7% of the total.', '',
    'Priya Raman leads the field work and reports to the steering group every month.', ''].join('\n'));
}

// A stand-in Codex the server can start: this Node running the scripted app server.
function fakeCodex(sandbox) {
  const launcher = path.join(sandbox, 'codex');
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`, { mode: 0o755 });
  return launcher;
}

/** A library with the Harbour folder and a second one, served with the stand-in Codex. */
async function library(t, { environment = {}, ...overrides } = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-ai-writing-'));
  const harbour = path.join(sandbox, 'Harbour');
  const other = path.join(sandbox, 'Other');
  writeProject(harbour);
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'Costs.csv'), 'Item,Amount\nBudget overrun,950\n');
  const log = path.join(sandbox, 'codex.log');
  const before = { ...process.env };
  Object.assign(process.env, { FAKE_CODEX_LOG: log, ...environment });
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, codexPath: fakeCodex(sandbox), ...overrides });
  await app.workspace.add([fs.realpathSync(harbour), fs.realpathSync(other)], actor);
  t.after(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const ids = Object.fromEntries(app.workspace.state().directories.map((directory) => [directory.name, directory.id]));
  const requests = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry)) : []);
  return { app, harbour: ids.Harbour, other: ids.Other, requests };
}

async function serve(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

/** A prompt posted to the server, and the events it answered with. */
async function written(base, body) {
  const response = await fetch(`${base}/api/writing`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'chatgpt', ...body }) });
  assert.equal(response.status, 200);
  return (await response.text()).trim().split('\n').map((entry) => JSON.parse(entry));
}

test('a citation mark cut across deltas is read whole', () => {
  const reader = new CitedText();
  const pieces = ['Equipment is [', '[3|18,', '400]', '] in all.'].flatMap((delta) => reader.push(delta));
  pieces.push(...reader.end());
  assert.deepEqual(pieces, [{ text: 'Equipment is ' }, { text: '18,400', source: 3 }, { text: ' in all.' }]);
});

test('brackets that are not a citation stay as written', () => {
  assert.deepEqual(citedPieces('See [[the appendix]] and item [2].'), [{ text: 'See [[the appendix]] and item [2].' }]);
});

test('a citation never closed keeps its words and loses its brackets', () => {
  assert.deepEqual(citedPieces('Travel is [[1|4,200'), [{ text: 'Travel is 4,200' }]);
});

test('a file found by its name comes back with its rows, each numbered', async (t) => {
  const { app, harbour } = await library(t);
  const sources = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: harbour });
  const shown = sources.search(['budget']);
  assert.match(shown, /Budget 2026\.csv/);
  const equipment = /\[(\d+)\] Equipment · Amount: 18400/.exec(shown);
  assert.ok(equipment, shown);
  assert.match(shown, /\[\d+\] The steering group approved the budget on 3 March 2026/);
  // Rows read in the sheet's order, whichever matched first.
  assert.ok(shown.indexOf('Travel · Amount') < shown.indexOf('Equipment · Amount'));
  const source = sources.source(Number(equipment[1]));
  assert.equal(source.path, 'Budget 2026.csv');
  assert.equal(source.valueText, '18400');
  assert.equal(source.projectId, harbour);
  assert.equal(app.dependencies.objectById(source.id).id, source.id);
});

test('a folder chosen with the switcher is the only one searched', async (t) => {
  const { app, harbour, other } = await library(t);
  const everywhere = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies });
  assert.match(everywhere.search(['budget']), /Budget overrun/);
  const chosen = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: harbour });
  assert.doesNotMatch(chosen.search(['budget']), /Budget overrun/);
  const elsewhere = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: other });
  assert.doesNotMatch(elsewhere.search(['budget']), /Equipment/);
});

test('opening a numbered source reads its whole file in order', async (t) => {
  const { app, harbour } = await library(t);
  const sources = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: harbour });
  const number = /\[(\d+)\] Priya Raman leads/.exec(sources.search(['Priya']))?.[1];
  assert.ok(number);
  const opened = sources.open(Number(number));
  assert.ok(opened.indexOf('The steering group approved') < opened.indexOf('Priya Raman leads'));
  assert.match(sources.open(999), /No source \[999\]/);
});

test('a folder kept as a search index is searched the same way', async (t) => {
  const { app, harbour } = await library(t, { searchIndexObjects: 0 });
  assert.ok(app.dependencies.searchIndexFor(harbour), 'the folder is searched through its index');
  const sources = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: harbour });
  const shown = sources.search(['budget']);
  assert.match(shown, /\[\d+\] Equipment · Amount: 18400/);
  assert.match(shown, /The steering group approved the budget/);
});

test('a prompt is answered as words to write, the cited ones with their source', async (t) => {
  const { app, harbour, requests } = await library(t);
  const base = await serve(app);
  const events = await written(base, { prompt: 'Write a message detailing the budget', onlyProjectId: harbour });
  assert.deepEqual(events[0], { type: 'status', status: 'searching', detail: 'budget' });
  assert.equal(events.at(-1).type, 'done');
  const words = events.filter((event) => ['text', 'cite'].includes(event.type));
  const whole = words.map((event) => event.text).join('');
  // The answer starts at its first word; marks, and what was said before the lookup, are not written.
  assert.match(whole, /^Travel · Amount is 4200\. Travel · Notes is Site visits and the March workshop\. Nothing else is known \[here\]\.$/);
  const cited = words.filter((event) => event.type === 'cite');
  assert.deepEqual(cited.map((event) => event.text), ['4200', 'Site visits and the March workshop']);
  assert.equal(events.at(-1).cited, 2);
  for (const event of cited) {
    assert.equal(event.source.projectId, harbour);
    assert.equal(event.source.path, 'Budget 2026.csv');
    assert.ok(event.source.versionId && event.source.snapshotId);
    assert.equal(app.dependencies.objectById(event.source.id).id, event.source.id);
  }
  // The writer was started as a writer: Lasso's instructions and tools, no files of its own to change.
  const thread = requests().find((entry) => entry.method === 'thread/start').params;
  assert.match(thread.baseInstructions, /\[\[n\|words\]\]/);
  assert.deepEqual(thread.dynamicTools.map((tool) => tool.name), ['lasso_search', 'lasso_open']);
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.ephemeral, true);
});

test('a writer that fails says why and writes nothing', async (t) => {
  const { app } = await library(t);
  const base = await serve(app);
  const events = await written(base, { prompt: 'fail on the budget' });
  // Lasso's own first search ran; nothing came of the writer.
  assert.deepEqual(events.map((event) => event.type), ['status', 'error']);
  assert.match(events[1].message, /usage limit/);
});

test('closing the connection stops the writer', async (t) => {
  const { app, requests } = await library(t);
  const base = await serve(app);
  const stop = new AbortController();
  const response = await fetch(`${base}/api/writing`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'chatgpt', prompt: 'slow budget' }), signal: stop.signal });
  // Read until the writer's first words arrive, then hang up.
  const reader = response.body.getReader();
  let received = '';
  while (!received.includes('"Starting"')) received += new TextDecoder().decode((await reader.read()).value);
  stop.abort();
  for (let waited = 0; waited < 100 && !requests().some((entry) => entry.method === 'turn/interrupt'); waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(requests().some((entry) => entry.method === 'turn/interrupt'), 'the turn was interrupted');
});

test('a writer that is not signed in is reported before anything is asked of it', async (t) => {
  const { app } = await library(t, { environment: { FAKE_CODEX_SIGNED_OUT: '1' } });
  const base = await serve(app);
  const prepared = await (await fetch(`${base}/api/writing/agents/chatgpt/prepare`, { method: 'POST' })).json();
  assert.equal(prepared.ready, false);
  assert.equal(prepared.code, 'writer-signed-out');
  const events = await written(base, { prompt: 'the budget' });
  assert.deepEqual(events.map((event) => event.code), ['writer-signed-out']);
});

test('a Codex that refuses the switched-off features is started without them', async (t) => {
  const { app } = await library(t, { environment: { FAKE_CODEX_REJECT_FLAGS: '1' } });
  const base = await serve(app);
  const prepared = await (await fetch(`${base}/api/writing/agents/chatgpt/prepare`, { method: 'POST' })).json();
  assert.deepEqual(prepared, { ready: true, plan: 'plus' });
});

test('without Codex the writer is listed as unavailable and a prompt says what to do', async (t) => {
  const { app } = await library(t, { codexPath: path.join(os.tmpdir(), 'no-codex-here') });
  const base = await serve(app);
  const { agents } = await (await fetch(`${base}/api/writing/agents`)).json();
  assert.deepEqual(agents, [{ id: 'chatgpt', name: 'ChatGPT', available: false }]);
  const events = await written(base, { prompt: 'the budget' });
  assert.equal(events[0].code, 'writer-missing');
  assert.match(events[0].message, /Install the ChatGPT app/);
});

test('Lasso looks up the prompt\'s own words before the writer is asked', async (t) => {
  const { app, harbour, requests } = await library(t);
  const sources = new WritingSources({ workspace: app.workspace, dependencies: app.dependencies, onlyProjectId: harbour });
  const first = sources.firstSearch('Write a message detailing the budget');
  assert.equal(first.query, 'budget');
  assert.match(first.text, /Equipment · Amount: 18400/);
  // Words that only say what to do name nothing to look up.
  assert.equal(sources.firstSearch('Write a short message please'), null);
  assert.deepEqual(requests(), [], 'no writer was started for it');
});

test('stopping Lasso while the writer is starting leaves no writer running', async (t) => {
  const { app, requests } = await library(t);
  const starting = app.writing.prepare('chatgpt');
  app.writing.close();
  await assert.rejects(starting, /Stopped/);
  // A stop is not a refusal of the switched-off features: nothing is started a second time.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(requests().filter((entry) => entry.method === 'initialize').length <= 1);
  assert.equal(app.writing.codex.child, null);
});

test('a prompt needs words and a writer Lasso knows', async (t) => {
  const { app } = await library(t);
  const base = await serve(app);
  const post = (body) => fetch(`${base}/api/writing`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ agent: 'chatgpt', prompt: '   ' })).status, 400);
  assert.equal((await post({ agent: 'someone-else', prompt: 'the budget' })).status, 404);
});
