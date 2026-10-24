import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { currentFileType, detectFileType } from '../src/history/file-types.js';
import { presentationOutline, readPresentation } from '../src/dependencies/presentation-extraction.js';
import { singleSlidePresentation } from '../src/sharing/slide-export.js';
import { readZip, zipBytes } from '../src/dependencies/zip-archive.js';
import { offeredShareScopes } from '../src/sharing/object-share.js';
import { quarterlyReview } from './fixtures/presentations.js';

const actor = { id: 'human:deck-test', displayName: 'Deck test', actorType: 'HUMAN_SELF' };

/** Every part of an archive as text, by name. */
function partsOf(buffer) {
  return new Map([...readZip(buffer)].map(([name, entry]) => [name, zipBytes(entry, 10_000_000).toString('utf8')]));
}

test('a deck is read slide by slide, in the order PowerPoint shows them, without notes or footers', () => {
  // Arrange
  const deck = readPresentation(quarterlyReview());

  // Assert
  assert.equal(detectFileType('Board/Quarterly-Review.pptx'), 'presentation');
  assert.equal(deck.extraction, 'PPTX_OOXML');
  assert.equal(deck.title, 'Quarterly Business Review');
  assert.equal(deck.author, 'Dana Lee');
  assert.deepEqual(deck.slides.map((slide) => slide.title), ['Quarterly Business Review', 'Revenue Growth', 'Hiring Plan', 'Next Steps']);
  assert.equal(deck.slides[3].hidden, true);
  const revenue = deck.slides[1].blocks.filter((block) => block.type === 'item');
  assert.deepEqual(revenue.map((block) => [block.level, block.text.slice(0, 20)]), [
    [0, 'Revenue grew 18 perc'], [1, 'Recurring contracts '], [0, 'Churn fell to 3 perc'], [0, 'See the hiring plan ']]);
  assert.deepEqual(deck.slides[2].blocks.find((block) => block.type === 'table').rows[1], ['Engineering', '4', '6']);
  assert.deepEqual(deck.slides[3].blocks.filter((block) => block.type === 'item').map((block) => block.text),
    ['Approve the budget', 'Open the requisitions'], 'SmartArt words are read');
  const text = JSON.stringify(deck);
  assert.doesNotMatch(text, /PRIVATE|footer/i, 'speaker notes, comments and footers are not read');
  assert.equal(readPresentation(Buffer.from('not a deck')).extraction, 'PPTX_UNREADABLE');
});

