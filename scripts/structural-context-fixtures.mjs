// Deterministic synthetic workloads. No user documents or remote models used.
import assert from 'node:assert/strict';
import { buildDocumentContext, buildGeometryContext, buildSpreadsheetContext } from '../src/agent/structural/adapters.js';

export function dependencyIds(records, roots) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const selected = new Set(roots);
  let size = -1;
  while (size !== selected.size) {
    size = selected.size;
    for (const key of selected) {
      const r = byId.get(key); assert.ok(r, `Missing fixture dependency ${key}`);
      for (const dep of r.requires ?? r.deps ?? []) selected.add(dep);
    }
  }
  return selected;
}
const source = (id) => ({ id, revision: 'synthetic-v1' });
const resultObjects = (packet) => packet.payload.evidence.filter((r) => r.id.includes(':result:')).map((r) => JSON.parse(r.text));

export function documentFixture() {
  const input = {
    source: source('study'),
    records: [
      { id: 'endpoint', text: 'Primary endpoint: independently assessed task completion at day 30. A percentage-point difference compares rates; it is not a relative percentage change.', locator: { page: 2, sentence: 4 } },
      { id: 'population', text: 'The trial enrolled 240 adults across two clinics. The prespecified subgroup contained 96 adults with prior task experience; results for it must not be generalized to all participants.', locator: { page: 3, sentence: 2 } },
      { id: 'qualification', text: 'The full-cohort primary comparison was inconclusive: its confidence interval included zero. The positive estimate below is restricted to the prespecified experienced subgroup.', requires: ['population'], locator: { page: 9, sentence: 3 } },
      { id: 'primary', text: 'In the experienced subgroup, completion increased by 12 percentage points, with a 95% confidence interval of 3 to 21 points.', requires: ['endpoint', 'qualification'], locator: { page: 8, sentence: 2 } },
      { id: 'secondary', text: 'The exploratory secondary task-time difference was minus 4 minutes, with a 95% confidence interval of minus 9 to 1 minute; this does not establish a reduction.', requires: ['population'], locator: { page: 8, sentence: 5 } },
      { id: 'safety', text: 'Eight mild adverse events were recorded in the intervention group and seven in the control group. The trial was not powered to establish rare-event safety.', requires: ['population'], locator: { page: 9, sentence: 8 } },
      ...Array.from({ length: 120 }, (_, i) => ({ id: `appendix-${i + 1}`, text: `Calibration batch ${i + 1} used instrument ${i % 7 + 1}, reference mass ${100 + i * 5} grams, and ambient temperature ${18 + i % 9} Celsius. The recorded calibration deviation was ${(i % 13) / 10} percent; this batch log does not measure clinical outcomes.`, locator: { page: 12 + Math.floor(i / 8), row: i % 8 + 1 } })),
    ],
    requests: [ { id: 'primary-finding', candidates: ['primary'] }, { id: 'secondary-finding', candidates: ['secondary'] }, { id: 'safety-finding', candidates: ['safety'] } ],
  };
  const roots = input.requests.flatMap((r) => r.candidates);
  const needed = dependencyIds(input.records, roots);
  return { name: 'document-study', domain: 'document', input, graph: buildDocumentContext(input),
    full: { source: input.source, records: input.records, requests: input.requests },
    dependencyComplete: { source: input.source, records: input.records.filter((r) => needed.has(r.id)), requests: input.requests },
    check(packet) {
      for (const key of needed) {
        const record = packet.payload.evidence.find((r) => r.id === `document:record:${encodeURIComponent(key)}`);
        assert.ok(record, `Required definition or qualifier ${key} missing`);
        const original = input.records.find((r) => r.id === key);
        assert.equal(record.text, original.text); assert.deepEqual(record.source.locator, original.locator);
      }
      assert.ok(!packet.text.includes('Calibration batch'));
      return { retainedRequiredRecords: needed.size, unrelatedRecordsExcluded: 120, semanticCompleteness: 'only_declared_dependencies_checked' };
    },
  };
}

