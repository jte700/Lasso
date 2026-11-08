import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocumentContext, buildGeometryContext, buildSpreadsheetContext, geometryContextFromStepModel } from '../src/agent/structural/adapters.js';
import { compileContext } from '../src/agent/structural/compiler.js';
import { readStepModel } from '../src/dependencies/step-model.js';
import { fixtureAssembly } from './fixtures/step-models.js';

const source = { id: 'fixture', revision: 'v1' };
const matrix = (x = 0, y = 0, z = 0) => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]];
const occurrence = (id, transform = matrix()) => ({ id, definitionId: 'shared-part', transform, placementValidity: 'valid', axes: { x: [1, 0, 0], z: [0, 0, 1] } });
const geometry = (op = 'relative_transform') => ({ source, unit: 'mm', occurrences: [occurrence('a'), occurrence('b', matrix(3, 4))], queries: [{ id: 'q', op, a: 'a', b: 'b', axisA: 'x', axisB: 'x' }] });
const compile = (graph) => compileContext({ ...graph, budgetBytes: 100000 });
const values = (packet) => packet.payload.evidence.filter((r) => r.id.includes(':result:')).map((r) => JSON.parse(r.text));
const code = (expected) => (error) => error.code === expected;

// Independent affine evaluation: test relative transforms by transforming an
// arbitrary point through both coordinate routes, rather than copying inverse math.
const apply = (m, p) => m.slice(0, 3).map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]);
test('relative transform preserves repeated-instance identity and rotated reference frames', () => {
  const input = geometry();
  input.occurrences[0].transform = [[0, -1, 0, 10], [1, 0, 0, 20], [0, 0, 1, 0], [0, 0, 0, 1]];
  input.occurrences[1].transform = [[-1, 0, 0, 13], [0, -1, 0, 24], [0, 0, 1, 0], [0, 0, 0, 1]];
  const packet = compile(buildGeometryContext(input));
  const result = values(packet)[0];
  assert.deepEqual(result.transform, [[0, -1, 0, 4], [1, 0, 0, -3], [0, 0, 1, 0], [0, 0, 0, 1]]);
  assert.deepEqual(apply(input.occurrences[0].transform, apply(result.transform, [2, 7, 3])), apply(input.occurrences[1].transform, [2, 7, 3]));
  assert.equal(result.from, 'b'); assert.equal(result.to, 'a');
  assert.equal(packet.audit.computationDependencyIds.length, 2);
  assert.ok(packet.payload.evidence.every((r) => !r.id.includes(':occurrence:')));
});

test('angle uses declared local axes in world coordinates with directed-axis convention', () => {
  const input = geometry('axis_angle');
  input.occurrences[1].transform = [[0, -1, 0, 3], [1, 0, 0, 4], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.equal(values(compile(buildGeometryContext(input)))[0].angle_degrees, 90);
  input.occurrences[1].axes.x = [-1, 0, 0]; input.occurrences[1].transform = matrix();
  assert.equal(values(compile(buildGeometryContext(input)))[0].angle_degrees, 180);
});

test('geometry rejects missing placements, unknown units, scale, reflection, missing axes and unsupported operations', () => {
  const cases = [
    ['unknown_placement', (x) => { delete x.occurrences[0].placementValidity; }],
    ['unknown_unit', (x) => { x.unit = 'unspecified'; }],
    ['nonrigid_transform', (x) => { x.occurrences[0].transform[0][0] = 2; }],
    ['nonrigid_transform', (x) => { x.occurrences[0].transform[0][0] = -1; }],
    ['invalid_transform', (x) => { x.occurrences[0].transform = []; }],
    ['missing_occurrence', (x) => { x.queries[0].a = 'absent'; }],
    ['invalid_input', (x) => { x.queries[0].op = 'axis_angle'; x.queries[0].axisA = 'missing'; }],
    ['unsupported_operation', (x) => { x.queries[0].op = 'motion_clearance'; }],
  ];
  for (const [expected, mutate] of cases) { const x = geometry(); mutate(x); assert.throws(() => buildGeometryContext(x), code(expected)); }
});

test('solid box separation has independent 3-4-5 oracle and valid witness points', () => {
  const x = geometry('solid_box_separation'); x.occurrences[1].transform = matrix(4, 5);
  for (const item of x.occurrences) item.solid = { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] };
  const r = values(compile(buildGeometryContext(x)))[0];
  assert.equal(r.separation, 5);
  assert.deepEqual(r.witnesses, [[1, 1, 0], [4, 5, 0]]);
  assert.equal(Math.hypot(...r.witnesses[0].map((v, i) => v - r.witnesses[1][i])), 5);
  x.occurrences[1].transform = matrix(1, 0, 0);
  assert.equal(values(compile(buildGeometryContext(x)))[0].status, 'touching_or_overlapping');
});

