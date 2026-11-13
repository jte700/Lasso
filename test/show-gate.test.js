import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { nameFragmentEarnsCard, sharedWordsEarnCard } from '../src/dependencies/show-gate.js';
import { matchKey, ownWordKeys } from '../src/dependencies/direct-match.js';

// A ledger whose rows begin like everyday words ("Harbour" and "Happy",
// "Cost" and "connection"), and notes whose sentences share everyday words
// with small talk.
async function workspace(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-show-gate-'));
  const root = path.join(temporary, 'Operations');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'Ledger.csv'), ['Account,September CAD,Forecast CAD',
    'Harbour Office Furniture,1200,1300', 'Cost of goods sold,48000,47000', 'Net income,22500,21000',
    'Salaries and wages,31000,31000', 'Insurance,900,900', 'Facilities,2100,2000', 'Payroll,30500,30500'].join('\n'));
  fs.writeFileSync(path.join(root, 'Fixes.txt'), ['Pool raised from 40 to 80 connections after the outage.',
    'The label export moved to the read replica last week.',
    'Engagement notes from the kickoff meeting with the client.',
    'Fuel surcharge rises from 6% to 7.5% on 1 October.'].join('\n'));
  fs.writeFileSync(path.join(root, 'format.ts'), 'export const format = (value: number) => value.toFixed(2);\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:show-gate', displayName: 'Show gate test', actorType: 'SYSTEM' });
  return app;
}

async function offered(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return [
    ...(prediction.completion ? [prediction.completion] : []),
    ...prediction.sourceCompletions, ...prediction.workspaceCompletions,
    ...prediction.claims.flatMap((claim) => claim.candidates ?? []),
  ].map((item) => item.dependencyCandidate?.label ?? item.label ?? item.replacementText ?? item.insertText ?? '');
}

/** Every keystroke of a sentence at which something was offered, with what led. */
async function cardsWhileTyping(app, sentence) {
  const cards = [];
  for (let end = 2; end <= sentence.length; end += 1) {
    const labels = await offered(app, sentence.slice(0, end));
    if (labels.length) cards.push(`${JSON.stringify(sentence.slice(0, end))} offered ${labels[0]}`);
  }
  return cards;
}

test('a couple of letters at the start of a word do not name a source', () => {
  // Arrange
  const harbour = { label: 'Harbour Office Furniture' };
  const wages = { label: 'Salaries and wages' };

  // Act and assert
  assert.equal(nameFragmentEarnsCard('Ha', harbour), false, '"Ha" begins "Happy" as readily');
  assert.equal(nameFragmentEarnsCard('Har', harbour), true, 'three letters of a name are the name being typed');
  assert.equal(nameFragmentEarnsCard('wa', wages), false, '"was" is not "wages"');
  assert.equal(nameFragmentEarnsCard('wag', wages), false);
  assert.equal(nameFragmentEarnsCard('wage', wages), true, 'a later word of a name takes one more letter');
  assert.equal(nameFragmentEarnsCard('move', { label: 'Net cash movement' }), false, 'an everyday word typed whole is that word');
  assert.equal(nameFragmentEarnsCard('gre', { label: 'First Höhe (Z Größe)' }), false, 'letters inside a word begin nothing');
});

test('a name typed in full, in several words or in its own spelling is offered at once', () => {
  // Act and assert
  assert.equal(nameFragmentEarnsCard('Tax', { label: 'Tax' }), true, 'a short name typed whole');
  assert.equal(nameFragmentEarnsCard('net inc', { label: 'Net income' }), true, 'a second word is under way');
  assert.equal(nameFragmentEarnsCard('rates.p', { label: 'rates.py' }, { wholeFile: true }), true, 'a file spelled as written');
  assert.equal(nameFragmentEarnsCard('Q3', { label: 'Q3 Sprint Review' }), true, 'a spelling no sentence word has');
});

test('an everyday word is not the start of a file name, so "form" is not format.ts', () => {
  // Act and assert
  assert.equal(nameFragmentEarnsCard('form', { label: 'format.ts' }, { wholeFile: true }), false);
  assert.equal(nameFragmentEarnsCard('forma', { label: 'format.ts' }, { wholeFile: true }), true);
  assert.equal(nameFragmentEarnsCard('bra', { label: 'Bracket.step' }, { wholeFile: true }), true);
});

