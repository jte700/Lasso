import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openEngine } from '../src/agent/engine.js';
import { blockRange, definitions, parseLineRange } from '../src/agent/evidence.js';
import { isSecretPath } from '../src/agent/scope.js';
import { fileLines } from '../src/dependencies/code-lines.js';
import { actor, agent, agentLibrary, API_APP, WEB_APP } from './fixtures/agent-library.js';

function engineFor(t, dataDir, scope = ['*']) {
  const engine = openEngine({ dataDir, scope });
  t.after(() => engine.close());
  return engine;
}

const items = (engine, ...requested) => engine.evidence.inspect({ items: requested }).items;

test('an inclusive line range returns exactly those lines of the indexed revision, numbered as the file numbers them', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const response = engine.evidence.inspect({ items: [{ file: 'app.py', folder: 'Api', lines: '5-12' }] });
  const [lines] = response.items;

  // Assert
  assert.deepEqual(lines.lines, [5, 12]);
  assert.equal(lines.text.split('\n').length, 8, 'lines 5-12 are eight lines');
  assert.equal(lines.text, API_APP.split('\n').slice(4, 12).join('\n'), 'indentation and blank lines are kept exactly');
  assert.equal(lines.total, fileLines(API_APP).length);
  assert.match(lines.h, /^[0-9A-Z]{10}$/);
  assert.deepEqual(Object.keys(response.sources[lines.src]), ['folder', 'path', 'rev'], 'an unchanged, current file needs no more');
  assert.equal(response.sources[lines.src].path, 'app.py');
  assert.equal(response.sources[lines.src].rev.length, 12);
  const numbered = items(engine, { file: 'app.py', folder: 'Api', lines: '5-6', numbered: true })[0];
  assert.equal(numbered.text, '5\tdef handle(request):\n6\t    """Return every item."""');
});

test('indexed line reads equal reading the file directly, for every range tried (literal-query parity)', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  const files = [['Api', 'app.py', API_APP], ['Web', 'src/server.js', WEB_APP]];
  let seed = 7;
  const random = (limit) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return 1 + (seed % limit); };

  // Act and assert
  for (const [folder, file, source] of files) {
    const all = fileLines(source);
    for (let trial = 0; trial < 40; trial += 1) {
      const first = random(all.length);
      const last = Math.min(all.length, first + random(6) - 1);
      const [read] = items(engine, { file, folder, lines: `${first}-${last}` });
      assert.equal(read.text, all.slice(first - 1, last).join('\n'), `${file} ${first}-${last}`);
    }
  }
  assert.equal(items(engine, { file: 'app.py', folder: 'Api', lines: '19-25' })[0].error.code, 'out_of_range');
  assert.equal(items(engine, { file: 'app.py', folder: 'Api', lines: '1-2000' })[0].error.code, 'out_of_range');
});

test('a file name two folders share is reported as ambiguous, and a folder or longer path settles it', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const [bare, named, prefixed, longer] = items(engine,
    { file: 'app.py', lines: '1' }, { file: 'app.py', folder: 'Web', lines: '1' },
    { file: 'Web/src/app.py', lines: '1' }, { file: 'src/app.py', lines: '1' });
  const suggested = engine.evidence.suggest({ queries: [{ text: 'app.py', kind: 'file' }] }).results[0];

  // Assert
  assert.equal(bare.error.code, 'ambiguous', 'a root app.py does not win over another folder\'s src/app.py');
  assert.deepEqual(bare.error.matches.map((match) => `${match.folder}/${match.path}`).sort(), ['Api/app.py', 'Web/src/app.py']);
  assert.equal(named.text, '# The web front end lives in server.js');
  assert.equal(prefixed.text, named.text);
  assert.equal(longer.text, named.text);
  assert.equal(suggested.candidates.length, 2, 'suggest lists every file of that name');
  assert.equal(suggested.coverage.exhausted, true);
});

