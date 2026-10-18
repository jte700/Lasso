import test from 'node:test';
import assert from 'node:assert/strict';
import { extractDxfDocument } from '../src/dependencies/dxf-extraction.js';
import { drawingDescriptors } from '../src/dependencies/drawing-objects.js';
import { askCommand } from '../src/terminal/commands/ask.js';

function dxf(entities, units = 4) {
  return Buffer.from(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', String(units), '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flat(), '0', 'ENDSEC', '0', 'EOF'].join('\n'));
}
function boundary({ id = 'A1', points = [[0, 0], [5000, 0], [5000, 4000], [0, 4000]], flags = 1, extras = [] } = {}) {
  return ['0', 'LWPOLYLINE', '5', id, '8', 'ROOMS', '90', String(points.length), '70', String(flags), ...points.flatMap(([x, y]) => ['10', String(x), '20', String(y)]), ...extras];
}
function label(value, x = 2500, y = 2000) { return ['0', 'TEXT', '5', 'B1', '1', value, '10', String(x), '20', String(y)]; }

test('native DXF closed room has physical area, perimeter, handle and preview geometry', () => {
  const result = extractDxfDocument(dxf([boundary(), label('OFFICE 101')]));
  assert.equal(result.status, 'ready');
  assert.equal(result.sourceUnits, 'mm');
  const [area, perimeter] = result.pages[0].annotations;
  assert.equal(area.label, 'OFFICE 101');
  assert.equal(area.numericValue, 20);
  assert.equal(area.units, 'm²');
  assert.equal(area.measurementBasis, 'geometry');
  assert.equal(area.elementId, 'A1');
  assert.equal(area.propertyName, 'Area');
  assert.equal(perimeter.numericValue, 18);
  assert.equal(perimeter.units, 'm');
  assert.equal(perimeter.propertyName, 'Perimeter');
  assert.equal(perimeter.kind, 'perimeter');
  assert.deepEqual(area.geometry.normalizedVertices, [[0, 1], [1, 1], [1, 0], [0, 0]]);
  assert.deepEqual(area.bbox, { x: 0, y: 0, width: 1, height: 1 });
});

test('DXF handle-based identity survives area and room-name edits', () => {
  const original = extractDxfDocument(dxf([boundary(), label('OFFICE 101')]));
  const changed = extractDxfDocument(dxf([boundary({ points: [[0, 0], [6000, 0], [6000, 4000], [0, 4000]] }), label('OFFICE 101A')]));
  assert.equal(original.pages[0].annotations[0].id, changed.pages[0].annotations[0].id);
  assert.equal(changed.pages[0].annotations[0].numericValue, 24);
});

test('DXF feet convert exactly and missing units never produce dimensions', () => {
  const points = [[0, 0], [12, 0], [12, 15], [0, 15]];
  const feet = extractDxfDocument(dxf([boundary({ points }), label('BEDROOM', 6, 7)], 2));
  assert.equal(feet.pages[0].annotations[0].value, '180 ft²');
  const unknown = extractDxfDocument(dxf([boundary()], 0));
  assert.equal(unknown.status, 'unsupported');
  assert.equal(unknown.pages[0].annotations.length, 0);
  assert.match(unknown.warnings.join(' '), /no physical measurements/);
});

test('DXF refuses unsupported arcs, self intersections, transforms and open boundaries', () => {
  const cases = [boundary({ extras: ['42', '0.5'] }), boundary({ points: [[0, 0], [5, 4], [0, 4], [5, 0]] }), boundary({ extras: ['230', '-1'] }), boundary({ flags: 0 }), boundary({ extras: ['43', '20'] })];
  for (const entity of cases) {
    const result = extractDxfDocument(dxf([entity]));
    assert.equal(result.pages[0].annotations.length, 0);
    assert.equal(result.status, 'unsupported');
    assert.ok(result.warnings.length);
  }
});

