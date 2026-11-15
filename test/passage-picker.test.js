import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { passageDocument, passageKind } from '../src/sharing/passage-document.js';
import { passageSelection } from '../src/sharing/passage-selection.js';
import { writeZip } from '../src/dependencies/zip-archive.js';
import { bulletDeck } from './fixtures/presentations.js';
import { textPdf } from './fixtures/pdf.js';

// A stand-up as on-device speech hears it: its segments end where the
// recogniser paused, which is not always where a sentence ends.
function standupTranscript() {
  const segment = (words, from) => {
    const spoken = words.split(' ').map((text, index) => ({ text, start: from + index * 0.3, end: from + index * 0.3 + 0.25 }));
    return { start: spoken[0].start, end: spoken.at(-1).end, text: words, words: spoken };
  };
  return {
    status: 'ok', duration: 9,
    segments: [
      segment('Good morning, everyone. The drywall crew starts on Monday. The fire', 0),
      segment('inspection is booked for the 15th. Bring your badges.', 4.5),
    ],
  };
}

const selected = (document, range) => document.text.slice(range.start, range.end);
const placesIn = (document, range) => document.places.filter((place) => place.start < range.end && place.end > range.start);

function wordDocx(paragraphs) {
  const body = paragraphs.map(({ text, heading }) => `<w:p>${heading ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return writeZip([{ name: 'word/document.xml',
    content: Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`, 'utf8') }]);
}

test('Passages are picked from videos, decks, PDFs, Word documents and text files, and not from tables or code', () => {
  // Arrange, Act, Assert
  assert.equal(passageKind('clips/Site Standup.mov'), 'video');
  assert.equal(passageKind('Q3-Sprint-Review.pptx'), 'slides');
  assert.equal(passageKind('Agreement.pdf'), 'pdf');
  assert.equal(passageKind('Spec.docx'), 'word');
  assert.equal(passageKind('README.md'), 'text');
  assert.equal(passageKind('notes.txt'), 'text');
  assert.equal(passageKind('ledger.xlsx'), null);
  assert.equal(passageKind('server.js'), null);
});

test('A video reads a sentence per line, each word at the time it is said, and the times are never part of the text', () => {
  // Arrange, Act
  const document = passageDocument({ path: 'Site Standup.mov', transcript: standupTranscript() });

  // Assert
  assert.equal(document.text.split('\n')[2], '0:02  The fire inspection is booked for the 15th.');
  const fire = document.text.indexOf('The fire');
  assert.ok(Math.abs(placesIn(document, { start: fire, end: fire + 3 })[0].time - 2.7) < 0.01);
  assert.ok(document.decorations.some((range) => selected(document, range) === '0:02  '));
  assert.equal(document.lineBreaks, 'space');
});

test('A video opens highlighted from the typed words to the end of the sentence they are said in', () => {
  // Arrange
  const document = passageDocument({ path: 'Site Standup.mov', transcript: standupTranscript() });
  const excerpt = { anchor: { kind: 'video-time', start: 0, end: 5 } };

  // Act
  const range = passageSelection(document, excerpt, 'Reminder that the fire insp');

  // Assert
  assert.equal(selected(document, range), 'The fire inspection is booked for the 15th.', 'the words as the video spells them');
});

test('The opening highlight names the typed words it was found by, counted back from the caret', () => {
  // Arrange
  const document = passageDocument({ path: 'Site Standup.mov', transcript: standupTranscript() });
  const typed = 'Reminder that the fire ';

  // Act
  const range = passageSelection(document, { anchor: { start: 0, end: 5 } }, typed);

  // Assert
  assert.deepEqual(range.trigger, { fromEnd: 'the fire '.length, length: 'the fire'.length, text: 'the fire' });
});

test('The typed words that brought a passage up include a "the" before them, but not the words before that', () => {
  // Arrange
  const notes = Buffer.from('FICTIONAL TEST DATA\nProject JH-26-021\nPermit submission target: 2026-11-12.\nNo fire resistance rating or occupant-load calculation is supplied.\n');
  const document = passageDocument({ path: 'Design-Decision-Register.txt', content: notes });
  const whole = { anchor: { lineStart: 1, lineEnd: 4 }, valueText: notes.toString('utf8') };

  // Act
  const capital = passageSelection(document, whole, 'The fire');
  const later = passageSelection(document, whole, 'Reminder that the fire');

  // Assert
  assert.deepEqual(capital.trigger, { fromEnd: 8, length: 8, text: 'The fire' });
  assert.equal(later.trigger.text, 'the fire');
});

