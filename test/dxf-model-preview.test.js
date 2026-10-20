import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildModelPreview } from '../src/dependencies/model-preview.js';
import { createApplication } from '../src/server.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function dxf(entities, units = 4) {
  return Buffer.from(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(Infinity), '0', 'ENDSEC', '0', 'EOF'].join('\n'));
}
function boundary(id, points, extras = []) {
  return ['0', 'LWPOLYLINE', '5', id, '8', 'ROOMS', '90', String(points.length), '70', '1',
    ...points.flatMap(([x, y]) => ['10', String(x), '20', String(y)]), ...extras];
}
function room(id, label, x, y, width, height) {
  return [boundary(id.toString(16), [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]),
    ['0', 'TEXT', '5', (id + 1).toString(16), '8', 'ROOM-LABELS', '10', String(x + width / 2),
      '20', String(y + height / 2), '1', label]];
}
// These dimensions and handles match the Desktop architecture practice files.
const cedar = () => dxf([room(0x100, 'LIVING 101', 0, 0, 6000, 4000), room(0x102, 'BEDROOM 102', 6500, 0, 4000, 4000),
  room(0x104, 'STUDIO 103', 0, 4500, 4000, 3000)]);
const juniper = () => dxf([room(0x100, 'RECEPTION 201', 0, 0, 6000, 4000), room(0x102, 'CONFERENCE 202', 6500, 0, 6000, 5000),
  room(0x104, 'OFFICE 203', 0, 5500, 5000, 4000), room(0x106, 'STORAGE 204', 5500, 5500, 2500, 4000)]);
const file = (content, filename = 'Rooms.dxf') => ({ path: filename, content });
const anchor = elementId => ({ anchor: { kind: 'cad-property', elementId, propertyName: 'Area' } });

test('DXF architecture plans render real source coordinates, overview and exact selected room handles', async () => {
  for (const [bytes, handle, name, count, expected] of [
    [cedar(), '104', 'STUDIO 103', 3, [[0, 4500], [4000, 4500], [4000, 7500], [0, 7500]]],
    [juniper(), '102', 'CONFERENCE 202', 4, [[6500, 0], [12500, 0], [12500, 5000], [6500, 5000]]],
  ]) {
    const overview = await buildModelPreview(file(bytes));
    assert.equal(overview.kind, 'model-plan', overview.reason);
    assert.equal(overview.format, 'dxf');
    assert.equal(overview.units, 'mm');
    assert.equal(overview.sourceHash, hash(bytes));
    assert.equal(overview.elements.length, count);
    assert.equal(overview.selected, null);
    assert.ok(overview.elements.every(element => !element.selected));
    const selected = await buildModelPreview(file(bytes), { ...anchor(handle), valueText: '12 m²' });
    assert.equal(selected.selected.guid, handle);
    assert.equal(selected.selected.label, name);
    assert.equal(selected.selected.entityType, 'LWPOLYLINE');
    assert.deepEqual(selected.elements.find(element => element.selected).polygons, [expected]);
    assert.equal(selected.elements.filter(element => element.selected).length, 1);
    assert.equal(selected.elements.length, count, 'surrounding boundaries remain available');
    assert.equal(selected.propertyName, 'Area');
    assert.equal(selected.valueText, '12 m²');
    assert.ok(selected.focusBounds.minX < expected[0][0]);
  }
});

test('DXF explicit anchors never fall back to overview or a nearby boundary', async () => {
  for (const source of [anchor('NOT-A-HANDLE'), { anchor: { kind: 'cad-property' } },
    { anchor: { kind: 'cad-property', stepId: 104 } }]) {
    const result = await buildModelPreview(file(cedar()), source);
    assert.equal(result.kind, 'model-unavailable');
    assert.ok(result.reason);
    assert.equal(result.elements, undefined);
  }
  const bytes = dxf([boundary('ab', [[0, 0], [4, 0], [4, 3], [0, 3]])], 2);
  const lower = await buildModelPreview(file(bytes), anchor('ab'));
  assert.equal(lower.selected.guid, 'AB');
  assert.equal(lower.units, 'ft');
  assert.deepEqual(lower.elements[0].polygons[0][2], [4, 3], 'feet are retained as source coordinates');
});

test('unitless DXF previews expose only raw drawing coordinates, with an explicit unit warning', async () => {
  const bytes = dxf([boundary('A1', [[0, 0], [12, 0], [12, 15], [0, 15]])], 0);
  const result = await buildModelPreview(file(bytes), anchor('A1'));
  assert.equal(result.kind, 'model-plan', result.reason);
  assert.equal(result.units, 'drawing units (unspecified)');
  assert.equal(result.unitsCode, 0);
  assert.match(result.warnings.join(' '), /no physical measurements/);
  assert.deepEqual(result.elements[0].polygons[0][2], [12, 15]);
  assert.equal(result.valueText, null);
});

