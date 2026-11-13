import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { redactModelPlan } from '../src/sharing/model-redaction.js';
import { renderSharePage } from '../src/sharing/share-page.js';
import { renderSharedDrawing, sharedDrawingSvg } from '../src/sharing/shared-drawing.js';

const square = [[0, 0], [100, 0], [100, 100], [0, 100]];
const mask = { kind: 'DRAWING', effect: 'BLUR', x: .4, y: .4, width: .2, height: .2 };
const plan = () => ({ kind: 'model-plan', format: 'dxf', units: 'mm', bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  sourceHash: 'PRIVATE_HASH', sourceText: 'PRIVATE_RAW', path: '/private/PRIVATE_PATH', fileName: 'PRIVATE_NAME',
  selected: { guid: 'PRIVATE_GUID', label: 'PRIVATE_LABEL' }, storey: { label: 'PRIVATE_FLOOR' }, propertyName: 'PRIVATE_PROPERTY', valueText: 'PRIVATE_VALUE',
  elements: [{ id: 1, guid: 'PRIVATE_GUID', label: 'PRIVATE_LABEL', role: 'space', polygons: [square], selected: true }],
  drawing: [{ id: 'PRIVATE_HANDLE', type: 'path', layer: 'PRIVATE_LAYER', points: [[0, 50], [51, 52], [100, 50]], closed: false },
    { id: 'SECRET_TEXT', type: 'text', layer: 'PRIVATE_LAYER', point: [50, 50], text: 'PRIVATE_TEXT', height: 1, rotation: 30 },
    { id: 'PUBLIC_TEXT', type: 'text', layer: 'LABELS', point: [10, 90], text: 'PUBLIC', height: .5, rotation: 0 }] });