export function spreadsheetFixture(count = 240, includeMargin = true) {
  const data = Array.from({ length: count }, (_, i) => ({ id: `Revenue!B${i + 2}`, value: i + 1, unit: 'USD', valueStatus: 'current' }));
  const cells = [...data, { id: 'Summary!B2', op: 'sum', deps: data.map((r) => r.id), unit: 'USD', cachedValue: -999, cacheStatus: 'stale' }];
  const requests = [{ id: 'revenue', cell: 'Summary!B2' }];
  if (includeMargin) {
    cells.push({ id: 'Costs!B2', value: 12000, unit: 'USD' }, { id: 'Summary!B3', op: 'difference', deps: ['Summary!B2', 'Costs!B2'], unit: 'USD' },
      { id: 'Summary!B4', op: 'ratio', deps: ['Summary!B3', 'Summary!B2'], unit: '1' });
    requests.push({ id: 'margin', cell: 'Summary!B4' });
    cells.push(...Array.from({ length: 100 }, (_, i) => ({ id: `Inventory!C${i + 2}`, value: 5 + i * 2, unit: 'items' })));
  }
  const input = { source: source(`workbook-${count}`), cells, requests };
  const needed = dependencyIds(cells, requests.map((r) => r.cell));
  return { name: `spreadsheet-${count}`, domain: 'spreadsheet', input, graph: buildSpreadsheetContext(input),
    full: { source: input.source, cells, requests },
    dependencyComplete: { source: input.source, cells: cells.filter((c) => needed.has(c.id)), requests },
    check(packet) {
      const results = resultObjects(packet), total = count * (count + 1) / 2;
      assert.equal(results.find((r) => r.cell === 'Summary!B2').value, total);
      if (includeMargin) assert.equal(results.find((r) => r.cell === 'Summary!B4').value, (total - 12000) / total);
      assert.ok(!packet.text.includes('-999')); assert.ok(!packet.text.includes('Inventory!'));
      assert.ok(packet.audit.computationDependencyIds.length >= needed.size);
      return { total, ...(includeMargin ? { margin: (total - 12000) / total } : {}), operandCellsValidatedLocally: needed.size };
    },
  };
}

export function geometryFixture() {
  const occurrences = Array.from({ length: 80 }, (_, i) => {
    const x = i % 10 * 25, y = Math.floor(i / 10) * 25;
    const transform = i % 2 ? [[0, -1, 0, x], [1, 0, 0, y], [0, 0, 1, 0], [0, 0, 0, 1]]
      : [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, 0], [0, 0, 0, 1]];
    return { id: `bolt:${i}`, definitionId: 'bolt-M6', placementValidity: 'valid', transform, axes: { x: [1, 0, 0], z: [0, 0, 1] } };
  });
  const queries = [{ id: 'relative-pose', op: 'relative_transform', a: 'bolt:6', b: 'bolt:35' },
    { id: 'axis-angle', op: 'axis_angle', a: 'bolt:6', b: 'bolt:35', axisA: 'x', axisB: 'x' }];
  const input = { source: source('assembly'), unit: 'mm', occurrences, queries };
  return { name: 'geometry-80-occurrences', domain: 'geometry', input, graph: buildGeometryContext(input),
    full: input, dependencyComplete: { ...input, occurrences: occurrences.filter((r) => ['bolt:6', 'bolt:35'].includes(r.id)) },
    check(packet) {
      const results = resultObjects(packet);
      assert.deepEqual(results.find((r) => r.operation === 'relative_transform').transform, [[0, -1, 0, -25], [1, 0, 0, 75], [0, 0, 1, 0], [0, 0, 0, 1]]);
      assert.equal(results.find((r) => r.operation === 'axis_angle').angle_degrees, 90);
      return { translationInA: [-25, 75, 0], directedAxisAngleDegrees: 90, retainedOccurrences: 2, totalOccurrences: 80 };
    },
  };
}

export function selectionFixture() {
  const src = source('selection');
  return { expectedRevisions: { selection: src.revision }, requirements: ['a', 'b', 'c'],
    records: [ { id: 't', text: 'alpha '.repeat(6) }, { id: 'x', text: 'beta '.repeat(10) }, { id: 'y', text: '' } ].map((r) => ({ ...r, requires: [], source: src, validity: 'valid' })),
    alternatives: [ { id: 'trap', covers: ['a', 'b'], evidence: ['t'] }, { id: 'wide', covers: ['a', 'c'], evidence: ['x'] }, { id: 'small', covers: ['b'], evidence: ['y'] } ]
      .map((r) => ({ ...r, audit: [], guarantee: 'declared_dependencies' })),
  };
}

export function fixtures() { return [documentFixture(), spreadsheetFixture(), geometryFixture()]; }
