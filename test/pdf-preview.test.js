import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { extractPdfFullText, extractPdfPassages } from '../src/dependencies/document-extraction.js';
import { buildFullShareDocument, buildInspectorPreview, buildSharePreview } from '../src/sharing/share-preview.js';
import { INDEX_VERSION } from '../src/dependencies/constants.js';

const writer = { id: 'human:pdf-preview', displayName: 'PDF writer', actorType: 'HUMAN_SELF' };
const nativePdf = process.platform === 'darwin';

function pdf(pages, { encoded = false } = {}) {
  const escape = text => text.replace(/[\\()]/g, character => `\\${character}`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, lines] of pages.entries()) {
    const stream = lines.map((text, line) => `BT /F1 12 Tf 50 ${740 - line * 24} Td (${escape(text)}) Tj ET`).join('\n');
    const content = encoded ? `${Buffer.from(stream).toString('hex')}>` : stream;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)}${encoded ? ' /Filter /ASCIIHexDecode' : ''} >>\nstream\n${content}\nendstream`);
  }
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${output}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function fixture(t, filename, content) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-pdf-preview-'));
  const root = path.join(temporary, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, filename), content);
  fs.writeFileSync(path.join(root, 'draft.md'), '# Draft\n');
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, writer, { watch: false });
  return { app, project, root };
}

test('PDF inspector preserves a cited word, page, and drawing region', () => {
  const bbox = { x: 0.1, y: 0.2, width: 0.2, height: 0.1 };
  const preview = buildInspectorPreview({ path: 'plan.pdf', content: pdf([['BEDROOM 144 SF']]) },
    { pageNumber: 2, bbox }, { rawText: 'BEDROOM 144 SF' });
  assert.equal(preview.kind, 'pdf');
  assert.equal(preview.page, 2);
  assert.equal(preview.pageNumber, 2);
  assert.equal(preview.selectedText, 'BEDROOM 144 SF');
  assert.deepEqual(preview.bbox, bbox);
  assert.deepEqual(preview.openAt, { page: 2 }, 'Open file lands on the cited page');
});

test('the local PDF engine extracts encoded PDF words the syntax fallback cannot read', { skip: !nativePdf }, () => {
  assert.equal(extractPdfFullText(pdf([['Cytokine']], { encoded: true })).trim(), 'Cytokine');
});

test('the Cedar Lane drawing indexes wrapped sentences and paragraphs as independently citable PDF excerpts', { skip: !nativePdf }, t => {
  const bytes = fs.readFileSync(new URL('./fixtures/drawings/cedar-lane-concept-plan.pdf', import.meta.url));
  const sentence = 'The separate KIT reference IFC is used only to test model previews.';
  const paragraph = 'A fictional residential renovation. ' + sentence;
  const passages = extractPdfPassages(bytes);
  assert.ok(passages.some(item => item.excerptType === 'sentence' && item.selectedText === sentence));
  assert.ok(passages.some(item => item.excerptType === 'paragraph' && item.selectedText === paragraph));
  const { app, project } = fixture(t, 'Cedar-Lane-Concept-Plan.pdf', bytes);
  const objects = app.dependencies.objectsAt(project.id);
  const drawing = objects.find(object => object.objectType === 'DRAWING');
  const excerpt = objects.find(object => object.metadata.rawText === sentence);
  assert.ok(drawing, 'a drawing PDF must retain its original drawing references');
  assert.ok(excerpt, 'a drawing PDF must also offer text passages');
  assert.equal(excerpt.anchor.pageNumber, 1);
  assert.equal(excerpt.metadata.componentType, 'PDF_EXCERPT');
  const completion = app.dependencies.predict(project.id, { text: 'The separate KIT reference IFC', documentPath: 'draft.md' }).completion;
  assert.ok(completion);
  assert.equal(completion.completedText, sentence);
  assert.equal(completion.source.objectId, excerpt.id);
  assert.equal(completion.dependencyCandidate.versionId, excerpt.versionId);
  const preview = buildInspectorPreview({ path: excerpt.path, content: bytes }, excerpt.anchor, excerpt.metadata);
  assert.equal(preview.selectedText, sentence);
  assert.equal(preview.hasExcerpt, true);
  assert.ok(preview.bbox.width > 0 && preview.bbox.height < 0.1);
  const whole = buildInspectorPreview({ path: drawing.path, content: bytes }, drawing.anchor, drawing.metadata);
  assert.equal(whole.selectedText, '');
  assert.equal(whole.hasExcerpt, false);
  assert.ok(whole.text.includes(sentence.replace(' to test', ' to\ntest')));
  assert.equal(buildSharePreview({ path: drawing.path, content: bytes }, drawing.anchor, drawing.metadata), null,
    'a page reference must not silently share the entire page as an excerpt');
});

test('older PDF indexes gain passages without replacing existing objects or versions', { skip: !nativePdf }, t => {
  const bytes = pdf([['GENERAL NOTES', 'Exterior insulation must continue around all window openings.']]);
  const { app, project } = fixture(t, 'notes.pdf', bytes);
  const originals = app.dependencies.objectsAt(project.id).filter(object => object.anchor?.kind !== 'pdf-excerpt');
  // Simulate a version-one index made before PDF passage support shipped.
  const guard = app.dependencies.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  app.dependencies.db.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  app.dependencies.db.exec(`DELETE FROM scientific_object_versions WHERE object_id IN
    (SELECT id FROM scientific_objects WHERE object_key LIKE '%:pdf-excerpt:%');
    DELETE FROM scientific_objects WHERE object_key LIKE '%:pdf-excerpt:%';`);
  app.dependencies.db.exec(guard);
  app.dependencies.db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 1 WHERE snapshot_id = ?').run(project.currentSnapshotId);
  app.dependencies.objectCache.delete(project.currentSnapshotId);
  app.dependencies.ensureIndex(project.id);
  const updated = app.dependencies.objectsAt(project.id);
  assert.ok(updated.some(object => object.anchor?.kind === 'pdf-excerpt'));
  for (const original of originals) {
    const preserved = updated.find(object => object.id === original.id);
    assert.equal(preserved.versionId, original.versionId);
  }
  assert.throws(() => app.dependencies.db.prepare('DELETE FROM scientific_object_versions WHERE id = ?').run(originals[0].versionId), /immutable/);
  // The upgrade records the current index version (4 adds STEP CAD models).
  assert.equal(app.dependencies.db.prepare('SELECT drawing_index_version AS version FROM snapshot_object_indexes WHERE snapshot_id = ?')
    .get(project.currentSnapshotId).version, INDEX_VERSION);
});

test('visual PDF documents preserve original layout while redaction keeps safe extracted blocks', () => {
  const file = { path: 'plan.pdf', content: pdf([['Cedar Lane Concept Plan', 'Private drawing note']]) };
  const visual = buildFullShareDocument(file, { visualPdf: true });
  assert.equal(visual.kind, 'pdf');
  assert.ok(visual.blocks.join(' ').includes('Private drawing note'));
  const selective = buildFullShareDocument(file);
  assert.equal(selective.kind, 'text');
  assert.deepEqual(selective.blocks, visual.blocks);
});

test('public complete PDF shares render the pinned original inline without opening other disclosure scopes', async t => {
  const bytes = pdf([['FLOOR PLAN', 'Cedar Lane Concept Plan', 'Public drawing notes'], ['GENERAL NOTES', 'PRIVATE_SECOND_PAGE_NOTE']]);
  const { app, project, root } = fixture(t, 'Cedar-Lane-Concept-Plan.pdf', bytes);
  const drawing = app.dependencies.objectsAt(project.id).find(object => object.objectType === 'DRAWING');
  assert.ok(drawing);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const local = await (await fetch(`${base}/api/dependency-objects/${drawing.id}/document`)).json();
  assert.equal(local.document.kind, 'pdf');
  assert.ok(local.document.fileUrl.endsWith(`?version=${drawing.versionId}`));
  assert.deepEqual(Buffer.from(await (await fetch(base + local.document.fileUrl)).arrayBuffer()), bytes);
  const create = accessScope => app.objectShares.createShare({ projectId: project.id,
    objectId: drawing.id, versionId: drawing.versionId, actor: writer, accessScope,
    redactions: accessScope === 'REDACTED' ? local.document.blocks.map((_, block) => ({ kind: 'BLOCK', block, effect: 'BLANK' })) : [] });
  const complete = create('DOCUMENT');
  const sharedUrl = `${base}/d/${complete.token}`;
  const html = await (await fetch(sharedUrl)).text();
  assert.match(html, /class="shared-pdf"/);
  assert.ok(html.includes(`/d/${complete.token}/source#page=`));
  assert.doesNotMatch(html, /An inline excerpt is unavailable/);
  assert.ok(!html.includes(root));
  const inline = await fetch(`${sharedUrl}/source`);
  assert.equal(inline.status, 200);
  assert.equal(inline.headers.get('content-type'), 'application/pdf');
  assert.equal(inline.headers.get('content-disposition'), 'inline; filename="Cedar-Lane-Concept-Plan.pdf"');
  assert.equal(inline.headers.get('cache-control'), 'no-store');
  assert.equal(inline.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await inline.arrayBuffer()), bytes);
  fs.writeFileSync(path.join(root, 'Cedar-Lane-Concept-Plan.pdf'), pdf([['Changed after sharing']]));
  app.timeline.capture(project.id, writer);
  assert.deepEqual(Buffer.from(await (await fetch(`${sharedUrl}/source`)).arrayBuffer()), bytes);
  assert.deepEqual(Buffer.from(await (await fetch(base + local.document.fileUrl)).arrayBuffer()), bytes);
  for (const accessScope of ['INDEXED', 'REDACTED']) {
    const restricted = create(accessScope);
    const restrictedUrl = `${base}/d/${restricted.token}`;
    const page = await (await fetch(restrictedUrl)).text();
    assert.doesNotMatch(page, /class="shared-pdf"|<iframe/);
    assert.ok(!page.includes(`/d/${restricted.token}/source`));
    assert.equal((await fetch(`${restrictedUrl}/source`)).status, 403);
    assert.equal((await fetch(`${restrictedUrl}/download`)).status, 403);
    if (accessScope === 'REDACTED') {
      assert.doesNotMatch(page, /PRIVATE_SECOND_PAGE_NOTE/);
      const excerpt = await fetch(`${restrictedUrl}/excerpt`);
      assert.equal(excerpt.status, 200);
      assert.match(excerpt.headers.get('content-type'), /text\/plain/);
      assert.doesNotMatch(await excerpt.text(), /PRIVATE_SECOND_PAGE_NOTE|%PDF/);
    }
  }
  const text = app.dependencies.objectsAt(project.id).find(object => object.path === 'draft.md');
  const nonPdf = app.objectShares.createShare({ projectId: project.id, objectId: text.id,
    versionId: text.versionId, actor: writer, accessScope: 'DOCUMENT' });
  assert.equal((await fetch(`${base}/d/${nonPdf.token}/source`)).status, 415);
  const expired = app.objectShares.createShare({ projectId: project.id, objectId: drawing.id,
    versionId: drawing.versionId, actor: writer, accessScope: 'DOCUMENT', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // The link lapses: its stored expiry passes.
  app.db.prepare('UPDATE object_share_grants SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00.000Z', expired.token);
  assert.equal((await fetch(`${base}/d/${expired.token}/source`)).status, 410);
  app.objectShares.revokeShare(complete.token);
  assert.equal((await fetch(`${sharedUrl}/source`)).status, 410);
  assert.equal((await fetch(`${base}/d/${'z'.repeat(32)}/source`)).status, 404);
});

