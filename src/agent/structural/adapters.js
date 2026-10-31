// Research prototype: normalized, revision-pinned adapters, not general parsers.
// No authorization is performed here: callers must supply authorized inputs.
// Matrices are row-major 4x4 arrays acting on column vectors. Occurrence
// transforms map local coordinates into one shared world frame.

export class StructuralAdapterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StructuralAdapterError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new StructuralAdapterError(code, message); };
const name = (value, label) => typeof value === 'string' && value.trim() ? value : fail('invalid_input', `${label} must be a nonempty string.`);
const finite = (value, label) => typeof value === 'number' && Number.isFinite(value) ? value : fail('invalid_number', `${label} must be finite.`);
const list = (value, label) => Array.isArray(value) ? value : fail('invalid_input', `${label} must be an array.`);
const token = (value) => encodeURIComponent(value);
const id = (domain, kind, key) => `${domain}:${kind}:${token(key)}`;
const clean = (value) => Object.is(value, -0) ? 0 : value;
const checkedSource = (source) => ({ id: name(source?.id, 'source.id'), revision: name(source?.revision, 'source.revision'),
  ...(source.locator === undefined ? {} : { locator: source.locator }) });
const validity = (value = 'valid') => ['valid', 'unknown', 'invalid'].includes(value) ? value : fail('invalid_input', 'Unknown validity value.');
const vector = (value, label) => {
  if (!Array.isArray(value) || value.length !== 3) fail('invalid_input', `${label} must have three coordinates.`);
  return value.map((number) => finite(number, label));
};
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unitVector = (value, label) => {
  const v = vector(value, label), length = Math.hypot(...v);
  if (!(length > 0) || !Number.isFinite(length)) fail('invalid_axis', `${label} must have a nonzero finite length.`);
  return v.map((number) => number / length);
};
const record = (recordId, content, source, requires = [], state = 'valid') => ({
  id: recordId, text: typeof content === 'string' ? content : JSON.stringify(content), requires,
  source: { ...source }, validity: validity(state),
});
const uniqueMap = (values, label) => {
  const result = new Map();
  for (const value of list(values, label)) {
    const key = name(value?.id, `${label}.id`);
    if (result.has(key)) fail('duplicate_id', `${label} contains duplicate id ${key}.`);
    result.set(key, value);
  }
  return result;
};
const expected = (input, source) => ({ ...input.expectedRevisions,
  [source.id]: input.expectedRevision ?? input.expectedRevisions?.[source.id] ?? source.revision });

export function rigidMatrix(value, label) {
  if (!Array.isArray(value) || value.length !== 4 || value.some((row) => !Array.isArray(row) || row.length !== 4)) {
    fail('invalid_transform', `${label} must be a row-major 4x4 matrix.`);
  }
  const matrix = value.map((row) => row.map((v) => finite(v, label)));
  const tolerance = 1e-9;
  if (matrix[3].some((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) > tolerance)) fail('nonrigid_transform', `${label} is not affine.`);
  const columns = [0, 1, 2].map((column) => matrix.slice(0, 3).map((row) => row[column]));
  for (let a = 0; a < 3; a += 1) for (let b = 0; b < 3; b += 1) {
    if (Math.abs(dot(columns[a], columns[b]) - (a === b ? 1 : 0)) > tolerance) fail('nonrigid_transform', `${label} must have orthonormal axes.`);
  }
  if (Math.abs(dot(columns[0], cross(columns[1], columns[2])) - 1) > tolerance) {
    fail('nonrigid_transform', `${label} must be a proper rotation; reflections are unsupported.`);
  }
  return matrix;
}

