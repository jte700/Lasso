// Plan and isometric geometry comes from the preserved design model. This renderer
// deliberately has no knowledge of room names or property types: selection uses
// element IDs. Elements carry filled polygons (IFC plans) and/or open polylines
// (CAD wireframes). Wireframes that also carry 3D edges can be rotated.
import { cameraAxes, orbitCamera, orbitOf, projectPoint, projectWireframe, shiftInView } from './model-orbit.js';

// Zoom stops at a tenth of the smaller of the selection and the whole model,
// and at twice the larger, so a drawing never shrinks to a dot or blows up.
const MAX_MAGNIFICATION = 10;
const MAX_REDUCTION = 2;
const ZOOM_STEP = .75;
const PAN_KEY_STEP = .1;
const PINCH_SPEED = .01;
// Dragging 360 px turns the model half way round.
const ORBIT_PER_PIXEL = Math.PI / 360;
const ORBIT_KEY_STEP = Math.PI / 12;
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export const MODEL_PLAN_STYLE = `
.model-plan-drawing .model-plan-element{fill:none;stroke:#c0cad6;stroke-width:.45}.model-plan-drawing .model-plan-element.selected{fill:#9cc9ff;fill-opacity:.4;stroke:#1877ea;stroke-width:2.5}.model-drawing-line{fill:none;stroke:#354357;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}.model-drawing-text{fill:#24344a;stroke:none;font-family:Arial,Helvetica,sans-serif;white-space:pre}
.model-plan{--model-paper:#f9fbfd;--model-line:#7c8b9e;--model-ink:#24344a;--model-blue:#1877ea;border:1px solid #d7dfe9;border-radius:10px;overflow:hidden;background:var(--model-paper);color:var(--model-ink);font:12px/1.45 -apple-system,BlinkMacSystemFont,sans-serif}
.model-plan-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #dfe5ed;background:#fff}.model-plan-head>div{display:grid;min-width:0;gap:2px}.model-plan-head strong{font-size:12px;overflow-wrap:anywhere}.model-plan-head small{color:#617085;font-size:10px}.model-plan-tools{display:flex;flex-wrap:wrap;gap:4px}.model-plan-tools button{appearance:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid #d7dfe9;border-radius:5px;padding:4px 7px;background:#fff;color:#29476a;font:inherit;font-size:11px;cursor:pointer}.model-plan-tools button:hover{background:#edf4fe}.model-plan-tools button:focus-visible,.model-plan-svg:focus-visible{outline:2px solid var(--model-blue);outline-offset:-2px}.model-plan .model-plan-svg{display:block;width:100%;height:340px;min-height:210px;background:var(--model-paper);touch-action:none}.model-plan-svg[data-interactive]{cursor:grab;-webkit-user-select:none;user-select:none}.model-plan-svg[data-dragging]{cursor:grabbing}.model-plan-element{fill:#e6ebf1;stroke:var(--model-line);stroke-width:.7;vector-effect:non-scaling-stroke;stroke-linejoin:round}.model-plan-element.space{fill:#fff;stroke:#a5b3c4;stroke-width:.6}.model-plan-element.selected{fill:#9cc9ff;fill-opacity:.7;stroke:var(--model-blue);stroke-width:2.5}.model-plan-element.line{fill:none;stroke:#8695a8;stroke-width:.8;stroke-linecap:round}.model-plan-element.line.selected{fill:none;stroke:var(--model-blue);stroke-width:2.2}.model-plan-foot{display:flex;flex-wrap:wrap;gap:8px 14px;padding:8px 12px;border-top:1px solid #dfe5ed;color:#617085;font-size:10px}.model-plan-key{display:inline-flex;align-items:center;gap:5px}.model-plan-key:before{content:'';display:inline-block;width:10px;height:8px;border:1px solid #1877ea;background:#9cc9ff}.model-plan-warning,.model-plan-empty{margin:0;padding:11px 12px;color:#695322;background:#fff8e9;font-size:12px}.model-plan-empty{background:#f4f6f9;color:#58687c}.source-viewer-model-plan{padding:16px}.source-viewer-model-plan .model-plan-svg{height:min(62vh,700px)}.inspector-spatial .model-plan-head{padding:8px}.inspector-spatial .model-plan-svg{height:260px}.inspector-spatial .model-plan-head strong{font-size:10px}.inspector-spatial .model-plan-tools button{font-size:9px}.inspector-spatial .model-plan-foot{font-size:9px}
`;