test('A long passage is highlighted to its last words, not only its first forty', () => {
  // Arrange
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ');
  const document = passageDocument({ path: 'long.txt', content: Buffer.from(`Intro line.\n${words}.\nOutro line.\n`) });

  // Act
  const range = passageSelection(document, { anchor: { lineStart: 2, lineEnd: 2 }, valueText: `${words}.` }, '');

  // Assert
  assert.equal(selected(document, range), `${words}.`);
});

test('A sentence found only by a shared word names no typed words to replace', () => {
  // Arrange
  const document = passageDocument({ path: 'Site Standup.mov', transcript: standupTranscript() });

  // Act
  const range = passageSelection(document, { anchor: { start: 0, end: 5 } }, 'We need the crew soon');

  // Assert
  assert.equal(range.trigger, undefined);
});

test('A video whose excerpt has none of the typed words in order opens on the sentence with one of them', () => {
  // Arrange
  const document = passageDocument({ path: 'Site Standup.mov', transcript: standupTranscript() });

  // Act
  const range = passageSelection(document, { anchor: { start: 0, end: 5 } }, 'We need the crew soon');

  // Assert
  assert.equal(selected(document, range), 'The drywall crew starts on Monday.');
});

test('A deck reads a slide at a time, each slide placed by its number, its labels and bullets apart from its text', () => {
  // Arrange
  const deck = bulletDeck([
    { title: 'Sprint review', lines: ['Everything shipped on time'] },
    { title: 'Highlights', lines: ['Tracking panel live for every customer since 2 September', 'Delivery windows narrowed from four hours to two hours'] },
  ]);

  // Act
  const document = passageDocument({ path: 'Sprint-Review.pptx', content: deck });
  const range = passageSelection(document, { anchor: { slideNumber: 2 }, valueText: 'Tracking panel live for every customer since 2 September' },
    'This sprint the tracking panel');

  // Assert
  assert.equal(selected(document, range), 'Tracking panel live for every customer since 2 September');
  assert.deepEqual(placesIn(document, range).map((place) => [place.kind, place.number]), [['slide', 2]]);
  assert.ok(document.decorations.some((label) => selected(document, label) === 'Slide 2\n'));
  assert.ok(document.headings.some((heading) => selected(document, heading) === 'Highlights'));
});

test('A slide line opens highlighted from the typed words when they are in the middle of it', () => {
  // Arrange
  const deck = bulletDeck([{ title: 'Limits', lines: ['Rate limit raised from 100 to 120 requests per minute'] }]);
  const document = passageDocument({ path: 'Limits.pptx', content: deck });

  // Act
  const range = passageSelection(document, { anchor: { slideNumber: 1 }, valueText: 'Rate limit raised from 100 to 120 requests per minute' },
    'Last month it was raised fr');

  // Assert
  assert.equal(selected(document, range), 'raised from 100 to 120 requests per minute');
});

test('A typed word in another form of the slide’s word (shipment, Shipments) still starts the opening highlight', () => {
  // Arrange
  const deck = bulletDeck([{ title: 'Request path', lines: ['Shipments stored in PostgreSQL behind a fixed connection pool'] }]);
  const document = passageDocument({ path: 'Architecture-Overview.pptx', content: deck });
  const source = { anchor: { slideNumber: 1 }, valueText: 'Shipments stored in PostgreSQL behind a fixed connection pool' };

  // Act
  const range = passageSelection(document, source, 'shipment stored');
  const verb = passageSelection(document, source, 'The orders were storing');

  // Assert
  assert.equal(selected(document, range), 'Shipments stored in PostgreSQL behind a fixed connection pool');
  assert.deepEqual(range.trigger, { fromEnd: 15, length: 15, text: 'shipment stored' });
  assert.equal(selected(document, verb), 'stored in PostgreSQL behind a fixed connection pool', 'storing and stored are one word');
});

