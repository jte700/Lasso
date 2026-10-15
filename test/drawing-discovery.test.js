import test from 'node:test';
import assert from 'node:assert/strict';
import { drawingDiscovery, drawingReferenceMatch } from '../src/dependencies/drawing-discovery.js';

const legacy = { id: 'drawing-id', objectType: 'DRAWING', label: '0001', path: 'Duplex_A_20110907.ifc',
  anchor: { kind: 'cad-model' }, metadata: { format: 'IFC', title: '0001', annotationCount: 2843,
    extraction: 'ifc-properties', extractionStatus: 'ready', textExcerpt: 'IFC2X3 · 23145 entities · 2843 measurements' } };

test('old immutable IFC model rows gain useful file and model discovery names', () => {
  const before = structuredClone(legacy);
  const discovery = drawingDiscovery(legacy);
  assert.equal(discovery.label, 'Duplex A 20110907');
  assert.ok(discovery.aliases.includes('floor plan'));
  assert.ok(discovery.searchText.includes('Duplex_A_20110907.ifc'));
  for (const query of ['duplex', 'dupl', 'Duplex_A_20110907.ifc', 'floor plan', 'floor pl', 'floor pla', 'floorplan',
    'floorpl', 'architectural drawing', 'building model', 'BIM model', 'duplex floor plan', 'floor plan duplex']) {
    const match = drawingReferenceMatch(legacy, query);
    assert.ok(match, query);
    assert.equal(match.label, discovery.label);
    assert.ok(match.score >= .89 && match.score <= 1);
  }
  assert.deepEqual(legacy, before, 'discovery must not rewrite immutable source metadata');
});

test('whole-model discovery rejects unrelated prose, substring collisions, and element-property queries', () => {
  for (const query of ['', 'du', 'duplexer', 'floor', 'plan', 'model', 'building', 'floor plan for trip',
    'retirement plan', 'floor 2.5', 'financial plan', 'our floor plan is ready', 'Living Room A102 Area',
    'duplex room area', 'duplex area', 'floor building', 'A102']) {
    assert.equal(drawingReferenceMatch(legacy, query), null, query);
  }
  assert.equal(drawingDiscovery({ ...legacy, objectType: 'DRAWING_ANNOTATION' }), null);
  assert.equal(drawingReferenceMatch({ ...legacy, objectType: 'DATASET' }, 'floor plan'), null);
});

test('building aliases require parsed IFC evidence and never invent an authored sheet title', () => {
  for (const object of [
    { ...legacy, metadata: { format: 'IFC' } },
    { ...legacy, metadata: { ...legacy.metadata, extractionStatus: 'unsupported' } },
    { ...legacy, metadata: { ...legacy.metadata, format: 'DXF' } },
  ]) assert.equal(drawingReferenceMatch(object, 'floor plan'), null);
  const summaryOnly = { ...legacy, metadata: { ...legacy.metadata, annotationCount: 0 } };
  assert.ok(drawingReferenceMatch(summaryOnly, 'building model'));
  const roomEvidence = { ...legacy, metadata: { format: 'IFC', textExcerpt: '#2=IFCSPACE(...)' } };
  assert.ok(drawingReferenceMatch(roomEvidence, 'floor plan'));
  assert.equal(drawingDiscovery({ ...legacy, label: 'West Wing', metadata: { ...legacy.metadata, title: 'West Wing' } }).label, 'Duplex A 20110907 · West Wing');
  const titled = { ...legacy, label: 'Room model', metadata: { ...legacy.metadata, title: 'Room model' } };
  assert.notEqual(drawingDiscovery(titled).label, drawingDiscovery({ ...titled, path: 'Other_Building.ifc' }).label);
  assert.equal(drawingDiscovery({ ...legacy, label: 'Duplex A 20110907' }).label, 'Duplex A 20110907');
  assert.ok(!drawingDiscovery(legacy).label.toLowerCase().includes('floor plan'));
});

test('CAD and civil aliases remain specific to their indexed formats', () => {
  const dxf = { ...legacy, path: 'Site_Boundary.dxf', metadata: { format: 'DXF', extractionStatus: 'ready' } };
  const civil = { ...legacy, path: 'Main_Road.landxml', metadata: { format: 'LandXML', extractionStatus: 'ready' } };
  assert.ok(drawingReferenceMatch(dxf, 'CAD plan'));
  assert.equal(drawingReferenceMatch(dxf, 'BIM model'), null);
  assert.ok(drawingReferenceMatch(civil, 'civil engineering plan'));
  assert.ok(drawingReferenceMatch(civil, 'main road'));
  assert.equal(drawingReferenceMatch(civil, 'architectural drawing'), null);
  assert.equal(drawingReferenceMatch(civil, 'civil engineering plan for travel'), null);
});
