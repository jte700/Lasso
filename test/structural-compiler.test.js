import test from 'node:test';
import assert from 'node:assert/strict';
import { compileContext, EXACT_ALTERNATIVE_LIMIT } from '../src/agent/structural/compiler.js';

const source = { id: 'file', revision: 'r1' };
const record = (id, text = id, requires = [], extra = {}) => ({ id, text, requires, source, validity: 'valid', ...extra });
const alternative = (id, covers, evidence, extra = {}) => ({ id, covers, evidence, audit: [], guarantee: 'declared_dependencies', ...extra });
const input = (records, alternatives, requirements, extra = {}) => ({
  records, alternatives, requirements, expectedRevisions: { file: 'r1' }, budgetBytes: 100_000, ...extra,
});
const ids = (result) => result.payload.evidence.map((entry) => entry.id);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('deduplicates shared visible closure while validating private computation closure locally', () => {
  const request = input([
    record('unit', 'All values in mm'),
    record('a', 'Left = 12', ['unit']),
    record('b', 'Right = 14', ['unit']),
    record('raw', 'Private raw measurement', ['calibration']),
    record('calibration', 'Calibration valid'),
  ], [
    alternative('left', ['left'], ['a'], { audit: ['raw'], guarantee: 'supported_operator' }),
    alternative('right', ['right'], ['b'], { audit: ['raw'], guarantee: 'supported_operator' }),
  ], ['right', 'left']);
  const result = compileContext(request);
  assert.equal(result.payload.status, 'complete_for_declared_requirements');
  assert.deepEqual(ids(result), ['a', 'b', 'unit']);
  assert.deepEqual(result.audit.computationDependencyIds, ['calibration', 'raw']);
  assert.deepEqual(result.audit.validatedRecordIds, ['a', 'b', 'calibration', 'raw', 'unit']);
  assert.equal(result.text.includes('Private raw measurement'), false);
  assert.equal(result.audit.accounting.auditIncluded, false);
  assert.equal(result.audit.accounting.responseBytes, Buffer.byteLength(result.text));
  assert.deepEqual(JSON.parse(result.text), result.payload);
});

test('finite cyclic dependencies are emitted once; an invalid member invalidates the whole cycle', () => {
  const request = input([record('a', 'A', ['b']), record('b', 'B', ['a'])], [alternative('cycle', ['q'], ['a'])], ['q']);
  assert.deepEqual(ids(compileContext(request)), ['a', 'b']);
  const rejected = compileContext({ ...request, records: [request.records[0], { ...request.records[1], validity: 'invalid' }] });
  assert.equal(rejected.payload.status, 'partial');
  assert.deepEqual(ids(rejected), []);
  assert.match(rejected.audit.rejectedAlternatives[0].reasons.join(' '), /record b: validity is invalid/);
});

test('missing, unpinned, invalid and stale dependencies fail closed, including private transitive dependencies', () => {
  const cases = [
    { name: 'missing visible', evidence: ['absent'], records: [], reason: /missing record absent/ },
    { name: 'missing nested visible', evidence: ['a'], records: [record('a', 'A', ['absent'])], reason: /missing record absent/ },
    { name: 'missing private', audit: ['absent'], records: [], reason: /missing record absent/ },
    { name: 'missing nested private', audit: ['raw'], records: [record('raw', 'raw', ['absent'])], reason: /missing record absent/ },
    { name: 'stale visible', evidence: ['old'], records: [record('old', 'old', [], { source: { id: 'file', revision: 'r0' } })], reason: /stale revision/ },
    { name: 'stale private', audit: ['raw'], records: [record('raw', 'raw', ['old']), record('old', 'old', [], { source: { id: 'file', revision: 'r0' } })], reason: /stale revision/ },
    { name: 'unknown defaults closed', audit: ['raw'], records: [record('raw', 'raw', [], { validity: undefined })], reason: /validity is unknown/ },
    { name: 'invalid private', audit: ['raw'], records: [record('raw', 'raw', [], { validity: 'invalid' })], reason: /validity is invalid/ },
    { name: 'unpinned source', audit: ['raw'], records: [record('raw', 'raw', [], { source: { id: 'untrusted', revision: 'r1' } })], reason: /no pinned revision/ },
  ];
  for (const fixture of cases) {
    const request = input([record('safe'), record('result'), ...fixture.records], [
      alternative('safe-alt', ['safe'], ['safe']),
      alternative('bad-alt', ['wanted'], fixture.evidence ?? ['result'], { audit: fixture.audit ?? [] }),
    ], ['safe', 'wanted']);
    const result = compileContext(request);
    assert.equal(result.payload.status, 'partial', fixture.name);
    assert.deepEqual(result.payload.missing, ['wanted'], fixture.name);
    assert.deepEqual(ids(result), ['safe'], fixture.name);
    assert.match(result.audit.rejectedAlternatives[0].reasons.join(' '), fixture.reason, fixture.name);
  }
});

