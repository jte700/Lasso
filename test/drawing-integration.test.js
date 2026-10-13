import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';

const actor = { id: 'human:drawing-reviewer', displayName: 'Drawing reviewer', actorType: 'HUMAN_SELF' };
const spaceGuid = '0YvctVUKr0kugbFTf53O9L';

// Small exchange model for lifecycle tests. The independent downloaded IFC
// and LandXML acceptance run is scripts/validate-drawing-sample.js.
function roomModel(area = 20) {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('rooms.ifc','2026-10-12T00:00:00',('Test'),('Test'),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#3=IFCUNITASSIGNMENT((#1,#2));
#4=IFCPROJECT('0jwnU9qGD0b8PTtX03mIf1',$,'Room model',$,$,$,$,$,#3);
#5=IFCSPACE('${spaceGuid}',$,'101',$,$,$,$,'Conference',.ELEMENT.,$,$);
#6=IFCQUANTITYAREA('NetFloorArea',$,$,${area}.,$);
#7=IFCQUANTITYAREA('GrossFloorArea',$,$,25.,$);
#8=IFCELEMENTQUANTITY('2QffKrYT12kwTWIkFVWaE1',$,'Qto_SpaceBaseQuantities',$,$,(#6,#7));
#9=IFCRELDEFINESBYPROPERTIES('0OZZDxlGb7BPUVPymrkX0U',$,$,$,(#5),#8);
#10=IFCBUILDINGSTOREY('2IKtcuaz91dPPrUW0MPgAh',$,'Ground floor',$,$,$,$,$,.ELEMENT.,0.);
#11=IFCRELAGGREGATES('1YWwgSZAT8swTlYaAlWxoj',$,$,$,#10,(#5));
ENDSEC;
END-ISO-10303-21;
`;
}

function workspace(t, extraFiles = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-drawing-integration-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'rooms.ifc'), roomModel());
  fs.writeFileSync(path.join(root, 'Notes.md'), '# Notes\n\nThe Conference room has 20 m² of net floor area.\n');
  for (const [name, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(root, name), content);
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false };
  const state = { root, config, app: createApplication(config) };
  state.project = state.app.timeline.importProject(root, actor, { watch: false }).project;
  t.after(async () => { await state.app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return state;
}

function roomFact(state) {
  return state.app.dependencies.objectsAt(state.project.id, null, ['DRAWING_ANNOTATION'])
    .find((object) => object.metadata.globalId === spaceGuid && object.metadata.propertyName === 'NetFloorArea');
}

test('native model facts flow through graph, source links, revisions, and pinned historical evidence', async (t) => {
  const state = workspace(t);
  const { app, project, root } = state;
  // A normal search must trigger indexing without a separate drawing import.
  const found = app.terminal.graph.search(project.id, 'Conference Net Floor Area', { limit: 20 });
  const result = found.find((entry) => entry.object.metadata.propertyName === 'NetFloorArea');
  assert.ok(result, 'search discovers model quantities during ordinary project indexing');
  const source = result.object;
  assert.equal(source.objectType, 'DRAWING_ANNOTATION');
  assert.equal(source.valueText, '20 m²');
  assert.equal(source.metadata.storey, 'Ground floor');
  assert.equal(source.anchor.kind, 'cad-property');
  assert.equal(source.anchor.elementId, spaceGuid);

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(`${base}/api/snapshots/${source.snapshotId}/preview?path=rooms.ifc`);
  assert.equal(response.status, 200);
  const { preview: filePreview } = await response.json();
  assert.equal(filePreview.kind, 'drawing');
  const selected = filePreview.items.find((item) => item.anchor.propertyName === 'NetFloorArea');
  assert.equal(selected.value, '20 m²');
  assert.equal(selected.basis, 'model-property');
  assert.equal(selected.anchor.identifier, source.anchor.identifier);
  assert.equal(selected.anchor.elementId, spaceGuid);
  assert.ok(selected.location.includes('Qto_SpaceBaseQuantities'));

  const graphPreview = app.terminal.graph.preview(project.id, source);
  assert.equal(graphPreview.kind, 'text');
  assert.equal(graphPreview.measurementBasis, 'model-property');
  assert.ok(graphPreview.lines.some((line) => line.text.includes("#6=IFCQUANTITYAREA('NetFloorArea',$,$,20.,$)")));

  const document = app.dependencies.getDocument(project.id, 'Notes.md');
  const index = document.blocks.findIndex((block) => block.text.includes('20 m²'));
  const block = document.blocks[index], start = block.text.indexOf('20 m²');
  const linked = app.dependencies.link(project.id, {
    documentPath: 'Notes.md', anchor: anchorForSpan(index, block.type, block.text, start, start + '20 m²'.length),
    spanText: '20 m²', sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
  }, actor);
  const dependencyId = linked.dependency.id;
  const before = app.dependencies.dependencyPreview(dependencyId);
  assert.equal(before.content.kind, 'text-context');
  assert.equal(before.content.measurementBasis, 'model-property');
  assert.equal(before.source.valueText, '20 m²');
  const viewer = app.dependencies.dependencySourceViewer(dependencyId);
  assert.equal(viewer.kind, 'document');
  assert.ok(viewer.selectedStart > 0, 'highlight starts at the source evidence after its location header');
  assert.equal(viewer.text.slice(viewer.selectedStart, viewer.selectedStart + viewer.selectedText.length), viewer.selectedText);
  assert.match(viewer.locationLabel, /NetFloorArea/);
  assert.ok(viewer.text.includes(spaceGuid));
  assert.ok(viewer.text.includes("#6=IFCQUANTITYAREA('NetFloorArea',$,$,20.,$)"));

  fs.writeFileSync(path.join(root, 'rooms.ifc'), roomModel(24));
  const changed = app.timeline.capture(project.id, actor, { source: 'EXPLICIT_CHECKPOINT' });
  assert.equal(changed.changed, true);
  const current = roomFact(state);
  assert.equal(current.id, source.id, 'GUID + quantity identity survives source revision');
  assert.equal(current.objectKey, source.objectKey);
  assert.notEqual(current.versionId, source.versionId);
  assert.equal(current.valueText, '24 m²');
  const propertyHistory = app.rfi.request(project.id, { path: 'rooms.ifc', anchor: selected.anchor });
  assert.equal(propertyHistory.selection.value, '24 m²');
  assert.deepEqual(propertyHistory.history.map((entry) => entry.value), ['20 m²', '24 m²']);
  const oldHistory = app.rfi.request(project.id, { path: 'rooms.ifc', anchor: selected.anchor, snapshotId: source.snapshotId });
  assert.equal(oldHistory.selection.value, '20 m²');
  assert.equal(app.dependencies.objectAt(project.id, source.snapshotId, source.id).valueText, '20 m²');
  const stale = app.dependencies.getDependency(dependencyId);
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.statusDetails.linkedSourceValue, '20 m²');
  assert.equal(stale.statusDetails.currentSourceValue, '24 m²');
  assert.match(fs.readFileSync(path.join(root, 'Notes.md'), 'utf8'), /20 m²/);
  assert.equal(app.dependencies.dependencyPreview(dependencyId).source.valueText, '20 m²');
  assert.ok(app.dependencies.dependencySourceViewer(dependencyId).text.includes("#6=IFCQUANTITYAREA('NetFloorArea',$,$,20.,$)"));
  const pinnedBytes = app.dependencies.dependencySourceFile(dependencyId).content.toString();
  assert.ok(pinnedBytes.includes("#6=IFCQUANTITYAREA('NetFloorArea',$,$,20.,$)"));
  assert.ok(!pinnedBytes.includes("#6=IFCQUANTITYAREA('NetFloorArea',$,$,24.,$)"));

  await app.close();
  state.app = createApplication(state.config);
  assert.equal(state.app.dependencies.getDependency(dependencyId).status, 'STALE');
  assert.equal(state.app.dependencies.dependencyPreview(dependencyId).source.valueText, '20 m²');
  assert.equal(roomFact(state).id, source.id);
  assert.equal(roomFact(state).valueText, '24 m²');
});

test('drawing migration adds facts to an existing snapshot without replacing earlier indexed objects', async (t) => {
  const state = workspace(t, { 'Budget.csv': 'Item,Cost\nDoors,400\n' });
  const before = state.app.dependencies.objectsAt(state.project.id);
  const existing = before.find((object) => object.path === 'Budget.csv');
  assert.ok(existing);
  const snapshotId = state.project.currentSnapshotId;
  const databasePath = state.app.config.databasePath;
  await state.app.close();
  // Recreate the old schema and its already-indexed snapshot: existing CSV
  // versions remain, while drawing objects and the new marker do not exist.
  const legacy = new DatabaseSync(databasePath);
  const deleteGuard = legacy.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  // This is test-fixture construction only. Restore the exact guard before
  // opening the application; the migration must pass with immutability active.
  legacy.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  legacy.exec(`DELETE FROM scientific_object_versions WHERE object_id IN
    (SELECT id FROM scientific_objects WHERE object_type IN ('DRAWING','DRAWING_ANNOTATION'));
    DELETE FROM scientific_objects WHERE object_type IN ('DRAWING','DRAWING_ANNOTATION');
    ALTER TABLE snapshot_object_indexes DROP COLUMN drawing_index_version;
    DELETE FROM schema_migrations WHERE version=16;`);
  legacy.exec(deleteGuard);
  legacy.close();
  state.app = createApplication(state.config);
  assert.equal(state.app.db.prepare('SELECT drawing_index_version AS version FROM snapshot_object_indexes WHERE snapshot_id=?').get(snapshotId).version, 0);
  const after = state.app.dependencies.objectsAt(state.project.id);
  const preserved = after.find((object) => object.id === existing.id);
  assert.equal(preserved.versionId, existing.versionId, 'historical CSV object version is retained');
  assert.equal(preserved.valueText, existing.valueText);
  assert.ok(after.some((object) => object.metadata.globalId === spaceGuid && object.metadata.propertyName === 'NetFloorArea'));
  assert.equal(state.app.db.prepare('SELECT drawing_index_version AS version FROM snapshot_object_indexes WHERE snapshot_id=?').get(snapshotId).version, 1);
  assert.equal(state.app.timeline.getProject(state.project.id).currentSnapshotId, snapshotId, 'index upgrades do not create timeline edits');
  assert.throws(() => state.app.db.prepare('DELETE FROM scientific_object_versions WHERE id=?').run(existing.versionId), /immutable/);
  const count = after.length;
  state.app.dependencies.ensureIndex(state.project.id);
  assert.equal(state.app.dependencies.objectsAt(state.project.id).length, count, 'repeated indexing does not duplicate facts');
});

test('unsupported native drawing containers remain visible with actionable export guidance', (t) => {
  const state = workspace(t, { 'site.dwg': 'AC1027 unsupported binary container', 'building.rvt': 'Revit binary container' });
  const drawings = state.app.dependencies.objectsAt(state.project.id, null, ['DRAWING']);
  for (const name of ['site.dwg', 'building.rvt']) {
    const file = drawings.find((object) => object.path === name);
    assert.ok(file, `${name} remains discoverable`);
    assert.equal(file.metadata.extractionStatus, 'unsupported');
    assert.equal(file.metadata.annotationCount, 0);
  }
  const failures = state.app.terminal.indexing.failures(state.project.id);
  const dwg = failures.find((failure) => failure.path === 'site.dwg');
  assert.equal(dwg.code, 'DRAWING_UNSUPPORTED');
  assert.match(dwg.reason, /DXF.*IFC.*LandXML/);
  const revit = failures.find((failure) => failure.path === 'building.rvt');
  assert.match(revit.reason, /Export IFC.*rooms\/spaces.*quantities/i);
  assert.equal(revit.retryable, false);
});
