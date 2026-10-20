// Plan and isometric geometry comes from the preserved design model. This renderer
// deliberately has no knowledge of room names or property types: selection uses
// element IDs. Elements carry filled polygons (IFC plans) and/or open polylines
// (CAD wireframes).
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

export const MODEL_PLAN_STYLE = `
.model-plan-drawing .model-plan-element{fill:none;stroke:#c0cad6;stroke-width:.45}.model-plan-drawing .model-plan-element.selected{fill:#9cc9ff;fill-opacity:.4;stroke:#1877ea;stroke-width:2.5}.model-drawing-line{fill:none;stroke:#354357;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round}.model-drawing-text{fill:#24344a;stroke:none;font-family:Arial,Helvetica,sans-serif;white-space:pre}
.model-plan{--model-paper:#f9fbfd;--model-line:#7c8b9e;--model-ink:#24344a;--model-blue:#1877ea;border:1px solid #d7dfe9;border-radius:10px;overflow:hidden;background:var(--model-paper);color:var(--model-ink);font:12px/1.45 -apple-system,BlinkMacSystemFont,sans-serif}
.model-plan-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid #dfe5ed;background:#fff}.model-plan-head>div{display:grid;min-width:0;gap:2px}.model-plan-head strong{font-size:12px;overflow-wrap:anywhere}.model-plan-head small{color:#617085;font-size:10px}.model-plan-tools{display:flex;flex-wrap:wrap;gap:4px}.model-plan-tools button{appearance:none;display:inline-flex;align-items:center;justify-content:center;border:1px solid #d7dfe9;border-radius:5px;padding:4px 7px;background:#fff;color:#29476a;font:inherit;font-size:11px;cursor:pointer}.model-plan-tools button:hover{background:#edf4fe}.model-plan-tools button:focus-visible,.model-plan-svg:focus-visible{outline:2px solid var(--model-blue);outline-offset:-2px}.model-plan .model-plan-svg{display:block;width:100%;height:340px;min-height:210px;background:var(--model-paper);touch-action:none}.model-plan-svg[data-interactive]{cursor:grab}.model-plan-svg[data-dragging]{cursor:grabbing}.model-plan-element{fill:#e6ebf1;stroke:var(--model-line);stroke-width:.7;vector-effect:non-scaling-stroke;stroke-linejoin:round}.model-plan-element.space{fill:#fff;stroke:#a5b3c4;stroke-width:.6}.model-plan-element.selected{fill:#9cc9ff;fill-opacity:.7;stroke:var(--model-blue);stroke-width:2.5}.model-plan-element.line{fill:none;stroke:#8695a8;stroke-width:.8;stroke-linecap:round}.model-plan-element.line.selected{fill:none;stroke:var(--model-blue);stroke-width:2.2}.model-plan-foot{display:flex;flex-wrap:wrap;gap:8px 14px;padding:8px 12px;border-top:1px solid #dfe5ed;color:#617085;font-size:10px}.model-plan-key{display:inline-flex;align-items:center;gap:5px}.model-plan-key:before{content:'';display:inline-block;width:10px;height:8px;border:1px solid #1877ea;background:#9cc9ff}.model-plan-warning,.model-plan-empty{margin:0;padding:11px 12px;color:#695322;background:#fff8e9;font-size:12px}.model-plan-empty{background:#f4f6f9;color:#58687c}.source-viewer-model-plan{padding:16px}.source-viewer-model-plan .model-plan-svg{height:min(62vh,700px)}.inspector-spatial .model-plan-head{padding:8px}.inspector-spatial .model-plan-svg{height:260px}.inspector-spatial .model-plan-head strong{font-size:10px}.inspector-spatial .model-plan-tools button{font-size:9px}.inspector-spatial .model-plan-foot{font-size:9px}
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

function linePath(lines) {
  return (Array.isArray(lines) ? lines : []).map(line => {
    if (!Array.isArray(line) || line.length < 2 || !line.every(point => Array.isArray(point)
      && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return '';
    return `M${line.map(point => `${point[0]},${point[1]}`).join('L')}`;
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
    ${hasSelection ? '<button type="button" data-model-action="selection">Fit selection</button>' : ''}<button type="button" data-model-action="context">Show context</button></nav>` : '';
  const geometry = hasGeometry ? `<svg class="model-plan-svg${drawing.length ? ' model-plan-drawing' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="${focusViewBox.join(' ')}" ${interactive ? 'tabindex="0" data-interactive="true"' : ''} role="img" aria-label="${escapeHtml(`${hasSelection ? 'Selected element: ' : 'Model plan: '}${title}`)}">
    <title>${escapeHtml(title)} · ${escapeHtml(view.toLowerCase())}</title><g transform="scale(1,-1)">${elements.map(element => {
      const classes = `${element.role === 'space' ? 'space' : 'context'}${element.selected ? ' selected' : ''}`;
      const attributes = `data-model-element="${escapeHtml(element.guid || element.id)}"`;
      const tooltip = `<title>${escapeHtml([element.label, element.entityType, element.guid || element.id].filter(Boolean).join(' · '))}</title>`;
      return `${element.path ? `<path class="model-plan-element ${classes}" ${attributes} d="${element.path}" fill-rule="evenodd">${tooltip}</path>` : ''}${element.wire ? `<path class="model-plan-element line ${classes}" ${attributes} d="${element.wire}">${tooltip}</path>` : ''}`;
    }).join('')}${drawing.length ? `<g class="model-drawing-details">${drawing.join('')}</g>` : ''}</g></svg>`
    : '<p class="model-plan-empty">No displayable geometry was found for this indexed element. Its recorded properties remain available above.</p>';
  return `<style>${MODEL_PLAN_STYLE}</style><section class="model-plan" data-model-plan data-model-focus="${focusViewBox.join(' ')}" data-model-context="${fullViewBox.join(' ')}">
    <header class="model-plan-head"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml([preview.storey?.label, selected?.entityType, view].filter(Boolean).join(' · '))}</small>${preview.propertyName && preview.valueText != null ? `<small>${escapeHtml(preview.propertyName)}: ${escapeHtml(preview.valueText)}</small>` : ''}</div>${controls}</header>
    ${geometry}${warnings.map(warning => `<p class="model-plan-warning">${escapeHtml(warning)}</p>`).join('')}
    ${hasGeometry ? `<footer class="model-plan-foot">${hasSelection ? '<span class="model-plan-key">Selected element</span>' : ''}<span>Source ${preview.format === 'dxf' ? 'drawing' : 'model'} geometry · ${escapeHtml(preview.units || 'm')}</span>${interactive ? '<span>Drag to pan · + / − to zoom</span>' : ''}</footer>` : ''}</section>`;
}