test('unsafe or unsupported DXF geometry has an actionable reason and never a fabricated plan', async () => {
  const square = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const cases = [Buffer.from('AutoCAD Binary DXF\r\n\x1a\0'), Buffer.from('0\nSECTION\n2\nENTITIES\n0\nEOF'),
    dxf([boundary('A1', square, ['230', '-1'])]),
    dxf([boundary('A1', square), boundary('A1', square)]),
  ];
  for (const bytes of cases) {
    const result = await buildModelPreview(file(bytes));
    assert.equal(result.kind, 'model-unavailable');
    assert.ok(result.reason.length > 20);
    assert.equal(result.elements, undefined);
  }
});

test('curves and invalid area boundaries may be viewed but never become measured selections', async () => {
  for (const bytes of [dxf([boundary('A1', [[0, 0], [4, 0], [4, 3], [0, 3]], ['42', '0.5'])]),
    dxf([boundary('A1', [[0, 0], [4, 3], [0, 3], [4, 0]])])]) {
    const overview = await buildModelPreview(file(bytes));
    assert.equal(overview.kind, 'model-plan', overview.reason);
    assert.equal(overview.elements.length, 0);
    assert.ok(overview.drawing.length > 0);
    assert.equal(overview.selected, null);
    assert.ok(overview.warnings.length > 0, 'measurement limitation remains explicit');
    assert.equal((await buildModelPreview(file(bytes), anchor('A1'))).kind, 'model-unavailable');
  }
});

test('realistic architecture drafting preserves room evidence alongside doors, furniture, labels and dimensions', async () => {
  const bytes = fs.readFileSync(new URL('./fixtures/drawings/cedar-lane-residence-realistic.dxf', import.meta.url));
  const selected = await buildModelPreview(file(bytes), anchor('A103'));
  assert.equal(selected.kind, 'model-plan', selected.reason);
  assert.equal(selected.selected.label, 'LIVING ROOM 103');
  assert.equal(selected.elements.length, 6, 'furniture and fixtures do not add measured rooms');
  assert.ok(selected.drawing.length > 100);
  assert.ok(selected.drawing.some(item => item.id.includes('/') && item.layer === 'FURNITURE'), 'block instances are expanded');
  assert.ok(selected.drawing.some(item => item.type === 'path' && item.points.length > 20 && item.layer === 'DOORS'), 'curved door swings are displayed');
  assert.ok(selected.drawing.some(item => item.type === 'text' && item.text === 'LIVING ROOM 103'));
  assert.ok(selected.drawing.some(item => item.layer === 'DIMENSIONS'));
  assert.equal(selected.sourceHash, hash(bytes));
  assert.deepEqual(selected.warnings, [], 'the supported fixture renders without omissions');
});

test('hidden source boundaries do not reappear through the measured room overlay', async () => {
  const bytes = dxf([boundary('A1', [[0, 0], [4, 0], [4, 3], [0, 3]], ['60', '1']),
    ['0', 'LINE', '5', 'B1', '10', '0', '20', '0', '11', '10', '21', '0']]);
  const overview = await buildModelPreview(file(bytes));
  assert.equal(overview.kind, 'model-plan', overview.reason);
  assert.deepEqual(overview.elements, []);
  assert.deepEqual(overview.drawing.map(item => item.id), ['B1']);
  assert.equal((await buildModelPreview(file(bytes), anchor('A1'))).kind, 'model-unavailable');
  assert.ok(overview.bounds.maxY > overview.bounds.minY, 'horizontal lines still receive a usable fitting extent');
});

test('text-only drawing fitting includes descenders and subsequent lines without inventing physical quantities', async () => {
  const bytes = dxf([['0', 'TEXT', '5', 'ABC', '10', '0', '20', '0', '40', '100', '1', 'g\\Pg']], 8);
  const preview = await buildModelPreview(file(bytes));
  assert.equal(preview.kind, 'model-plan', preview.reason);
  assert.equal(preview.units, 'microin');
  assert.deepEqual(preview.elements, []);
  assert.equal(preview.drawing[0].text, 'g\ng');
  assert.ok(preview.bounds.minY <= -155, 'fit includes the lower baseline and its descender');
  assert.ok(preview.bounds.maxY >= 100, 'fit includes text above its first baseline');
  assert.match(preview.warnings.join(' '), /no physical measurements/);
});

