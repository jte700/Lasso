import assert from 'node:assert/strict';
import test from 'node:test';
import { caretPointForTextLengths, contextualCompletionCase } from '../public/editor-acceptance.js';

test('accepted labels inherit sentence casing without damaging scientific identifiers', () => {
  assert.equal(contextualCompletionCase('Supplies', 'sup', 'The statement lists ', 'label'), 'supplies');
  assert.equal(contextualCompletionCase('Current Period', '', 'supplies for the ', 'label'), 'current period');
  assert.equal(contextualCompletionCase('Vitamin B1', 'vit', 'Our study found ', 'label'), 'vitamin B1');
  assert.equal(contextualCompletionCase('CON4', 'co', 'in row ', 'label'), 'CON4');
  assert.equal(contextualCompletionCase('Mohammad et al. (2021)', 'moh', 'The paper by ', 'proper-name'), 'Mohammad et al. (2021)');
  assert.equal(contextualCompletionCase('Supplies', 'Sup', '', 'label'), 'Supplies');
});

test('caret boundaries resolve after accepted linked text, not inside its final word', () => {
  assert.deepEqual(caretPointForTextLengths([8], 8), { atEnd: true });
  assert.deepEqual(caretPointForTextLengths([8, 4], 8), { atEnd: false, nodeIndex: 1, offset: 0 });
  assert.deepEqual(caretPointForTextLengths([8, 4], 3), { atEnd: false, nodeIndex: 0, offset: 3 });
});
