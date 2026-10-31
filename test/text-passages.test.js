import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { markdownPassages } from '../src/sharing/markdown.js';
import { extractDocxFullText } from '../src/dependencies/document-extraction.js';
import { storedZip } from './fixtures/workbook.js';

const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const NOTES = `# Field notes

## Irrigation

Soil moisture in **plot B** rose by
eighteen percent after the second irrigation cycle. The [sensor log](https://example.com/log) confirms the trend.

- Root depth stayed below the *expected* thirty centimetres.

| Plot | Moisture |
| --- | --- |
| B | 18 |
`;

function workspace(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-text-passages-'));
  const root = path.join(sandbox, 'Study');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, writer, { watch: false });
  return { app, project };
}

const excerpts = (objects, filePath) => objects.filter(object => object.path === filePath
  && object.metadata.componentType === 'TEXT_EXCERPT');

test('markdown passages are plain sentences and paragraphs with source offsets and lines', () => {
  const passages = markdownPassages(NOTES);
  const moisture = 'Soil moisture in plot B rose by eighteen percent after the second irrigation cycle.';
  assert.deepEqual(passages.map(passage => [passage.excerptType, passage.selectedText]), [
    ['sentence', moisture],
    ['sentence', 'The sensor log confirms the trend.'],
    ['paragraph', `${moisture} The sensor log confirms the trend.`],
    ['sentence', 'Root depth stayed below the expected thirty centimetres.'],
  ]);
  const [sentence, linked, paragraph, item] = passages;
  assert.equal(NOTES.slice(sentence.start, sentence.end), 'Soil moisture in **plot B** rose by\neighteen percent after the second irrigation cycle.');
  assert.deepEqual([sentence.lineStart, sentence.lineEnd, sentence.section], [5, 6, 'Irrigation']);
  assert.deepEqual([linked.lineStart, linked.lineEnd], [6, 6]);
  assert.match(NOTES.slice(linked.start, linked.end), /^The \[sensor log\]\(https:\/\/example\.com\/log\) confirms the trend\.$/);
  assert.deepEqual([paragraph.start, paragraph.lineStart, paragraph.lineEnd], [sentence.start, 5, 6]);
  assert.equal(item.lineStart, 8);
  // Plain text keeps characters that would be Markdown markers.
  assert.equal(markdownPassages('The *starred* value stayed at four units.', { plain: true })[0].selectedText,
    'The *starred* value stayed at four units.');
});

test('markdown and text sources index passages that previews and indexed shares cite exactly', async t => {
  const { app, project } = workspace(t, {
    'notes.md': NOTES,
    'log.txt': 'Weekly log.\n\nThe pump at station four was replaced on Tuesday.\nIt has run without faults since then.\n',
  });
  const objects = app.dependencies.objectsAt(project.id);
  const parent = objects.find(object => object.path === 'notes.md' && object.objectKey.endsWith(':document'));
  assert.equal(parent.valueText, 'Field notes', 'the whole-document object is unchanged');
  const passages = excerpts(objects, 'notes.md');
  assert.equal(passages.length, 4);
  const sentence = passages.find(object => object.valueText.startsWith('Soil moisture'));
  assert.equal(sentence.objectType, 'DOCUMENT');
  assert.equal(sentence.metadata.excerptType, 'sentence');
  assert.equal(sentence.metadata.format, 'MARKDOWN');
  assert.equal(sentence.anchor.kind, 'text-excerpt');
  assert.equal(sentence.anchor.selectedText, sentence.valueText);
  assert.deepEqual([sentence.anchor.lineStart, sentence.anchor.lineEnd], [5, 6]);
  assert.ok(Number.isInteger(sentence.anchor.start) && sentence.anchor.end > sentence.anchor.start);

  const text = excerpts(objects, 'log.txt');
  assert.deepEqual(text.map(object => object.metadata.excerptType).sort(), ['paragraph', 'sentence', 'sentence']);
  const pump = text.find(object => object.valueText.startsWith('The pump'));
  assert.deepEqual([pump.anchor.lineStart, pump.anchor.lineEnd, pump.metadata.format], [3, 3, 'TXT']);

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const preview = async object => (await (await fetch(
    `${base}/api/dependency-objects/${object.id}/preview?version=${object.versionId}`)).json()).preview;

  // No `text` hint: the passage anchor alone selects the cited block.
  const markdown = await preview(sentence);
  assert.equal(markdown.format, 'markdown');
  assert.equal(markdown.location, 'Irrigation · Lines 5–6');
  assert.equal(markdown.text, sentence.valueText);
  assert.deepEqual(markdown.blocks.filter(block => block.cited).map(block => block.type), ['paragraph']);
  const item = await preview(passages.find(object => object.valueText.startsWith('Root depth')));
  assert.deepEqual(item.blocks.filter(block => block.cited).map(block => block.type), ['item']);
  const plain = await preview(pump);
  assert.equal(plain.location, 'Line 3');
  assert.equal(plain.text, pump.valueText);
  assert.deepEqual(plain.lines.filter(line => line.cited).map(line => line.lineNumber), [3]);

  const response = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ objectId: sentence.id, versionId: sentence.versionId, actor: writer, accessScope: 'INDEXED' }),
  });
  assert.equal(response.status, 201);
  const share = (await response.json()).share;
  const page = await (await fetch(`${base}/d/${share.token}`)).text();
  assert.match(page, /Soil moisture in plot B rose by eighteen percent after the second irrigation cycle\./);
  assert.match(page, /lines 5–6/);
  assert.doesNotMatch(page, /Field notes|sensor log|Root depth|example\.com/, 'only the indexed passage is published');
  const excerpt = await (await fetch(`${base}/d/${share.token}/excerpt`)).text();
  assert.equal(excerpt.trim(), sentence.valueText);
});

