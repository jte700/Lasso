import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { BRACKET, bracketPart, fixtureAssembly } from './fixtures/step-models.js';

const actor = { id: 'human:cad-reviewer', displayName: 'CAD reviewer', actorType: 'HUMAN_SELF' };

function workspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-integration-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(path.join(root, 'CAD'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CAD', 'bracket.step'), bracketPart());
  fs.writeFileSync(path.join(root, 'Notes.md'), '# Notes\n\nThe mounting holes are 8 mm in diameter and the plate is 100 mm long.\n');
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false };
  const app = createApplication(config);
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { app, project, root };
}

function linkSpan(app, project, source, spanText) {
  const document = app.dependencies.getDocument(project.id, 'Notes.md');
  const index = document.blocks.findIndex(block => block.text.includes(spanText));
  const block = document.blocks[index], start = block.text.indexOf(spanText);
  return app.dependencies.link(project.id, {
    documentPath: 'Notes.md', anchor: anchorForSpan(index, block.type, block.text, start, start + spanText.length),
    spanText, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
  }, actor).dependency.id;
}

test('STEP part facts flow through search, questions, model previews and source links', async t => {
  const { app, project, root } = workspace(t);
  // Broad queries show a few results per file; name the feature to reach it.
  const found = app.dependencies.search(project.id, 'Bracket Ø8 hole diameter');
  const hole = found.find(object => object.label === 'Bracket Ø8 hole diameter');
  assert.ok(hole, 'ordinary search discovers measured CAD features');
  assert.equal(hole.objectType, 'DRAWING_ANNOTATION');
  assert.equal(hole.valueText, '8 mm');
  assert.equal(hole.anchor.kind, 'cad-property');
  assert.equal(hole.anchor.featureId, 'hole:8:10');

  const run = question => app.terminal.executor.run(project.id, question, actor);
  const answer = run('What is the diameter of the Bracket Ø8 hole?');
  assert.equal(answer.data.answered, true);
  assert.equal(answer.data.value, '8 mm');
  assert.equal(answer.data.measurementBasis, 'geometry');
  assert.equal(run('What is the radius of the Bracket arc?').data.value, '5 mm');
  assert.equal(run('What is the arc length of the Bracket arc?').data.value, '7.853981634 mm');
  const length = run('What is the length of Bracket?');
  assert.equal(length.data.reason, 'AMBIGUOUS_DRAWING_VALUE', 'X, Y and Z extents are offered rather than guessed');
  assert.equal(length.data.candidates.length, 3);
  assert.equal(run('What is the diameter of the Bracket Ø9 hole?').data.answered, false);

  // Written values carry units; the popup ranks the matching measurement first
  // and does not treat centimetres as millimetres.
  const predicted = text => app.dependencies.predict(project.id, { text, cursor: text.length, blockIndex: 1, documentPath: 'Notes.md' })
    .claims[0].candidates;
  const millimetres = predicted('The Bracket Ø8 hole diameter is 8 mm')[0];
  assert.equal(millimetres.label, 'Bracket Ø8 hole diameter');
  assert.ok(millimetres.reasons.includes('matching value'));
  assert.equal(predicted('The Bracket Ø12 hole diameter is 12 mm')[0].label, 'Bracket Ø12 hole diameter');
  assert.ok(!predicted('The Bracket Ø8 hole diameter is 8 cm').some(candidate => candidate.reasons.includes('matching value')));

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const { preview } = await get(`/api/dependency-objects/${hole.id}/preview?version=${hole.versionId}`);
  assert.equal(preview.kind, 'model-plan', preview.reason);
  assert.equal(preview.view, 'Isometric view');
  assert.equal(preview.selected.label, 'Bracket · Ø8 hole');
  assert.equal(preview.elements.filter(element => element.selected).flatMap(element => element.lines).length, 20);
  const { preview: file } = await get(`/api/snapshots/${hole.snapshotId}/preview?path=CAD/bracket.step&elementId=Bracket&featureId=${encodeURIComponent('arc:5:90')}`);
  assert.equal(file.selected.label, 'Bracket · R5 90° arc');
  const { objects } = await get(`/api/projects/${project.id}/source-library`);
  const model = objects.find(object => object.objectType === 'DRAWING' && object.path === 'CAD/bracket.step');
  assert.ok(model.searchAliases.includes('CAD model'));

  const extent = app.dependencies.search(project.id, 'Bracket overall X extent').find(object => object.label === 'Bracket overall X extent');
  const holeLink = linkSpan(app, project, hole, '8 mm');
  const extentLink = linkSpan(app, project, extent, '100 mm');
  const viewer = app.dependencies.dependencySourceViewer(holeLink);
  assert.equal(viewer.kind, 'document');
  assert.match(viewer.text, /CYLINDRICAL_SURFACE\('',#\d+,4\.\)/);
  assert.equal(viewer.text.slice(viewer.selectedStart, viewer.selectedStart + viewer.selectedText.length), viewer.selectedText);
  assert.equal((await app.dependencies.dependencyModelPreview(holeLink)).selected.label, 'Bracket · Ø8 hole');

  // Resize the four Ø8 holes. The plate's extents keep their identity; the
  // Ø8 feature no longer exists and is not silently redirected to Ø10.
  fs.writeFileSync(path.join(root, 'CAD', 'bracket.step'), bracketPart({ holes: BRACKET.holes.map(item => item.split ? item : { ...item, radius: 5 }) }));
  assert.equal(app.timeline.capture(project.id, actor, { source: 'EXPLICIT_CHECKPOINT' }).changed, true);
  assert.equal(app.dependencies.getDependency(holeLink).status, 'BROKEN');
  assert.notEqual(app.dependencies.getDependency(extentLink).status, 'BROKEN');
  assert.equal(app.dependencies.objectsAt(project.id).find(object => object.id === extent.id).valueText, '100 mm');
  assert.equal(app.dependencies.dependencyPreview(holeLink).source.valueText, '8 mm', 'the pinned version keeps its evidence');
  assert.ok(app.dependencies.search(project.id, 'Bracket Ø10 hole diameter').some(object => object.label === 'Bracket Ø10 hole diameter'));
  const pinned = await app.dependencies.dependencyModelPreview(holeLink);
  assert.equal(pinned.selected.label, 'Bracket · Ø8 hole', 'historical previews render the linked source version');
});

test('snapshots indexed before STEP support gain CAD facts lazily without creating timeline edits', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-upgrade-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'fixture.stp'), fixtureAssembly());
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Item,Cost\nPins,40\n');
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false };
  let app = createApplication(config);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const step = () => app.dependencies.objectsAt(project.id).filter(object => object.path === 'fixture.stp');
  const indexed = step().map(object => object.objectKey).sort();
  const budget = app.dependencies.objectsAt(project.id).find(object => object.path === 'Budget.csv');
  const snapshotId = project.currentSnapshotId;
  const databasePath = app.config.databasePath;
  await app.close();
  // Fixture construction only: rebuild a snapshot indexed by the previous
  // drawing reader, then restore the immutability guard before reopening.
  const legacy = new DatabaseSync(databasePath);
  const guard = legacy.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  legacy.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  legacy.prepare("DELETE FROM scientific_object_versions WHERE path = 'fixture.stp'").run();
  // Index version 3 is the last one before STEP models (4).
  legacy.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 3 WHERE snapshot_id = ?').run(snapshotId);
  legacy.exec(guard);
  legacy.close();
  app = createApplication(config);
  assert.deepEqual(step().map(object => object.objectKey).sort(), indexed);
  assert.equal(app.dependencies.objectsAt(project.id).find(object => object.id === budget.id).versionId, budget.versionId, 'earlier objects keep their versions');
  assert.equal(app.db.prepare('SELECT drawing_index_version FROM snapshot_object_indexes WHERE snapshot_id = ?').get(snapshotId).drawing_index_version, 4);
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, snapshotId);
});