test('solid box operation refuses general B-rep bounds and rotated bounding-box approximations', () => {
  const x = geometry('solid_box_separation');
  assert.throws(() => buildGeometryContext(x), code('unsupported_shape'));
  for (const item of x.occurrences) item.solid = { kind: 'box', min: [0, 0, 0], max: [1, 1, 1] };
  const c = Math.SQRT1_2;
  x.occurrences[1].transform = [[c, -c, 0, 3], [c, c, 0, 4], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.throws(() => buildGeometryContext(x), code('unsupported_orientation'));
});

test('existing STEP parser feeds actual assembly occurrences to the isolated bridge', () => {
  const model = readStepModel(fixtureAssembly());
  assert.equal(model.occurrences.length, 3);
  assert.equal(model.occurrences[1].part, model.occurrences[2].part);
  const graph = geometryContextFromStepModel(model, { source, queries: [
    { id: 'pose', op: 'relative_transform', a: 'occurrence:1', b: 'occurrence:2' },
    { id: 'angle', op: 'axis_angle', a: 'occurrence:1', b: 'occurrence:2', axisA: 'x', axisB: 'x' },
  ] });
  const results = values(compile(graph));
  assert.equal(results.find((r) => r.operation === 'axis_angle').angle_degrees, 90);
  assert.deepEqual(results.find((r) => r.operation === 'relative_transform').transform, [[0, -1, 0, 50], [1, 0, 0, 30], [0, 0, 1, 0], [0, 0, 0, 1]]);
  for (const warning of ['Assembly placement is missing', 'assembly structure is cyclic', 'Only the first 5000 assembly component instances were placed.']) {
    assert.throws(() => geometryContextFromStepModel({ ...model, warnings: [warning] }, { source, queries: [{ id: 'q', op: 'relative_transform', a: 'occurrence:1', b: 'occurrence:2' }] }), code('unknown_placement'));
  }
});

const document = () => ({ source, records: [
  { id: 'result', text: 'The endpoint improved by 12%.', requires: ['definition', 'limitation'], locator: { page: 8, sentence: 3 } },
  { id: 'definition', text: 'Endpoint = measured task completion at 30 days.', requires: [] },
  { id: 'limitation', text: 'Only the prespecified adult subgroup; the full cohort was inconclusive.', requires: ['population'] },
  { id: 'population', text: 'Adults at two clinics.', requires: [] },
  { id: 'unrelated', text: 'Earlier work used a different endpoint.', requires: [] },
], requests: [{ id: 'findings', candidates: ['result'] }] });

test('document selection retains remote definitions and nested qualifiers with citations', () => {
  const packet = compile(buildDocumentContext(document()));
  assert.equal(packet.payload.status, 'complete_for_declared_requirements');
  assert.equal(packet.payload.evidence.length, 5);
  assert.ok(packet.payload.evidence.some((r) => r.text.includes('full cohort was inconclusive')));
  assert.ok(!packet.text.includes('Earlier work'));
  assert.deepEqual(packet.payload.evidence.find((r) => r.id.endsWith(':result')).source.locator, { page: 8, sentence: 3 });
  assert.deepEqual(packet.payload.guarantees, ['declared_dependencies']);
});

test('missing document dependency is rejected and a declared invalid qualifier blocks its claim', () => {
  const missing = document(); missing.records = missing.records.filter((r) => r.id !== 'limitation');
  assert.throws(() => buildDocumentContext(missing), code('missing_dependency'));
  const invalid = document(); invalid.records.find((r) => r.id === 'limitation').validity = 'unknown';
  assert.equal(compile(buildDocumentContext(invalid)).payload.status, 'partial');
});

test('document alternative IDs cannot collide when request and candidate contain slashes', () => {
  const x = { source, records: [{ id: 'b/c', text: 'One' }, { id: 'c', text: 'Two' }], requests: [{ id: 'a', candidates: ['b/c'] }, { id: 'a/b', candidates: ['c'] }] };
  assert.equal(compile(buildDocumentContext(x)).payload.covered.length, 2);
});

const sheet = () => ({ source, cells: [
  { id: 'Sales!B2', value: 120, unit: 'USD' }, { id: 'Sales!B3', value: 80, unit: 'USD' },
  { id: 'Sales!B4', value: 50, unit: 'USD' },
  { id: 'Sales!B5', op: 'sum', deps: ['Sales!B2', 'Sales!B3'], unit: 'USD', cachedValue: 999, cacheStatus: 'stale' },
  { id: 'Sales!B6', op: 'difference', deps: ['Sales!B5', 'Sales!B4'] },
  { id: 'Sales!B7', op: 'ratio', deps: ['Sales!B6', 'Sales!B5'] },
], requests: [{ id: 'margin', cell: 'Sales!B7' }] });

test('sheet recomputes full dependency chain and ignores stale formula caches', () => {
  const packet = compile(buildSpreadsheetContext(sheet()));
  const result = values(packet)[0];
  assert.equal(result.value, 0.75); assert.equal(result.unit, '1');
  assert.equal(packet.audit.computationDependencyIds.length, 6);
  assert.equal(packet.payload.evidence.length, 2);
  assert.equal(result.calculation.dependency_count, 2);
  assert.ok(!packet.text.includes('999'));
});

test('sheet rejects missing operands, cycles, stale inputs, zero division, mixed units and unimplemented formulas', () => {
  const cases = [
    ['missing_dependency', (x) => { x.cells.shift(); }],
    ['cyclic_dependency', (x) => { x.cells[3].deps = ['Sales!B7']; }],
    ['stale_value', (x) => { x.cells[0].valueStatus = 'stale'; }],
    ['invalid_cell', (x) => { x.cells[0].validity = 'unknown'; }],
    ['division_by_zero', (x) => { x.cells[0].value = -80; }],
    ['unit_mismatch', (x) => { x.cells[0].unit = 'EUR'; }],
    ['unsupported_formula', (x) => { x.cells[3].op = 'XLOOKUP'; }],
    ['unsupported_formula', (x) => { x.cells[0].formula = '=RAND()'; }],
    ['invalid_number', (x) => { x.cells[0].value = Infinity; }],
  ];
  for (const [expected, mutate] of cases) { const x = sheet(); mutate(x); assert.throws(() => buildSpreadsheetContext(x), code(expected), expected); }
});

test('all adapters can be pinned to a newer expected revision and cannot emit stale evidence', () => {
  for (const [build, x] of [[buildGeometryContext, geometry()], [buildDocumentContext, document()], [buildSpreadsheetContext, sheet()]]) {
    x.expectedRevision = 'v2'; const packet = compile(build(x));
    assert.equal(packet.payload.status, 'partial'); assert.deepEqual(packet.payload.evidence, []);
  }
});
