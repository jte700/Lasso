import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openEngine } from '../src/agent/engine.js';
import { isIdentifier, parseAsk, splitAsk } from '../src/agent/ask.js';
import { formatAnswer } from '../src/agent/render.js';
import { actor, agentLibrary, API_APP, WEB_APP } from './fixtures/agent-library.js';

function engineFor(t, dataDir, scope = ['*']) {
  const engine = openEngine({ dataDir, scope });
  t.after(() => engine.close());
  return engine;
}

const ask = (engine, ...asks) => engine.evidence.ask({ ask: asks });
const apiLines = (first, last) => API_APP.split('\n').slice(first - 1, last).join('\n');

test('an ask is read for the files, line ranges, definitions, revision, disk state, history and folder it names', () => {
  // Arrange
  const folders = ['Api', 'Web', 'Finance'];
  const read = (value) => parseAsk(value, folders);

  // Act and assert
  assert.deepEqual(read('Can you show me lines 10 to 20 in src/server.ts?').files.map((file) => [file.name, file.ranges]), [['src/server.ts', [[10, 20]]]]);
  assert.deepEqual(read('L12-L30 of utils.go').ranges, [[12, 30]]);
  assert.deepEqual(read('lines 1, 5-6 and 11 of Api/app.py').ranges, [[1, 1], [5, 6], [11, 11]]);
  assert.deepEqual(read('Api/app.py:5-8').ranges, [[5, 8]]);
  assert.deepEqual(read('Api/app.py:1-2,5-6, 9').files[0].ranges, [[1, 2], [5, 6], [9, 9]]);
  assert.equal(read('app.py lines 3-4 in the Api folder').folder, 'Api');
  assert.equal(read('the config at revision a1b2c3d4e5f6').revision, 'a1b2c3d4e5f6');
  assert.equal(read('server.js @deadbeef01 lines 1-2').revision, 'deadbeef01');
  assert.equal(read('lines 1-3 of routes.js as the file is now').disk, true);
  assert.equal(read('North revenue before the last change').history, true);
  assert.equal(read('the previous value of the North revenue').history, true);
  assert.equal(read('North revenue history').history, true);
  assert.deepEqual(read('the parse_config function').symbols, ['parse_config']);
  assert.deepEqual(read('class Store').symbols, ['Store']);
  assert.deepEqual(read('show handle() and load()').symbols, ['handle', 'load']);
  assert.deepEqual(read('definitions of fetchUser and save_record').symbols, ['fetchUser', 'save_record']);
  assert.deepEqual(read('normalize_sku').symbols, ['normalize_sku']);
  assert.deepEqual(read("What's the value of MAX_POOL_SIZE in the settings?").symbols, [], 'a value asked about is found, not read as a definition');
  assert.equal(read('where is server.js?').fileOnly, true);
  assert.equal(read('e.g. the revenue of 12.4 million').files.length, 0, 'abbreviations and decimals are not files');
  assert.deepEqual(read('Open "Operating budget.xlsx" for the North row').files.map((file) => file.name), ['Operating budget.xlsx']);
  assert.ok(['normalize_sku', 'fetchUser', 'MAX_POOL_SIZE', 'UnknownDiscount'].every(isIdentifier));
  assert.ok(!['Store', 'FY2025', 'INV-2025-00417', 'revenue'].some(isIdentifier));
});

test('an enumerated question is split into its parts; anything else stays whole', () => {
  // Arrange, act and assert
  assert.deepEqual(splitAsk('Give: (a) the load function, (b) North division revenue and (c) the grant note.'),
    ['the load function', 'North division revenue', 'the grant note']);
  assert.deepEqual(splitAsk('For the South division: 1. revenue 2. scenario'), ['For the South division revenue', 'For the South division scenario']);
  assert.deepEqual(splitAsk('Plan a) is the cheaper one'), ['Plan a) is the cheaper one']);
  assert.deepEqual(splitAsk('North division revenue'), ['North division revenue']);
});

test('asks for lines, definitions and files are answered exactly, and a name two folders share is never guessed', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const response = ask(engine, 'show me lines 5 through 8 of app.py in the Api folder', 'lines 1, 5-6 and 11 of Api/app.py',
    'app.py line 1', 'the handle function', 'where is start defined', 'show handle() and load()', 'the put method', 'where is server.js?');
  const [range, ranges, ambiguous, handle, start, both, put, file] = response.answers;

  // Assert
  assert.equal(range.items[0].text, apiLines(5, 8));
  assert.deepEqual(ranges.items.map((item) => item.text), [apiLines(1, 1), apiLines(5, 6), apiLines(11, 11)]);
  assert.equal(ambiguous.kind, 'error');
  assert.deepEqual(ambiguous.error.matches.map((match) => `${match.folder}/${match.path}`).sort(), ['Api/app.py', 'Web/src/app.py']);
  assert.equal(handle.items[0].text, apiLines(4, 8), 'the decorator belongs to the function');
  assert.equal(start.items[0].text, WEB_APP.split('\n').slice(2, 9).join('\n'), 'an exported JavaScript function is found');
  assert.equal(start.items[0].only, true, 'and said to be the only one, so nobody greps to make sure');
  assert.deepEqual(both.items.map((item) => item.symbol), ['handle', 'load']);
  assert.equal(put.items[0].text, apiLines(18, 19));
  assert.deepEqual(file.items.map((item) => response.sources[item.src].path), ['src/server.js']);
});