test('accepted markdown sentence completions link to their own passage object', t => {
  const { app, project } = workspace(t, { 'draft.md': '# Draft\n', 'notes.md': NOTES });
  const prompt = 'Our records show soil moisture in plot B rose by';
  const prediction = app.dependencies.predict(project.id, { text: prompt, cursor: prompt.length, documentPath: 'draft.md' });
  const completion = prediction.completion;
  assert.ok(completion, 'a completion comes from the indexed notes');
  assert.equal(completion.insertText, ' eighteen percent after the second irrigation cycle.');
  const candidate = completion.dependencyCandidate;
  assert.equal(candidate.path, 'notes.md');
  assert.equal(candidate.metadata.componentType, 'TEXT_EXCERPT');
  assert.equal(candidate.metadata.excerptType, 'sentence');
  assert.deepEqual([candidate.anchor.lineStart, candidate.anchor.lineEnd], [5, 6]);

  const completed = `${prompt}${completion.insertText}`;
  app.dependencies.saveDocument(project.id, {
    path: 'draft.md', content: `# Draft\n\n${completed}\n`, baseSnapshotId: project.currentSnapshotId,
  }, writer);
  const document = app.dependencies.getDocument(project.id, 'draft.md');
  const blockIndex = document.blocks.findIndex(block => block.text === completed);
  const linked = app.dependencies.link(project.id, {
    documentPath: 'draft.md',
    anchor: anchorForSpan(blockIndex, document.blocks[blockIndex].type, completed, 0, completed.length),
    spanText: completed, sourceObjectId: candidate.id, sourceSnapshotId: candidate.snapshotId,
    selectionMethod: 'AUTOCOMPLETE', expectedSnapshotId: document.snapshotId,
  }, writer);
  assert.equal(linked.dependency.source.id, candidate.id);
  assert.equal(linked.dependency.source.anchor.lineStart, 5);
  const context = app.dependencies.sharedSourceContent(linked.dependency, 'CONTEXT', 0);
  assert.equal(context.kind, 'text-context');
  assert.match(context.text, /Soil moisture in \*\*plot B\*\* rose by/);
});

test('an index made before text passages gains them without changing existing versions', t => {
  const { app, project } = workspace(t, { 'notes.md': NOTES });
  const objects = app.dependencies.objectsAt(project.id);
  const originals = objects.filter(object => object.metadata.componentType !== 'TEXT_EXCERPT');
  const db = app.dependencies.db;
  const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  db.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  db.exec(`DELETE FROM scientific_object_versions WHERE object_id IN
    (SELECT id FROM scientific_objects WHERE object_key LIKE '%:text-excerpt:%');
    DELETE FROM scientific_objects WHERE object_key LIKE '%:text-excerpt:%';`);
  db.exec(guard);
  db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 2 WHERE snapshot_id = ?').run(project.currentSnapshotId);
  app.dependencies.objectCache.delete(project.currentSnapshotId);
  assert.equal(excerpts(app.dependencies.objectsAt(project.id), 'notes.md').length, 4, 'passages are added on upgrade');
  for (const original of originals) {
    assert.equal(app.dependencies.objectsAt(project.id).find(object => object.id === original.id).versionId, original.versionId);
  }
  // The upgrade records the current index version (4 adds STEP CAD models, 5 Word passages).
  assert.equal(db.prepare('SELECT drawing_index_version AS version FROM snapshot_object_indexes WHERE snapshot_id = ?')
    .get(project.currentSnapshotId).version, 5);
});

test('a Word document is read a paragraph per line, and an index from before Word passages gains them', t => {
  // Arrange
  const memo = storedZip({ 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>'
    + '<w:p><w:r><w:t>Site visit</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>The pump on line 3 was repl</w:t></w:r><w:r><w:t>aced on 2 May after the seal failed.</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Flow returned to 42 litres per minute </w:t></w:r><w:r><w:t>by the afternoon.</w:t></w:r></w:p>'
    + '</w:body></w:document>' });
  const { app, project } = workspace(t, { 'visit.docx': memo });
  const db = app.dependencies.db;

  // Act
  const text = extractDocxFullText(memo);
  const indexed = excerpts(app.dependencies.objectsAt(project.id), 'visit.docx');
  const guard = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  db.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  db.exec(`DELETE FROM scientific_object_versions WHERE object_id IN
    (SELECT id FROM scientific_objects WHERE object_key LIKE '%:text-excerpt:%');
    DELETE FROM scientific_objects WHERE object_key LIKE '%:text-excerpt:%';`);
  db.exec(guard);
  db.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 4 WHERE snapshot_id = ?').run(project.currentSnapshotId);
  app.dependencies.objectCache.delete(project.currentSnapshotId);
  const upgraded = excerpts(app.dependencies.objectsAt(project.id), 'visit.docx');

  // Assert
  assert.equal(text, 'Site visit\n\nThe pump on line 3 was replaced on 2 May after the seal failed.\n\nFlow returned to 42 litres per minute by the afternoon.',
    'paragraphs on their own lines, runs joined as written');
  const cited = (passages) => passages.map((passage) => [passage.anchor.lineStart, passage.valueText]).sort();
  assert.deepEqual(cited(indexed), [[3, 'The pump on line 3 was replaced on 2 May after the seal failed.'],
    [5, 'Flow returned to 42 litres per minute by the afternoon.']]);
  assert.deepEqual(cited(upgraded), cited(indexed), 'an index from before version 5 reads Word passages on upgrade');
});
