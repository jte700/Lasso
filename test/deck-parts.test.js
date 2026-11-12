// A deck is a zip of parts, one per slide plus parts every slide shares (the
// slide list, layouts, masters and theme). Saving one slide changes only its
// part, so the other slides keep what they were read as and only the edited
// slide is read again. The deck's outline and passages are then made from all
// of its slides, as before.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { readPresentation } from '../src/dependencies/presentation-extraction.js';
import { deckSlideCache, slideSignatures } from '../src/dependencies/deck-parts.js';
import { readZip, zipBytes } from '../src/dependencies/zip-archive.js';
import { HEADCOUNT_CHART, quarterlyReview } from './fixtures/presentations.js';

const actor = { id: 'human:deck-parts', displayName: 'Deck parts', actorType: 'HUMAN_SELF' };

const part = (buffer, name) => zipBytes(readZip(buffer).get(name), 10_000_000).toString('utf8');
/** The quarterly review deck with the revenue figure on slide 2 changed. */
const revenueEdited = (overrides = {}) => quarterlyReview({
  'ppt/slides/slide2.xml': part(quarterlyReview(), 'ppt/slides/slide2.xml').replace('Revenue grew 18 percent', 'Revenue grew 21 percent'),
  ...overrides,
});

/** A slide cache that counts in `counter.read` the slides read rather than carried. */
function countingCache() {
  const stored = new Map();
  const counter = { read: 0 };
  const store = { get: (key) => stored.get(key), set: (key, value) => { counter.read += 1; stored.set(key, value); } };
  return { ...deckSlideCache(store), counter };
}

test('A slide keeps its signature until its own parts or a part every slide reads changes', () => {
  // Arrange
  const before = slideSignatures(readZip(quarterlyReview()));

  // Act
  const edited = slideSignatures(readZip(revenueEdited()));
  const charted = slideSignatures(readZip(quarterlyReview(HEADCOUNT_CHART)));
  const themed = slideSignatures(readZip(quarterlyReview({ 'ppt/theme/theme1.xml': '<a:theme name="Other"/>' })));

  // Assert
  assert.equal(before.length, 4);
  assert.deepEqual(edited.map((slide, index) => slide.signature === before[index].signature), [true, false, true, true]);
  assert.deepEqual(charted.map((slide, index) => slide.signature === before[index].signature), [true, true, false, true],
    'a chart the slide links to is part of the slide');
  assert.ok(themed.every((slide, index) => slide.signature !== before[index].signature), 'the theme is read by every slide');
  assert.equal(slideSignatures(readZip(Buffer.from('not a deck'))), null);
});

test('Editing one slide of a deck reads only that slide again, and the deck reads as a whole reading would', () => {
  // Arrange
  const cache = countingCache();
  readPresentation(quarterlyReview(), { slideCache: cache });
  cache.counter.read = 0;

  // Act
  const carried = readPresentation(revenueEdited(), { slideCache: cache });

  // Assert
  assert.equal(cache.counter.read, 1);
  assert.deepEqual(carried, readPresentation(revenueEdited()));
  assert.match(JSON.stringify(carried.slides[1]), /Revenue grew 21 percent/);
});

test('A change to the slide list reads every slide again', () => {
  // Arrange
  const cache = countingCache();
  readPresentation(quarterlyReview(), { slideCache: cache });
  cache.counter.read = 0;
  const presentation = part(quarterlyReview(), 'ppt/presentation.xml').replace('cx="12192000"', 'cx="9144000"');

  // Act
  readPresentation(quarterlyReview({ 'ppt/presentation.xml': presentation }), { slideCache: cache });

  // Assert
  assert.equal(cache.counter.read, 4);
});

test('A folder re-reads only the edited slide of a deck, and its passages follow the edit', async (t) => {
  // Arrange
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-deck-parts-')));
  const root = path.join(sandbox, 'Board');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'review.pptx'), quarterlyReview());
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const read = [];
  const original = app.dependencies.slideReadingCache.set.bind(app.dependencies.slideReadingCache);
  app.dependencies.slideReadingCache.set = (key, value) => { read.push(key); return original(key, value); };

  // Act
  fs.writeFileSync(path.join(root, 'review.pptx'), revenueEdited());
  app.timeline.capture(project.id, actor);
  app.dependencies.ensureIndex(project.id);
  const texts = app.dependencies.objectsAt(project.id).filter((object) => object.path === 'review.pptx').map((object) => object.valueText);

  // Assert
  assert.equal(read.length, 1, 'one slide was read again');
  assert.ok(texts.some((text) => /Revenue grew 21 percent/.test(text ?? '')));
  assert.ok(!texts.some((text) => /Revenue grew 18 percent/.test(text ?? '')));
});
