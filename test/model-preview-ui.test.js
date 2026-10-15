import test from 'node:test';
import assert from 'node:assert/strict';
import { renderModelPlan, modelPlanViewBox, bindModelPlans } from '../public/model-preview.js';
import { renderInspectorPanel, renderSharePage } from '../src/sharing/share-page.js';

const bounds = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
const preview = {
  kind: 'model-plan', units: 'm', bounds,
  focusBounds: { minX: 11, minY: 21, maxX: 12, maxY: 23 },
  selected: { id: 44, guid: 'door-guid', label: 'D105 Door', entityType: 'IFCDOOR' },
  storey: { label: 'Ground floor' },
  elements: [
    { id: 44, guid: 'door-guid', label: 'D105 Door', entityType: 'IFCDOOR', role: 'context', selected: true,
      polygons: [[[11, 21], [12, 21], [12, 23], [11, 23]]] },
    { id: 20, guid: 'wall-guid', label: 'Wall', entityType: 'IFCWALL', role: 'context', selected: false,
      polygons: [[[10, 20], [30, 20], [30, 40], [10, 40]], [[11, 21], [29, 21], [29, 39], [11, 39]]] },
  ],
};

test('plan preview focuses any indexed element and draws its surrounding model with holes', () => {
  const html = renderModelPlan(preview);
  assert.match(html, /aria-label="Selected element: D105 Door"/);
  assert.match(html, /Ground floor · IFCDOOR · Plan view/);
  assert.match(html, /class="model-plan-element context selected" data-model-element="door-guid"/);
  assert.ok(html.indexOf('data-model-element="wall-guid"') < html.indexOf('data-model-element="door-guid"'), 'selected geometry must draw above context');
  assert.match(html, /d="M10,20L30,20L30,40L10,40ZM11,21L29,21L29,39L11,39Z" fill-rule="evenodd"/);
  assert.match(html, /transform="scale\(1,-1\)"/);
  assert.match(html, /data-model-action="selection"/);
  assert.match(html, /data-model-action="context"/);
  const [x, y, width, height] = modelPlanViewBox(preview.focusBounds, true);
  assert.ok(x < 11 && x + width > 12);
  assert.ok(y < -23 && y + height > -21, 'view box contains the flipped IFC Y coordinates');
});

test('missing or malformed element geometry never produces a blank drawing or a false selected highlight', () => {
  const html = renderModelPlan({ ...preview, elements: [{ ...preview.elements[0], polygons: [[[NaN, 1], [1, 2], [2, 3]]] }] });
  assert.match(html, /No displayable geometry was found/);
  assert.doesNotMatch(html, /<svg/);
  const context = renderModelPlan({ ...preview, elements: [preview.elements[1]] });
  assert.match(context, /This indexed element has no displayable geometry/);
  assert.doesNotMatch(context, /data-model-action="selection"/);
});

test('element labels and IDs are escaped when design metadata is rendered', () => {
  const html = renderModelPlan({ ...preview, selected: { label: '<img src=x onerror=alert(1)>' },
    elements: [{ ...preview.elements[0], guid: '" onmouseover="alert(1)', label: '</title><script>alert(1)</script>' }] });
  assert.doesNotMatch(html, /<img|<script>|" onmouseover="/);
  assert.match(html, /&lt;img/);
});

test('zoom and context controls change the same preserved plan and restore the selected extent', () => {
  const handlers = new Map();
  const actions = ['zoom-in', 'zoom-out', 'selection', 'context'].map(action => ({
    dataset: { modelAction: action }, addEventListener: (_, handler) => handlers.set(action, handler),
  }));
  let viewBox = modelPlanViewBox(preview.focusBounds, true).join(' ');
  const svg = { dataset: {}, getAttribute: () => viewBox, setAttribute: (_, value) => { viewBox = value; },
    addEventListener: (event, handler) => handlers.set(event, handler) };
  const plan = { dataset: { modelFocus: viewBox, modelContext: modelPlanViewBox(bounds).join(' ') },
    querySelector: () => svg, querySelectorAll: () => actions };
  bindModelPlans({ querySelectorAll: () => [plan] });
  const initial = viewBox;
  handlers.get('zoom-in')({ stopPropagation() {} });
  assert.ok(Number(viewBox.split(' ')[2]) < Number(initial.split(' ')[2]));
  handlers.get('context')({ stopPropagation() {} });
  assert.equal(viewBox, plan.dataset.modelContext);
  handlers.get('selection')({ stopPropagation() {} });
  assert.equal(viewBox, initial);
  handlers.get('keydown')({ key: 'ArrowRight', preventDefault() {}, stopPropagation() {} });
  assert.ok(Number(viewBox.split(' ')[0]) > Number(initial.split(' ')[0]));
});

test('local inspector shows focused geometry without exposing that context in indexed or redacted public shares', () => {
  const source = { filename: 'building.ifc', label: 'D105 Door', valueText: '1 m', location: 'D105 · Width',
    context: 'Width', snapshotVersion: 1 };
  const local = renderInspectorPanel({ source }, 'reference', preview);
  assert.match(local, /data-model-element="door-guid"/);
  assert.match(local, /data-model-element="wall-guid"/);
  assert.doesNotMatch(local, /data-model-action/);
  for (const accessScope of ['INDEXED', 'REDACTED']) {
    const shared = renderSharePage({ source, share: { accessScope, redactions: [] } }, 'token', preview, preview);
    assert.doesNotMatch(shared, /data-model-element|wall-guid|door-guid/);
  }
});
