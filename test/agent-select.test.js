import test from 'node:test';
import assert from 'node:assert/strict';
import { hasWord, readingOrder, selectEvidence, withContext } from '../src/agent/select.js';

// A file's passages as the index has them: sentences (and a paragraph) with pages and offsets.
const sentence = (id, page, start, text) => ({ id, valueText: text, anchor: { kind: 'pdf-excerpt', pageNumber: page, start }, metadata: { excerptType: 'sentence' } });
const paragraph = (id, page, start, text) => ({ id, valueText: text, anchor: { kind: 'pdf-excerpt', pageNumber: page, start }, metadata: { excerptType: 'paragraph' } });

const RESULTS = [
  'At 12 weeks the pain score fell by 3.1 points with exercise and 1.4 points with usual care, a difference of 1.7 points.',
  'This difference exceeded the minimal clinically important difference.',
];
const SUBGROUP = [
  'Benefits were smaller among participants aged 70 and over, at 0.6 points.',
  'Benefits did not differ by sex.',
  'However, the age subgroup analysis was not pre-specified.',
];
const LIMITS = ['Participants were not blinded and pain was self-reported.'];
const passages = [
  ...RESULTS.map((text, index) => sentence(`r${index}`, 3, index * 200, text)), paragraph('rp', 3, 0, RESULTS.join(' ')),
  ...SUBGROUP.map((text, index) => sentence(`s${index}`, 4, index * 200, text)), paragraph('sp', 4, 0, SUBGROUP.join(' ')),
  ...LIMITS.map((text, index) => sentence(`l${index}`, 6, index * 200, text)),
];
const headings = [{ at: [3, -1, -1], text: '3 Results' }, { at: [6, -1, -1], text: '5 Limitations' }];

test('a sentence comes with what it cannot be read without, and no more', () => {
  // Arrange
  const sentences = readingOrder(passages, headings);
  const at = (text) => sentences.findIndex((item) => item.text.startsWith(text));

  // Act and assert
  assert.deepEqual(withContext(sentences, at('This difference')), [at('At 12 weeks'), at('This difference')], '"This difference" needs the sentence it points back to');
  assert.deepEqual(withContext(sentences, at('Benefits were smaller')), [at('Benefits were smaller'), at('Benefits did not'), at('However')],
    'a qualification two sentences on comes with the sentence between');
  assert.deepEqual(withContext(sentences, at('At 12 weeks')), [at('At 12 weeks'), at('This difference')], 'and a result comes with the sentence that goes on about it');
  assert.deepEqual(withContext(sentences, at('Participants were not blinded')), [at('Participants were not blinded')]);
  assert.equal(sentences[at('Participants were not blinded')].heading, '5 Limitations');
});

test('sentences that only share the ask\'s words are shown a few times a file; sentences that state something are not limited', () => {
  // Arrange
  const names = ['Ana', 'Bram', 'Cleo', 'Dev', 'Eli', 'Fen', 'Gus', 'Hal'];
  const places = ['Leeds', 'Mons', 'Nice', 'Oslo', 'Pisa', 'Riga', 'Sion', 'Turku'];
  const fillers = names.map((name, index) => `${name} mentioned the vendor review to ${places[index]} staff.`);
  const costs = ['The Leeds vendor review cost 2,000 pounds.', 'Auditors found 14 late invoices in the Mons vendor review.',
    'After the Oslo vendor review, prices fell 6% within a quarter.', 'Riga\'s vendor review took 9 weeks, twice the plan.'];
  const file = (texts) => [{ key: 'notes', sentences: readingOrder(texts.map((text, index) => sentence(`n${index}`, 1, index * 100, text))) }];
  const weights = new Map([['vendor', 1], ['review', 1], ['date', 2]]);

  // Act
  const repeats = selectEvidence(file(['The vendor review is scheduled for March 3.', ...fillers]), weights, { budget: 700 });
  const facts = selectEvidence(file(costs), weights, { budget: 700 });

  // Assert
  assert.equal(repeats.shownSentences, 4, 'the dated sentence and three that only repeat its words');
  assert.ok(repeats.files[0].excerpts[0].text.startsWith('The vendor review is scheduled for March 3.'));
  assert.ok(repeats.leftOut >= 5, 'the rest are counted, not shown');
  assert.equal(facts.shownSentences, costs.length, 'each states a different figure');
});