test('the slide outline gives each slide its heading and the lines it covers', () => {
  // Arrange
  const outline = presentationOutline(readPresentation(quarterlyReview()));
  const lines = outline.text.split('\n');

  // Assert
  assert.deepEqual(outline.slides.map((slide) => lines[slide.lineStart - 1]),
    ['## Slide 1 · Quarterly Business Review', '## Slide 2 · Revenue Growth', '## Slide 3 · Hiring Plan', '## Slide 4 · Next Steps']);
  assert.ok(lines.includes('  - Recurring contracts made up most of the increase.'), 'a second-level bullet is indented');
  assert.ok(lines.includes('| Engineering | 4 | 6 |'));
  const escaped = presentationOutline({ slides: [{ number: 1, title: 'A *bold* claim', blocks: [
    { type: 'title', text: 'A *bold* claim' }, { type: 'paragraph', text: '1. Scope' }, { type: 'paragraph', text: '# not a heading' }] }] });
  assert.match(escaped.text, /## Slide 1 · A \\\*bold\\\* claim/);
  assert.match(escaped.text, /^1\\\. Scope$/m, 'a numbered line stays prose');
  assert.match(escaped.text, /^\\# not a heading$/m);
});

test('one slide exported alone keeps only that slide and what it needs', () => {
  // Arrange
  const original = quarterlyReview();

  // Act
  const exported = singleSlidePresentation(original, 2);
  const parts = partsOf(exported);

  // Assert
  const deck = readPresentation(exported);
  assert.equal(deck.slideCount, 1);
  assert.equal(deck.slides[0].title, 'Revenue Growth');
  for (const [name, content] of parts) {
    assert.doesNotMatch(content, /PRIVATE|Hiring Plan|Next Steps|Prepared for the Orchard/, `${name} carries nothing of the rest of the deck`);
  }
  for (const gone of ['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml', 'ppt/notesSlides/notesSlide2.xml', 'ppt/comments/comment1.xml',
    'ppt/commentAuthors.xml', 'docProps/app.xml', 'docProps/core.xml', 'docProps/thumbnail.jpeg', 'ppt/media/image3.png', 'ppt/viewProps.xml']) {
    assert.ok(!parts.has(gone), `${gone} is left out`);
  }
  for (const kept of ['ppt/media/image2.png', 'ppt/media/image1.png', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml']) {
    assert.ok(parts.has(kept), `${kept} travels with the slide`);
  }
  assert.match(parts.get('ppt/slides/_rels/slide2.xml.rels'), /Id="rId5"[^>]*Target="slide2.xml"/, 'a jump to another slide jumps to this one');
  assert.doesNotMatch(parts.get('ppt/slides/_rels/slide2.xml.rels'), /notesSlide|comments/);
  assert.doesNotMatch(parts.get('[Content_Types].xml'), /slide3|notesSlide|comment|docProps/);
  assert.doesNotMatch(parts.get('ppt/presProps.xml'), /custShow/);
  assert.match(parts.get('ppt/presentation.xml'), /<p:sldIdLst><p:sldId id="257" r:id="rId3"\/><\/p:sldIdLst>/);
  assert.equal(singleSlidePresentation(original, 9), null);
  assert.equal(singleSlidePresentation(Buffer.from('nope'), 1), null);
  for (const number of [1, 3, 4]) assert.equal(readPresentation(singleSlidePresentation(original, number)).slideCount, 1);
});

test('a deck is shared whole or as one slide, and code never', () => {
  assert.deepEqual(offeredShareScopes('Deck.pptx', { kind: 'text-excerpt', slideNumber: 2 }), ['DOCUMENT', 'INDEXED']);
  assert.deepEqual(offeredShareScopes('Deck.pptx', null), ['DOCUMENT'], 'the whole deck names no slide');
  assert.deepEqual(offeredShareScopes('src/server.js', { kind: 'line-range' }), []);
  assert.deepEqual(offeredShareScopes('Budget.xlsx', {}), ['DOCUMENT', 'INDEXED', 'REDACTED']);
  assert.equal(currentFileType('Deck.pptx', 'binary'), 'presentation', 'a deck recorded before Lasso read decks is read now');
  assert.equal(currentFileType('notes.txt', 'text'), 'text');
});

async function boardFolder(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-deck-'));
  const root = path.join(sandbox, 'Board');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Quarterly-Review.pptx'), quarterlyReview());
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await app.workspace.add([fs.realpathSync(root)], actor);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const projectId = app.workspace.state().directories[0].id;
  const objects = app.dependencies.objectsAt(projectId).filter((object) => object.path === 'Quarterly-Review.pptx');
  return { app, base, projectId, objects };
}

const json = async (response) => { assert.equal(response.status, 200, await response.clone().text()); return response.json(); };

test('a deck is indexed: named by its file, its slides’ sentences offered while writing', async (t) => {
  // Arrange
  const { app, objects } = await boardFolder(t);
  const deck = objects.find((object) => object.objectType === 'DOCUMENT' && !object.anchor);
  const churn = objects.find((object) => object.metadata.componentType === 'TEXT_EXCERPT' && /^Churn fell/.test(object.valueText));

  // Assert
  assert.equal(deck.label, 'Quarterly Business Review');
  assert.equal(deck.metadata.slideCount, 4);
  assert.equal(churn.anchor.slideNumber, 2);
  assert.equal(churn.metadata.slideTitle, 'Revenue Growth');
  assert.ok(!objects.some((object) => /PRIVATE|footer/i.test(`${object.valueText} ${object.label}`)), 'notes are never offered');
  const named = await app.workspace.predict({ text: 'See the Quarterly-Review.pp', cursor: 27, blockIndex: 0 });
  assert.ok(named.claims.some((claim) => claim.candidates.some((candidate) => candidate.id === deck.id && candidate.label === 'Quarterly-Review.pptx')));
  const written = await app.workspace.predict({ text: 'Churn fell to 3 percent', cursor: 23, blockIndex: 0 });
  const offered = [...written.workspaceCompletions, ...(written.completion ? [written.completion] : [])];
  assert.ok(offered.some((completion) => completion.dependencyCandidate?.metadata?.slideNumber === 2), 'the slide’s sentence completes');
});

test('the card shows the cited slide, and shares publish that slide or the whole deck', async (t) => {
  // Arrange
  const { app, base, projectId, objects } = await boardFolder(t);
  const churn = objects.find((object) => object.metadata.componentType === 'TEXT_EXCERPT' && /^Churn fell/.test(object.valueText));
  const deck = objects.find((object) => object.objectType === 'DOCUMENT' && !object.anchor);
  const share = async (object, accessScope) => fetch(`${base}/api/projects/${projectId}/object-shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: object.id, versionId: object.versionId, actor, accessScope }),
  });

  // Act
  const preview = await json(await fetch(`${base}/api/dependency-objects/${churn.id}/preview?version=${churn.versionId}`));
  const whole = await json(await fetch(`${base}/api/dependency-objects/${deck.id}/preview?version=${deck.versionId}`));
  const full = await json(await fetch(`${base}/api/dependency-objects/${churn.id}/document?version=${churn.versionId}`));

  // Assert: the card
  assert.equal(preview.preview.format, 'markdown');
  assert.equal(preview.preview.location, 'Slide 2 · Revenue Growth');
  assert.deepEqual(preview.preview.openAt, { slide: 2 });
  assert.ok(preview.preview.blocks.every((block) => !/Hiring|Quarterly/.test(block.text)), 'only the cited slide');
  assert.deepEqual(preview.preview.blocks.filter((block) => block.cited).map((block) => block.text),
    ['Churn fell to 3 percent across enterprise accounts.']);
  assert.deepEqual(preview.shareScopes, ['DOCUMENT', 'INDEXED']);
  assert.equal(whole.preview.location, 'Entire presentation');
  assert.deepEqual(whole.shareScopes, ['DOCUMENT']);
  assert.equal(full.document.format, 'markdown');
  assert.equal(full.document.styles.filter((style) => style.type === 'heading').length, 4, 'the composer’s whole deck has every slide');

  // Assert: one slide
  const slideShare = (await (await share(churn, 'INDEXED')).json()).share;
  const page = await (await fetch(`${base}/d/${slideShare.token}`)).text();
  assert.match(page, /Cited slide only/);
  assert.match(page, /Revenue Growth/);
  assert.match(page, /class="md-item cited"/, 'the cited bullet is marked');
  assert.doesNotMatch(page, /Hiring Plan|Next Steps|PRIVATE|Download original/);
  const download = await fetch(`${base}/d/${slideShare.token}/excerpt`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.match(download.headers.get('content-disposition'), /Quarterly-Review-slide-2-v\d+\.pptx/);
  const slideDeck = readPresentation(Buffer.from(await download.arrayBuffer()));
  assert.deepEqual(slideDeck.slides.map((slide) => slide.title), ['Revenue Growth']);
  assert.equal((await fetch(`${base}/d/${slideShare.token}/download`)).status, 403, 'the deck itself stays private');

  // Assert: the whole deck, and what is refused
  const deckShare = (await (await share(churn, 'DOCUMENT')).json()).share;
  const deckPage = await (await fetch(`${base}/d/${deckShare.token}`)).text();
  assert.match(deckPage, /Hiring Plan/);
  assert.match(deckPage, /4 slides/);
  const original = await fetch(`${base}/d/${deckShare.token}/download`);
  assert.equal(original.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal((await share(churn, 'REDACTED')).status, 422, 'a deck has nothing to redact');
  assert.equal((await share(deck, 'INDEXED')).status, 422, 'the whole deck names no slide');
  assert.equal((await share(deck, 'DOCUMENT')).status, 201);
});
