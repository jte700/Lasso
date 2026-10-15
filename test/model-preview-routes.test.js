import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/server.js';

const actor = { id: 'ai:model-preview-test', displayName: 'Model preview test', actorType: 'AI_AGENT' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('real IFC preview routes focus different indexed products and preserve source versions', { timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-model-preview-'));
  const root = path.join(directory, 'Project');
  fs.mkdirSync(root);
  const bytes = fs.readFileSync(new URL('./fixtures/drawings/AC20-FZK-Haus.ifc', import.meta.url));
  fs.writeFileSync(path.join(root, 'House.ifc'), bytes);
  const app = createApplication({ dataDir: path.join(directory, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const objects = app.dependencies.objectsAt(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const selected = [];
  for (const entityType of ['IFCSPACE', 'IFCDOOR', 'IFCWALLSTANDARDCASE', 'IFCWINDOW']) {
    const object = objects.find(o => o.metadata.entityType === entityType);
    assert.ok(object, `${entityType} is actually indexed from the public source`);
    const { preview, source } = await get(`/api/dependency-objects/${object.id}/preview?version=${object.versionId}`);
    assert.ok(source.location.includes(object.anchor.propertyName), 'native preview identifies the selected property');
    assert.notEqual(source.location, '—');
    assert.equal(preview.kind, 'model-plan', preview.reason);
    assert.equal(preview.sourceHash, hash(bytes));
    assert.equal(preview.selected.guid, object.anchor.elementId);
    const highlighted = preview.elements.filter(e => e.selected);
    assert.equal(highlighted.length, 1);
    assert.equal(highlighted[0].guid, object.anchor.elementId);
    assert.ok(highlighted[0].polygons.some(ring => ring.length >= 3));
    assert.ok(preview.elements.some(e => !e.selected), 'surrounding model context remains visible');
    assert.equal(preview.propertyName, object.anchor.propertyName);
    selected.push({ object, preview });
  }
  assert.equal(new Set(selected.map(s => s.preview.selected.guid)).size, 4);
  assert.ok(new Set(selected.map(s => JSON.stringify(s.preview.focusBounds))).size > 1);
  const { object: room } = selected[0];
  const { preview: focusedFile } = await get(`/api/snapshots/${room.snapshotId}/preview?path=House.ifc&elementId=${encodeURIComponent(room.anchor.elementId)}`);
  assert.equal(focusedFile.selected.guid, room.anchor.elementId);
  const { preview: missing } = await get(`/api/snapshots/${room.snapshotId}/preview?path=House.ifc&elementId=not-a-real-element`);
  assert.equal(missing.kind, 'model-unavailable');
  assert.ok(missing.reason);

  const terminal = await fetch(`${base}/api/projects/${project.id}/terminal/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: { kind: 'object', objectId: room.id } }),
  });
  assert.equal((await terminal.json()).preview.selected.guid, room.anchor.elementId);
  const document = await get(`/api/dependency-objects/${room.id}/document?version=${room.versionId}`);
  assert.equal(document.document.selected.guid, room.anchor.elementId);

  // A new export's bytes must not leak into the pinned preview of the old one.
  const revised = Buffer.from(bytes.toString().replace('DATA;', 'DATA;\n/* A later export revision. */'));
  fs.writeFileSync(path.join(root, 'House.ifc'), revised);
  assert.equal(app.timeline.capture(project.id, actor).changed, true);
  app.dependencies.ensureIndex(project.id);
  const pinned = await get(`/api/dependency-objects/${room.id}/preview?version=${room.versionId}`);
  assert.equal(pinned.preview.sourceHash, hash(bytes));
  const current = await get(`/api/dependency-objects/${room.id}/preview`);
  assert.equal(current.preview.sourceHash, hash(revised));
  assert.equal(current.preview.selected.guid, room.anchor.elementId);
});
