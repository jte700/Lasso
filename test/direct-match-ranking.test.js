import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { matchKey, matchedSourceWords, ownWordKeys, typedWordKeys } from '../src/dependencies/direct-match.js';
import { detectClaimSpans } from '../src/dependencies/claim-detection.js';

// A ledger's columns and a deck-like note: words that a sentence either
// names or does not, so a suggestion's presence says whether it matched.
async function workspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-direct-match-'));
  const root = path.join(temporary, 'Operations');
  fs.mkdirSync(path.join(root, 'decks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Ledger.csv'),
    'Account Code,Credit CAD,Outstanding CAD\n1000,120.5,40.25\n1010,80.75,12.5\n1020,64.25,9.75\n');
  fs.writeFileSync(path.join(root, 'decks', 'Fixes.txt'),
    'Pool raised from 40 to 80 connections after the outage.\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:direct-match', displayName: 'Direct match test', actorType: 'SYSTEM' });
  return app;
}

async function offered(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return [
    ...(prediction.completion ? [prediction.completion] : []),
    ...prediction.workspaceCompletions,
    ...prediction.claims.flatMap((claim) => claim.candidates ?? []),
  ].map((item) => item.dependencyCandidate?.label ?? item.label ?? item.replacementText ?? item.insertText ?? '');
}

test('a sentence that names nothing in the sources is offered nothing', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const results = await offered(app, 'The results showed');
  const study = await offered(app, 'Our analysis found that');

  // Assert
  assert.deepEqual(results, [], 'no column is offered for words none of them contain');
  assert.deepEqual(study, []);
});

test('file details are not words a sentence can match', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act: "decks" is a folder, "excerpt" and "sentence" are how a passage is filed
  const offeredForDetails = await offered(app, 'We filed the decks excerpt sentence');

  // Assert
  assert.ok(!offeredForDetails.some((label) => /Pool raised/.test(label)), offeredForDetails.join(' | '));
});

test('a typed word found in a source sentence offers that sentence, even in another form', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const raise = await offered(app, 'We should raise the pool');

  // Assert
  assert.ok(raise.some((label) => /Pool raised from 40 to 80 connections/.test(label)), raise.join(' | '));
});

test('a whole file is matched by its name, not by every word inside it', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act: "outage" is in Fixes.txt's sentence but not in its name
  const outage = await offered(app, 'We wrote up the outage');

  // Assert
  assert.ok(outage.some((label) => /Pool raised/.test(label)), 'the sentence that says it is offered');
  assert.ok(!outage.includes('Fixes'), outage.join(' | '));
});

test('a file the typed words name ranks before sentences that only contain them', async (t) => {
  // Arrange: the file in one folder, a sentence about it in another
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-direct-order-'));
  const books = path.join(temporary, 'Books');
  const team = path.join(temporary, 'Team');
  fs.mkdirSync(books);
  fs.mkdirSync(team);
  fs.writeFileSync(path.join(books, 'General-Ledger.csv'), 'Account,Debit CAD\nCash,120\nRent,80\n');
  fs.writeFileSync(path.join(team, 'Notes.txt'), 'We reconcile the general ledger every Friday afternoon.\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([books, team], { id: 'system:direct-order', displayName: 'Direct order test', actorType: 'SYSTEM' });

  // Act
  const text = 'We checked the general ledger';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const places = [
    ...(prediction.completion ? [[prediction.completion.rankOrder, prediction.completion.insertText]] : []),
    ...prediction.workspaceCompletions.map((item) => [item.rankOrder, item.replacementText]),
    ...prediction.claims.flatMap((claim) => claim.candidates.map((item) => [item.rankOrder, item.label])),
  ];
  const ranked = [...places].sort((left, right) => left[0] - right[0]).map(([, label]) => label);

  // Assert
  assert.ok(places.every(([order]) => Number.isInteger(order)), 'every suggestion carries its place');
  assert.equal(ranked[0], 'General Ledger', ranked.join(' | '));
  assert.ok(ranked.slice(1).some((label) => /Friday afternoon/.test(label)), 'the other folder\u2019s sentence follows');
});

test('each suggestion names the typed words it matched, as its source spells them', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const text = 'We should raise the pool';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const pool = prediction.workspaceCompletions.find((item) => /Pool raised/.test(item.replacementText));

  // Assert
  assert.deepEqual(pool?.matchedWords, ['Pool', 'raised']);
});