test('a referenced revision is read as it was, never replaced by the current one', async (t) => {
  // Arrange
  const { app, dataDir, sandbox, folders } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  const before = items(engine, { file: 'src/server.js', lines: '3-9' })[0];
  const oldRev = engine.evidence.inspect({ items: [{ file: 'src/server.js', lines: '3' }] }).sources.s1.rev;
  fs.writeFileSync(path.join(sandbox, 'Web', 'src', 'server.js'), `// Entry point\n// Second header line\n${WEB_APP}`);
  app.timeline.capture(folders.Web, actor);

  // Act
  const response = engine.evidence.inspect({ items: [
    { file: 'src/server.js', lines: '3-9', rev: oldRev },
    { file: 'src/server.js', lines: '3-9' },
    { h: before.h },
    { file: 'src/server.js', lines: '3-9', rev: 'deadbeefdeadbeef' },
  ] });
  const [pinned, current, byHandle, unknown] = response.items;
  const outline = items(engine, { file: 'src/server.js' })[0];
  const [handlePinned, valueRev] = items(engine, { h: outline.h, lines: '3-9', rev: oldRev },
    { h: engine.evidence.suggest({ queries: [{ text: 'grant' }] }).results[0].candidates[0].h, rev: oldRev });

  // Assert
  assert.equal(pinned.text, before.text, 'the old revision keeps its own line 3');
  assert.equal(pinned.historical, true);
  assert.notEqual(pinned.current, oldRev, 'the response names the newer revision without using it');
  assert.equal(current.text, WEB_APP.split('\n').slice(0, 7).join('\n'), 'the current revision has shifted lines');
  assert.equal(byHandle.text, before.text, 'a handle keeps naming the revision it was issued for');
  assert.equal(unknown.error.code, 'revision_not_found');
  assert.equal(handlePinned.text, before.text, 'a revision asked for with a handle is the one read');
  assert.equal(handlePinned.historical, true);
  assert.equal(valueRev.error.code, 'invalid_request', 'never silently ignored');
});

test('a file changed on disk since indexing is flagged, and version "disk" reads it as unindexed', async (t) => {
  // Arrange
  const { dataDir, sandbox } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  fs.writeFileSync(path.join(sandbox, 'Api', 'app.py'), `# edited\n${API_APP}`);

  // Act
  const response = engine.evidence.inspect({ items: [
    { file: 'app.py', folder: 'Api', lines: '1' },
    { file: 'app.py', folder: 'Api', lines: '1', version: 'disk' },
  ] });
  const [indexed, disk] = response.items;

  // Assert
  assert.equal(indexed.text, 'import json');
  assert.equal(response.sources[indexed.src].disk, 'changed');
  assert.match(response.warnings[0], /^Api\/app\.py changed on disk after Lasso indexed it/, 'said in words, not only flagged');
  assert.equal(disk.text, '# edited');
  assert.equal(disk.unindexed, true);
  assert.equal(disk.h, undefined, 'unindexed bytes get no handle to bind');
});

test('credential files and paths excluded from suggestions never reach an agent', async (t) => {
  // Arrange
  const { app, dataDir, folders } = await agentLibrary(t);
  app.terminal.rules.add(folders.Finance, { sentence: 'when source path starts with Private then exclude from autocomplete' }, actor);
  const engine = engineFor(t, dataDir);

  // Act
  const searched = engine.evidence.suggest({ queries: [
    { id: 'secret', text: 'hunter2-secret' }, { id: 'env', text: '.env', kind: 'file' },
    { id: 'salary', text: 'Avery' }, { id: 'private', text: 'salaries.csv', kind: 'file' },
  ] });
  const [env, salaries] = items(engine, { file: '.env', folder: 'Finance', lines: '1' }, { file: 'Private/salaries.csv', lines: '1' });

  // Assert
  for (const result of searched.results) assert.deepEqual(result.candidates, [], result.id);
  assert.equal(env.error.code, 'not_found');
  assert.equal(salaries.error.code, 'not_found');
  assert.ok(isSecretPath('config/.env.production'));
  assert.ok(isSecretPath('home/.ssh/config'));
  assert.ok(!isSecretPath('src/environment.js'));
});

test('an agent sees only its scope, and a handle from outside it is refused', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const everything = engineFor(t, dataDir, ['*']);
  const apiOnly = engineFor(t, dataDir, ['Api']);
  const unconfigured = engineFor(t, dataDir, []);
  const financeHandle = everything.evidence.suggest({ queries: [{ text: 'North division' }] }).results[0].candidates
    .flatMap((candidate) => [candidate.h, ...Object.values(candidate.fields ?? {}).map((field) => field.h)]).find(Boolean);

  // Act
  const scoped = apiOnly.evidence.suggest({ queries: [{ text: 'North division' }, { text: 'app.py', kind: 'file' }] });
  const [refused, folders] = items(apiOnly, { h: financeHandle }, { folders: true });

  // Assert
  assert.deepEqual(scoped.results[0].candidates, []);
  assert.deepEqual(scoped.results[1].candidates.map((candidate) => scoped.sources[candidate.src].folder), ['Api']);
  assert.equal(refused.error.code, 'unauthorized');
  assert.deepEqual(folders.folders.map((folder) => folder.name), ['Api']);
  assert.throws(() => unconfigured.evidence.suggest({ queries: [{ text: 'app' }] }), { code: 'scope_not_configured' });
});

