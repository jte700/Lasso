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
import { HEADCOUNT_CHART, POWERPOINT_THEME, quarterlyReview, themedDeck } from './fixtures/presentations.js';

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

test('a chart is read with its slide: its titles, then its data as a table', () => {
  // Arrange
  const deck = readPresentation(quarterlyReview(HEADCOUNT_CHART));

  // Assert
  const hiring = deck.slides[2].blocks;
  assert.deepEqual(hiring.filter((block) => block.type === 'paragraph').map((block) => block.text),
    ['Offers go out after the board approves the budget.', 'Headcount by quarter', 'People hired']);
  assert.deepEqual(hiring.filter((block) => block.type === 'table').at(-1).rows,
    [['', 'Engineering', 'Sales'], ['Third quarter', '4', '2'], ['Fourth quarter', '6', '3']]);
  assert.deepEqual(deck.slideSize, { width: 12_192_000, height: 6_858_000 });
});

test('every piece of a slide’s text is listed with the outline line it is on', () => {
  // Arrange
  const outline = presentationOutline(readPresentation(quarterlyReview()));
  const lines = outline.text.split('\n');

  // Assert
  const at = (text) => outline.texts.find((entry) => entry.text === text);
  assert.deepEqual(at('Hiring Plan'), { text: 'Hiring Plan', line: 12, kind: 'title', slide: 3 });
  assert.equal(lines[at('Hiring Plan').line - 1], '## Slide 3 · Hiring Plan');
  assert.equal(lines[at('Engineering · 4 · 6').line - 1], '| Engineering | 4 | 6 |');
  assert.equal(at('Approve the budget').kind, 'item');
  assert.equal(at('Prepared for the Orchard board').kind, 'paragraph');
  assert.ok(outline.texts.every((entry) => lines[entry.line - 1].includes(entry.text.split(' · ')[0])), 'each names its own line');
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

test('a deck is shared whole, as one slide or marked up, and code never', () => {
  assert.deepEqual(offeredShareScopes('Deck.pptx', { kind: 'text-excerpt', slideNumber: 2 }), ['DOCUMENT', 'INDEXED', 'MARKED']);
  assert.deepEqual(offeredShareScopes('Deck.pptx', null), ['DOCUMENT', 'MARKED'], 'the whole deck names no slide');
  assert.deepEqual(offeredShareScopes('src/server.js', { kind: 'line-range' }), []);
  assert.deepEqual(offeredShareScopes('Budget.xlsx', {}), ['DOCUMENT', 'INDEXED', 'REDACTED'], 'a workbook has no pages to draw on');
  assert.deepEqual(offeredShareScopes('Memo.docx', {}), ['DOCUMENT', 'INDEXED', 'REDACTED', 'MARKED']);
  assert.deepEqual(offeredShareScopes('Plan.PDF', {}), ['DOCUMENT', 'INDEXED', 'REDACTED', 'MARKED']);
  assert.equal(currentFileType('Deck.pptx', 'binary'), 'presentation', 'a deck recorded before Lasso read decks is read now');
  assert.equal(currentFileType('notes.txt', 'text'), 'text');
});

async function boardFolder(t, deck = quarterlyReview(), others = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-deck-'));
  const root = path.join(sandbox, 'Board');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Quarterly-Review.pptx'), deck);
  for (const [name, content] of Object.entries(others)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await app.workspace.add([fs.realpathSync(root)], actor);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const projectId = app.workspace.state().directories[0].id;
  const everything = app.dependencies.objectsAt(projectId);
  const objects = everything.filter((object) => object.path === 'Quarterly-Review.pptx');
  return { app, base, projectId, objects, everything };
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

test('a slide’s title, short lines and table rows are offered while writing, each citing its slide', async (t) => {
  // Arrange
  const { app, objects } = await boardFolder(t);
  const passage = (text) => objects.find((object) => object.metadata.componentType === 'TEXT_EXCERPT' && object.valueText === text);
  const offered = async (text) => {
    const result = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
    return [...result.workspaceCompletions, ...(result.completion ? [result.completion] : [])];
  };

  // Assert: indexed
  assert.equal(passage('Hiring Plan').metadata.excerptType, 'title');
  assert.equal(passage('Hiring Plan').anchor.slideNumber, 3);
  assert.equal(passage('Open the requisitions').metadata.excerptType, 'line');
  assert.equal(passage('Open the requisitions').anchor.slideNumber, 4);
  assert.equal(passage('Team · Q3 · Q4').metadata.excerptType, 'row');
  assert.equal(passage('Prepared for the Orchard board').anchor.lineStart, 3);
  assert.equal(objects.filter((object) => object.valueText === 'Churn fell to 3 percent across enterprise accounts.').length, 1,
    'a sentence already offered is not offered twice');
  assert.equal(passage('Engineering · 4 · 6'), undefined, 'a row of one word and numbers is too little to offer');

  // Assert: offered while writing
  const requisitions = await offered('Next we will open the requ');
  assert.ok(requisitions.some((completion) => completion.dependencyCandidate?.metadata?.slideNumber === 4
    && /isitions/.test(completion.insertText ?? completion.replacementText ?? '')), 'a short bullet completes');
  const growth = await offered('As the revenue gro');
  assert.ok(growth.some((completion) => completion.dependencyCandidate?.metadata?.excerptType === 'title'
    && completion.dependencyCandidate.metadata.slideNumber === 2 && completion.insertText === 'wth'), 'a slide title completes');
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

  const inspector = await (await fetch(`${base}/inspect?object=${churn.id}&version=${churn.versionId}`)).text();

  // Assert: the inspector shows the cited slide's picture alone, whole
  assert.doesNotMatch(inspector, /aria-label="Slide menu"/, 'no slide menu');
  assert.equal((inspector.match(/<figure class="cited-slide/g) ?? []).length, 1, 'only the cited slide');
  assert.match(inspector, new RegExp(`src="/api/dependency-objects/${churn.id}/slides/2\\?version=[^"]+" alt="Slide 2 of 4 · Revenue Growth"`));
  assert.doesNotMatch(inspector, /\/slides\/[134]\?/, 'no other slide is fetched');

  // Assert: the card
  assert.equal(preview.preview.format, 'markdown');
  assert.equal(preview.preview.location, 'Slide 2 · Revenue Growth');
  assert.deepEqual(preview.preview.deck, { slides: [{ number: 1, title: 'Quarterly Business Review' }, { number: 2, title: 'Revenue Growth' },
    { number: 3, title: 'Hiring Plan' }, { number: 4, title: 'Next Steps' }], aspect: 1.7778 }, 'the slide menu lists every slide');
  assert.deepEqual(preview.preview.openAt, { slide: 2 });
  assert.ok(preview.preview.blocks.every((block) => !/Hiring|Quarterly/.test(block.text)), 'only the cited slide');
  assert.deepEqual(preview.preview.blocks.filter((block) => block.cited).map((block) => block.text),
    ['Churn fell to 3 percent across enterprise accounts.']);
  assert.deepEqual(preview.shareScopes, ['DOCUMENT', 'INDEXED', 'MARKED']);
  assert.equal(whole.preview.location, 'Entire presentation');
  assert.deepEqual(whole.shareScopes, ['DOCUMENT', 'MARKED']);
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

test('a slide is drawn as a picture of its own, and the slide menu lists every slide', { skip: !POWERPOINT_THEME }, async (t) => {
  // Arrange
  const titles = ['Pilot results', 'Budget review', 'Field staffing', 'Risks and delays', 'Next steps'];
  const { base, objects, everything } = await boardFolder(t,
    themedDeck(titles.map((title, index) => ({ title, lines: [`Item ${index + 1} of the ${title.toLowerCase()} is on track.`] }))),
    { 'Budget.csv': 'Department,Amount\nPeople,42\n' });
  const cited = objects.find((object) => object.anchor?.slideNumber === 3 && object.metadata.excerptType === 'sentence');
  const deck = objects.find((object) => object.objectType === 'DOCUMENT' && !object.anchor);
  const budget = everything.find((object) => object.path === 'Budget.csv');
  const slide = (object, number) => fetch(`${base}/api/dependency-objects/${object.id}/slides/${number}?version=${object.versionId}`);

  // Act
  const picture = await slide(cited, 3);
  const neighbour = await slide(cited, 4);
  const preview = await json(await fetch(`${base}/api/dependency-objects/${cited.id}/preview?version=${cited.versionId}`));
  const pages = await fetch(`${base}/api/dependency-objects/${deck.id}/pages?version=${deck.versionId}`);

  // Assert
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/jpeg');
  const bytes = Buffer.from(await picture.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xFF, 0xD8, 0xFF], 'a JPEG');
  assert.equal(neighbour.status, 200);
  assert.equal((await slide(cited, 6)).status, 404, 'a slide past the last one');
  assert.equal((await slide(cited, 0)).status, 404);
  assert.equal((await slide(budget, 1)).status, 415, 'only a deck has slides');
  assert.equal(preview.preview.slideNumber, 3);
  assert.deepEqual(preview.preview.deck.slides.map((entry) => entry.title), titles);
  assert.equal(preview.preview.deck.aspect, 1.7778, 'every slide is 16 by 9');
  assert.equal(pages.status, 200);
  const pdf = Buffer.from(await pages.arrayBuffer()).toString('latin1');
  assert.equal((pdf.match(/\/Type\s*\/Page\b/g) ?? []).length, 5, 'a marked copy draws on every slide');
});