const inside = ([x, y]) => x > 40 + 1e-8 && x < 60 - 1e-8 && y > 40 + 1e-8 && y < 60 - 1e-8;
const area = ring => Math.abs(ring.reduce((total, a, i) => { const b = ring[(i + 1) % ring.length]; return total + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;

test('drawing masks remove secret path vertices and text, preserve polygon holes and strip private metadata', () => {
  const original = plan(), result = redactModelPlan(original, [mask]);
  assert.deepEqual(result.bounds, original.bounds); assert.deepEqual(result.focusBounds, original.bounds);
  assert.equal(result.selected, null); assert.equal(result.storey, null);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|SECRET_TEXT|PUBLIC_TEXT|LABELS/);
  assert.ok(result.drawing.some(item => item.text === 'PUBLIC'));
  assert.ok(result.drawing.filter(item => item.type === 'path').length >= 2);
  assert.ok(result.drawing.flatMap(item => item.points ?? [item.point]).every(point => !inside(point)));
  assert.equal(result.elements[0].polygons.length, 2);
  assert.deepEqual(result.elements[0].polygons.map(ring => Math.round(area(ring))).sort((a, b) => b - a), [10000, 400]);
  assert.ok(result.elements.flatMap(element => element.polygons.flat()).every(point => !inside(point)));
  assert.match(JSON.stringify(original), /PRIVATE_TEXT/, 'the pinned cached source plan is unchanged');
  const html = renderSharePage({ source: { filename: 'Plan.dxf', label: 'PRIVATE_LABEL', valueText: 'PRIVATE_VALUE', location: 'PRIVATE_LOCATION', context: 'PRIVATE_CONTEXT', snapshotVersion: 1 }, share: { accessScope: 'REDACTED', createdAt: new Date().toISOString(), redactions: [mask] } }, 'x'.repeat(32), null, result);
  assert.doesNotMatch(html, /PRIVATE_|SECRET_TEXT|Download original/);
  assert.match(html, /drawing-redaction blur/); assert.match(html, />PUBLIC</);
  const blurRadius = Number(html.match(/feGaussianBlur stdDeviation="([^"]+)"/)?.[1]);
  assert.ok(Math.abs(blurRadius - 1.3) < 1e-9, 'synthetic blur scales with drawing coordinates rather than shrinking to an invisible pixel');
});

test('overlapping masks clip crossing and boundary paths, preserve even-odd source holes and remove complete labels', () => {
  const source = plan();
  source.elements[0].polygons.push([[10, 10], [20, 10], [20, 20], [10, 20]]);
  source.drawing = [{ id: 'A', type: 'path', points: [[0, 50], [100, 50]], closed: false },
    { id: 'B', type: 'path', points: [[40, 40], [60, 40]], closed: false },
    { id: 'C', type: 'path', points: [[45, 45], [55, 55]], closed: false },
    { id: 'D', type: 'text', point: [39.5, 50], text: 'OVERLAPPING', height: 1, rotation: 90 }];
  const result = redactModelPlan(source, [mask, { ...mask, effect: 'BLANK', x: .5 }]);
  const paths = result.drawing.filter(item => item.type === 'path');
  assert.equal(paths.length, 2); assert.deepEqual(paths.map(item => item.points), [[[0, 50], [40, 50]], [[70, 50], [100, 50]]]);
  assert.equal(result.elements[0].polygons.length, 3); assert.deepEqual(result.elements[0].polygons.map(ring => Math.round(area(ring))).sort((a, b) => b - a), [10000, 600, 100]);
  const allHidden = redactModelPlan(source, [{ ...mask, x: 0, y: 0, width: 1, height: 1 }]);
  assert.deepEqual(allHidden.drawing, []); assert.deepEqual(allHidden.elements, []);
  const html = renderSharePage({ source: { filename: 'Plan.dxf', snapshotVersion: 1 }, share: { accessScope: 'REDACTED', createdAt: new Date().toISOString(), redactions: [mask] } }, 'x'.repeat(32), null, allHidden);
  assert.match(html, /aria-label="Redacted drawing"/); assert.match(html, /drawing-redaction blur/);
});

test('metre-scale drawing masks keep exact region geometry in recipient and standalone SVG output', () => {
  const source = { ...plan(), format: 'ifc', units: 'm', bounds: { minX: -2, minY: 4, maxX: 8, maxY: 9 },
    elements: [], drawing: [{ type: 'path', points: [[-2, 4], [8, 9]], closed: false }] };
  const regions = [{ kind: 'DRAWING', effect: 'BLUR', x: .1, y: .2, width: .2, height: .4 },
    { kind: 'DRAWING', effect: 'BLANK', x: .6, y: .5, width: .2, height: .2 }];
  const sanitized = redactModelPlan(source, regions);
  const recipient = renderSharedDrawing(sanitized), download = sharedDrawingSvg(sanitized);
  const masks = markup => [...markup.matchAll(/<g class="drawing-redaction [^"]+"[^>]*>[\s\S]*?<\/g>/g)].map(match => match[0]);
  assert.deepEqual(masks(recipient), masks(download), 'recipient and download use identical mask geometry and paint');
  assert.equal(masks(recipient).length, 2);
  for (const [index, expected] of [[0, [-1, -8, 2, 2]], [1, [4, -6.5, 2, 1]]]) {
    const shape = masks(recipient)[index];
    assert.match(shape, /stroke="none"/);
    const values = shape.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/).slice(1).map(Number);
    assert.ok(values.every((value, coordinate) => Math.abs(value - expected[coordinate]) < 1e-9));
  }
  assert.match(masks(recipient)[0], /fill="#b5bdc9"/);
  assert.match(masks(recipient)[1], /fill="#000"/);
});


test('drawing label redaction follows anchors, multiline placement and rotation without removing clearly outside labels', () => {
  const source = plan(); source.elements = [];
  const label = (id, point, text, extras = {}) => ({ id, type: 'text', point, text, height: 1, rotation: 0, ...extras });
  source.drawing = [
    label('A', [62, 50], 'KEEP RIGHT LONG LABEL'),
    label('B', [38, 50], 'KEEP LEFT LONG LABEL', { align: 'end' }),
    label('C', [80, 50], 'CENTER', { align: 'middle' }),
    label('D', [38, 50], 'HIDE GLYPH OVERLAP'),
    label('E', [50, 63], 'HIDE BELOW\nSECOND\nTHIRD', { verticalAlign: 'top', height: 2 }),
    label('F', [39.5, 45], 'HIDE ROTATED', { rotation: 90 }),
    label('10', [38, 45], 'KEEP ROTATED', { rotation: 90 }),
    label('11', [50, 37], 'HIDE ABOVE\nSECOND\nTHIRD', { verticalAlign: 'bottom', height: 2 }),
  ];
  const result = redactModelPlan(source, [mask]);
  assert.deepEqual(result.drawing.map(item => item.text), ['KEEP RIGHT LONG LABEL', 'KEEP LEFT LONG LABEL', 'CENTER', 'KEEP ROTATED']);
});

test('the public rendering boundary refuses a redacted drawing without server-side sanitization', () => {
  const html = renderSharePage({ source: { filename: 'Plan.dxf', snapshotVersion: 1 }, share: { accessScope: 'REDACTED', redactions: [mask] } }, 'x'.repeat(32), null, plan());
  assert.doesNotMatch(html, /PRIVATE_|data-model-element|data-drawing-entity|data-model-plan/);
  assert.match(html, /safe redacted drawing preview could not be rendered/);
});

test('invalid drawing masks and geometry fail closed', () => {
  for (const invalid of [{ ...mask, x: NaN }, { ...mask, x: '0.4' }, { ...mask, width: 0 }, { ...mask, height: -1 }, { ...mask, x: .9 }, { ...mask, kind: 'CELL' }, { ...mask, effect: 'CSS' }]) assert.throws(() => redactModelPlan(plan(), [invalid]), /Invalid/);
  assert.throws(() => redactModelPlan(plan(), Array(65).fill(mask)), /64/);
  assert.throws(() => redactModelPlan({ ...plan(), bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }, [mask]), /bounds/);
  assert.throws(() => redactModelPlan({ ...plan(), drawing: [{ type: 'path', points: [[NaN, 0], [1, 1]] }] }, [mask]), /path/);
});

function dxf() {
  return Buffer.from(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '5', 'A', '8', 'ROOMS', '90', '4', '70', '1', ...square.flatMap(([x, y]) => ['10', x, '20', y]),
    '0', 'TEXT', '5', 'B', '10', '50', '20', '50', '40', '1', '1', 'HIDDEN-ROOM',
    '0', 'TEXT', '5', 'C', '10', '10', '20', '90', '40', '.5', '1', 'PUBLIC', '0', 'ENDSEC', '0', 'EOF'].join('\n'));
}
const ifc = Buffer.from(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Share regression'),'2;1');FILE_NAME('plan.ifc','2026-10-15T00:00:00',(),(),'Lasso','Lasso','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Plan',$,$,$,$,(#10),#9);
#2=IFCCARTESIANPOINT((0.,0.,0.));#3=IFCDIRECTION((0.,0.,1.));#4=IFCDIRECTION((1.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#2,#3,#4);#6=IFCLOCALPLACEMENT($,#5);
#7=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#8=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);#9=IFCUNITASSIGNMENT((#7,#8));#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#11=IFCBUILDINGSTOREY('floor',$,'HIDDEN-FLOOR',$,$,#6,$,$,.ELEMENT.,0.);
#30=IFCCARTESIANPOINT((0.,0.));#31=IFCCARTESIANPOINT((100.,0.));#32=IFCCARTESIANPOINT((100.,100.));#33=IFCCARTESIANPOINT((0.,100.));
#40=IFCPOLYLINE((#30,#31,#32,#33,#30));#41=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#40);#42=IFCEXTRUDEDAREASOLID(#41,#5,#3,3.);#43=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));#44=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#100=IFCSPACE('secret-room',$,'HIDDEN-ROOM',$,$,#6,#44,'HIDDEN-ROOM',.ELEMENT.,.INTERNAL.,$);#200=IFCRELAGGREGATES('rooms',$,$,$,#11,(#100));
ENDSEC;END-ISO-10303-21;`);

test('public CAD shares render the pinned plan, redact regions, reject wrong masks and deny restricted downloads', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-model-share-'));
  const root = path.join(sandbox, 'Project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Plan.dxf'), dxf()); fs.writeFileSync(path.join(root, 'Plan.ifc'), ifc);
  fs.writeFileSync(path.join(root, 'Notes.txt'), 'Plain source');
  const app = createApplication({ shareBaseUrl: 'http://localhost:4317', dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:tester', displayName: 'Tester', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false }); app.dependencies.ensureIndex(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  const objectFor = filename => app.db.prepare(`SELECT v.id AS versionId, v.object_id AS objectId FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id WHERE o.project_id=? AND v.path=? ORDER BY CASE json_extract(v.anchor_json,'$.kind') WHEN 'cad-model' THEN 0 ELSE 1 END LIMIT 1`).get(project.id, filename);
  const create = async (source, options) => fetch(`${base}/api/projects/${project.id}/object-shares`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...source, actor, ...options }) });
  for (const filename of ['Plan.dxf', 'Plan.ifc']) {
    const object = objectFor(filename); assert.ok(object, filename);
    const local = await (await fetch(`${base}/api/dependency-objects/${object.objectId}/document?version=${object.versionId}`)).json();
    assert.equal(local.document.kind, 'model-plan', local.document.reason); assert.deepEqual(local.document.focusBounds, local.document.bounds);
    const whole = await create(object, { accessScope: 'DOCUMENT' }); assert.equal(whole.status, 201);
    const token = (await whole.json()).share.token, publicPage = await (await fetch(`${base}/d/${token}`)).text();
    assert.match(publicPage, /data-model-plan/); assert.match(publicPage, /HIDDEN-ROOM/); assert.match(publicPage, /Download original/);
    const original = await fetch(`${base}/d/${token}/download`); assert.equal(original.status, 200); assert.ok((await original.text()).includes('HIDDEN-ROOM'));
    const selective = await create(object, { accessScope: 'REDACTED', redactions: [mask] }); assert.equal(selective.status, 201);
    const selectiveToken = (await selective.json()).share.token, page = await (await fetch(`${base}/d/${selectiveToken}`)).text();
    assert.match(page, /data-model-plan/); assert.match(page, /drawing-redaction blur/); assert.doesNotMatch(page, /HIDDEN-ROOM|HIDDEN-FLOOR|secret-room|sourceHash|Download original/); assert.ok(!page.includes(sandbox));
    assert.equal((await fetch(`${base}/d/${selectiveToken}/download`)).status, 403);
    const exported = await fetch(`${base}/d/${selectiveToken}/excerpt`);
    assert.equal(exported.status, 200); assert.match(exported.headers.get('content-type'), /image\/svg\+xml/);
    const svg = await exported.text();
    assert.match(svg, /drawing-redaction blur/);
    assert.match(svg, filename.endsWith('.dxf') ? /PUBLIC/ : /model-plan-element/);
    assert.doesNotMatch(svg, /HIDDEN-ROOM|HIDDEN-FLOOR|secret-room|sourceHash|<script|<foreignObject/);
    const indexed = await create(object, { accessScope: 'INDEXED' }); const indexedToken = (await indexed.json()).share.token;
    const indexedPage = await (await fetch(`${base}/d/${indexedToken}`)).text(); assert.doesNotMatch(indexedPage, /data-model-plan|Download original/);
    assert.equal((await fetch(`${base}/d/${indexedToken}/download`)).status, 403);
    const wrong = await create(object, { accessScope: 'REDACTED', redactions: [{ kind: 'CELL', row: 0, column: 0 }] }); assert.equal(wrong.status, 400);
    const broken = await create(object, { accessScope: 'REDACTED', redactions: [{ ...mask, x: .9 }] }); assert.equal(broken.status, 400);
    if (filename === 'Plan.dxf') {
      fs.writeFileSync(path.join(root, filename), dxf().toString().replace('PUBLIC', 'NEW-REVISION'));
      app.timeline.capture(project.id, actor); app.dependencies.ensureIndex(project.id);
      const pinned = await (await fetch(`${base}/d/${selectiveToken}`)).text(); assert.match(pinned, />PUBLIC</); assert.doesNotMatch(pinned, /NEW-REVISION/);
    }
  }
  const wrongFile = await create(objectFor('Notes.txt'), { accessScope: 'REDACTED', redactions: [mask] }); assert.equal(wrongFile.status, 400);
});
