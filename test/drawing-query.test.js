import test from 'node:test';
import assert from 'node:assert/strict';
import { askCommand } from '../src/terminal/commands/ask.js';
import { parseDrawingQuestion } from '../src/terminal/drawing-queries.js';
import { canonicalAddress, dependencyName, sourceLocator } from '../src/terminal/names.js';

function fact(overrides = {}) {
  const base = {
    id: 'obj-101', objectKey: 'drawing:office101', objectType: 'DRAWING_ANNOTATION',
    label: 'Office 101 area', valueText: '120 sq ft', path: 'Architecture/plans.pdf',
    anchor: { kind: 'drawing-annotation', pageNumber: 2, sheetNumber: 'A101', identifier: 'office-101-area', label: 'Office 101 area' },
    metadata: { drawing: true, kind: 'room_area', numericValue: 120, units: 'sq ft', measurementBasis: 'explicit', rawText: 'OFFICE 101 120 SF' },
  };
  const object = { ...base, ...overrides, anchor: { ...base.anchor, ...overrides.anchor }, metadata: { ...base.metadata, ...overrides.metadata } };
  return { ...object, name: dependencyName(object), locator: sourceLocator(object) };
}
function context(objects, overrides = {}) {
  return { projectId: 'test', graph: { namedObjects: () => objects, resolve: () => ({ status: 'NOT_FOUND' }), search: () => [], ...overrides } };
}
const ask = (objects, question, overrides) => askCommand(context(objects, overrides), { rest: question });

test('drawing queries recognize area wording and preserve full room identifiers', () => {
  const objects = [fact(), fact({ id: 'obj-1010', objectKey: 'drawing:office1010', label: 'Office 1010 area', anchor: { identifier: 'office-1010-area', label: 'Office 1010 area' } })];
  for (const question of [
    'What is the square footage of Office 101?', 'What is the square feet of room 101?',
    'What is the ft² of Office 101?', 'What is the sq. ft. of Office 101?',
    'How many square feet is Office 101?', 'How many square feet does Office 101 have?',
    "What is Office 101's area?", 'What is the area of room 101?', 'What is Office 101 area?',
  ]) {
    const response = ask(objects, question);
    assert.equal(response.data.answered, true, question);
    assert.equal(response.data.object, 'drawing:office101', question);
    assert.match(response.headline, /120 sq ft/);
    assert.match(response.data.locator, /sheet A101 · page 2/);
  }
});

test('drawing answers refuse missing, unknown, nonnumeric, and unverified measurements', () => {
  for (const objects of [[], [fact()], [fact({ metadata: { measurementBasis: 'estimated' } })],
    [fact({ metadata: { numericValue: null } })], [fact({ metadata: { numericValue: NaN } })],
    [fact({ metadata: { units: null } })], [fact({ valueText: null })]]) {
    const question = objects.length && objects[0].metadata.measurementBasis === 'explicit' && objects[0].valueText && objects[0].metadata.units && Number.isFinite(objects[0].metadata.numericValue)
      ? 'What is the area of Office 201?' : 'What is the area of Office 101?';
    const response = ask(objects, question);
    assert.equal(response.data.answered, false);
    assert.equal(response.data.reason, 'NO_EXPLICIT_DRAWING_VALUE');
  }
});

test('duplicate room measurements return every source and accept explicit sheet, page, and file scopes', () => {
  const objects = [fact(), fact({ id: 'second', objectKey: 'second', path: 'Architecture/other.pdf', valueText: '140 sq ft', anchor: { sheetNumber: 'A201', pageNumber: 3 }, metadata: { numericValue: 140 } })];
  const ambiguous = ask(objects, 'What is the area of Office 101?');
  assert.equal(ambiguous.data.answered, false);
  assert.equal(ambiguous.data.reason, 'AMBIGUOUS_DRAWING_VALUE');
  assert.equal(ambiguous.results.length, 2);
  for (const qualifier of ['on sheet A201', 'on page 3', 'in other.pdf', 'on page 3 in other.pdf']) {
    const response = ask(objects, `What is the area of Office 101 ${qualifier}?`);
    assert.equal(response.data.answered, true, qualifier);
    assert.equal(response.data.object, 'second');
  }
});

test('civil drawing metrics remain distinct and do not guess a length from a slope', () => {
  const objects = [fact({ label: 'Storm pipe P1 slope', valueText: '2 %', metadata: { kind: 'slope', units: '%', numericValue: 2 } })];
  assert.equal(ask(objects, 'What is the slope of storm pipe P1?').data.value, '2 %');
  assert.equal(ask(objects, 'What is the length of storm pipe P1?').data.answered, false);
  assert.equal(ask(objects, 'What is the slope of storm pipe P10?').data.answered, false);
  assert.equal(parseDrawingQuestion('How long is pipe P1?').kind, 'length');
});