const rotate = (matrix, direction) => matrix.slice(0, 3).map((row) => dot(row.slice(0, 3), direction));
const point = (matrix, location) => rotate(matrix, location).map((v, i) => finite(v + matrix[i][3], 'transformed point'));
const relative = (a, b) => {
  const result = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) result[row][column] = clean(dot(a.slice(0, 3).map((r) => r[row]), b.slice(0, 3).map((r) => r[column])));
    result[row][3] = clean(dot(a.slice(0, 3).map((r) => r[row]), b.slice(0, 3).map((r, i) => r[3] - a[i][3])));
  }
  result[3][3] = 1;
  return result.map((row) => row.map((v) => finite(v, 'relative transform')));
};

function worldSolidBox(occurrence) {
  if (occurrence.solid?.kind !== 'box') fail('unsupported_shape', 'Separation requires explicitly declared occupied solid boxes; bounds of general shapes are insufficient.');
  const min = vector(occurrence.solid.min, 'box.min'), max = vector(occurrence.solid.max, 'box.max');
  if (min.some((v, i) => v >= max[i])) fail('invalid_box', 'A solid box must have strictly positive dimensions.');
  // No tolerance-based snapping: even a slightly rotated box is not exactly
  // its world AABB. Permit only exact signed-permutation rotation matrices.
  const rotation = occurrence.transform.slice(0, 3).map((row) => row.slice(0, 3));
  if (rotation.some((row) => row.filter((v) => v === 1 || v === -1).length !== 1 || row.some((v) => ![0, 1, -1].includes(v)))) {
    fail('unsupported_orientation', 'Solid-box separation supports only exactly world-axis-aligned boxes.');
  }
  const corners = Array.from({ length: 8 }, (_, mask) => point(occurrence.transform, min.map((v, axis) => mask & (1 << axis) ? max[axis] : v)));
  return { min: [0, 1, 2].map((axis) => Math.min(...corners.map((p) => p[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((p) => p[axis]))) };
}

/**
 * Input: {source, expectedRevision?, unit, occurrences, queries}.
 * Occurrences: {id,definitionId,transform,placementValidity:'valid',axes?,solid?}.
 * Queries: {id,op,a,b,axisA?,axisB?}; op is relative_transform, axis_angle,
 * or solid_box_separation. Values are float64 computations, not certified
 * physical tolerances. No motion, general B-rep, or contact inference occurs.
 */
export function buildGeometryContext(input) {
  const source = checkedSource(input?.source);
  if (!['mm', 'cm', 'm', 'in', 'ft', 'um', 'nm', 'km'].includes(input.unit)) fail('unknown_unit', 'A supported declared length unit is required.');
  const occurrences = uniqueMap(input.occurrences, 'occurrences');
  const queries = uniqueMap(input.queries, 'queries');
  const contextId = id('geometry', 'context', source.id);
  const records = [record(contextId, { domain: 'geometry', frame: 'world', length_unit: input.unit,
    numeric_method: 'float64', transform_convention: 'row-major matrices, column vectors, local-to-world',
    coverage: 'requested_static_operations_only', physical_error_bound: 'not_established' }, source)];
  const alternatives = [], requirements = [...queries.keys()];
  const resolved = new Map();
  function occurrence(key) {
    const raw = occurrences.get(key);
    if (!raw) fail('missing_occurrence', `No occurrence ${key}.`);
    if (resolved.has(key)) return resolved.get(key);
    if (raw.placementValidity !== 'valid') fail('unknown_placement', `Occurrence ${key} has no validated placement.`);
    const item = { ...raw, definitionId: name(raw.definitionId, 'definitionId'), transform: rigidMatrix(raw.transform, `transform ${key}`) };
    const recordId = id('geometry', 'occurrence', key);
    records.push(record(recordId, { occurrence: key, definition: item.definitionId, transform: item.transform,
      ...(raw.path ? { path: raw.path } : {}), ...(raw.axes ? { axes: raw.axes } : {}), ...(raw.solid ? { solid: raw.solid } : {}) }, source));
    item.recordId = recordId;
    resolved.set(key, item);
    return item;
  }
  for (const query of queries.values()) {
    const a = occurrence(query.a), b = occurrence(query.b);
    let result;
    if (query.op === 'relative_transform') {
      result = { operation: query.op, from: b.id, to: a.id, transform: relative(a.transform, b.transform), length_unit: input.unit };
    } else if (query.op === 'axis_angle') {
      const axisA = name(query.axisA, 'axisA'), axisB = name(query.axisB, 'axisB');
      const directionA = unitVector(rotate(a.transform, unitVector(a.axes?.[axisA], `axis ${a.id}.${axisA}`)), 'world axis A');
      const directionB = unitVector(rotate(b.transform, unitVector(b.axes?.[axisB], `axis ${b.id}.${axisB}`)), 'world axis B');
      const angle = Math.atan2(Math.hypot(...cross(directionA, directionB)), dot(directionA, directionB));
      result = { operation: query.op, a: a.id, b: b.id, axis_a: axisA, axis_b: axisB, frame: 'world',
        angle_degrees: clean(angle * 180 / Math.PI), convention: 'unsigned angle between directed axes, range 0..180 degrees' };
    } else if (query.op === 'solid_box_separation') {
      const boxA = worldSolidBox(a), boxB = worldSolidBox(b);
      const gaps = [0, 1, 2].map((axis) => Math.max(0, boxB.min[axis] - boxA.max[axis], boxA.min[axis] - boxB.max[axis]));
      const witnesses = [[], []];
      for (let axis = 0; axis < 3; axis += 1) {
        if (boxA.max[axis] < boxB.min[axis]) { witnesses[0].push(boxA.max[axis]); witnesses[1].push(boxB.min[axis]); }
        else if (boxB.max[axis] < boxA.min[axis]) { witnesses[0].push(boxA.min[axis]); witnesses[1].push(boxB.max[axis]); }
        else { const coordinate = Math.max(boxA.min[axis], boxB.min[axis]); witnesses[0].push(coordinate); witnesses[1].push(coordinate); }
      }
      const separation = finite(Math.hypot(...gaps), 'separation');
      result = { operation: query.op, a: a.id, b: b.id, frame: 'world', separation,
        length_unit: input.unit, witnesses, shape_contract: 'declared occupied axis-aligned solid boxes',
        status: separation > 0 ? 'separated' : 'touching_or_overlapping', coverage: 'static_pair_only' };
    } else fail('unsupported_operation', `Unsupported geometry operation ${query.op}.`);
    const resultId = id('geometry', 'result', query.id);
    records.push(record(resultId, result, source, [contextId]));
    alternatives.push({ id: id('geometry', 'alternative', query.id), covers: [query.id], evidence: [resultId],
      audit: [...new Set([a.recordId, b.recordId])], guarantee: 'supported_operator' });
  }
  return { records, alternatives, requirements, expectedRevisions: expected(input, source) };
}

/** Bridge for readStepModel output. Does not change or duplicate the parser.
 * Occurrence IDs are revision-local occurrence:0, occurrence:1, ... . Part
 * extents are deliberately never promoted to occupied solid-box geometry.
 * The parser has no per-occurrence placement validity; any structural warning
 * conservatively disqualifies every requested placement computation.
 */
// A parser warning that puts any occurrence's placement in doubt.
export const STRUCTURAL_WARNING = /placement|cyclic|deeper than|instances were placed|truncat/i;

export function geometryContextFromStepModel(model, options) {
  if (!model?.unit || !Number.isFinite(model.unit.mm) || model.unit.mm <= 0) fail('unknown_unit', 'STEP model has no declared supported length unit.');
  const warnings = list(model.warnings ?? [], 'STEP warnings');
  const structuralWarning = warnings.some((warning) => STRUCTURAL_WARNING.test(String(warning)));
  const occurrences = list(model.occurrences, 'STEP occurrences').map((occurrence, index) => {
    const part = model.parts?.[occurrence.part];
    if (!part?.unitKnown) fail('unknown_unit', `STEP occurrence ${index} has unmeasured source units.`);
    const r = occurrence.matrix?.r, t = occurrence.matrix?.t;
    if (!Array.isArray(r) || r.length !== 9 || !Array.isArray(t) || t.length !== 3) fail('invalid_transform', 'STEP occurrence matrix is missing.');
    return { id: `occurrence:${index}`, definitionId: name(part.key, 'STEP part key'), path: occurrence.path,
      placementValidity: structuralWarning ? 'unknown' : 'valid', axes: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      transform: [[...r.slice(0, 3), t[0]], [...r.slice(3, 6), t[1]], [...r.slice(6, 9), t[2]], [0, 0, 0, 1]] };
  });
  for (const query of list(options.queries, 'queries')) {
    if (!['relative_transform', 'axis_angle'].includes(query.op)) fail('unsupported_operation', 'The STEP bridge only supports occurrence transforms and named-axis angles.');
  }
  return buildGeometryContext({ ...options, unit: model.unit.convertedToMm ? 'mm' : model.unit.label, occurrences });
}

/** Normalized document records carry explicit requires IDs (reference,
 * qualifier, header, definition, etc.). requests are {id,candidates:[IDs]}.
 * Each candidate is an alternative answer for the same requirement; callers
 * needing several claims must declare several requirements. Completeness of
 * semantic dependencies is not inferred or certified by this adapter.
 */
export function buildDocumentContext(input) {
  const source = checkedSource(input?.source);
  const supplied = uniqueMap(input.records, 'document records');
  const requests = uniqueMap(input.requests, 'requests');
  const contextId = id('document', 'context', source.id);
  const records = [record(contextId, { domain: 'document', dependency_policy: 'explicit caller-declared relationships only',
    completeness: 'semantic completeness not established' }, source)];
  for (const item of supplied.values()) {
    if (typeof item.text !== 'string') fail('invalid_input', 'Document record text must be a string.');
    const requires = list(item.requires ?? [], 'requires');
    for (const dependency of requires) if (!supplied.has(dependency)) fail('missing_dependency', `Document record ${item.id} requires missing ${dependency}.`);
    records.push(record(id('document', 'record', item.id), item.text,
      { ...source, ...(item.locator === undefined ? {} : { locator: item.locator }) },
      [contextId, ...new Set(requires.map((key) => id('document', 'record', key)))], item.validity));
  }
  const alternatives = [];
  for (const request of requests.values()) {
    for (const candidate of new Set(list(request.candidates, 'candidates'))) {
      if (!supplied.has(candidate)) fail('missing_candidate', `No document candidate ${candidate}.`);
      alternatives.push({ id: id('document', 'alternative', JSON.stringify([request.id, candidate])), covers: [request.id],
        evidence: [id('document', 'record', candidate)], audit: [], guarantee: 'declared_dependencies' });
    }
  }
  return { records, alternatives, requirements: [...requests.keys()], expectedRevisions: expected(input, source) };
}

/** Normalized cells: literal {id,value,unit,valueStatus?:'current'} or formula
 * {id,op:'sum'|'difference'|'ratio',deps:[IDs],unit?,cachedValue?,cacheStatus?}.
 * Formula caches are ignored; operators run over the full declared dependency
 * graph. sum/difference require equal units; ratio requires equal units and
 * returns dimensionless unit '1'. No arbitrary formula strings are evaluated.
 */
export function buildSpreadsheetContext(input) {
  const source = checkedSource(input?.source);
  const cells = uniqueMap(input.cells, 'cells'), requests = uniqueMap(input.requests, 'requests');
  const contextId = id('spreadsheet', 'context', source.id);
  const records = [record(contextId, { domain: 'spreadsheet', evaluator: 'normalized-operators-v1', numeric_method: 'float64',
    supported_operations: ['sum', 'difference', 'ratio'], cache_policy: 'formula caches ignored; dependencies evaluated locally' }, source)];
  const evaluated = new Map(), visiting = new Set();
  function evaluate(key) {
    if (evaluated.has(key)) return evaluated.get(key);
    if (visiting.has(key)) fail('cyclic_dependency', `Formula dependency cycle at ${key}.`);
    const cell = cells.get(key);
    if (!cell) fail('missing_dependency', `No cell ${key}.`);
    if (validity(cell.validity) !== 'valid') fail('invalid_cell', `Cell ${key} is not valid.`);
    visiting.add(key);
    const deps = list(cell.deps ?? [], 'cell dependencies');
    let value, unit, calculation;
    if (!cell.op) {
      if (cell.formula !== undefined || deps.length) fail('unsupported_formula', `Cell ${key} requires an explicit supported normalized operator.`);
      if (cell.valueStatus !== undefined && cell.valueStatus !== 'current') fail('stale_value', `Literal ${key} is not current.`);
      value = finite(cell.value, `value ${key}`);
      unit = name(cell.unit, `unit ${key}`);
      calculation = { kind: 'literal', value, unit };
    } else {
      if (!['sum', 'difference', 'ratio'].includes(cell.op)) fail('unsupported_formula', `Unsupported operator ${cell.op}.`);
      if (!deps.length || (cell.op !== 'sum' && deps.length !== 2)) fail('invalid_formula', `Operator ${cell.op} has an invalid number of dependencies.`);
      const inputs = deps.map(evaluate);
      if (inputs.some((item) => item.unit !== inputs[0].unit)) fail('unit_mismatch', `Operator ${cell.op} requires compatible declared units.`);
      if (cell.op === 'ratio' && inputs[1].value === 0) fail('division_by_zero', `Formula ${key} divides by zero.`);
      value = cell.op === 'sum' ? inputs.reduce((total, item) => total + item.value, 0)
        : cell.op === 'difference' ? inputs[0].value - inputs[1].value : inputs[0].value / inputs[1].value;
      value = finite(value, `computed value ${key}`);
      unit = cell.op === 'ratio' ? '1' : inputs[0].unit;
      if (cell.unit !== undefined && cell.unit !== unit) fail('unit_mismatch', `Declared result unit for ${key} disagrees with its operator.`);
      calculation = { kind: 'computed', operator: cell.op, dependencies: deps,
        dependency_values: inputs.map(({ value: v, unit: u }) => ({ value: v, unit: u })), cache_used: false };
    }
    const auditId = id('spreadsheet', 'cell', key);
    records.push(record(auditId, { cell: key, value, unit, calculation,
      ...(cell.formula === undefined ? {} : { source_formula: cell.formula }),
      ...(cell.cacheStatus === undefined ? {} : { source_cache_status: cell.cacheStatus }) },
    { ...source, locator: key }, deps.map((dep) => id('spreadsheet', 'cell', dep))));
    const result = { value, unit, calculation, auditId };
    evaluated.set(key, result);
    visiting.delete(key);
    return result;
  }
  const alternatives = [];
  for (const request of requests.values()) {
    const cellId = name(request.cell, 'request.cell'), result = evaluate(cellId);
    const resultId = id('spreadsheet', 'result', request.id);
    records.push(record(resultId, { cell: cellId, value: result.value, unit: result.unit,
      calculation: result.calculation.kind === 'computed' ? { operator: result.calculation.operator, dependency_count: result.calculation.dependencies.length, audit_ref: result.auditId } : 'literal',
      status: result.calculation.kind === 'computed' ? 'recomputed_from_declared_dependencies' : 'source_literal' },
    { ...source, locator: cellId }, [contextId]));
    alternatives.push({ id: id('spreadsheet', 'alternative', request.id), covers: [request.id], evidence: [resultId],
      audit: [result.auditId], guarantee: 'supported_operator' });
  }
  return { records, alternatives, requirements: [...requests.keys()], expectedRevisions: expected(input, source) };
}