test('a record query bundles the asked fields per row and keeps competing sources apart', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const response = engine.evidence.suggest({ queries: [{ id: 'g1', text: 'North division', fields: ['Revenue', 'Reporting period', 'Scenario'] }] });
  const records = response.results[0].candidates.filter((candidate) => candidate.type === 'record' && candidate.row === 'North division');

  // Assert
  assert.equal(records.length, 2, 'the planning and the approved budget are both offered');
  const byScenario = Object.fromEntries(records.map((record) => [record.fields.Scenario.value, record]));
  assert.equal(byScenario.Planning.fields.Revenue.value, '12.4');
  assert.equal(byScenario.Approved.fields.Revenue.value, '11.9');
  assert.equal(response.sources[byScenario.Planning.src].path, 'Planning/budget.csv');
  assert.equal(response.sources[byScenario.Approved.src].path, 'Approved/budget.csv');
  for (const record of records) {
    assert.deepEqual(Object.keys(record.fields), ['Revenue', 'Reporting period', 'Scenario']);
    for (const field of Object.values(record.fields)) assert.match(field.h, /^[0-9A-Z]{10}$/);
  }
});

test('bind records chosen evidence, enforces explicit constraints and inserts the recorded literals', async (t) => {
  // Arrange
  const { app, dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  const records = engine.evidence.suggest({ queries: [{ text: 'division', fields: ['Revenue', 'Reporting period'] }] })
    .results[0].candidates.filter((candidate) => candidate.type === 'record');
  const north = records.find((record) => record.row === 'North division' && record.fields.Revenue.value === '12.4');
  const south = records.find((record) => record.row === 'South division');
  const usageBefore = app.db.prepare('SELECT COUNT(*) AS n FROM recommendation_usage').get().n;

  // Act
  const mixed = () => engine.evidence.bind({ task: 't1', bind: { revenue: north.fields.Revenue.h, period: south.fields['Reporting period'].h },
    same_record: [['revenue', 'period']] }, agent);
  const unbound = () => engine.evidence.bind({ task: 't-other', bind: { revenue: north.fields.Revenue.h }, template: '{{revenue}} in {{period}}' }, agent);
  const human = () => engine.evidence.bind({ task: 't1', bind: { revenue: north.fields.Revenue.h } }, actor);
  const bound = engine.evidence.bind({ task: 't1', bind: { revenue: north.fields.Revenue.h, period: north.fields['Reporting period'].h },
    same_record: [['revenue', 'period']], template: 'North division reported {{revenue}} for {{period}}.' }, agent);
  const southBound = engine.evidence.bind({ task: 't1', bind: { south: south.fields.Revenue.h },
    template: 'South: {{south}}; North: {{revenue}}.', cite: 'none' }, agent);

  // Assert
  assert.throws(mixed, { code: 'inconsistent' });
  assert.throws(unbound, { code: 'unbound' });
  assert.throws(human, { code: 'unauthorized' }, 'a request cannot record a binding as a person');
  assert.equal(bound.text, 'North division reported 12.4 [1] for FY2025 [2].');
  assert.deepEqual(bound.citations.map((citation) => [citation.n, citation.path]), [[1, 'Planning/budget.csv'], [2, 'Planning/budget.csv']]);
  assert.equal(bound.fields.revenue.now, 'same');
  assert.equal(southBound.text, 'South: 9.10; North: 12.4.', 'literals keep their written form (9.10, not 9.1), and earlier bindings render');
  const rows = app.db.prepare("SELECT b.field, a.actor_type FROM agent_bindings b JOIN actors a ON a.id = b.actor_id WHERE task_id = 't1' ORDER BY b.id").all();
  assert.deepEqual(rows.map((row) => [row.field, row.actor_type]), [['revenue', 'AI_AGENT'], ['period', 'AI_AGENT'], ['south', 'AI_AGENT']]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM recommendation_usage').get().n, usageBefore, 'agent choices never feed human ranking');
});

test('a bound value reports a later change at its source without moving the citation', async (t) => {
  // Arrange
  const { app, dataDir, sandbox, folders } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  const line = items(engine, { file: 'src/server.js', lines: '3' })[0];
  engine.evidence.bind({ task: 't2', bind: { entry: line.h } }, agent);
  fs.writeFileSync(path.join(sandbox, 'Web', 'src', 'server.js'), WEB_APP.replace('export function start(port)', 'export function start(port, host)'));
  app.timeline.capture(folders.Web, actor);

  // Act
  const rendered = engine.evidence.bind({ task: 't2', template: '`{{entry}}`', cite: 'none' }, agent);

  // Assert
  assert.equal(rendered.text, '`export function start(port) {`', 'the recorded literal is inserted, not the new line');
  assert.equal(rendered.fields.entry.now, 'changed');
});

test('pages continue where the last ended, a budget trims a response, and a cursor goes stale with the folders', async (t) => {
  // Arrange
  const rows = Array.from({ length: 30 }, (_, index) => `Item ${index + 1},${index * 10},Widget`).join('\n');
  const { app, dataDir, sandbox, folders } = await agentLibrary(t, { extra: { 'Finance/widgets.csv': `Name,Amount,Kind\n${rows}\n` } });
  const engine = engineFor(t, dataDir);

  // Act
  const first = engine.evidence.suggest({ queries: [{ id: 'w', text: 'widget', limit: 5 }] }).results[0];
  const second = engine.evidence.suggest({ queries: [{ id: 'w', text: 'widget', limit: 5, cursor: first.coverage.cursor }] }).results[0];
  const trimmed = engine.evidence.suggest({ queries: [{ id: 'w', text: 'widget', limit: 30 }], budget: 400 }).results[0];
  fs.writeFileSync(path.join(sandbox, 'Finance', 'more.csv'), 'Name,Kind\nGadget,Widget\n');
  app.timeline.capture(folders.Finance, actor);
  app.dependencies.ensureIndex(folders.Finance);
  const stale = engine.evidence.suggest({ queries: [{ id: 'w', text: 'widget', limit: 5, cursor: first.coverage.cursor }] }).results[0];

  // Assert
  assert.equal(first.coverage.more, true);
  assert.ok(first.coverage.total > 10);
  assert.equal(second.coverage.offset, 5);
  const seen = new Set(first.candidates.map((candidate) => candidate.h));
  assert.ok(second.candidates.every((candidate) => !seen.has(candidate.h)), 'no candidate repeats across pages');
  assert.ok(trimmed.candidates.length < 30);
  assert.equal(trimmed.coverage.budget, true);
  assert.equal(trimmed.coverage.more, true);
  assert.equal(stale.error.code, 'stale_cursor');
});

test('handles are stable across calls and resolve in another process\'s engine', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const first = engineFor(t, dataDir);
  const second = engineFor(t, dataDir);

  // Act
  const once = first.evidence.suggest({ queries: [{ text: 'grant' }] }).results[0].candidates[0];
  const again = first.evidence.suggest({ queries: [{ text: 'grant' }] }).results[0].candidates[0];
  const [expanded] = items(second, { h: once.h });
  const [unknown] = items(second, { h: 'ZZZZZZZZZZ' });

  // Assert
  assert.equal(once.h, again.h);
  assert.equal(expanded.type, 'passage');
  assert.match(expanded.text, /excludes the one-time grant/);
  assert.equal(unknown.error.code, 'expired_handle');
});

test('a definition is read as its whole block, and a file outline lists definitions by line', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const [handle, start, outline, missing] = items(engine,
    { file: 'app.py', folder: 'Api', symbol: 'handle' }, { file: 'src/server.js', symbol: 'start' },
    { file: 'app.py', folder: 'Api' }, { file: 'src/server.js', symbol: 'restart' });

  // Assert
  assert.deepEqual(handle.lines, [4, 8], 'the decorator belongs to the function');
  assert.equal(handle.text, API_APP.split('\n').slice(3, 8).join('\n'));
  assert.deepEqual(start.lines, [3, 9]);
  assert.deepEqual(outline.outline, ['5 handle', '11 load', '14 Store', '15 get', '18 put']);
  assert.equal(missing.error.code, 'not_found');
  assert.deepEqual(parseLineRange('lines 5-12'), [5, 12]);
  assert.deepEqual(parseLineRange([7]), [7, 7]);
  assert.throws(() => parseLineRange('12-5'), { code: 'invalid_request' });
  const lines = ['fn main() {', '    let x = "}";', '    println!("{}", x);', '}', 'fn other() {}'];
  assert.deepEqual(blockRange(lines, definitions(lines)[0]), { start: 1, end: 4, truncated: false });
});

