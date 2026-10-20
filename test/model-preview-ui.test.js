import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_PLAN_STYLE, renderModelPlan, modelPlanViewBox, bindModelPlans } from '../public/model-preview.js';
import { ISOMETRIC_CAMERA, cameraAxes, projectWireframe } from '../public/model-orbit.js';
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
    querySelector: selector => selector.startsWith('svg') ? svg : null,
    querySelectorAll: selector => selector === '[data-model-action]' ? actions : [] };
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
  assert.match(local, /data-model-action="zoom-in"/, 'the inspector can zoom its drawing');
  assert.match(local, /import \{ bindModelPlans \} from '\/model-preview\.js\?v=3'/);
  for (const accessScope of ['INDEXED', 'REDACTED']) {
    const shared = renderSharePage({ source, share: { accessScope, redactions: [] } }, 'token', preview, preview);
    assert.doesNotMatch(shared, /data-model-element|wall-guid|door-guid/);
  }
});

test('DXF drafting is drawn above measured room highlights, with upright source text and open curves', () => {
  const html = renderModelPlan({ ...preview, format: 'dxf', drawing: [
    { id: 'D1/A', type: 'path', layer: 'DOORS', points: [[0, 0], [1, 0], [.7, .7], [0, 1]], closed: false, lineweight: 25 },
    { id: 'T1', type: 'text', layer: 'LABELS', point: [5, 6], text: 'Kitchen\n01', height: .2, rotation: 90, align: 'middle', verticalAlign: 'top', widthScale: .8 },
  ] });
  assert.ok(html.indexOf('data-model-element="door-guid"') < html.indexOf('data-drawing-entity="D1/A"'), 'draft details remain visible above the room fill');
  assert.match(html, /d="M0,0L1,0L0.7,0.7L0,1"/);
  assert.match(html, /transform="translate\(5 6\) rotate\(90\) scale\(0.8 -1\)"/);
  assert.match(html, /font-size="0.2" text-anchor="middle" dominant-baseline="text-before-edge"/);
  assert.match(html, /<tspan x="0" dy="0">Kitchen<\/tspan>/);
  assert.match(html, /Source drawing geometry/);
});

test('line-only DXF drawings have usable view controls and escape all drafting text and identities', () => {
  const html = renderModelPlan({ ...preview, selected: null, elements: [], format: 'dxf', fileName: 'Office.dxf', drawing: [
    { id: 'L1', type: 'path', layer: 'WALLS', points: [[0, 0], [5, 0]], closed: false },
    { id: '" onload="oops', type: 'text', layer: '<script>', point: [1, 1], text: '</text><script>alert(1)</script>', height: 1, rotation: 0 },
    { id: 'invalid', type: 'path', points: [[0, NaN], [1, 1]] },
    { id: 'bad-text', type: 'text', point: [0, 0], text: 'Bad', height: Infinity },
  ] });
  assert.match(html, /<svg/);
  assert.match(html, /data-model-action="zoom-in"/);
  assert.match(html, /data-model-action="context"/);
  assert.doesNotMatch(html, /data-model-action="selection"|data-model-element|data-drawing-entity="invalid"|bad-text|<script>|" onload="/);
  assert.match(html, /&lt;\/text&gt;&lt;script&gt;/);
  for (const accessScope of ['INDEXED', 'REDACTED']) {
    const shared = renderSharePage({ source: { filename: 'office.dxf' }, share: { accessScope, redactions: [] } }, 'token', { ...preview, drawing: [{ id: 'secret-drawing', type: 'path', points: [[0, 0], [1, 1]] }] });
    assert.doesNotMatch(shared, /secret-drawing|data-drawing-entity/);
  }
});

// A 10 mm cube with a vertical Ø4 bore, cited, and one context edge.
const cube = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
const cubeEdges = [...cube.map((point, index) => [point, cube[(index + 1) % 4]]),
  ...cube.map((point, index) => [point.with(2, 10), cube[(index + 1) % 4].with(2, 10)]), ...cube.map(point => [point, point.with(2, 10)])];
const bore = { center: [5, 5, 0], axis: [0, 0, 1], xdir: [1, 0, 0], ydir: [0, 1, 0], radius: 2, h0: 0, h1: 10 };
const isometric = cameraAxes(ISOMETRIC_CAMERA);
const wireElement = (guid, selected, edges, cylinders) => ({ id: guid, guid, label: guid, entityType: 'PART', role: 'context', selected,
  polygons: [], edges, cylinders, lines: projectWireframe({ edges, cylinders }, isometric) });
const solid = {
  kind: 'model-plan', format: 'step', units: 'mm', view: 'Isometric view', projection: 'isometric',
  bounds: { minX: -8, minY: -9, maxX: 8, maxY: 9 }, focusBounds: { minX: -3, minY: -3, maxX: 3, maxY: 4 },
  selected: { guid: 'Block', label: 'Block · Ø4 hole', entityType: 'Ø4 hole' },
  orbit: { ...ISOMETRIC_CAMERA, pivot: [5, 5, 5] },
  elements: [wireElement('Block', false, cubeEdges, []), wireElement('Block', true, [], [bore])],
};