test('A PDF reads a page at a time, each page placed by its number', () => {
  // Arrange
  const pdf = textPdf('A renewal notice must be received by 2027-08-01.');

  // Act
  const document = passageDocument({ path: 'Agreement.pdf', content: pdf });
  const range = passageSelection(document, { anchor: { pageNumber: 1 }, valueText: 'A renewal notice must be received by 2027-08-01.' }, 'The ');

  // Assert
  assert.equal(selected(document, range), 'A renewal notice must be received by 2027-08-01.');
  assert.deepEqual(placesIn(document, range).map((place) => [place.kind, place.number]), [['page', 1]]);
});

test('A Word document reads a paragraph at a time, each in the section of the heading above it', () => {
  // Arrange
  const memo = wordDocx([
    { text: 'Scope', heading: true },
    { text: 'The pump on line 3 was replaced on 2 May after the seal failed.' },
    { text: 'Results', heading: true },
    { text: 'Flow returned to 42 litres per minute by the afternoon.' },
  ]);

  // Act
  const document = passageDocument({ path: 'Visit.docx', content: memo });
  const range = passageSelection(document, { anchor: { lineStart: 7, lineEnd: 7 }, valueText: 'Flow returned to 42 litres per minute by the afternoon.' }, '');

  // Assert
  assert.equal(selected(document, range), 'Flow returned to 42 litres per minute by the afternoon.');
  assert.deepEqual(placesIn(document, range).map((place) => [place.kind, place.title]), [['section', 'Results']]);
});

test('A text file reads as written, each line placed by its number', () => {
  // Arrange
  const readme = Buffer.from('# Runbook\n\nRestart the worker before paging anyone.\nCheck the queue depth first.\n');

  // Act
  const document = passageDocument({ path: 'README.md', content: readme });
  const range = passageSelection(document, { anchor: { lineStart: 3, lineEnd: 4 }, valueText: 'Restart the worker before paging anyone. Check the queue depth first.' }, '');

  // Assert
  assert.equal(selected(document, range), 'Restart the worker before paging anyone.\nCheck the queue depth first.');
  assert.deepEqual(placesIn(document, range).map((place) => place.number), [3, 4]);
});

test('A video not yet transcribed says so rather than showing an empty document', () => {
  // Arrange, Act
  const document = passageDocument({ path: 'Site Standup.mov', transcript: null });

  // Assert
  assert.equal(document.unavailable, 'This video has not been transcribed yet.');
  assert.equal(passageSelection(document, { anchor: {} }, 'the fire'), null);
});

test('The picker route serves a suggested passage’s document with the passage highlighted', async (t) => {
  // Arrange
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-picker-'));
  const folder = path.join(root, 'Decks');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'Sprint-Review.pptx'), bulletDeck([
    { title: 'Sprint review', lines: ['Everything shipped on time'] },
    { title: 'Highlights', lines: ['Delivery windows narrowed from four hours to two hours'] },
  ]));
  const app = createApplication({ dataDir: path.join(root, 'state'), watchProjects: false });
  const server = await new Promise((resolve) => { const listening = app.server.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => { server.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.workspace.add([folder], { id: 'system:picker', displayName: 'Decks', actorType: 'SYSTEM' });
  const typed = 'Delivery windows narrowed';
  const prediction = await app.workspace.predict({ text: typed, cursor: typed.length, blockIndex: 0 });
  const suggestion = prediction.completion?.dependencyCandidate ?? prediction.workspaceCompletions[0]?.dependencyCandidate;
  const base = `http://127.0.0.1:${server.address().port}`;

  // Act
  const answer = await fetch(`${base}/api/dependency-objects/${encodeURIComponent(suggestion.id)}/passages?version=${suggestion.versionId}&typed=${encodeURIComponent(typed)}`);
  const { document } = await answer.json();

  // Assert
  assert.equal(answer.status, 200);
  assert.equal(document.kind, 'slides');
  assert.equal(document.name, 'Sprint-Review.pptx');
  assert.equal(document.text.slice(document.selection.start, document.selection.end), 'Delivery windows narrowed from four hours to two hours');
});