test('trusted revision mapping requires an own key, not an inherited property', () => {
  const inherited = Object.create({ file: 'r1' });
  const result = compileContext(input([record('a')], [alternative('a', ['q'], ['a'])], ['q'], { expectedRevisions: inherited }));
  assert.deepEqual(result.payload.covered, []);
  assert.match(result.audit.rejectedAlternatives[0].reasons.join(' '), /no pinned revision/);
});

test('exact UTF-8 budget includes all JSON metadata, escaping and complete dependency closure', () => {
  const request = input([
    record('unit', 'Unit: mm'),
    record('value', 'Étage 😀 "quoted" ' + String.fromCharCode(10) + 'next line', ['unit']),
  ], [alternative('answer', ['q'], ['value'])], ['q']);
  const full = compileContext(request);
  const cost = Buffer.byteLength(full.text, 'utf8');
  assert.ok(cost > full.text.length);
  const boundary = compileContext({ ...request, budgetBytes: cost });
  assert.equal(boundary.text, full.text);
  const short = compileContext({ ...request, budgetBytes: cost - 1 });
  assert.deepEqual(ids(short), [], 'cannot drop the unit dependency to squeeze in the value');
  assert.equal(short.payload.status, 'partial');
  assert.ok(Buffer.byteLength(short.text) <= cost - 1);
  const minimum = Buffer.byteLength(short.text);
  assert.equal(compileContext({ ...request, budgetBytes: minimum }).text, short.text);
  assert.throws(() => compileContext({ ...request, budgetBytes: minimum - 1 }), /empty response requires/);
});

test('minimizes the complete payload, not the number of roots or the root text alone', () => {
  const request = input([
    record('shared', 'Units are mm.'),
    record('a', 'A=1', ['shared']),
    record('b', 'B=2', ['shared']),
    record('big', 'x'.repeat(700)),
  ], [
    alternative('joint', ['a', 'b'], ['big']),
    alternative('left', ['a'], ['a']),
    alternative('right', ['b'], ['b']),
  ], ['a', 'b']);
  const result = compileContext(request);
  assert.deepEqual(result.audit.selectedAlternatives, ['left', 'right']);
  assert.deepEqual(ids(result), ['a', 'b', 'shared']);
});

test('canonical serialization and tie selection are independent of input iteration order', () => {
  const request = input([
    record('b', 'B', ['a'], { source: { revision: 'r1', locator: { sheet: 'Data', cell: { row: 2, column: 1 } }, id: 'file' } }),
    record('a', 'A'),
  ], [
    alternative('z', ['q2', 'q1'], ['b', 'a']),
    alternative('a', ['q1', 'q2'], ['a', 'b']),
  ], ['q2', 'q1']);
  const original = compileContext(request);
  const reordered = compileContext({
    ...request, records: [...request.records].reverse().map((r) => ({
      ...r, requires: [...r.requires].reverse(),
      source: r.id === 'b' ? { id: 'file', locator: { cell: { column: 1, row: 2 }, sheet: 'Data' }, revision: 'r1' } : r.source,
    })),
    alternatives: [...request.alternatives].reverse(), requirements: [...request.requirements].reverse(),
  });
  assert.equal(original.text, reordered.text);
  assert.deepEqual(original.audit, reordered.audit);
  assert.deepEqual(original.audit.selectedAlternatives, ['a']);
});