test('drawing PDF preview fetches the exact indexed bytes and keeps later page excerpts', { skip: !nativePdf }, async t => {
  const sentence = 'Exterior wall assemblies use a continuous thermal barrier around the occupied spaces.';
  const bytes = pdf([['FLOOR PLAN', 'Cedar Lane Concept Plan'], ['GENERAL NOTES', sentence]], { encoded: true });
  const { app, project, root } = fixture(t, 'Cedar-Lane-Concept-Plan.pdf', bytes);
  const drawing = app.dependencies.objectsAt(project.id).find(object => object.objectType === 'DRAWING' && object.anchor.pageNumber === 2);
  assert.ok(drawing);
  const completion = app.dependencies.predict(project.id, { text: 'Exterior wall assemblies use', documentPath: 'draft.md' }).completion;
  const excerpt = completion.dependencyCandidate;
  assert.notEqual(completion.source.objectId, drawing.id);
  assert.equal(excerpt.objectType, 'DOCUMENT');
  assert.equal(excerpt.metadata.componentType, 'PDF_EXCERPT');
  assert.equal(excerpt.metadata.rawText, sentence);
  assert.equal(excerpt.anchor.selectedText, sentence);
  assert.equal(excerpt.anchor.kind, 'pdf-excerpt');
  assert.equal(completion.completedText, sentence);
  assert.equal(completion.sourceSentence, sentence);
  assert.equal(completion.dependencyCandidate.anchor.pageNumber, 2);
  assert.equal(completion.generated, false);
  assert.ok(app.dependencies.search(project.id, 'thermal barrier').some(object => object.id === drawing.id));
  assert.ok(app.dependencies.search(project.id, 'thermal barrier').some(object => object.id === excerpt.id));

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/dependency-objects/${drawing.id}/preview`);
  assert.equal(response.status, 200);
  const { preview } = await response.json();
  assert.equal(preview.kind, 'pdf');
  assert.equal(preview.page, 2);
  assert.ok(preview.fileUrl.endsWith(`?version=${drawing.versionId}`));
  assert.ok(preview.text.includes(sentence));
  const excerptResponse = await (await fetch(`${base}/api/dependency-objects/${excerpt.id}/preview`)).json();
  assert.equal(excerptResponse.preview.selectedText, sentence);
  assert.equal(excerptResponse.preview.page, 2);
  assert.equal(excerptResponse.preview.hasExcerpt, true);
  const excerptShare = buildSharePreview({ path: 'Cedar-Lane-Concept-Plan.pdf', content: bytes }, excerpt.anchor, excerpt.metadata);
  assert.equal(excerptShare.text, sentence);
  assert.equal(excerptShare.pageNumber, 2);
  assert.ok(!excerptShare.text.includes('Cedar Lane Concept Plan'));
  const renderedBytes = Buffer.from(await (await fetch(base + preview.fileUrl)).arrayBuffer());
  assert.deepEqual(renderedBytes, bytes);
  const snapshotResponse = await fetch(`${base}/api/snapshots/${drawing.snapshotId}/preview?path=Cedar-Lane-Concept-Plan.pdf`);
  assert.equal(snapshotResponse.status, 200);
  const { preview: snapshotPreview } = await snapshotResponse.json();
  assert.equal(snapshotPreview.kind, 'pdf');
  assert.equal(snapshotPreview.pages[1].anchor.pageNumber, 2);
  assert.ok(snapshotPreview.pages[1].text.includes(sentence));
  const snapshotSource = await fetch(base + snapshotPreview.fileUrl);
  assert.equal(snapshotSource.headers.get('content-type'), 'application/pdf');
  assert.equal(snapshotSource.headers.get('content-disposition'), 'inline');
  assert.equal(snapshotSource.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await snapshotSource.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/api/snapshots/${drawing.snapshotId}/source?path=draft.md`)).status, 415);

  fs.writeFileSync(path.join(root, 'Cedar-Lane-Concept-Plan.pdf'), pdf([['FLOOR PLAN', 'Changed export']]));
  app.timeline.capture(project.id, writer);
  const pinnedBytes = Buffer.from(await (await fetch(base + preview.fileUrl)).arrayBuffer());
  assert.deepEqual(pinnedBytes, bytes, 'a new export must not replace bytes in an open preview');
  assert.deepEqual(Buffer.from(await (await fetch(base + snapshotPreview.fileUrl)).arrayBuffer()), bytes);
  const inspector = await (await fetch(`${base}/inspect?object=${drawing.id}&version=${drawing.versionId}`)).text();
  assert.ok(inspector.includes(`class="source-pdf"`));
  assert.ok(inspector.includes(preview.fileUrl));
});

test('PDF sentences after the metadata excerpt limit remain available for completion and context', { skip: !nativePdf }, t => {
  const background = 'The initial section describes routine collection and ordinary laboratory procedures. '.repeat(280);
  const finding = 'Researchers found that supplemented pregnancies had significantly higher placental amino acid levels.';
  const { app, project } = fixture(t, 'article.pdf', pdf([[background], [finding]]));
  const paper = app.dependencies.objectsAt(project.id).find(object => object.objectType === 'PAPER');
  assert.ok(paper);
  assert.ok(!paper.metadata.textExcerpt.includes(finding));
  assert.ok(app.dependencies.search(project.id, 'placental amino acid').some(object => object.id === paper.id));
  const completion = app.dependencies.predict(project.id, { text: 'Researchers found that supplemented', documentPath: 'draft.md' }).completion;
  assert.equal(completion.completedText, finding);
  const context = app.dependencies.sharedSourceContent({ source: paper, spanText: finding }, 'CONTEXT', 0);
  assert.ok(context.text.includes(finding));
});
