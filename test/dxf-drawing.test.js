import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDxfDrawing } from '../src/dependencies/dxf-drawing.js';

const record = (type, handle, pairs = []) => [[0, type], ...(handle == null ? [] : [[5, handle]]), ...pairs];
const line = (handle, pairs = []) => record('LINE', handle, [[10, 0], [20, 0], [11, 10], [21, 0], ...pairs]);
const lw = (handle, vertices, flags = 0) => record('LWPOLYLINE', handle,
  [[90, vertices.length], [70, flags], ...vertices.flatMap(([x, y, bulge = 0]) => [[10, x], [20, y], [42, bulge]])]);
function file({ entities = [], blocks = [], layers = [], units = 4 } = {}) {
  return Buffer.from([[0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, units], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'TABLES'], ...layers, [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'BLOCKS'], ...blocks, [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...entities, [0, 'ENDSEC'], [0, 'EOF']].flat().join('\n') + '\n');
}
const pointNear = (actual, expected, tolerance = 1e-8) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${actual} near ${expected}`));
const block = (name, handle, contents, pairs = []) => [...record('BLOCK', handle, [[2, name], ...(pairs.some(p => p[0] === 10) ? [] : [[10, 0]]), ...(pairs.some(p => p[0] === 20) ? [] : [[20, 0]]), ...pairs]), ...contents, ...record('ENDBLK', `${handle}E`)];

test('DXF visual lines preserve source units and handles, suppress off/frozen/hidden/paper-space geometry', () => {
  const drawing = buildDxfDrawing(file({ layers: [
    ...record('LAYER', '90', [[2, 'walls'], [62, 7], [370, 35]]),
    ...record('LAYER', '91', [[2, 'off'], [62, -7]]),
    ...record('LAYER', '92', [[2, 'frozen'], [70, 1]]),
  ], entities: [...line('ab', [[8, 'walls']]), ...line('B', [[8, 'off']]), ...line('C', [[8, 'frozen']]),
    ...line('D', [[60, 1]]), ...line('E', [[67, 1]]), ...line('F', [[410, 'Layout1']]), ...line('10', [[62, -2]])] }));
  assert.equal(drawing.sourceUnits, 'mm'); assert.equal(drawing.unitsCode, 4);
  assert.deepEqual(drawing.primitives, [{ id: 'AB', type: 'path', points: [[0, 0], [10, 0]], closed: false, elevation: 0, layer: 'walls', lineweight: 35 }]);
  assert.deepEqual(drawing.warnings, []);
});

test('DXF arcs, circles and rotated ellipses follow actual CCW geometry and retain closure', () => {
  const { primitives } = buildDxfDrawing(file({ entities: [
    ...record('ARC', 'A', [[10, 5], [20, 10], [40, 2], [50, 350], [51, 10]]),
    ...record('CIRCLE', 'B', [[10, 1], [20, 2], [40, 3]]),
    ...record('ELLIPSE', 'C', [[10, 0], [20, 0], [11, 0], [21, 4], [40, 0.5], [41, 0], [42, Math.PI * 2]]),
    ...record('ELLIPSE', 'D', [[10, 0], [20, 0], [11, 4], [21, 0], [40, 0.5], [41, 0], [42, Math.PI / 2]])] }));
  assert.equal(primitives.length, 4);
  pointNear(primitives[0].points[0], [5 + 2 * Math.cos(350 * Math.PI / 180), 10 + 2 * Math.sin(350 * Math.PI / 180)]);
  pointNear(primitives[0].points.at(-1), [5 + 2 * Math.cos(10 * Math.PI / 180), 10 + 2 * Math.sin(10 * Math.PI / 180)]);
  assert.ok(primitives[0].points.some(p => p[0] > 6.999));
  assert.equal(primitives[0].closed, false); assert.equal(primitives[1].closed, true);
  assert.equal(primitives[1].points.length, 180); pointNear(primitives[1].points[45], [1, 5]);
  pointNear(primitives[2].points[0], [0, 4]); pointNear(primitives[2].points[45], [-2, 0]);
  assert.equal(primitives[2].closed, true); assert.equal(primitives[3].closed, false);
  pointNear(primitives[3].points.at(-1), [0, 2]);
});

test('DXF open/closed lightweight and legacy polylines render signed bulge arcs accurately', () => {
  const { primitives, warnings } = buildDxfDrawing(file({ entities: [
    ...lw('A', [[0, 0, 1], [2, 0]]), ...lw('B', [[0, 0, -1], [2, 0]]),
    ...lw('C', [[0, 0], [2, 0, 1]], 1),
    ...record('POLYLINE', 'D', [[70, 1], [30, 7]]),
    ...record('VERTEX', 'D1', [[10, 0], [20, 0], [42, 1]]),
    ...record('VERTEX', 'D2', [[10, 2], [20, 0]]), ...record('SEQEND', 'D3')] }));
  assert.deepEqual(warnings, []); assert.equal(primitives.length, 4);
  pointNear(primitives[0].points[45], [1, -1]); pointNear(primitives[1].points[45], [1, 1]);
  pointNear(primitives[0].points.at(-1), [2, 0]); assert.equal(primitives[0].closed, false);
  assert.ok(primitives[2].points.some(p => p[1] > 0.999)); assert.equal(primitives[2].closed, true);
  assert.equal(primitives[3].elevation, 7); pointNear(primitives[3].points[45], [1, -1]);
});

test('nested block insertion honors base point, scale, rotation, inherited layer and exact handle path', () => {
  const leaf = block('LEAF', '90', line('A', [[8, '0']]), [[10, 0], [20, 0]]);
  const nested = block('NESTED', '91', record('INSERT', 'B', [[2, 'LEAF'], [10, 5], [20, 0], [41, 2], [42, 1], [50, 90]]));
  const drawing = buildDxfDrawing(file({ blocks: [...leaf, ...nested], entities: record('INSERT', 'C', [[2, 'NESTED'], [10, 100], [20, 200], [50, 90], [8, 'furniture']]) }));
  assert.deepEqual(drawing.warnings, []);
  const path = drawing.primitives[0]; assert.equal(path.id, 'C/B/A'); assert.equal(path.layer, 'furniture');
  pointNear(path.points[0], [100, 205]); pointNear(path.points[1], [80, 205]);
  const based = buildDxfDrawing(file({ blocks: block('BASE', '92', line('D'), [[10, 5], [20, 2]]), entities: record('INSERT', 'E', [[2, 'BASE'], [10, 50], [20, 60], [41, -1], [42, 2]]) }));
  pointNear(based.primitives[0].points[0], [55, 56]); pointNear(based.primitives[0].points[1], [45, 56]);
});

test('block base points, array offsets and elevations transform without scaling array spacing', () => {
  const drawing = buildDxfDrawing(file({ blocks: block('BASE', '90', record('LINE', 'A', [[10, 5], [20, 2], [30, 3], [11, 6], [21, 2], [31, 3]]), [[30, 3]]).map(([code, value]) => [code, value]),
    entities: record('INSERT', 'B', [[2, 'BASE'], [10, 100], [20, 200], [30, 8], [41, 2], [42, 2], [43, 3], [70, 2], [71, 1], [44, 10]]) }));
  assert.deepEqual(drawing.warnings, []); assert.equal(drawing.primitives.length, 2);
  assert.equal(drawing.primitives[0].id, 'B[0,0]/A'); assert.equal(drawing.primitives[0].elevation, 8);
  pointNear(drawing.primitives[0].points[0], [110, 204]); pointNear(drawing.primitives[1].points[0], [120, 204]);
});

test('dimensions use their cached anonymous block and never invent a dimension label or quantity', () => {
  const drawing = buildDxfDrawing(file({ blocks: block('*D1', '90', [...line('A'), ...record('TEXT', 'B', [[10, 5], [20, 1], [40, 1], [1, '10.00']])]),
    entities: [...record('DIMENSION', 'C', [[2, '*D1'], [10, 1000], [20, 2000], [42, 999]]), ...record('DIMENSION', 'D', [[42, 25]])] }));
  assert.equal(drawing.primitives.length, 2); pointNear(drawing.primitives[0].points[0], [0, 0]);
  assert.equal(drawing.primitives[1].text, '10.00'); assert.equal(drawing.primitives[1].id, 'C/B');
  assert.match(drawing.warnings.join(' '), /no usable cached drawing block/);
});

test('plain TEXT and MTEXT preserve labels, multiline content, alignment, rotation and escaped text', () => {
  const drawing = buildDxfDrawing(file({ entities: [
    ...record('TEXT', 'A', [[10, 0], [20, 0], [11, 4], [21, 5], [72, 1], [73, 2], [40, 2], [50, 90], [41, 0.8], [1, 'STUDIO %%d']]),
    ...record('MTEXT', 'B', [[10, 10], [20, 20], [40, 2], [71, 3], [50, Math.PI / 2], [3, '{\\C1;FIRST}\\P'], [1, 'SECOND \\U+00D8']]),
    ...record('MTEXT', 'C', [[10, 0], [20, 0], [40, 1], [50, Math.PI], [11, 0], [21, 1], [1, '<script>alert(1)</script>']]) ] }));
  assert.match(drawing.warnings.join(' '), /plain font/); assert.equal(drawing.primitives.length, 3);
  const [a, b, c] = drawing.primitives;
  pointNear(a.point, [4, 5]); assert.equal(a.text, 'STUDIO °'); assert.equal(a.align, 'middle'); assert.equal(a.verticalAlign, 'middle'); assert.equal(a.rotation, 90); assert.equal(a.widthScale, 0.8);
  assert.equal(b.text, 'FIRST\nSECOND Ø'); assert.equal(b.rotation, 90); assert.equal(b.align, 'end'); assert.equal(b.verticalAlign, 'top');
  assert.equal(c.rotation, 90); assert.equal(c.text, '<script>alert(1)</script>');
});

test('invalid, tilted, duplicate, missing, unsupported and nonplanar entities are omitted with warnings', () => {
  const drawing = buildDxfDrawing(file({ entities: [
    ...line('A', [[210, 0.1]]), ...line('B', [[31, 2]]), ...line('C'), ...line('C'), ...line(null),
    ...record('SPLINE', 'D'), ...record('CIRCLE', 'E', [[10, 0], [20, 0], [40, -1]]),
    ...record('ELLIPSE', 'F', [[10, 0], [20, 0], [11, 2], [21, 0], [31, 1], [40, 0.5]]),
    ...lw('10', [[0, 0], [1, 1]]), ...line('11', [[39, 1]])] }));
  assert.equal(drawing.primitives.length, 1); assert.equal(drawing.primitives[0].id, '10');
  for (const text of ['tilted', 'nonplanar', 'duplicate', 'handle is missing', 'SPLINE', 'radius', 'thickness']) assert.ok(drawing.warnings.join(' ').includes(text), text);
});

test('application groups and xdata cannot replace geometry, handles or visibility', () => {
  const drawing = buildDxfDrawing(file({ entities: line('A', [[102, '{FOREIGN'], [10, 100], [20, 100], [5, 'B'], [60, 1], [102, '}'], [1001, 'FOREIGN'], [1010, 999]]) }));
  assert.equal(drawing.primitives.length, 1); assert.equal(drawing.primitives[0].id, 'A'); pointNear(drawing.primitives[0].points[0], [0, 0]);
});

test('malformed/binary/truncated DXF never returns partial geometry', () => {
  const valid = file({ entities: line('A') }).toString();
  for (const source of ['AutoCAD Binary DXF\r\n\x1a\0', '0\nSECTION\n2\nENTITIES\n', valid.replace('0\nENDSEC\n0\nEOF', '0\nEOF'), `${valid}0\nLINE\n`, valid.replace('10\n0', 'no-code\n0'), valid.replace('0\nEOF', '102\n{BAD\n0\nEOF')]) {
    assert.throws(() => buildDxfDrawing(Buffer.from(source)), /DXF/);
  }
  assert.throws(() => buildDxfDrawing(Buffer.alloc(30_000_001, 32)), /30 MB/);
  assert.throws(() => buildDxfDrawing(file({ blocks: record('BLOCK', 'A', [[2, 'BAD']]) })), /Unclosed/);
});

test('recursive, missing, oversized arrays, too-deep blocks and mirrored/skewed text fail visibly', () => {
  const recursive = block('LOOP', '90', record('INSERT', 'A', [[2, 'LOOP'], [10, 0], [20, 0]]));
  const text = block('TEXT', '91', record('TEXT', 'B', [[10, 0], [20, 0], [40, 1], [50, 45], [1, 'ROOM']]));
  const drawing = buildDxfDrawing(file({ blocks: [...recursive, ...text], entities: [
    ...record('INSERT', 'C', [[2, 'LOOP'], [10, 0], [20, 0]]),
    ...record('INSERT', 'D', [[2, 'MISSING'], [10, 0], [20, 0]]),
    ...record('INSERT', 'E', [[2, 'TEXT'], [10, 0], [20, 0], [70, 1001]]),
    ...record('INSERT', 'F', [[2, 'TEXT'], [10, 0], [20, 0], [41, -1]]),
    ...record('INSERT', '10', [[2, 'TEXT'], [10, 0], [20, 0], [41, 2]])] }));
  assert.equal(drawing.primitives.length, 0);
  for (const text of ['recursive', 'missing', 'instance limit', 'mirrored', 'skewed']) assert.ok(drawing.warnings.join(' ').includes(text), text);
  const blocks = [];
  for (let i = 0; i < 14; i += 1) blocks.push(...block(`N${i}`, (100 + i).toString(16), i === 13 ? line('FF') : record('INSERT', (200 + i).toString(16), [[2, `N${i + 1}`], [10, 0], [20, 0]])));
  const deep = buildDxfDrawing(file({ blocks, entities: record('INSERT', 'A', [[2, 'N0'], [10, 0], [20, 0]]) }));
  assert.equal(deep.primitives.length, 0); assert.match(deep.warnings.join(' '), /depth limit/);
});

test('primitive, curve point and text budgets bound block expansion and report truncation', () => {
  const paths = [line('A'), line('B'), line('C')].flat();
  const nested = block('NEST', '91', record('INSERT', 'D', [[2, 'LINES'], [10, 0], [20, 0], [70, 1000]]));
  const drawing = buildDxfDrawing(file({ blocks: [...block('LINES', '90', paths), ...nested], entities: record('INSERT', 'E', [[2, 'NEST'], [10, 0], [20, 0], [70, 1000]]) }));
  assert.equal(drawing.primitives.length, 25_000); assert.match(drawing.warnings.join(' '), /complexity limit/);
  const curves = buildDxfDrawing(file({ blocks: block('CURVE', '92', record('CIRCLE', 'F', [[10, 0], [20, 0], [40, 1]])), entities: [
    ...record('INSERT', '10', [[2, 'CURVE'], [10, 0], [20, 0], [70, 1000]]),
    ...record('INSERT', '11', [[2, 'CURVE'], [10, 0], [20, 0], [70, 1000]]),
    ...record('INSERT', '12', [[2, 'CURVE'], [10, 0], [20, 0], [70, 1000]])] }));
  assert.ok(curves.primitives.reduce((n, p) => n + p.points.length, 0) <= 400_000); assert.match(curves.warnings.join(' '), /complexity limit/);
  const text = buildDxfDrawing(file({ entities: record('TEXT', 'A', [[10, 0], [20, 0], [40, 1], [1, 'a'.repeat(4097)]]) }));
  assert.equal(text.primitives.length, 0); assert.match(text.warnings.join(' '), /character limit/);
});

test('hidden boundaries and inherited hidden layers remain invisible; invalid numeric geometry is never approximated', () => {
  const layers = [...record('LAYER', '90', [[2, 'off'], [62, -7]]), ...record('LAYER', '91', [[2, 'frozen'], [70, 1]])];
  const drawing = buildDxfDrawing(file({ layers, blocks: block('ROOM', '92', lw('A', [[0, 0], [2, 0], [2, 2]], 1)), entities: [
    ...lw('B', [[0, 0], [2, 0], [2, 2]], 1), [8, 'off'],
    ...lw('C', [[0, 0], [2, 0], [2, 2]], 1), [8, 'frozen'],
    ...record('INSERT', 'D', [[2, 'ROOM'], [10, 0], [20, 0], [8, 'off']]),
    ...lw('E', [[0, 0], [2, 0], [2, 2]], 1), [60, 1],
    ...lw('F', [[0, 0], [2, 0]], 0), [20, 9],
    ...lw('10', [[0, 0], [2, 0, 1]], 0), [42, -1],
    ...record('LINE', '11', [[10, '0xFF'], [20, 0], [11, 2], [21, 0]]),
    ...line('12', [[11, 20]]),
    ...line('13', [[370, 500]]),
    ...record('DIMENSION', '14', [[2, 'ROOM'], [12, 1]])] }));
  assert.deepEqual(drawing.primitives.map(p => p.id), ['13']); assert.equal('lineweight' in drawing.primitives[0], false);
  for (const text of ['duplicate polyline Y', 'duplicate polyline bulge', 'invalid number', 'duplicate numeric', 'invalid lineweight', 'clone insertion']) assert.ok(drawing.warnings.join(' ').includes(text), text);
});

test('file entity budget and total displayed text limit prevent expansion past bounded resources', () => {
  assert.throws(() => buildDxfDrawing(file({ entities: Array.from({ length: 50_001 }, (_, i) => line((i + 1).toString(16))).flat() })), /entity limit/);
  const drawing = buildDxfDrawing(file({ blocks: block('NOTES', '90', record('TEXT', 'A', [[10, 0], [20, 0], [40, 1], [1, 'x'.repeat(1000)]])),
    entities: record('INSERT', 'B', [[2, 'NOTES'], [10, 0], [20, 0], [70, 1000]]) }));
  assert.equal(drawing.primitives.reduce((n, p) => n + p.text.length, 0), 250_000);
  assert.match(drawing.warnings.join(' '), /complexity limit/);
});