/** The rendered plan, bound to a minimal DOM built from its own markup. */
function boundPlan(html) {
  const handlers = new Map(), attributes = new Map();
  const json = html.match(/<script type="application\/json" data-model-orbit>([^<]*)<\/script>/)?.[1];
  const read = (name, source = html) => source.match(new RegExp(`${name}="([^"]*)"`))[1];
  attributes.set('viewBox', read('viewBox'));
  const paths = [...html.matchAll(/data-model-wire="(\d+)" d="([^"]*)"/g)].map(([, index, d]) => ({
    dataset: { modelWire: index }, d, setAttribute(name, value) { if (name === 'd') this.d = value; } }));
  const label = { textContent: html.match(/<span data-model-view>([^<]*)<\/span>/)?.[1] };
  const actions = [...html.matchAll(/data-model-action="([^"]+)"/g)].map(([, action]) => ({
    dataset: { modelAction: action }, addEventListener: (_, handler) => handlers.set(action, handler) }));
  const svg = { dataset: {}, getAttribute: name => attributes.get(name), setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (event, handler) => handlers.set(event, handler), setPointerCapture() {} };
  const plan = { dataset: { modelFocus: read('data-model-focus'), modelContext: read('data-model-context') },
    querySelector: selector => selector.startsWith('svg') ? svg : selector.startsWith('script') ? (json ? { textContent: json } : null)
      : selector === '[data-model-view]' ? label : null,
    querySelectorAll: selector => selector === '[data-model-action]' ? actions : selector === '[data-model-wire]' ? paths : [] };
  bindModelPlans({ querySelectorAll: () => [plan] });
  const fire = (name, event = {}) => handlers.get(name)({ preventDefault() {}, stopPropagation() {}, ...event });
  const box = () => attributes.get('viewBox').split(' ').map(Number);
  return { fire, box, paths, label, plan, svg };
}
const numbers = d => d.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g).map(Number);
const close = (a, b, tolerance = 1e-6) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) < tolerance);