test('a word still being typed marks the source word it begins', () => {
  // Arrange
  const fix = 'Alert when more than 75% of the pool is in use';

  // Assert
  assert.deepEqual(matchedSourceWords('the slide whe', fix), ['when']);
  assert.deepEqual(matchedSourceWords('We raised the poo', 'Pool raised from 40 to 80 connections'), ['Pool', 'raised']);
  assert.deepEqual(matchedSourceWords('the slide whe ', fix), [], 'a finished word is matched whole or not at all');
  assert.deepEqual(matchedSourceWords('the pool alerts the', fix), ['Alert', 'pool'], 'a finished function word marks nothing');
  assert.deepEqual(matchedSourceWords('the slide wh', fix), [], 'two letters begin too many words');
});

test('every suggestion for a half-typed word names a word its preview can mark', async (t) => {
  // Arrange
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-direct-match-prefix-'));
  const root = path.join(temporary, 'Incidents');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Fixes.md'),
    '# Fixes\n\n- Pool raised from 40 to 80 connections\n- Alert when more than 75% of the pool is in use\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:direct-match', displayName: 'Direct match test', actorType: 'SYSTEM' });

  // Act
  const text = 'the slide whe';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const suggestions = [...(prediction.completion ? [prediction.completion] : []), ...prediction.workspaceCompletions,
    ...prediction.claims.flatMap((claim) => claim.candidates ?? [])];

  // Assert
  assert.ok(suggestions.some((item) => /^Alert when/.test(item.label ?? '')), 'the alert is offered for the word being typed');
  for (const suggestion of suggestions) {
    assert.ok(suggestion.matchedWords?.length, `${suggestion.label ?? suggestion.insertText} names a word to mark`);
  }
});

test('a typed word naming a column offers that column first', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const outstanding = await offered(app, 'We checked the outstanding');

  // Assert
  assert.equal(outstanding[0], 'Outstanding CAD', outstanding.join(' | '));
  assert.ok(!outstanding.includes('Account Code'), 'a column the sentence does not name is left out');
});

test('common word forms share a key, and a function word never stands in for another word', () => {
  // Arrange
  const pairs = [['sale', 'sales'], ['rate', 'rates'], ['size', 'sizes'], ['company', 'companies'],
    ['liability', 'liabilities'], ['meeting', 'meetings'], ['raise', 'raised'], ['raise', 'raising'],
    ['pool', 'pools'], ['expense', 'expenses'], ['match', 'matches'], ['bonus', 'bonuses'], ['compute', 'computed']];

  // Act
  const differing = pairs.filter(([one, other]) => matchKey(one) !== matchKey(other));

  // Assert
  assert.deepEqual(differing, []);
  assert.deepEqual(typedWordKeys('We analyzed the figures using notes based on'), [matchKey('figures'), matchKey('notes')]);
  assert.ok(!ownWordKeys({ label: 'It is not ready', valueText: '', metadata: {} }).includes(matchKey('notes')),
    '"not" in a source is not "notes"');
});

test('a sheet name or a row’s column headers are not the row’s own words', () => {
  // Arrange
  const row = { objectType: 'DATASET_ROW', anchor: { kind: 'table-row' }, label: 'Gizmos', valueText: '12',
    metadata: { sheet: 'Revenue', columns: ['Product', 'Customer Companies'], dataset: 'Products' } };
  const table = { objectType: 'DATASET', anchor: null, label: 'Products',
    valueText: 'Product Customer Companies Gizmos Gadgets', metadata: { sheet: 'Revenue' } };

  // Act
  const rowWords = ownWordKeys(row);
  const tableWords = ownWordKeys(table);

  // Assert
  assert.deepEqual(rowWords, [matchKey('gizmos')]);
  assert.deepEqual(tableWords, [matchKey('products')], 'a whole table is matched by its name');
});

