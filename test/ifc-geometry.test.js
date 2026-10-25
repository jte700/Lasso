import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildIfcPlan, keepIfcModelsIn } from '../src/dependencies/ifc-geometry.js';

// Deliberate geometric fixture: millimetres, an L-shaped space with a void,
// another floor translated 10m in X, a wall, and a property-only space.
// The expected plan follows these independent authored coordinates, not any
// measured area metadata or output from the tessellator being tested.
const source = Buffer.from(`ISO-10303-21;
HEADER;FILE_DESCRIPTION(('Geometry regression'),'2;1');FILE_NAME('geometry.ifc','2026-10-13T00:00:00',(),(),'Lasso test','Lasso test','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Geometry test',$,$,$,$,(#10),#9);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCDIRECTION((0.,0.,1.));
#4=IFCDIRECTION((1.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#2,#3,#4);
#6=IFCLOCALPLACEMENT($,#5);
#7=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#8=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#9=IFCUNITASSIGNMENT((#7,#8));
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#11=IFCBUILDINGSTOREY('floor-1',$,'Ground',$,$,#6,$,$,.ELEMENT.,0.);
#15=IFCCARTESIANPOINT((10000.,0.,3000.));
#16=IFCAXIS2PLACEMENT3D(#15,#3,#4);
#17=IFCLOCALPLACEMENT($,#16);
#18=IFCBUILDINGSTOREY('floor-2',$,'Upper',$,$,#17,$,$,.ELEMENT.,3000.);
#30=IFCCARTESIANPOINT((0.,0.));
#31=IFCCARTESIANPOINT((4000.,0.));
#32=IFCCARTESIANPOINT((4000.,2000.));
#33=IFCCARTESIANPOINT((2000.,2000.));
#34=IFCCARTESIANPOINT((2000.,4000.));
#35=IFCCARTESIANPOINT((0.,4000.));
#40=IFCPOLYLINE((#30,#31,#32,#33,#34,#35,#30));
#41=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#40);
#42=IFCEXTRUDEDAREASOLID(#41,#5,#3,2800.);
#43=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#42));
#44=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#60=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4000.,200.);
#61=IFCEXTRUDEDAREASOLID(#60,#5,#3,2800.);
#62=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#61));
#63=IFCPRODUCTDEFINITIONSHAPE($,$,(#62));
#70=IFCCARTESIANPOINT((500.,500.));
#71=IFCCARTESIANPOINT((1500.,500.));
#72=IFCCARTESIANPOINT((1500.,1500.));
#73=IFCCARTESIANPOINT((500.,1500.));
#79=IFCPOLYLINE((#70,#71,#72,#73,#70));
#80=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#40,(#79));
#81=IFCEXTRUDEDAREASOLID(#80,#5,#3,2800.);
#82=IFCSHAPEREPRESENTATION(#10,'Body','SweptSolid',(#81));
#83=IFCPRODUCTDEFINITIONSHAPE($,$,(#82));
#100=IFCSPACE('room-lower',$,'101',$,$,#6,#83,'Courtyard office',.ELEMENT.,.INTERNAL.,$);
#101=IFCSPACE('room-upper',$,'201',$,$,#17,#44,'Upper office',.ELEMENT.,.INTERNAL.,$);
#102=IFCSPACE('no-geometry',$,'Unmodelled',$,$,#6,$,$,.ELEMENT.,.INTERNAL.,$);
#103=IFCWALL('wall-guid',$,'W1',$,$,#6,#63,'W1',.STANDARD.);
#200=IFCRELAGGREGATES('ground-rooms',$,$,$,#11,(#100,#102));
#201=IFCRELAGGREGATES('upper-rooms',$,$,$,#18,(#101));
#202=IFCRELCONTAINEDINSPATIALSTRUCTURE('ground-elements',$,$,$,(#103),#11);
ENDSEC;END-ISO-10303-21;`);

const area = ring => Math.abs(ring.reduce((sum, p, i) => {
  const q = ring[(i + 1) % ring.length]; return sum + p[0] * q[1] - q[0] * p[1];
}, 0) / 2);

test('IFC geometry preserves authored concavity and holes and converts model millimetres to metres', async () => {
  const plan = await buildIfcPlan(source, { elementId: 'room-lower', stepId: '#100' });
  const [room] = plan.elements.filter(element => element.selected);
  assert.equal(plan.kind, 'model-plan');
  assert.equal(plan.sourceHash, createHash('sha256').update(source).digest('hex'));
  assert.equal(plan.units, 'm');
  assert.equal(plan.fillRule, 'evenodd');
  assert.equal(plan.storey.guid, 'floor-1');
  assert.deepEqual(room.bounds, { minX: 0, minY: 0, maxX: 4, maxY: 4 });
  assert.equal(room.polygons.length, 2, 'void remains a hole in the actual footprint');
  assert.deepEqual(room.polygons.map(area).sort((a, b) => b - a), [12, 1]);
  assert.ok(room.polygons.some(ring => ring.some(([x, y]) => x === 2 && y === 2)), 'L-shaped reentrant corner is retained');
  assert.ok(!plan.elements.some(element => element.guid === 'room-upper'), 'other storeys are not superimposed');
  assert.deepEqual(plan.warnings, []);
});