test('an asked word matches its own forms, as the index does, however short its stem', () => {
  // Arrange
  const texts = ['The savvy shopper compared prices.', 'Borrowers reported a median saving of 85 pounds a year.'];
  const file = [{ key: 'report', sentences: readingOrder(texts.map((text, index) => sentence(`v${index}`, 1, index * 100, text))) }];

  // Act
  const chosen = selectEvidence(file, new Map([['save', 2]]), { budget: 700 });

  // Assert
  assert.deepEqual(['savings', 'saved', 'saves'].map((word) => hasWord(word, 'save')), [true, true, true]);
  assert.deepEqual([hasWord('the homes surveyed', 'home'), hasWord('three rates', 'rate'), hasWord('completed on time', 'completion')], [true, true, true]);
  assert.deepEqual([hasWord('savvy', 'save'), hasWord('homage', 'home'), hasWord('rather', 'rate')], [false, false, false],
    'a short stem is not read as the start of other words');
  assert.equal(chosen.files[0].excerpts.map((excerpt) => excerpt.text).join(' '), texts[1]);
  assert.deepEqual(chosen.missingTerms, []);
});

test('evidence is chosen across sections within the budget, and neighbouring sentences are one excerpt', () => {
  // Arrange
  const sentences = readingOrder(passages, headings);
  const weights = new Map([['pain', 1], ['difference', 1.5], ['blinded', 3], ['limitations', 2]]);

  // Act
  const chosen = selectEvidence([{ key: 'report', sentences }], weights, { budget: 120 });
  const tight = selectEvidence([{ key: 'report', sentences }], weights, { budget: 30 });

  // Assert
  const excerpts = chosen.files[0].excerpts;
  assert.ok(excerpts.some((excerpt) => excerpt.text === RESULTS.join(' ')), 'the result and the sentence that refers to it, as one excerpt');
  assert.ok(excerpts.some((excerpt) => excerpt.heading === '5 Limitations'), 'the limitation, found by its heading and its own rare word');
  assert.ok(chosen.tokens <= 120);
  assert.equal(tight.files[0].excerpts.length, 1, 'a tight budget keeps the best excerpt only');
  assert.ok(tight.leftOut > 0, 'and counts what it left out');
});

test('a report\'s sections count by what they are for: references never, other work less, and its findings when its findings are asked', () => {
  // Arrange: a report whose background cites another study in the same words as its own result.
  const at = (page, start) => ({ anchor: { kind: 'pdf-excerpt', pageNumber: page, start }, metadata: { excerptType: 'sentence' } });
  const said = (id, page, start, text) => ({ id, valueText: text, ...at(page, start) });
  const report = [
    said('b', 2, 100, 'In an earlier pilot, nitrate in the streams fell by 40% (Rowe, 2019).'),
    said('m', 3, 100, 'Nitrate was sampled monthly at each stream.'),
    said('r', 5, 100, 'Nitrate in the restored streams fell by 24%, from 4.6 to 3.5 mg/L.'),
    said('t', 5, 300, 'Water clarity improved at 5 of the 6 sites.'),
    said('x', 9, 100, 'Rowe J. Nitrate in streams. Water Research 2019.'),
  ];
  const headings = [{ at: [2, 0, 0], text: '2 Previous studies' }, { at: [3, 0, 0], text: '3 Methods' }, { at: [4, 0, 0], text: '4 Results' },
    { at: [5, 0, 0], text: '4.1 Water quality' }, { at: [9, 0, 0], text: 'References' }];
  const sentences = readingOrder(report, headings);
  const shown = (selection) => selection.files.flatMap((file) => file.excerpts.map((excerpt) => excerpt.text)).join(' ');

  // Act
  const nitrate = selectEvidence([{ key: 'report', sentences }], new Map([['nitrate', 2], ['streams', 1]]), { budget: 60 });
  const findings = selectEvidence([{ key: 'report', sentences }], new Map(), { budget: 200, sectionsAsked: { findings: true } });
  const prior = selectEvidence([{ key: 'report', sentences }], new Map([['nitrate', 2]]), { budget: 400, sectionsAsked: { background: true, apparatus: true } });

  // Assert
  assert.deepEqual(sentences.map((sentence) => sentence.role), ['background', null, 'findings', 'findings', 'apparatus'], '4.1 is a result because 4 is');
  assert.match(shown(nitrate), /fell by 24%/, 'the report\'s own result before the other study\'s');
  assert.doesNotMatch(shown(nitrate), /Water Research/, 'a reference is not evidence');
  assert.match(shown(findings), /fell by 24%.*Water clarity improved/, 'its findings, though they share no word with the ask');
  assert.doesNotMatch(shown(findings), /sampled monthly|earlier pilot/);
  assert.match(shown(prior), /earlier pilot/, 'other work counts in full when it is what is asked');
});