// A runbook and a readme whose sentences share "numbers" with an earlier
// paragraph of a message, and nothing with its last line.
async function runbookWorkspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-reference-sentence-'));
  const root = path.join(temporary, 'tidewater');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'),
    '# Tidewater\n\nEvery shipment gets a tracking number of TW followed by ten digits, such as TW4820193375.\n');
  fs.writeFileSync(path.join(root, 'docs', 'runbook.md'),
    '# Runbook\n\n## Customers see "Too many lookups"\n\nEach API key may make 120 requests a minute, with bursts of 30. '
    + 'A partner polling every tracking number on a timer will hit this; ask them to use the scan webhook instead.\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:reference-sentence', displayName: 'Reference sentence test', actorType: 'SYSTEM' });
  return app;
}

test('a source named in an earlier paragraph is not offered for the line being typed', async (t) => {
  // Arrange
  const app = await runbookWorkspace(t);
  const message = 'please do the following:\n\n'
    + 'Grade my essay as a professor or TA would by cross referencing it to the course material and assignment requirements.\n\n'
    + 'Once you have done this, go through all quotes, sources and page numbers from those sources/ slide numbers or image references.\n\n'
    + 'Check that the invoice';

  // Act
  const results = await offered(app, message);

  // Assert
  assert.deepEqual(results, [], 'no source has "invoice"');
});

test('a reference being typed is read from its own sentence only', () => {
  // Arrange
  const earlier = 'Go through the slide numbers or image references.\n\nCheck that the invoice';
  const sameLine = 'Check the slides on tracking numb';

  // Act
  const acrossParagraphs = detectClaimSpans(earlier).filter((claim) => claim.type === 'LITERATURE');
  const inSentence = detectClaimSpans(sameLine).find((claim) => claim.type === 'LITERATURE');

  // Assert
  assert.deepEqual(acrossParagraphs, []);
  assert.equal(inSentence?.value, 'on tracking numb');
});

test('a document is not named by the folder it is filed in', async (t) => {
  // Arrange
  const app = await runbookWorkspace(t);

  // Act
  const byFolder = await offered(app, 'From the document docs');
  const byOwnWords = await offered(app, 'From the document on partner polling');

  // Assert
  assert.deepEqual(byFolder, [], '"docs" is only the folder the runbook is in');
  assert.ok(byOwnWords.some((label) => /A partner polling/.test(label)), byOwnWords.join(' | '));
});

// A design register whose lines share "issue" with a message, and nothing else.
async function registerWorkspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-current-clause-'));
  const root = path.join(temporary, 'Juniper Hub');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Design-Decision-Register.txt'),
    'Decision D-07: drawing set A-101 issued for permit on 2026-10-02.\n'
    + 'Open issue AR-12: verify the stair headroom on site.\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:current-clause', displayName: 'Current clause test', actorType: 'SYSTEM' });
  return app;
}

async function everythingOffered(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return [...prediction.sourceCompletions, ...await offered(app, text)]
    .map((item) => typeof item === 'string' ? item : item.dependencyCandidate?.label ?? item.replacementText ?? '');
}

test('a word the writer has typed past no longer picks the sources', async (t) => {
  // Arrange
  const app = await registerWorkspace(t);
  const start = 'yes remove the trailer from our main uncommited and merge into main so there are no issues';

  // Act
  const atTheWord = await everythingOffered(app, start);
  const nextClause = await everythingOffered(app, `${start} and `);
  const typedOn = await everythingOffered(app, `${start} and everything is how it is now`);

  // Assert
  assert.ok(atTheWord.length > 0, '"issues" at the caret names the register');
  assert.deepEqual(nextClause, [], 'a new clause has begun after "issues"');
  assert.deepEqual(typedOn, [], 'nothing in "everything is how it is now" is in the register');
});

test('a file named by its name marks nothing in its preview: the whole file is the match', async (t) => {
  // Arrange
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-file-name-'));
  const root = path.join(temporary, 'Books');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'General-Ledger.csv'), 'Account,Debit CAD\nCash,120\nRent,80\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:file-name', displayName: 'File name test', actorType: 'SYSTEM' });

  // Act
  const text = 'We checked the general ledger';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const file = prediction.claims.flatMap((claim) => claim.candidates ?? []).find((candidate) => candidate.fileReference);

  // Assert
  assert.ok(file, 'General-Ledger.csv is offered by name');
  assert.deepEqual(file.matchedWords, []);
});