test('IFC previews focus other floors, walls and spatial containers by exact identity', async () => {
  const [upper, wall, floor, overview] = await Promise.all([
    buildIfcPlan(source, { elementId: 'room-upper' }), buildIfcPlan(source, { elementId: 'wall-guid' }),
    buildIfcPlan(source, { elementId: 'floor-1' }), buildIfcPlan(source),
  ]);
  assert.equal(upper.storey.guid, 'floor-2');
  assert.deepEqual(upper.elements.find(element => element.selected).bounds,
    { minX: 10, minY: 0, maxX: 14, maxY: 4 });
  assert.equal(wall.selected.entityType, 'IFCWALL');
  assert.equal(wall.elements.filter(element => element.selected).length, 1);
  assert.notDeepEqual(wall.focusBounds, upper.focusBounds);
  assert.deepEqual(floor.elements.filter(element => element.selected).map(element => element.guid).sort(), ['room-lower', 'wall-guid']);
  assert.equal(overview.selected, null);
  assert.equal(overview.storey.guid, 'floor-1');
});

test('IFC geometry never substitutes another element or a made-up footprint for an unavailable anchor', async () => {
  await assert.rejects(buildIfcPlan(source, { elementId: 'missing' }), /not present/);
  await assert.rejects(buildIfcPlan(source, { elementId: 'room-lower', stepId: 101 }), /do not identify the same/);
  await assert.rejects(buildIfcPlan(source, { elementId: 'no-geometry' }), /No supported geometric representation/);
  await assert.rejects(buildIfcPlan(Buffer.from('not an IFC file')), /could not be opened/);
});

test('IFC geometry cache separates changed source bytes and never mutates previous selection', async () => {
  const original = await buildIfcPlan(source, { elementId: 'room-upper' });
  const changed = Buffer.from(source.toString().replace('10000.,0.,3000.', '20000.,0.,3000.'));
  const revised = await buildIfcPlan(changed, { elementId: 'room-upper' });
  assert.notEqual(original.sourceHash, revised.sourceHash);
  assert.equal(original.elements.find(element => element.selected).bounds.minX, 10);
  assert.equal(revised.elements.find(element => element.selected).bounds.minX, 20);
  const pinned = await buildIfcPlan(source, { elementId: 'room-lower' });
  assert.equal(pinned.selected.guid, 'room-lower');
  assert.equal(original.selected.guid, 'room-upper');
});

/** A store like the derived TextStore, held in memory. */
function memoryStore() {
  const entries = new Map();
  return { entries, get: key => entries.get(key), set: (key, value) => entries.set(key, structuredClone(value)) };
}
const variant = (from, to) => Buffer.from(source.toString().replace(from, to));

test('IFC models are kept by content, so a drawing is worked out once across launches', async (t) => {
  const store = memoryStore();
  keepIfcModelsIn(store);
  t.after(() => keepIfcModelsIn(null));
  const bytes = variant('Geometry test', 'Stored model');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const first = await buildIfcPlan(bytes, { elementId: 'room-lower' });
  assert.ok(store.entries.get(hash)?.model, 'the worked-out model is stored under the file\'s content');
  // A later launch has no model in memory and reads the stored one.
  const stored = store.entries.get(hash).model;
  store.entries.set(hash, { model: { ...stored, warnings: ['read from the store'] } });
  const relaunched = await buildIfcPlan(variant('Geometry test', 'Stored model'), { elementId: 'room-lower' });
  assert.deepEqual(relaunched.elements.find(element => element.selected).bounds,
    first.elements.find(element => element.selected).bounds);

  const unreadable = Buffer.from('ISO-10303-21; not a model that opens');
  await assert.rejects(buildIfcPlan(unreadable), /could not be opened/);
  const unreadableHash = createHash('sha256').update(unreadable).digest('hex');
  assert.match(store.entries.get(unreadableHash)?.error ?? '', /could not be opened/,
    'a file the engine cannot read is remembered, so it fails at once next time');
  store.entries.set(unreadableHash, { error: 'Remembered failure.' });
  await assert.rejects(buildIfcPlan(unreadable), /Remembered failure/);
});

test('an IFC model no one is waiting for by its turn is not made, and nothing is remembered for it', async (t) => {
  const store = memoryStore();
  keepIfcModelsIn(store);
  t.after(() => keepIfcModelsIn(null));
  const ahead = buildIfcPlan(variant('Geometry test', 'Ahead in line'));
  const passedOver = variant('Geometry test', 'Clicked past');
  const leaving = new AbortController();
  const waiting = buildIfcPlan(passedOver, { signal: leaving.signal });
  leaving.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  await ahead;
  assert.equal(store.entries.get(createHash('sha256').update(passedOver).digest('hex')), undefined,
    'an abandoned model is neither made nor recorded as a failure');
  const later = await buildIfcPlan(passedOver, { elementId: 'room-lower' });
  assert.equal(later.selected.guid, 'room-lower', 'the file is drawn when someone asks again');
});