test('dragging a STEP wireframe rotates it about the cited feature and Isometric restores the view', () => {
  const html = renderModelPlan(solid);
  assert.match(html, /data-model-action="isometric">Isometric</);
  assert.match(html, /Drag to rotate · Shift-drag to pan · Pinch or \+ \/ − to zoom/);
  const view = boundPlan(html);
  const [initialBox, initialPaths] = [view.box(), view.paths.map(path => path.d)];
  view.fire('pointerdown', { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  view.fire('pointermove', { pointerId: 1, clientX: 190, clientY: 130 });
  assert.notEqual(view.paths[0].d, initialPaths[0], 'the context edges are redrawn from 3D');
  assert.notEqual(view.paths[1].d, initialPaths[1], 'the bore silhouettes follow the camera');
  assert.equal(view.label.textContent, 'Rotated view');
  assert.deepEqual(view.box().slice(2), initialBox.slice(2), 'rotating does not zoom');
  view.fire('pointermove', { pointerId: 1, clientX: 100, clientY: 100 });
  assert.ok(close(view.box(), initialBox), 'turning back restores the framing');
  assert.ok(close(numbers(view.paths[0].d), numbers(initialPaths[0]), 1e-3), 'and the drawing');
  assert.equal(view.label.textContent, 'Isometric view');
  view.fire('pointermove', { pointerId: 1, clientX: 40, clientY: 10 });
  view.fire('pointerup', { pointerId: 1 });
  view.fire('pointermove', { pointerId: 1, clientX: 300, clientY: 300 });
  const rotated = view.paths[0].d;
  assert.notEqual(rotated, initialPaths[0]);
  view.fire('keydown', { key: 'ArrowLeft' });
  assert.notEqual(view.paths[0].d, rotated, 'arrow keys rotate a 3D view');
  view.fire('isometric', { stopPropagation() {} });
  assert.deepEqual(view.box(), initialBox);
  assert.ok(close(numbers(view.paths[0].d), numbers(initialPaths[0]), 1e-3));
  assert.equal(view.label.textContent, 'Isometric view');
});

test('dragging the drawing never selects it, and still gives it keyboard focus', () => {
  assert.match(MODEL_PLAN_STYLE, /\.model-plan-svg\[data-interactive\]\{[^}]*-webkit-user-select:none;user-select:none/);
  const view = boundPlan(renderModelPlan(solid));
  let prevented = false, focused = null;
  view.svg.focus = options => { focused = options; };
  view.fire('pointerdown', { button: 0, pointerId: 3, clientX: 0, clientY: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented, 'WebKit would otherwise start a text selection over the drawing');
  assert.deepEqual(focused, { preventScroll: true }, 'arrow keys keep working after a drag');
});

test('shift-dragging a 3D view pans instead of rotating', () => {
  const view = boundPlan(renderModelPlan(solid));
  const initial = view.paths[0].d;
  view.fire('keydown', { key: 'ArrowRight', shiftKey: true });
  assert.equal(view.paths[0].d, initial, 'no rotation');
  assert.ok(view.box()[0] > Number(view.plan.dataset.modelFocus.split(' ')[0]), 'the view moved');
});

test('Isometric and the fit buttons orbit around the cited feature again after a pan in a tilted view', () => {
  const drag = (view, dx, dy) => {
    view.fire('pointerdown', { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    view.fire('pointermove', { pointerId: 2, clientX: dx, clientY: dy });
    view.fire('pointerup', { pointerId: 2 });
  };
  const fresh = boundPlan(renderModelPlan(solid));
  drag(fresh, 120, 0);
  const panned = boundPlan(renderModelPlan(solid));
  drag(panned, 0, 80);
  for (let step = 0; step < 8; step++) panned.fire('keydown', { key: 'ArrowUp', shiftKey: true });
  panned.fire('isometric', { stopPropagation() {} });
  drag(panned, 120, 0);
  assert.ok(close(panned.box(), fresh.box()), 'the turn after Isometric matches a fresh one');
  for (const action of ['selection', 'context']) {
    const view = boundPlan(renderModelPlan(solid));
    drag(view, 0, 80);
    for (let step = 0; step < 8; step++) view.fire('keydown', { key: 'ArrowUp', shiftKey: true });
    drag(view, 0, -80);
    view.fire(action, { stopPropagation() {} });
    view.fire(action === 'selection' ? 'isometric' : 'selection', { stopPropagation() {} });
    drag(view, 120, 0);
    assert.ok(close(view.box(), fresh.box()), `${action} re-centres the orbit on the cited feature`);
  }
});

test('zoom stops at a tenth of the selection and at twice the whole model', () => {
  const view = boundPlan(renderModelPlan(solid));
  const size = box => Math.max(box[2], box[3]);
  const focus = size(view.plan.dataset.modelFocus.split(' ').map(Number));
  const context = size(view.plan.dataset.modelContext.split(' ').map(Number));
  for (let step = 0; step < 40; step++) view.fire('zoom-in', { stopPropagation() {} });
  assert.ok(Math.abs(size(view.box()) - Math.min(focus, context) / 10) < 1e-9, 'zoom in stops');
  for (let step = 0; step < 60; step++) view.fire('zoom-out', { stopPropagation() {} });
  assert.ok(Math.abs(size(view.box()) - Math.max(focus, context) * 2) < 1e-9, 'zoom out stops');
});

test('pinching zooms the drawing, while plain scrolling is left to the page', () => {
  const view = boundPlan(renderModelPlan(solid));
  const initial = view.box();
  let prevented = false;
  view.fire('wheel', { deltaY: 40, ctrlKey: false, preventDefault() { prevented = true; } });
  assert.deepEqual(view.box(), initial);
  assert.equal(prevented, false, 'the page still scrolls');
  view.fire('wheel', { deltaY: -40, ctrlKey: true });
  assert.ok(view.box()[2] < initial[2], 'a trackpad pinch (ctrl + wheel) zooms in');
  const pinched = view.box();
  view.fire('gesturestart', { scale: 1 });
  view.fire('gesturechange', { scale: .5 });
  view.fire('wheel', { deltaY: 40, ctrlKey: true });
  view.fire('gestureend', { scale: .5 });
  assert.ok(Math.abs(view.box()[2] - pinched[2] * 2) < 1e-9, 'a Safari pinch-out zooms out once, not twice');
});

test('3D wireframe data reaches only interactive local views, never shared drawings', () => {
  assert.doesNotMatch(renderModelPlan(solid, { interactive: false }), /data-model-orbit|data-model-wire|Rotated/);
  assert.doesNotMatch(renderModelPlan({ ...solid, orbit: undefined }), /data-model-orbit|data-model-action="isometric"/, 'no orbit without a camera');
  assert.match(renderModelPlan({ ...solid, orbit: undefined }), /Drag to pan · Pinch or \+ \/ − to zoom/);
  const source = { filename: 'block.step', label: 'Block', snapshotVersion: 1 };
  const shared = renderSharePage({ source, share: { accessScope: 'DOCUMENT', redactions: [] } }, 'token', solid, solid);
  assert.doesNotMatch(shared, /data-model-orbit|"edges"|"cylinders"/);
  const html = renderModelPlan(solid);
  const json = html.match(/<script type="application\/json" data-model-orbit>([^<]*)<\/script>/)[1];
  assert.deepEqual(JSON.parse(json).pivot, [5, 5, 5]);
});