test('best partial maximizes mandatory requirement coverage before minimizing bytes', () => {
  const request = input([record('x', 'X'), record('y', 'Y'.repeat(30)), record('huge', 'Z'.repeat(1000))], [
    alternative('one', ['a'], ['x']),
    alternative('two', ['b', 'c'], ['y']),
    alternative('last', ['d'], ['huge']),
  ], ['a', 'b', 'c', 'd']);
  const twoOnly = compileContext({ ...request, alternatives: [request.alternatives[1]] });
  const result = compileContext({ ...request, budgetBytes: bytes(twoOnly.payload) });
  assert.deepEqual(result.payload.covered, ['b', 'c']);
  assert.deepEqual(result.payload.missing, ['a', 'd']);
  assert.equal(result.payload.status, 'partial');
});

test('guarantees reflect every selected alternative without upgrading heuristic evidence', () => {
  const result = compileContext(input([record('a'), record('b')], [
    alternative('a', ['a'], ['a'], { guarantee: 'heuristic' }),
    alternative('b', ['b'], ['b'], { guarantee: 'supported_operator' }),
  ], ['a', 'b', 'never-declared-by-an-alternative']));
  assert.deepEqual(result.payload.guarantees, ['heuristic', 'supported_operator']);
  assert.equal(result.payload.status, 'partial');
  assert.deepEqual(result.payload.missing, ['never-declared-by-an-alternative']);
});

test('greedy reports unknown optimality even when complete and demonstrably more expensive than exact', () => {
  const request = input([record('t', 'T'.repeat(20)), record('x', 'X'.repeat(40)), record('y', '')], [
    alternative('trap', ['a', 'b'], ['t']),
    alternative('wide', ['a', 'c'], ['x']),
    alternative('small', ['b'], ['y']),
  ], ['a', 'b', 'c']);
  const exact = compileContext({ ...request, mode: 'exact' });
  const greedy = compileContext({ ...request, mode: 'greedy' });
  assert.equal(greedy.payload.status, 'complete_for_declared_requirements');
  assert.ok(greedy.audit.accounting.responseBytes > exact.audit.accounting.responseBytes);
  assert.equal(greedy.audit.solver, 'heuristic');
  assert.equal(greedy.audit.optimality, 'unknown');
  const padded = { ...request, alternatives: [...request.alternatives,
    ...Array.from({ length: EXACT_ALTERNATIVE_LIMIT - 2 }, (_, i) => alternative('noop-' + i, [], []))] };
  assert.equal(padded.alternatives.length, 19);
  assert.equal(compileContext(padded).audit.solver, 'heuristic');
  assert.throws(() => compileContext({ ...padded, mode: 'exact' }), /at most 18/);
});

test('coverage without evidence and invalid locators cannot create a complete answer', () => {
  const invalid = record('bad', 'B', [], { source: { ...source, locator: { value: Infinity } } });
  const result = compileContext(input([invalid], [
    alternative('unsupported-claim', ['q'], []),
    alternative('invalid-location', ['q'], ['bad']),
  ], ['q']));
  assert.equal(result.payload.status, 'partial');
  assert.equal(result.audit.rejectedAlternatives.length, 2);
});

test('empty requirements have a vacuously complete empty payload, and invalid API shapes fail clearly', () => {
  const empty = input([], [], []);
  const result = compileContext(empty);
  assert.equal(result.payload.status, 'complete_for_declared_requirements');
  assert.deepEqual(result.payload.evidence, []);
  assert.throws(() => compileContext({ ...empty, budgetBytes: 0 }), RangeError);
  assert.throws(() => compileContext({ ...empty, budgetBytes: 1.5 }), RangeError);
  assert.throws(() => compileContext({ ...empty, records: [record('a'), record('a')] }), /Duplicate record/);
  assert.throws(() => compileContext({ ...empty, alternatives: [alternative('bad', ['unknown'], ['missing'])] }), /undeclared requirement/);
});

