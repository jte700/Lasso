import { createHash } from 'node:crypto';
import { extractDxfDocument, isInformationalDxfWarning } from './dxf-extraction.js';
import { buildDxfDrawing } from './dxf-drawing.js';

// Match the IFC renderer's plan point budget. The shared DXF parser also
// bounds file size, entity count, polygon size and intersection checks.
const MAX_PLAN_POINTS = 400_000;

function combinedBounds(elements) {
  return elements.reduce((bounds, element) => ({
    minX: Math.min(bounds.minX, element.bounds.minX), minY: Math.min(bounds.minY, element.bounds.minY),
    maxX: Math.max(bounds.maxX, element.bounds.maxX), maxY: Math.max(bounds.maxY, element.bounds.maxY),
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function drawingBounds(items) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const include = ([x, y]) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  };
  for (const item of items) {
    if (item.type === 'path') { for (const point of item.points) include(point); continue; }
    // Text extents are an estimate for fitting only, never measured evidence.
    const lines = item.text.split('\n'), width = Math.max(...lines.map(line => line.length)) * item.height * .65 * (item.widthScale ?? 1);
    const height = lines.length * item.height * 1.2;
    const x = item.align === 'middle' ? -width / 2 : item.align === 'end' ? -width : 0;
    const bottom = item.verticalAlign === 'top' ? -height - item.height * .2
      : item.verticalAlign === 'middle' ? -height / 2 - item.height * .2
        : item.verticalAlign === 'bottom' ? -item.height * .2 : -(lines.length - 1) * item.height * 1.2 - item.height * .35;
    const top = item.verticalAlign === 'top' ? item.height * .2
      : item.verticalAlign === 'middle' ? height / 2 + item.height * .2
        : item.verticalAlign === 'bottom' ? height + item.height * .2 : item.height * 1.15;
    const angle = item.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    for (const [dx, dy] of [[x - item.height * .2, bottom], [x + width + item.height * .2, bottom],
      [x - item.height * .2, top], [x + width + item.height * .2, top]]) {
      include([item.point[0] + dx * cos - dy * sin, item.point[1] + dx * sin + dy * cos]);
    }
  }
  return bounds;
}

const identity = element => element ? {
  id: element.id, guid: element.guid, label: element.label, entityType: element.entityType,
} : null;

/** Detailed drafting and measured room boundaries share preserved source bytes.
 * Only the indexed parser's validated boundaries carry measured properties.
 * The visual paths/text never create quantities or selectable room evidence.
 */
export function buildDxfPlan(buffer, { elementId = null } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const drawing = extractDxfDocument(bytes);
  const draft = buildDxfDrawing(bytes);
  const geometry = drawing.pages[0]?.geometry ?? [];
  const displayedIds = new Set(draft.primitives.map(item => item.id));

  let pointCount = 0;
  const elements = geometry.filter(item => Number.isFinite(item.geometry.elevation) && displayedIds.has(item.elementId)).map((item, index) => {
    const vertices = item.geometry.vertices;
    pointCount += vertices.length;
    if (pointCount > MAX_PLAN_POINTS) throw new Error('DXF visual preview exceeds the plan complexity limit. Export a smaller model-space drawing.');
    const xs = vertices.map(point => point[0]), ys = vertices.map(point => point[1]);
    return {
      id: index + 1, guid: item.elementId, label: item.label || (item.layer !== '0' ? item.layer : `Boundary ${item.elementId}`),
      entityType: 'LWPOLYLINE', role: item.label ? 'space' : 'context', layer: item.layer,
      elevation: item.geometry.elevation, polygons: [vertices],
      bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    };
  });
  const requested = elementId == null ? null : String(elementId).trim().toUpperCase();
  const selected = requested == null ? null : elements.find(element => element.guid === requested);
  if (requested != null && !selected) {
      throw new Error(`DXF element ${requested || '(empty handle)'} is missing, hidden, or has no supported measured boundary in this source version. Open the original drawing or export visible straight-sided closed LWPOLYLINE boundaries.`);
  }
  if (!elements.length && !draft.primitives.length) throw new Error([...drawing.warnings, ...draft.warnings].join(' ') || 'No supported model-space drawing entities were found. Export a 2D ASCII DXF or open the original drawing.');
  const warnings = [...new Set([...drawing.warnings.filter(warning => !isInformationalDxfWarning(warning)), ...draft.warnings])];
  if (elements.length !== geometry.length) warnings.push('Hidden boundaries or boundaries without identifiable planar drawing geometry were omitted from this plan.');
  let elevation = selected?.elevation ?? Infinity;
  if (!selected) {
    for (const item of [...elements, ...draft.primitives]) elevation = Math.min(elevation, item.elevation);
  }
  const visible = elements.filter(element => Math.abs(element.elevation - elevation) <= 1e-8)
    .map(element => ({ ...element, selected: element === selected }));
  const visibleDrawing = draft.primitives.filter(item => Math.abs(item.elevation - elevation) <= 1e-8);
  const units = drawing.sourceUnits || draft.sourceUnits || 'drawing units (unspecified)';
  if (visible.length !== elements.length || visibleDrawing.length !== draft.primitives.length) warnings.push(`Showing the drawing at elevation ${elevation} ${units}. Other elevations are omitted; select an indexed room property to view its plane.`);
  const bounds = combinedBounds([...visible, { bounds: drawingBounds(visibleDrawing) }]);
  // A horizontal line or a single text baseline must still fit a usable view.
  if (bounds.minX === bounds.maxX) { bounds.minX -= .5; bounds.maxX += .5; }
  if (bounds.minY === bounds.maxY) { bounds.minY -= .5; bounds.maxY += .5; }
  const focus = selected?.bounds ?? bounds;
  const margin = Math.max((focus.maxX - focus.minX) * 0.2, (focus.maxY - focus.minY) * 0.2, 1e-9);
  return {
    kind: 'model-plan', format: 'dxf', sourceHash: createHash('sha256').update(bytes).digest('hex'),
    units, unitsCode: drawing.unitsCode, projection: 'plan', fillRule: 'evenodd',
    elements: visible, drawing: visibleDrawing, bounds,
    focusBounds: { minX: focus.minX - margin, minY: focus.minY - margin, maxX: focus.maxX + margin, maxY: focus.maxY + margin },
    selected: identity(selected), storey: null, warnings,
  };
}
