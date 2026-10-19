import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildStepView } from '../src/dependencies/step-geometry.js';
import { buildModelPreview } from '../src/dependencies/model-preview.js';
import { renderModelPlan } from '../public/model-preview.js';
import { BRACKET, bracketPart, fixtureAssembly } from './fixtures/step-models.js';

const bytes = Buffer.from(fixtureAssembly());
const selectedLines = view => view.elements.filter(element => element.selected).flatMap(element => element.lines);

test('STEP preview highlights only the cited feature of the cited part in an isometric wireframe', async () => {
  const view = await buildStepView(bytes, { elementId: 'Bracket', featureId: 'hole:8:10' });
  assert.equal(view.kind, 'model-plan');
  assert.equal(view.format, 'step');
  assert.equal(view.view, 'Isometric view');
  assert.equal(view.units, 'mm');
  assert.equal(view.sourceHash, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(view.selected, { id: 0, guid: 'Bracket', label: 'Bracket · Ø8 hole', entityType: 'Ø8 hole' });
  // Four holes: two rim circles, one seam and two silhouette generators each.
  assert.equal(selectedLines(view).length, BRACKET.holes.filter(hole => !hole.split).length * 5);
  assert.ok(view.elements.every(element => element.guid === 'Bracket' || !element.selected), 'pins remain unselected context');
  assert.ok(view.elements.some(element => element.guid === 'Bracket' && !element.selected), 'the rest of the bracket remains visible');
  assert.ok(view.elements.every(element => element.polygons.length === 0 && element.lines.every(line => line.length >= 2)));
  const width = box => box.maxX - box.minX;
  assert.ok(width(view.focusBounds) < width(view.bounds), 'the view focuses on the selected holes');
});

test('unmeasured datum-target surfaces remain visible in the preview', async () => {
  const plain = await buildStepView(Buffer.from(bracketPart()));
  const view = await buildStepView(Buffer.from(bracketPart({ targets: true })));
  const lineCount = preview => preview.elements.reduce((total, element) => total + element.lines.length, 0);
  // The bore patch adds two arcs and two sides; the raised area four sides.
  assert.equal(lineCount(view), lineCount(plain) + 8);
});

test('isometric projection keeps model Z vertical on screen', async () => {
  const view = await buildStepView(bytes, { elementId: 'Bracket', featureId: 'edge:10' });
  // Bracket's vertical outline edges are 10 mm long and parallel to Z.
  const vertical = selectedLines(view).filter(line => line.length === 2);
  assert.equal(vertical.length, 6);
  // Preview coordinates are rounded to six significant digits of the model size.
  for (const [[x0, y0], [x1, y1]] of vertical) {
    assert.ok(Math.abs(x0 - x1) < 1e-3, 'a Z edge has no horizontal screen component');
    assert.ok(Math.abs(Math.abs(y1 - y0) - 10 * 2 / Math.sqrt(6)) < 1e-3, 'Z is foreshortened by the isometric factor');
  }
});

test('extents select the whole part, assembly facts select every component, and unknown identities are refused', async () => {
  const pin = await buildStepView(bytes, { elementId: 'Pin', featureId: 'extent:X' });
  assert.equal(pin.selected.entityType, 'Overall X extent');
  assert.equal(pin.elements.filter(element => element.selected).length, 2, 'both pin instances are highlighted');
  assert.ok(pin.elements.some(element => element.guid === 'Bracket' && !element.selected));
  const assembly = await buildStepView(bytes, { elementId: '@assembly', featureId: 'extent:X' });
  assert.ok(assembly.elements.every(element => element.selected));
  assert.equal(assembly.selected.label, 'Fixture');
  const overview = await buildStepView(bytes);
  assert.equal(overview.selected, null);
  assert.ok(overview.elements.every(element => !element.selected));
  await assert.rejects(buildStepView(bytes, { elementId: 'Shaft' }), /cited part is not present/);
  await assert.rejects(buildStepView(bytes, { elementId: 'Bracket', featureId: 'hole:9:10' }), /cited feature is not present/);
});

test('model previews route STEP anchors by part and feature without falling back to another element', async () => {
  const file = { path: 'CAD/fixture.stp', content: bytes };
  const preview = await buildModelPreview(file, {
    label: 'Bracket R5 90° arc radius', valueText: '5 mm',
    anchor: { kind: 'cad-property', elementId: 'Bracket', featureId: 'arc:5:90', propertyName: 'Radius' },
  });
  assert.equal(preview.kind, 'model-plan');
  assert.equal(preview.selected.label, 'Bracket · R5 90° arc');
  assert.equal(selectedLines(preview).length, 4);
  assert.equal(preview.propertyName, 'Radius');
  const missing = await buildModelPreview(file, { anchor: { kind: 'cad-property', elementId: 'Bracket', featureId: 'arc:7:90' } });
  assert.equal(missing.kind, 'model-unavailable');
  const anonymous = await buildModelPreview(file, { anchor: { kind: 'cad-property' } });
  assert.equal(anonymous.kind, 'model-unavailable');

  const html = renderModelPlan(preview);
  assert.match(html, /Bracket · R5 90° arc/);
  assert.match(html, /R5 90° arc · Isometric view/);
  assert.match(html, /class="model-plan-element line context selected" data-model-element="Bracket" d="M[^"]+"/);
  assert.doesNotMatch(html, /fill-rule="evenodd"/, 'wireframes contain no filled polygon paths');
  assert.match(html, /Source model geometry · mm/);
});