test('one everyday word shared with a passage is not enough to offer it', () => {
  // Arrange
  const keys = (...words) => words.map(matchKey);

  // Act and assert
  assert.equal(sharedWordsEarnCard(keys('week')), false);
  assert.equal(sharedWordsEarnCard(keys('meeting')), false);
  assert.equal(sharedWordsEarnCard(keys('running')), false, 'a form of an everyday word is everyday too');
  assert.equal(sharedWordsEarnCard(keys('surcharge')), true, 'a word of the work itself names its passage');
  assert.equal(sharedWordsEarnCard(keys('move', 'meeting')), false, 'two everyday words are still small talk');
  assert.equal(sharedWordsEarnCard(keys('pool', 'raised')), true, 'words of the work are a subject');
  assert.equal(sharedWordsEarnCard(keys('move', 'meeting', 'week')), true, 'several everyday words together are a passage');
  assert.equal(sharedWordsEarnCard(keys('week'), keys('week')), true, 'the whole of a name was typed');
});

test('a word a long label was cut off in is not one of the source\'s words', () => {
  // Act
  const keys = ownWordKeys({ label: 'The label export moved to the read replica last wee…' });

  // Assert
  assert.ok(!keys.includes('wee'), keys.join(' '));
  assert.ok(keys.includes(matchKey('replica')));
});

test('everyday sentences that name nothing bring up no card at any keystroke', async (t) => {
  // Arrange
  const app = await workspace(t);
  const smallTalk = ['Happy birthday! Hope you have a great day with the family.',
    'Can we move the meeting to Friday afternoon?',
    'Please find attached the form you asked for last week.',
    'I am running late, the train is delayed again today.'];

  // Act
  const cards = [];
  for (const sentence of smallTalk) cards.push(...await cardsWhileTyping(app, sentence));

  // Assert
  assert.deepEqual(cards, []);
});

test('a plain sentence about the work finds its source without "we" or "our"', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const plain = await offered(app, 'The connection pool was raised');
  const firstPerson = await offered(app, 'We raised the connection pool');

  // Assert
  assert.ok(plain.some((label) => /Pool raised from 40 to 80 connections/.test(label)), plain.join(' | '));
  assert.ok(firstPerson.some((label) => /Pool raised from 40 to 80 connections/.test(label)), firstPerson.join(' | '));
});

test('a name being typed is still offered once it is plainly a name', async (t) => {
  // Arrange
  const app = await workspace(t);

  // Act
  const twoLetters = await offered(app, 'The co');
  const opening = await offered(app, 'The har');
  const secondWord = await offered(app, 'The recorded net inc');

  // Assert
  assert.deepEqual(twoLetters, [], '"co" begins "connection" as readily as "Cost"');
  assert.equal(opening[0], 'Harbour Office Furniture', opening.join(' | '));
  assert.equal(secondWord[0], 'Net income', secondWord.join(' | '));
});

test('a request the writer has typed past is not answered', async (t) => {
  // Arrange
  const app = await workspace(t);
  const text = 'The connection pool was raised';

  // Act and assert
  await assert.rejects(app.workspace.predict({ text, cursor: text.length }, { cancelled: () => true }),
    (error) => error.statusCode === 499 || error.status === 499);
  const answered = await app.workspace.predict({ text, cursor: text.length }, { cancelled: () => false });
  assert.ok(answered.workspaceCompletions.length > 0, 'a request still wanted is answered as before');
});

test('a name being typed in one folder is not outranked by passages in another that share a word', async (t) => {
  // Arrange
  const app = await workspace(t);
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-show-gate-other-')), 'Notes');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'Minutes.txt'), 'The recorded figures were checked against the bank statement.\n');
  t.after(() => fs.rmSync(path.dirname(other), { recursive: true, force: true }));
  await app.workspace.add([other], { id: 'system:show-gate', displayName: 'Show gate test', actorType: 'SYSTEM' });

  // Act
  const text = 'The recorded net inc';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });

  // Assert
  const name = prediction.claims[0]?.candidates[0];
  assert.equal(name?.label, 'Net income');
  assert.equal(name.rankOrder, 0, 'the name is first');
  assert.ok(prediction.workspaceCompletions.every((item) => item.rankOrder > name.rankOrder),
    'the other folder\'s passage follows the name');
});