export function bindModelPlans(root) {
  root.querySelectorAll('[data-model-plan]').forEach(plan => {
    const svg = plan.querySelector('svg[data-interactive]');
    if (!svg || svg.dataset.modelBound) return;
    svg.dataset.modelBound = 'true';
    const readBox = value => value.split(' ').map(Number);
    let box = readBox(svg.getAttribute('viewBox')), drag = null;
    const update = next => { box = next; svg.setAttribute('viewBox', box.join(' ')); };
    const zoom = factor => {
      const width = box[2] * factor, height = box[3] * factor;
      if (width < .01 || height < .01 || width > 1e7 || height > 1e7) return;
      update([box[0] + (box[2] - width) / 2, box[1] + (box[3] - height) / 2, width, height]);
    };
    plan.querySelectorAll('[data-model-action]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      const action = button.dataset.modelAction;
      if (action === 'zoom-in' || action === 'zoom-out') zoom(action === 'zoom-in' ? .75 : 1 / .75);
      else update(readBox(action === 'selection' ? plan.dataset.modelFocus : plan.dataset.modelContext));
    }));
    svg.addEventListener('keydown', event => {
      if (!['+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (['+', '=', '-'].includes(event.key)) zoom(event.key === '-' ? 1 / .75 : .75);
      else update([box[0] + (event.key === 'ArrowLeft' ? -.1 : event.key === 'ArrowRight' ? .1 : 0) * box[2],
        box[1] + (event.key === 'ArrowUp' ? -.1 : event.key === 'ArrowDown' ? .1 : 0) * box[3], box[2], box[3]]);
    });
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const matrix = svg.getScreenCTM();
      if (!matrix) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
      drag = { point, box: [...box], matrix: matrix.inverse(), id: event.pointerId };
      svg.setPointerCapture(event.pointerId); svg.dataset.dragging = 'true';
    });
    svg.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(drag.matrix);
      update([drag.box[0] + drag.point.x - point.x, drag.box[1] + drag.point.y - point.y, drag.box[2], drag.box[3]]);
    });
    const stop = () => { drag = null; delete svg.dataset.dragging; };
    svg.addEventListener('pointerup', stop); svg.addEventListener('pointercancel', stop); svg.addEventListener('lostpointercapture', stop);
  });
}
