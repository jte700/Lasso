import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSentenceCorpus, completeSentence } from '../src/dependencies/completion.js';

const complete = (sentence, text, options) => completeSentence(buildSentenceCorpus([{
  path: 'notes/results.md', snapshotId: 'v1', text: sentence,
}]), { text, documentPath: 'draft.md' }, options);

test('sentence continuations retain numeric values instead of ignoring or duplicating them', () => {
  const source = 'Revenue increased by 20 percent during the quarter.';
  for (const typed of ['Revenue increased by 10', 'Revenue increased by 10 percent',
    'Revenue increased by -20 percent', 'Revenue increased by −20 percent']) {
    assert.equal(complete(source, typed), null, typed);
  }
  assert.equal(complete(source, 'Revenue increased by 20').completedText, source);
  assert.equal(complete(source, 'Revenue increased by 20 ').completedText, source);

  const decimal = 'The average dose was 2.5 milligrams in the intervention group.';
  const text = 'Previous finding. The average dose was 2.5 mill';
  const completion = complete(decimal, text);
  assert.equal(completion.completedText, decimal);
  assert.equal(completion.claimStart, 'Previous finding. '.length);
  assert.equal(complete(decimal, 'The average dose was 3.5 milligrams'), null);
});

test('numeric continuation context preserves order and recognizes the typographic minus sign', () => {
  const source = 'Between 10 and 20 patients received treatment during the study.';
  assert.equal(complete(source, 'Between 20 and 10 patients received treatment'), null);
  assert.equal(complete(source, 'Between 10 and 20 patients received treatment').completedText, source);
  const negative = 'Revenue increased by -20 percent during the quarter.';
  assert.equal(complete(negative, 'Revenue increased by −20 percent').insertText, ' during the quarter.');
  assert.equal(complete(negative, 'Revenue increased by 20 percent'), null);
});

test('a matching suffix cannot transfer a result to a different subject or negate its finding', () => {
  for (const [source, typed] of [
    ['The control group had lower levels of folate after treatment.', 'The treated group had lower levels'],
    ['The Alpha project had higher costs during the quarter.', 'The Beta project had higher costs'],
    ['The analysis showed that glucose levels were higher after treatment.', 'The analysis did not show that glucose levels'],
    ['The analysis did not show that glucose levels were higher after treatment.', 'The analysis showed that glucose levels'],
    ['The analysis showed that glucose levels were higher after treatment.', 'The results showed that folate levels were higher'],
  ]) {
    let ranked = [];
    assert.equal(complete(source, typed, { rank: (items) => { ranked = items; return items; } }), null, typed);
    assert.deepEqual(ranked, [], 'incompatible claims never reach preference ranking');
  }
});

test('consistent scientific paraphrases still complete, including numeric and negative claims', () => {
  const source = 'The analysis showed that patients received 20 milligrams every day.';
  const typed = 'The results indicate that participants received 20';
  const completion = complete(source, typed);
  assert.equal(completion.matchKind, 'SEMANTIC_SEQUENCE');
  assert.equal(completion.insertText, ' milligrams every day.');
  assert.equal(completion.completedText, `${typed} milligrams every day.`);
  assert.equal(complete(source, typed.replace('20', '10')), null);

  const negative = complete('The analysis did not show that glucose levels were higher after treatment.',
    'The results did not indicate that glucose levels');
  assert.equal(negative.insertText, ' were higher after treatment.');
});

test('semantic completion respects the space that finishes the current word', () => {
  const source = 'The analysis showed that placental folate levels were higher in the supplemented group.';
  const prefix = 'The results indicate that placental';
  assert.equal(complete(source, prefix).insertText, ' folate levels were higher in the supplemented group.');
  const spaced = complete(source, `${prefix} `);
  assert.equal(spaced.insertText, 'folate levels were higher in the supplemented group.');
  assert.equal(spaced.completedText, `${prefix} folate levels were higher in the supplemented group.`);
  assert.equal(complete(source, 'The results indicate that placenta').insertText,
    'l folate levels were higher in the supplemented group.');
  assert.equal(complete(source, 'The results indicate that placenta '), null,
    'a completed word cannot have letters appended after its trailing space');
});