test('a table row named in an ask comes back with the columns it names; sources that disagree are shown together, never chosen between', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const response = ask(engine, 'North division revenue', 'the approved North division revenue', "South division's revenue and scenario",
    'North division revenue for FY2025');
  const [both, approved, south, period] = response.answers;
  const text = formatAnswer('ask', response);

  // Assert
  assert.equal(both.verdict, 'differ');
  assert.deepEqual(both.items.map((item) => item.fields.Revenue.value).sort(), ['11.9', '12.4']);
  assert.equal(approved.verdict, 'best');
  assert.deepEqual(approved.matched, ['approved']);
  assert.equal(approved.items[0].fields.Revenue.value, '11.9');
  assert.equal(approved.items.length, 2, 'the other budget is still shown');
  assert.equal(south.items.length, 1);
  assert.deepEqual(Object.keys(south.items[0].fields), ['Revenue', 'Scenario'], 'in the order asked');
  assert.equal(south.items[0].fields.Revenue.value, '9.10', 'the literal as written, not 9.1');
  assert.equal(period.verdict, 'differ', 'FY2025 is in both, so it settles nothing');
  assert.match(text, /\[1\] 2 sources differ; which is meant is not settled by the files:/);
  assert.match(text, /\[2\] s\d "North division" row 2: Revenue="11\.9" #[0-9A-Z]{10} \(matches "approved"\)\n  other source: s\d "North division" row 2: Revenue="12\.4"\n/);
});

test('an earlier value, a pinned revision and the file as it is now are each answered as asked', async (t) => {
  // Arrange
  const { app, dataDir, sandbox, folders } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  const oldRev = ask(engine, 'Api/app.py lines 5-8').sources.s1.rev;
  const planning = path.join(sandbox, 'Finance', 'Planning', 'budget.csv');
  fs.writeFileSync(planning, fs.readFileSync(planning, 'utf8').replace('North division,12.4', 'North division,13.0'));
  fs.writeFileSync(path.join(sandbox, 'Api', 'app.py'), `# header\n${API_APP}`);
  app.timeline.capture(folders.Finance, actor);
  app.timeline.capture(folders.Api, actor);
  fs.writeFileSync(path.join(sandbox, 'Api', 'app.py'), `# edited\n# header\n${API_APP}`);

  // Act
  const response = ask(engine, 'North division planning revenue before the last change', `Api/app.py lines 5-8 at revision ${oldRev}`,
    'Api/app.py lines 1-2 as it is now');
  const [history, pinned, disk] = response.answers;

  // Assert
  assert.equal(history.items[0].fields.Revenue.value, '13.0');
  assert.deepEqual(history.items[0].fields.Revenue.was.map((version) => version.value), ['12.4']);
  assert.equal(pinned.items[0].text, apiLines(5, 8));
  assert.equal(pinned.items[0].historical, true);
  assert.equal(disk.items[0].text, '# edited\n# header');
  assert.equal(disk.items[0].unindexed, true);
});

test('passages are found by their words, absence is said plainly, and credentials stay out', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const response = ask(engine, 'what does the note say about the one-time grant?', 'West division revenue', 'API_TOKEN', 'hunter2-secret');
  const [grant, west, token, secret] = response.answers;
  const text = formatAnswer('ask', response);

  // Assert
  assert.equal(grant.kind, 'found');
  assert.match(grant.items[0].value, /excludes the one-time grant/);
  assert.equal(west.kind, 'none');
  assert.deepEqual(west.missing, ['west']);
  assert.deepEqual(west.like.rows.sort(), ['North division', 'South division'], 'the rows that are there, none chosen');
  assert.match(text, /\[2\] no indexed text in the \d+ shared files has "west" \(asked: "west division revenue"\); rows labelled like it: "North division", "South division" \(s\d, s\d\)\.\n/);
  for (const answer of [token, secret]) assert.deepEqual([answer.kind, answer.items], ['none', []], JSON.stringify(answer));
  assert.ok(!Object.values(response.sources).some((source) => source.path.endsWith('.env')));
  assert.doesNotMatch(text, /API_TOKEN=/);
});