test('model properties cite element and property, distinguish net/gross, and convert requested area units', () => {
  const model = fact({ path: 'Model.ifc', label: 'Office 101 NetFloorArea', valueText: '12 m²',
    anchor: { kind: 'cad-property', elementId: '#101', propertyName: 'NetFloorArea' },
    metadata: { kind: 'area', numericValue: 12, units: 'm²', measurementBasis: 'model-property', propertyName: 'NetFloorArea' } });
  const gross = fact({ objectKey: 'gross', path: 'Model.ifc', label: 'Office 101 GrossFloorArea', valueText: '14 m²',
    anchor: { kind: 'cad-property', elementId: '#101', propertyName: 'GrossFloorArea' },
    metadata: { kind: 'area', numericValue: 14, units: 'm²', measurementBasis: 'model-property', propertyName: 'GrossFloorArea' } });
  assert.equal(ask([model, gross], 'What is the area of Office 101?').data.reason, 'AMBIGUOUS_DRAWING_VALUE');
  const selected = ask([model, gross], 'What is the net floor area of Office 101 in Model.ifc?');
  assert.equal(selected.data.answered, true);
  assert.equal(selected.data.value, '12 m²');
  assert.equal(selected.data.locator, 'element #101 · property NetFloorArea');
  const sqft = ask([model], 'What is the square footage of Office 101?');
  assert.equal(sqft.data.answered, true);
  assert.equal(sqft.data.units, 'ft²');
  assert.ok(Math.abs(sqft.data.numericValue - 129.166925) < 0.000001);
  assert.equal(sqft.data.conversion.sourceValue, '12 m²');
  assert.match(sqft.blocks.map((block) => block.text).join(' '), /1 ft = 0.3048 m/);
  assert.equal(ask([fact({ metadata: { units: 'unknown' } })], 'What is the square footage of Office 101?').data.reason, 'UNSUPPORTED_DRAWING_UNITS');
});

test('geometry is clearly distinguished from model properties', () => {
  const response = ask([fact({ metadata: { measurementBasis: 'geometry' } })], 'What is the area of Office 101?');
  assert.equal(response.data.measurementBasis, 'geometry');
  assert.match(response.blocks[0].text, /Measured CAD geometry/);
});

test('exact drawing names and source addresses retain sheet, page, and annotation', () => {
  const object = fact();
  assert.equal(dependencyName(object), 'office-101-area');
  assert.equal(sourceLocator(object), 'sheet A101 · page 2 · office-101-area');
  assert.equal(canonicalAddress(object), 'Architecture/plans.pdf:sheet A101 · page 2 · office-101-area');
  assert.equal(dependencyName({ anchor: { kind: 'drawing-sheet', sheetNumber: 'C-101' } }), 'sheet-c-101');
});

test('existing ask value queries retain their behavior, and unsupported drawing metrics never use fuzzy facts', () => {
  const financial = { objectKey: 'revenue', name: 'revenue', valueText: '400', path: 'income.csv' };
  const response = ask([], 'What is revenue?', { resolve: () => ({ status: 'RESOLVED', object: financial }), trace: () => ({ path: 'income.csv', locator: 'row 2', updatedAt: null }) });
  assert.equal(response.headline, 'revenue: 400');
  const unsupported = ask([fact()], 'What is the volume of Office 101?', { search: () => [{ object: fact(), score: 1 }] });
  assert.equal(unsupported.data.answered, false);
  assert.match(unsupported.data.reason, /supported drawing measurement/);
});


test('IFC net floor area and net square footage exclude wall, ceiling, BOMA, and planned properties', () => {
  const modelFact = (propertyName, value, kind = 'room_area') => fact({
    objectKey: propertyName, path: 'office.ifc', label: `Office 101 ${propertyName}`, valueText: `${value} m²`,
    anchor: { kind: 'cad-property', elementId: '#101', propertyName },
    metadata: { entityType: 'IFCSPACE', kind, numericValue: value, units: 'm²', measurementBasis: 'model-property', propertyName },
  });
  const objects = [modelFact('NetFloorArea', 12), modelFact('GrossFloorArea', 14),
    modelFact('NetWallArea', 100, 'area'), modelFact('NetCeilingArea', 101, 'area'),
    modelFact('BOMA Net Area', 99, 'area'), modelFact('NetPlannedArea', 15)];
  for (const question of ['What is the net floor area of Office 101?', 'What is the net area of Office 101?', 'What is the net square footage of Office 101?']) {
    const response = ask(objects, question);
    assert.equal(response.data.answered, true, question);
    assert.equal(response.data.object, 'NetFloorArea', question);
  }
  const converted = ask(objects, 'What is the net square footage of Office 101?');
  assert.equal(converted.data.units, 'ft²');
  const generic = ask(objects, 'What is the area of Office 101?');
  assert.equal(generic.data.reason, 'AMBIGUOUS_DRAWING_VALUE');
  assert.deepEqual(generic.data.candidates, ['NetFloorArea', 'GrossFloorArea', 'NetPlannedArea']);
  assert.equal(ask([modelFact('NetWallArea', 100, 'area')], 'What is the square footage of Office 101?').data.answered, false);
});


test('drawing vocabulary preserves existing named area and length facts outside drawings', () => {
  for (const [name, question] of [['campaign-length', 'What is campaign length?'], ['marketing-area', 'What is the marketing area?']]) {
    const business = { objectKey: name, name, label: name, valueText: '400', path: 'income.csv', anchor: { kind: 'table-cell' } };
    for (const objects of [[business], [business, fact()]]) {
      const response = ask(objects, question, {
        resolve: () => ({ status: 'RESOLVED', object: business }),
        trace: () => ({ path: 'income.csv', locator: 'row 2', updatedAt: null }),
      });
      assert.equal(response.data.answered, true);
      assert.equal(response.headline, `${name}: 400`);
    }
  }
});


test('perimeter query vocabulary remains separate from length measurements', () => {
  const perimeter = fact({ label: 'Office 101 perimeter', valueText: '44 ft', metadata: { kind: 'perimeter', numericValue: 44, units: 'ft', measurementBasis: 'geometry' } });
  assert.equal(ask([perimeter], 'What is the boundary perimeter of Office 101?').data.value, '44 ft');
  assert.equal(ask([perimeter], 'What is Office 101 perimeter?').data.value, '44 ft');
  assert.equal(ask([perimeter], 'What is the length of Office 101?').data.answered, false);
});