test('DXF selected boundaries show only their own plane, with context at the same elevation', async () => {
  const bytes = dxf([boundary('A1', [[0, 0], [4, 0], [4, 3], [0, 3]]),
    boundary('A2', [[0, 0], [8, 0], [8, 6], [0, 6]], ['38', '3000'])]);
  const overview = await buildModelPreview(file(bytes));
  assert.deepEqual(overview.elements.map(element => element.guid), ['A1']);
  const selected = await buildModelPreview(file(bytes), anchor('A2'));
  assert.deepEqual(selected.elements.map(element => element.guid), ['A2']);
  assert.equal(selected.selected.guid, 'A2');
  assert.match(selected.warnings.join(' '), /elevation 3000 mm/);
});

test('DXF object, snapshot, workspace and private inspector routes preserve selected and pinned geometry', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-dxf-preview-'));
  const root = path.join(directory, 'Project');
  fs.mkdirSync(root);
  const bytes = cedar(), filename = 'Cedar-Lane-Rooms-Rev02.dxf';
  fs.writeFileSync(path.join(root, filename), bytes);
  const app = createApplication({ dataDir: path.join(directory, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const actor = { id: 'ai:dxf-preview-test', displayName: 'DXF preview test', actorType: 'AI_AGENT' };
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const objects = app.dependencies.objectsAt(project.id);
  const room = objects.find(object => object.anchor.elementId === '104' && object.anchor.propertyName === 'Area');
  const model = objects.find(object => object.anchor.kind === 'cad-model');
  assert.ok(room);
  assert.ok(model);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const selected = await get(`/api/dependency-objects/${room.id}/preview?version=${room.versionId}`);
  assert.equal(selected.preview.kind, 'model-plan', selected.preview.reason);
  assert.equal(selected.preview.selected.guid, '104');
  assert.equal(selected.preview.sourceHash, hash(bytes));
  assert.equal(selected.preview.valueText, '12 m²');
  assert.equal(selected.source.location.includes('104'), true);
  const overview = await get(`/api/dependency-objects/${model.id}/preview?version=${model.versionId}`);
  assert.equal(overview.preview.kind, 'model-plan');
  assert.equal(overview.preview.selected, null);
  assert.equal(overview.preview.elements.length, 3);
  const snapshot = `/api/snapshots/${room.snapshotId}/preview?path=${filename}`;
  assert.equal((await get(snapshot)).preview.selected, null);
  assert.equal((await get(`${snapshot}&elementId=104`)).preview.selected.guid, '104');
  assert.equal((await get(`${snapshot}&elementId=invalid`)).preview.kind, 'model-unavailable');
  const document = await get(`/api/dependency-objects/${room.id}/document?version=${room.versionId}`);
  assert.equal(document.document.selected.guid, '104');
  await app.workspace.toggle(project.id, true, actor);
  const terminal = await fetch(`${base}/api/workspace/terminal/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: { kind: 'object', objectId: room.id, projectId: project.id } }),
  });
  assert.equal(terminal.status, 200);
  assert.equal((await terminal.json()).preview.selected.guid, '104');
  for (const object of [room, model]) {
    const inspector = await fetch(`${base}/inspect?object=${object.id}&version=${object.versionId}`);
    assert.equal(inspector.status, 200);
    const html = await inspector.text();
    assert.match(html, /data-model-plan/);
    assert.match(html, /data-model-element="104"/);
    assert.ok(html.includes(path.join(root, filename)));
    assert.doesNotMatch(html, /cannot be displayed inline/);
  }

  const revised = Buffer.from(bytes.toString().replace('20\n7500', '20\n8000'));
  fs.writeFileSync(path.join(root, filename), revised);
  assert.equal(app.timeline.capture(project.id, actor).changed, true);
  app.dependencies.ensureIndex(project.id);
  const pinned = await get(`/api/dependency-objects/${room.id}/preview?version=${room.versionId}`);
  const current = await get(`/api/dependency-objects/${room.id}/preview`);
  assert.equal(pinned.preview.sourceHash, hash(bytes));
  assert.equal(current.preview.sourceHash, hash(revised));
  assert.notDeepEqual(current.preview.elements.find(element => element.selected).polygons,
    pinned.preview.elements.find(element => element.selected).polygons);
  const pinnedInspector = await fetch(`${base}/inspect?object=${room.id}&version=${room.versionId}`);
  const pinnedHtml = await pinnedInspector.text();
  assert.match(pinnedHtml, /L4000,7500/);
  assert.doesNotMatch(pinnedHtml, /L4000,8000/);
});