test('several questions in one ask are answered in one call, and structured follow-ups still work', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);

  // Act
  const first = engine.evidence.ask({ ask: 'Give: (a) Api/app.py lines 1-2, (b) the load function, (c) South division revenue.' });
  const handle = first.answers[2].items[0].fields.Revenue.h;
  const followUp = engine.evidence.ask({ ask: [{ h: `#${handle}`, context: 1 }, { text: 'North division', fields: ['Scenario'] }] });

  // Assert
  assert.deepEqual(first.answers.map((answer) => [answer.ask, answer.kind]),
    [['Api/app.py lines 1-2', 'lines'], ['the load function', 'definition'], ['South division revenue', 'record']]);
  assert.equal(followUp.answers[0].kind, 'read');
  assert.ok(followUp.answers[0].items[0].table.rows.some((row) => row.includes('South division')));
  assert.equal(followUp.answers[1].kind, 'matches');
  assert.equal(followUp.answers[1].candidates.filter((candidate) => candidate.type === 'record').length, 2);
});

test('a word of the ask that names a folder or directory settles a shared file name, and a file is read as it is now', async (t) => {
  // Arrange
  const { dataDir, sandbox } = await agentLibrary(t);
  const engine = engineFor(t, dataDir);
  fs.writeFileSync(path.join(sandbox, 'Api', 'app.py'), `# edited, not yet indexed\n${API_APP}`);

  // Act
  const response = ask(engine, 'the Web app.py line 1', 'Web/app.py line 1', 'app.py line 1', 'Api/app.py:1-2', `Api/app.py line 1 at revision ${ask(engine, 'Web/src/server.js line 1').sources.s1.rev}`);
  const [named, prefixed, open, now] = response.answers;
  const indexed = engine.evidence.ask({ ask: [{ file: 'Api/app.py', lines: '1-2' }] });

  // Assert
  assert.equal(named.items[0].text, '# The web front end lives in server.js');
  assert.equal(prefixed.items[0].text, '# The web front end lives in server.js');
  assert.equal(open.kind, 'error', 'no word of the ask tells the two apart');
  assert.equal(now.items[0].text, `# edited, not yet indexed\n${apiLines(1, 1)}`);
  assert.equal(now.items[0].unindexed, true);
  assert.equal(response.sources[now.items[0].src].disk, 'read');
  assert.equal(indexed.answers[0].items[0].text, apiLines(1, 2), 'an explicit read stays on the indexed revision');
  assert.match(indexed.warnings.join(' '), /changed on disk after Lasso indexed it/);
});

test('asks written as objects, names only assigned a value, a file named alone and a passage that states a value', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t, { extra: {
    'Api/settings.py': 'POOL_SIZE = 8\nTIMEOUT_SECONDS = 30\n',
    'Finance/report.md': '# Report\n\nThe warranty reserve policy is reviewed by the board.\n\nThe warranty reserve at year end was $4.2 million.\n',
  } });
  const engine = engineFor(t, dataDir);

  // Act
  const response = ask(engine, { question: 'South division revenue' }, { text: 'North division', folder: 'Finance' }, { symbol: 'TIMEOUT_SECONDS' },
    'Finance/notes.md', 'where is notes.md?', 'warranty reserve');
  const [question, folder, assigned, whole, where, reserve] = response.answers;

  // Assert
  assert.equal(question.items[0].fields.Revenue.value, '9.10');
  assert.equal(folder.verdict, 'differ');
  assert.deepEqual([assigned.kind, assigned.items[0].text], ['definition', 'TIMEOUT_SECONDS = 30']);
  assert.deepEqual([whole.kind, whole.items[0].text], ['lines', '# Notes\n\nThe North division revenue figure excludes the one-time grant.']);
  assert.equal(where.kind, 'files');
  assert.match(formatAnswer('ask', ask(engine, 'where is nothing_here.py?')), /^\[1\] none of the \d+ shared files is named "nothing_here\.py"\.$/);
  assert.match(reserve.items[0].value, /\$4\.2 million/, 'the passage that states a figure comes first');
  assert.equal(reserve.items.length, 2, 'the other is still shown');
});

test('a word some file has elsewhere is never said to be absent, and a closest hit beside like-labelled rows must have the word that sets the label apart', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t, { extra: { 'Finance/facilities.md': '# Facilities\n\nThe west wing was renovated in 2024.\n' } });
  const engine = engineFor(t, dataDir);

  // Act
  const response = ask(engine, 'West division revenue');
  const [west] = response.answers;
  const text = formatAnswer('ask', response);

  // Assert
  assert.equal(west.kind, 'none');
  assert.equal(west.missing, undefined, '"west" is in facilities.md');
  assert.deepEqual(west.like.rows.sort(), ['North division', 'South division']);
  assert.deepEqual(west.items.map((item) => item.value), ['The west wing was renovated in 2024.']);
  assert.match(text, /nothing in the \d+ shared files has "west", "division", "revenue" together; no row is labelled "west division"; rows labelled like it/);
});