// Independent oracle uses bitmask enumeration and a fixed-point dependency set,
// rather than the compiler's recursive enumeration and work-list closure.
function bruteFixture(request, budgetBytes) {
  const candidates = [];
  const requirementOrder = [...new Set(request.requirements)].sort();
  for (let mask = 0; mask < 2 ** request.alternatives.length; mask += 1) {
    const selected = request.alternatives.filter((_, index) => mask & (1 << index)).sort((a, b) => a.id < b.id ? -1 : 1);
    const coverage = [...new Set(selected.flatMap((a) => a.covers))].sort();
    const evidence = new Set(selected.flatMap((a) => a.evidence));
    let previous = -1;
    while (previous !== evidence.size) {
      previous = evidence.size;
      for (const r of request.records) if (evidence.has(r.id)) for (const dependency of r.requires) evidence.add(dependency);
    }
    const missing = requirementOrder.filter((r) => !coverage.includes(r));
    const payload = {
      status: missing.length ? 'partial' : 'complete_for_declared_requirements',
      covered: coverage, missing,
      evidence: request.records.filter((r) => evidence.has(r.id)).sort((a, b) => a.id < b.id ? -1 : 1)
        .map((r) => ({ id: r.id, text: r.text, source: r.source })),
      guarantees: [...new Set(selected.map((a) => a.guarantee))].sort(),
    };
    const cost = bytes(payload);
    if (cost <= budgetBytes) candidates.push({ payload, cost, selected: selected.map((a) => a.id) });
  }
  candidates.sort((a, b) => b.payload.covered.length - a.payload.covered.length || a.cost - b.cost
    || a.selected.length - b.selected.length || (JSON.stringify(a.selected) < JSON.stringify(b.selected) ? -1 : 1));
  return candidates[0];
}

test('exact solver matches an independent exhaustive oracle over shared graphs and multiple byte budgets', () => {
  let seed = 71;
  const random = (limit) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
  for (let fixture = 0; fixture < 16; fixture += 1) {
    const records = Array.from({ length: 5 }, (_, i) => record('r' + i, 'é'.repeat(1 + random(45)), i ? ['r' + random(i)] : []));
    const alternatives = Array.from({ length: 5 }, (_, i) => alternative('a' + i,
      ['q' + random(4), 'q' + random(4)], ['r' + random(5)], { guarantee: i % 2 ? 'heuristic' : 'declared_dependencies' }));
    const request = input(records, alternatives, ['q0', 'q1', 'q2', 'q3']);
    const minimum = compileContext({ ...request, alternatives: [] }).audit.accounting.responseBytes;
    for (const budgetBytes of [minimum, minimum + 160, minimum + 280, 100_000]) {
      const oracle = bruteFixture(request, budgetBytes);
      const actual = compileContext({ ...request, budgetBytes });
      assert.deepEqual(actual.payload, oracle.payload, 'fixture ' + fixture + ', budget ' + budgetBytes);
      assert.deepEqual(actual.audit.selectedAlternatives, oracle.selected);
      assert.equal(actual.audit.accounting.responseBytes, oracle.cost);
      assert.equal(actual.audit.accounting.evaluatedSubsets, 32);
    }
  }
});

// A deliberately controlled tokenizer isolates the accounting contract. The
// benchmark separately uses real o200k_base tokenization, not this test metric.
test('optional tokenizer changes the objective and enforces complete-payload token budgets', () => {
  const request = input([record('a', 'byte-short'), record('b', 'token-efficient '.repeat(10))], [
    alternative('a', ['q'], ['a']), alternative('b', ['q'], ['b']),
  ], ['q']);
  const tokenCounter = (text) => 10 + (text.includes('byte-short') ? 100 : 0) + (text.includes('token-efficient') ? 20 : 0);
  assert.deepEqual(compileContext(request).audit.selectedAlternatives, ['a']);
  const result = compileContext({ ...request, tokenCounter, budgetTokens: 30 });
  assert.deepEqual(result.audit.selectedAlternatives, ['b']);
  assert.equal(result.audit.accounting.responseTokens, 30);
  assert.equal(result.audit.accounting.objective, 'tokens');
  assert.equal(compileContext({ ...request, tokenCounter, budgetTokens: 29 }).payload.status, 'partial');
  assert.throws(() => compileContext({ ...request, tokenCounter, budgetTokens: 9 }), /empty response/);
  assert.throws(() => compileContext({ ...request, budgetTokens: 30 }), /requires tokenCounter/);
  assert.throws(() => compileContext({ ...request, objective: 'tokens' }), /requires tokenCounter/);
  assert.throws(() => compileContext({ ...request, tokenCounter: () => NaN }), /nonnegative safe integer/);
});