test('the agent engine reads a library the desktop app has open, and leaves its drive state alone', async (t) => {
  // Arrange
  const { app, dataDir } = await agentLibrary(t);
  app.db.exec(`INSERT INTO removable_drives(id, name, root_path, connected, updated_at)
    VALUES ('drive-1', 'Card', '/Volumes/Card', 1, '2026-10-27T00:00:00Z')`);

  // Act
  const engine = engineFor(t, dataDir);
  const read = items(engine, { file: 'app.py', folder: 'Api', lines: '1' })[0];

  // Assert
  assert.equal(read.text, 'import json');
  assert.equal(app.db.prepare("SELECT connected FROM removable_drives WHERE id = 'drive-1'").get().connected, 1);
  assert.ok(engine.openedMs < 2000);
});

test('a row of a table too large to hold whole is found through its row index, with the asked fields', async (t) => {
  // Arrange
  const rows = ['Account,Balance,Region,Owner'];
  for (let index = 0; index < 130_000; index += 1) {
    rows.push(`Account ${100_000 + index},${(index * 37 % 100_000) / 100},Region ${index % 7},Owner number ${index % 1000}`);
  }
  const { app, dataDir, folders } = await agentLibrary(t, { extra: { 'Finance/ledger.csv': `${rows.join('\n')}\n` } });
  const engine = engineFor(t, dataDir);
  engine.evidence.suggest({ queries: [{ text: 'Account 100005' }] });
  // The app offers the row in its popup meanwhile, recording it into the snapshot this engine already read.
  const snapshotId = app.timeline.getProject(folders.Finance).currentSnapshotId;
  const table = app.dependencies.snapshotTables(folders.Finance, snapshotId)[0];
  const [row] = app.dependencies.tables.search(table.meta.id, 'Account 104233', 1);
  app.dependencies.indexedObjects(folders.Finance, snapshotId, table, app.dependencies.indexedRowObjects(table, row));

  // Act
  const response = engine.evidence.suggest({ queries: [{ text: 'Account 104233', fields: ['Balance', 'Owner'] }] });
  const [best] = response.results[0].candidates;
  const [context] = items(engine, { h: best.fields.Balance.h, context: 1 });
  const bound = engine.evidence.bind({ task: 'ledger', bind: { balance: best.fields.Balance.h }, template: 'Balance {{balance}}', cite: 'none' }, agent);

  // Assert
  assert.equal(response.sources[best.src].path, 'ledger.csv');
  assert.equal(best.row, 'Account 104233');
  assert.equal(best.match, 'exact name');
  assert.equal(best.fields.Balance.value, '566.21');
  assert.equal(best.fields.Owner.value, 'Owner number 233');
  assert.equal(response.results[0].candidates.filter((candidate) => candidate.row === 'Account 104233').length, 1, 'found once, though the app recorded it too');
  assert.deepEqual(context.table.header, ['Account', 'Balance', 'Region', 'Owner']);
  assert.ok(context.table.rows.some((cells) => cells.includes('Account 104233')));
  assert.equal(bound.text, 'Balance 566.21');
  assert.equal(bound.fields.balance.now, 'same');
});

test('a definition named without its file is found through the index, or listed when several share the name', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t, { extra: { 'Web/src/store.py': 'def load():\n    return []\n' } });
  const engine = engineFor(t, dataDir);

  // Act
  const [handle, load, missing, exported] = items(engine, { symbol: 'handle' }, { symbol: 'load' }, { symbol: 'nowhere' }, { symbol: 'start' });
  const absent = engine.evidence.suggest({ queries: [{ text: 'West division', fields: ['Revenue'] }] }).results[0];

  // Assert
  assert.equal(handle.symbol, 'handle');
  assert.deepEqual(handle.lines, [4, 8]);
  assert.equal(load.error.code, 'ambiguous');
  assert.deepEqual(load.error.matches.map((match) => `${match.folder}/${match.path}:${match.line}`).sort(), ['Api/app.py:11', 'Web/src/store.py:1']);
  assert.equal(missing.error.code, 'not_found');
  assert.equal(exported.text.split('\n')[0], 'export function start(port) {', 'an exported JavaScript function is found too');
  assert.ok(absent.coverage.total > 0, 'rows sharing a word still match');
  assert.equal(absent.coverage.exact, 0, 'and the response says none matched exactly');
});