test('door arcs, blocks and dimensions are noted without marking a measured plan partial', () => {
  const arc = ['0', 'ARC', '5', 'C1', '8', 'DOORS', '10', '0', '20', '0', '40', '900', '50', '0', '51', '90'];
  const block = ['0', 'INSERT', '5', 'C2', '8', 'FURNITURE', '2', 'SOFA', '10', '1000', '20', '1000'];
  const plan = extractDxfDocument(dxf([boundary(), label('OFFICE 101'), arc, block, boundary({ id: 'L1', flags: 0 })]));
  assert.equal(plan.status, 'ready');
  assert.match(plan.warnings.join(' '), /ARC, INSERT/);
  assert.match(plan.warnings.join(' '), /1 open polylines/);
  const problem = extractDxfDocument(dxf([boundary(), boundary({ id: 'A2', points: [[0, 0], [5, 4], [0, 4], [5, 0]] }), arc]));
  assert.equal(problem.status, 'partial');
});

test('multiple labels and nested boundaries do not fabricate a room association', () => {
  const multiple = extractDxfDocument(dxf([boundary(), label('OFFICE'), label('LOBBY', 1000, 1000)]));
  assert.equal(multiple.pages[0].annotations[0].label, 'ROOMS');
  assert.equal(multiple.pages[0].annotations[0].semantics, 'closed_boundary');
  const nested = extractDxfDocument(dxf([boundary(), boundary({ id: 'A2', points: [[100, 100], [4900, 100], [4900, 3900], [100, 3900]] }), label('OFFICE')]));
  assert.ok(nested.pages[0].annotations.every((item) => item.label === 'ROOMS'));
});

test('paper-space entities are excluded from native measurements', () => {
  const result = extractDxfDocument(dxf([boundary({ extras: ['67', '1', '410', 'Layout1'] })]));
  assert.equal(result.pages[0].annotations.length, 0);
});

test('binary, malformed and truncated DXF produce explicit unsupported/error results', () => {
  assert.equal(extractDxfDocument(Buffer.from('AutoCAD Binary DXF\r\n\x1a\0')).status, 'unsupported');
  assert.equal(extractDxfDocument(Buffer.from('0\nSECTION\n2\nENTITIES')).status, 'error');
  assert.equal(extractDxfDocument(Buffer.from('x\nSECTION\n0\nEOF')).status, 'error');
});


test('duplicate entity handles and truncated sections cannot supply native measurements', () => {
  const duplicates = extractDxfDocument(dxf([boundary(), boundary()]));
  assert.equal(duplicates.pages[0].annotations.length, 0);
  assert.match(duplicates.warnings.join(' '), /Duplicate DXF handle/);
  assert.equal(extractDxfDocument(Buffer.from('0\nSECTION\n2\nENTITIES\n0\nEOF')).status, 'error');
});

test('a text label on another elevation cannot name a boundary', () => {
  const raisedLabel = [...label('UPPER OFFICE'), '30', '3000'];
  const result = extractDxfDocument(dxf([boundary(), raisedLabel]));
  assert.equal(result.pages[0].annotations[0].semantics, 'closed_boundary');
});


test('DXF boundary perimeter answers a perimeter query and never a room length query', () => {
  const file = { path: 'office.dxf', projectFileId: 'office', contentHash: 'hash' };
  const { descriptors } = drawingDescriptors(file, dxf([boundary(), label('OFFICE 101')]));
  const objects = descriptors.map((descriptor) => ({ ...descriptor, objectType: descriptor.type, objectKey: descriptor.key, valueText: descriptor.value }));
  const context = { projectId: 'project', graph: { namedObjects: () => objects, resolve: () => ({ status: 'NOT_FOUND' }) } };
  const ask = (rest) => askCommand(context, { rest });
  const perimeter = ask('What is the perimeter of Office 101?');
  assert.equal(perimeter.data.answered, true);
  assert.equal(perimeter.data.value, '18 m');
  assert.equal(perimeter.data.query.kind, 'perimeter');
  for (const question of ['What is the length of Office 101?', 'How long is Office 101?']) {
    const response = ask(question);
    assert.equal(response.data.answered, false, question);
    assert.equal(response.data.reason, 'NO_EXPLICIT_DRAWING_VALUE');
  }
});