function validBounds(bounds) {
  return bounds && ['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(bounds[key]))
    && bounds.maxX >= bounds.minX && bounds.maxY >= bounds.minY;
}

export function modelPlanViewBox(bounds, focused = false) {
  if (!validBounds(bounds)) return [0, 0, 1, 1];
  const width = bounds.maxX - bounds.minX, height = bounds.maxY - bounds.minY;
  const padding = Math.max(Math.max(width, height) * (focused ? .2 : .045), .15);
  return [bounds.minX - padding, -bounds.maxY - padding, width + padding * 2, height + padding * 2];
}

function linePath(lines, round = value => value) {
  return (Array.isArray(lines) ? lines : []).map(line => {
    if (!Array.isArray(line) || line.length < 2 || !line.every(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return '';
    return `M${line.map(point => `${round(point[0])},${round(point[1])}`).join('L')}`;
  }).join('');
}

function polygonPath(polygons) {
  return (Array.isArray(polygons) ? polygons : []).map(ring => {
    if (!Array.isArray(ring) || ring.length < 3 || !ring.every(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return '';
    return `M${ring.map(point => `${point[0]},${point[1]}`).join('L')}Z`;
  }).join('');
}

function drawingMarkup(items) {
  return (Array.isArray(items) ? items : []).map(item => {
    const title = `<title>${escapeHtml([item.layer, item.id].filter(Boolean).join(' · '))}</title>`;
    const identity = `data-drawing-entity="${escapeHtml(item.id)}" data-drawing-layer="${escapeHtml(item.layer)}"`;
    if (item.type === 'path') {
      if (!Array.isArray(item.points) || item.points.length < 2 || !item.points.every(point => Array.isArray(point)
        && point.length === 2 && point.every(Number.isFinite))) return '';
      const width = Number.isFinite(item.lineweight) && item.lineweight > 0 ? Math.max(.65, Math.min(2.4, item.lineweight / 25)) : .9;
      return `<path class="model-drawing-line" ${identity} d="M${item.points.map(point => `${point[0]},${point[1]}`).join('L')}${item.closed ? 'Z' : ''}" style="stroke-width:${width}px">${title}</path>`;
    }
    if (item.type !== 'text' || !Array.isArray(item.point) || item.point.length !== 2 || !item.point.every(Number.isFinite)
      || !Number.isFinite(item.height) || item.height <= 0 || !Number.isFinite(item.rotation ?? 0)
      || !Number.isFinite(item.widthScale ?? 1) || (item.widthScale ?? 1) <= 0 || typeof item.text !== 'string') return '';
    const anchor = ['start', 'middle', 'end'].includes(item.align) ? item.align : 'start';
    const baseline = { top: 'text-before-edge', middle: 'central', bottom: 'text-after-edge' }[item.verticalAlign] ?? 'auto';
    const lines = item.text.split('\n');
    const firstOffset = item.verticalAlign === 'middle' ? -(lines.length - 1) * item.height * .6
      : item.verticalAlign === 'bottom' ? -(lines.length - 1) * item.height * 1.2 : 0;
    return `<text class="model-drawing-text" ${identity} transform="translate(${item.point.join(' ')}) rotate(${item.rotation ?? 0}) scale(${item.widthScale ?? 1} -1)" font-size="${item.height}" text-anchor="${anchor}" dominant-baseline="${baseline}">${title}${lines.map((line, index) => `<tspan x="0" dy="${index ? item.height * 1.2 : firstOffset}">${escapeHtml(line)}</tspan>`).join('')}</text>`;
  }).filter(Boolean);
}

export function renderModelPlan(preview, { interactive = true } = {}) {
  const drawing = drawingMarkup(preview.drawing);
  const elements = (preview.elements ?? []).map(element => ({ ...element, path: polygonPath(element.polygons), wire: linePath(element.lines) }))
    .filter(element => element.path || element.wire)
    // Preserve the source renderer's slab/space/wall order, placing only the
    // cited element above it. Otherwise a filled slab can obscure the plan.
    .sort((a, b) => Number(Boolean(a.selected)) - Number(Boolean(b.selected)));
  const hasSelection = elements.some(element => element.selected);
  // Only local, interactive views receive the 3D edges; shared drawings stay flat.
  const orbit = interactive ? orbitOf(preview) : null;
  const wires = orbit ? elements.filter(element => element.wire) : [];
  const wireIndex = new Map(wires.map((element, index) => [element, index]));
  const hasGeometry = elements.length > 0 || drawing.length > 0;
  const selected = preview.selected;
  const title = selected?.label || selected?.guid || selected?.id || (preview.format === 'dxf' ? preview.fileName || 'CAD drawing' : 'Design model');
  const view = preview.view || 'Plan view';
  const fullViewBox = modelPlanViewBox(preview.bounds);
  const focusViewBox = hasSelection && validBounds(preview.focusBounds) ? modelPlanViewBox(preview.focusBounds, true) : fullViewBox;
  const warnings = [...(preview.warnings ?? [])];
  if (selected && !hasSelection && elements.length) warnings.push('This indexed element has no displayable geometry. The surrounding model is shown for context.');
  const controls = interactive && hasGeometry ? `<nav class="model-plan-tools" aria-label="Drawing view controls">
    <button type="button" data-model-action="zoom-in" aria-label="Zoom in">＋</button><button type="button" data-model-action="zoom-out" aria-label="Zoom out">−</button>
    ${orbit ? '<button type="button" data-model-action="isometric">Isometric</button>' : ''}${hasSelection ? '<button type="button" data-model-action="selection">Fit selection</button>' : ''}<button type="button" data-model-action="context">Show context</button></nav>` : '';
  const orbitData = orbit ? `<script type="application/json" data-model-orbit>${JSON.stringify({
    camera: { azimuth: orbit.azimuth, elevation: orbit.elevation }, pivot: orbit.pivot,
    wires: wires.map(element => ({ edges: element.edges, cylinders: element.cylinders, selected: Boolean(element.selected) })),
  }).replace(/</g, '\\u003c')}</script>` : '';
  const hint = orbit ? 'Drag to rotate · Shift-drag to pan · Pinch or + / − to zoom' : 'Drag to pan · Pinch or + / − to zoom';
  const subtitle = [preview.storey?.label, selected?.entityType].filter(Boolean).map(escapeHtml)
    .concat(orbit ? `<span data-model-view>${escapeHtml(view)}</span>` : escapeHtml(view)).join(' · ');
  const geometry = hasGeometry ? `<svg class="model-plan-svg${drawing.length ? ' model-plan-drawing' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${focusViewBox.join(' ')}" ${interactive ? 'tabindex="0" data-interactive="true"' : ''} role="img" aria-label="${escapeHtml(`${hasSelection ? 'Selected element: ' : 'Model plan: '}${title}`)}">
    <title>${escapeHtml(title)} · ${escapeHtml(view.toLowerCase())}</title><g transform="scale(1,-1)">${elements.map(element => {
      const classes = `${element.role === 'space' ? 'space' : 'context'}${element.selected ? ' selected' : ''}`;
      const attributes = `data-model-element="${escapeHtml(element.guid || element.id)}"`;
      const tooltip = `<title>${escapeHtml([element.label, element.entityType, element.guid || element.id].filter(Boolean).join(' · '))}</title>`;
      const wire = wireIndex.has(element) ? ` data-model-wire="${wireIndex.get(element)}"` : '';
      return `${element.path ? `<path class="model-plan-element ${classes}" ${attributes} d="${element.path}" fill-rule="evenodd">${tooltip}</path>` : ''}${element.wire ? `<path class="model-plan-element line ${classes}" ${attributes}${wire} d="${element.wire}">${tooltip}</path>` : ''}`;
    }).join('')}${drawing.length ? `<g class="model-drawing-details">${drawing.join('')}</g>` : ''}</g></svg>`
    : '<p class="model-plan-empty">No displayable geometry was found for this indexed element. Its recorded properties remain available above.</p>';
  return `<style>${MODEL_PLAN_STYLE}</style><section class="model-plan" data-model-plan data-model-focus="${focusViewBox.join(' ')}" data-model-context="${fullViewBox.join(' ')}">
    <header class="model-plan-head"><div><strong>${escapeHtml(title)}</strong><small>${subtitle}</small>${preview.propertyName && preview.valueText != null ? `<small>${escapeHtml(preview.propertyName)}: ${escapeHtml(preview.valueText)}</small>` : ''}</div>${controls}</header>
    ${geometry}${orbitData}${warnings.map(warning => `<p class="model-plan-warning">${escapeHtml(warning)}</p>`).join('')}
    ${hasGeometry ? `<footer class="model-plan-foot">${hasSelection ? '<span class="model-plan-key">Selected element</span>' : ''}<span>Source ${preview.format === 'dxf' ? 'drawing' : 'model'} geometry · ${escapeHtml(preview.units || 'm')}</span>${interactive ? `<span>${hint}</span>` : ''}</footer>` : ''}</section>`;
}

export function bindModelPlans(root) {
  root.querySelectorAll('[data-model-plan]').forEach(plan => {
    const svg = plan.querySelector('svg[data-interactive]');
    if (!svg || svg.dataset.modelBound) return;
    svg.dataset.modelBound = 'true';
    bindModelPlan(plan, svg);
  });
}

const readBox = value => String(value).split(' ').map(Number);
const boxSize = box => Math.max(box[2], box[3]);
// Box centres in projected model coordinates. The drawing is flipped in Y.
const centerOf = box => [box[0] + box[2] / 2, -(box[1] + box[3] / 2)];
const nextFrame = callback => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(callback) : callback());

export function modelZoomLimits(focus, context) {
  return { min: Math.min(boxSize(focus), boxSize(context)) / MAX_MAGNIFICATION,
    max: Math.max(boxSize(focus), boxSize(context)) * MAX_REDUCTION };
}

// Five significant digits of the view keep redrawn paths short.
function rounder(size) {
  const scale = 10 ** Math.min(9, Math.max(0, 5 - Math.floor(Math.log10(Math.max(size, 1e-9)))));
  return value => Math.round(value * scale) / scale;
}

/** Rotation state of a 3D wireframe: its camera, and the model point held at
 * the centre of the view, which the camera orbits. Null for flat plans. */
function orbitControl(plan, box) {
  let data = null;
  try { data = JSON.parse(plan.querySelector('script[data-model-orbit]')?.textContent ?? 'null'); } catch { data = null; }
  if (!data?.camera || !Array.isArray(data.pivot) || !Array.isArray(data.wires)) return null;
  const paths = [...plan.querySelectorAll('[data-model-wire]')]
    .map(path => ({ path, wire: data.wires[Number(path.dataset.modelWire)] })).filter(item => item.wire);
  const label = plan.querySelector('[data-model-view]');
  const initialLabel = label?.textContent;
  const initial = data.camera, round = rounder(boxSize(box));
  let camera = initial, axes = cameraAxes(camera), pending = false;
  // The model point under the centre of a view, at the pivot's depth.
  const lift = view => {
    const [pivotX, pivotY] = projectPoint(data.pivot, axes), [centerX, centerY] = centerOf(view);
    return shiftInView(data.pivot, axes, centerX - pivotX, centerY - pivotY);
  };
  let target = lift(box);
  const isRotated = () => Math.abs(camera.azimuth - initial.azimuth) > 1e-9 || Math.abs(camera.elevation - initial.elevation) > 1e-9;
  const render = () => {
    pending = false;
    for (const { path, wire } of paths) path.setAttribute('d', linePath(projectWireframe(wire, axes), round));
    if (label) label.textContent = isRotated() ? 'Rotated view' : initialLabel;
  };
  const centredOn = (view, [x, y]) => [x - view[2] / 2, -y - view[3] / 2, view[2], view[3]];
  return {
    get camera() { return camera; },
    get rotated() { return isRotated(); },
    /** The view box after turning from `from`, still centred on the target. */
    turn(from, azimuthTurn, elevationTurn, view) {
      camera = orbitCamera(from, azimuthTurn, elevationTurn);
      axes = cameraAxes(camera);
      if (!pending) { pending = true; nextFrame(render); }
      return centredOn(view, projectPoint(target, axes));
    },
    /** Back to the camera the preview was sent in. */
    reset() { this.turn(initial, 0, 0, box); },
    /** Orbits around the cited geometry again after a fit. Pans in a turned
     * view can move the target in depth, which no later pan undoes. */
    anchor(view) { target = lift(view); },
    /** Keeps the target under the centre of a panned or zoomed view. */
    follow(view) {
      const [x, y] = projectPoint(target, axes), [cx, cy] = centerOf(view);
      target = shiftInView(target, axes, cx - x, cy - y);
    },
    /** A view box around the cited (or all) geometry as currently turned. */
    fit(cited) {
      const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (const { wire } of paths) {
        if (cited && !wire.selected) continue;
        for (const line of projectWireframe(wire, axes)) for (const [x, y] of line) {
          bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
          bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
        }
      }
      return validBounds(bounds) ? modelPlanViewBox(bounds, cited) : null;
    },
  };
}

function bindModelPlan(plan, svg) {
  const focus = readBox(plan.dataset.modelFocus), context = readBox(plan.dataset.modelContext);
  const limits = modelZoomLimits(focus, context);
  let box = readBox(svg.getAttribute('viewBox')), drag = null, gestureScale = null;
  const orbit = orbitControl(plan, box);
  const show = next => { box = next; svg.setAttribute('viewBox', box.join(' ')); orbit?.follow(box); };
  const zoom = (factor, anchor = [box[0] + box[2] / 2, box[1] + box[3] / 2]) => {
    const size = boxSize(box);
    // Never move the opposite way when an earlier fit left the view past a limit.
    const next = factor < 1 ? Math.max(Math.min(size, limits.min), size * factor) : Math.min(Math.max(size, limits.max), size * factor);
    const scale = next / size;
    if (!Number.isFinite(scale) || Math.abs(scale - 1) < 1e-12) return;
    show([anchor[0] - (anchor[0] - box[0]) * scale, anchor[1] - (anchor[1] - box[1]) * scale, box[2] * scale, box[3] * scale]);
  };
  const toDrawing = (event, matrix = svg.getScreenCTM?.()?.inverse()) => {
    if (!matrix) return null;
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return [point.x, point.y];
  };
  const fit = cited => (orbit?.rotated ? orbit.fit(cited) : null) ?? (cited ? focus : context);
  const refit = next => { show(next); orbit?.anchor(next); };

  plan.querySelectorAll('[data-model-action]').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation();
    const action = button.dataset.modelAction;
    if (action === 'zoom-in' || action === 'zoom-out') zoom(action === 'zoom-in' ? ZOOM_STEP : 1 / ZOOM_STEP);
    else if (action === 'isometric' && orbit) { orbit.reset(); refit(focus); }
    else refit(fit(action === 'selection'));
  }));
  svg.addEventListener('keydown', event => {
    const arrow = ARROWS[event.key];
    if (!arrow && !['+', '=', '-'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (!arrow) zoom(event.key === '-' ? 1 / ZOOM_STEP : ZOOM_STEP);
    else if (orbit && !event.shiftKey) show(orbit.turn(orbit.camera, -arrow[0] * ORBIT_KEY_STEP, arrow[1] * ORBIT_KEY_STEP, box));
    else show([box[0] + arrow[0] * PAN_KEY_STEP * box[2], box[1] + arrow[1] * PAN_KEY_STEP * box[3], box[2], box[3]]);
  });
  // Left drag turns a 3D view; shift or middle drag pans it. Plans always pan.
  svg.addEventListener('pointerdown', event => {
    if (event.button !== 0 && event.button !== 1) return;
    // A drag must not also start a selection: WebKit tints the whole drawing.
    // Preventing that default also skips focus, so the drawing takes it here.
    event.preventDefault();
    svg.focus?.({ preventScroll: true });
    const rotating = Boolean(orbit) && event.button === 0 && !event.shiftKey;
    const matrix = rotating ? null : svg.getScreenCTM?.()?.inverse();
    if (!rotating && !matrix) return;
    drag = { id: event.pointerId, rotating, x: event.clientX, y: event.clientY, box: [...box], camera: orbit?.camera,
      matrix, point: matrix ? toDrawing(event, matrix) : null };
    svg.setPointerCapture(event.pointerId); svg.dataset.dragging = 'true';
  });
  svg.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (drag.rotating) {
      show(orbit.turn(drag.camera, -(event.clientX - drag.x) * ORBIT_PER_PIXEL, (event.clientY - drag.y) * ORBIT_PER_PIXEL, box));
      return;
    }
    const [x, y] = toDrawing(event, drag.matrix);
    show([drag.box[0] + drag.point[0] - x, drag.box[1] + drag.point[1] - y, drag.box[2], drag.box[3]]);
  });
  const stop = () => { drag = null; delete svg.dataset.dragging; };
  svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop); svg.addEventListener('lostpointercapture', stop);
  // Trackpad pinches arrive as ctrl + wheel (Chrome, Firefox) or as gesture
  // events (Safari, WebKit views). Plain scrolling still scrolls the page.
  svg.addEventListener('wheel', event => {
    if (!event.ctrlKey || gestureScale !== null) return;
    event.preventDefault();
    zoom(Math.exp(event.deltaY * PINCH_SPEED), toDrawing(event) ?? undefined);
  }, { passive: false });
  svg.addEventListener('gesturestart', event => { event.preventDefault(); gestureScale = 1; });
  svg.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (gestureScale === null || !(event.scale > 0)) return;
    zoom(gestureScale / event.scale, toDrawing(event) ?? undefined);
    gestureScale = event.scale;
  });
  svg.addEventListener('gestureend', event => { event.preventDefault(); gestureScale = null; });
}
