import { createHash } from 'node:crypto';

const MAX_BYTES = 30_000_000;
const MAX_ENTITIES = 50_000;
const MAX_POLYGONS = 1_000;
const MAX_VERTICES = 500;
// DXF $INSUNITS: physical conversion is explicit, never inferred from extents.
const UNITS = new Map([
  [1, { name: 'in', factor: 1 / 12, linear: 'ft', area: 'ft²' }],
  [2, { name: 'ft', factor: 1, linear: 'ft', area: 'ft²' }],
  [3, { name: 'mi', factor: 5280, linear: 'ft', area: 'ft²' }],
  [4, { name: 'mm', factor: 0.001, linear: 'm', area: 'm²' }],
  [5, { name: 'cm', factor: 0.01, linear: 'm', area: 'm²' }],
  [6, { name: 'm', factor: 1, linear: 'm', area: 'm²' }],
  [7, { name: 'km', factor: 1000, linear: 'm', area: 'm²' }],
  [10, { name: 'yd', factor: 3, linear: 'ft', area: 'ft²' }],
  [14, { name: 'dm', factor: 0.1, linear: 'm', area: 'm²' }],
  [21, { name: 'US survey ft', factor: (1200 / 3937) / 0.3048, linear: 'ft', area: 'ft²' }],
]);
function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 20); }
function first(entity, code, fallback = '') { return entity.groups.find((item) => item.code === code)?.value ?? fallback; }
function numeric(entity, code, fallback = 0) { return Number(first(entity, code, fallback)); }
function tidy(value) { return String(value).replace(/\s+/g, ' ').trim(); }
function plainText(value) {
  return tidy(String(value).replace(/\\U\+([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\[Pp~]/g, ' ').replace(/\\[ACFHQTW][^;]*;/gi, '').replace(/\\[LlOoKk]/g, '')
    .replace(/[{}]/g, '').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[cC]/g, 'Ø'));
}
function areaOf(vertices) {
  // Translate to the first vertex to retain precision in survey coordinates.
  const [ox, oy] = vertices[0];
  let total = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]; const b = vertices[(i + 1) % vertices.length];
    total += (a[0] - ox) * (b[1] - oy) - (b[0] - ox) * (a[1] - oy);
  }
  return Math.abs(total / 2);
}
function perimeterOf(vertices) {
  return vertices.reduce((sum, a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    return sum + Math.hypot(b[0] - a[0], b[1] - a[1]);
  }, 0);
}
function extent(vertices) {
  return { minX: Math.min(...vertices.map((v) => v[0])), minY: Math.min(...vertices.map((v) => v[1])),
    maxX: Math.max(...vertices.map((v) => v[0])), maxY: Math.max(...vertices.map((v) => v[1])) };
}
function cross(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(point, a, b) {
  const tolerance = Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])) * 1e-10;
  return Math.abs(cross(a, b, point)) <= tolerance && point[0] >= Math.min(a[0], b[0]) - tolerance
    && point[0] <= Math.max(a[0], b[0]) + tolerance && point[1] >= Math.min(a[1], b[1]) - tolerance && point[1] <= Math.max(a[1], b[1]) + tolerance;
}
function intersects(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const ac = cross(a, b, c); const ad = cross(a, b, d); const ca = cross(c, d, a); const cb = cross(c, d, b);
  return (Math.sign(ac) !== Math.sign(ad) && Math.sign(ca) !== Math.sign(cb))
    || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}
function isSimple(vertices, budget) {
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]; const b = vertices[(i + 1) % vertices.length];
    if (a[0] === b[0] && a[1] === b[1]) return false;
    for (let j = i + 2; j < vertices.length; j += 1) {
      if (i === 0 && j === vertices.length - 1) continue;
      budget.remaining -= 1;
      if (budget.remaining < 0) return false;
      if (intersects(a, b, vertices[j], vertices[(j + 1) % vertices.length])) return false;
    }
  }
  return true;
}
function inside(point, vertices) {
  let result = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i]; const b = vertices[j];
    if (onSegment(point, a, b)) return false; // A boundary label is ambiguous.
    if (((a[1] > point[1]) !== (b[1] > point[1])) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function format(value) { return Number(value.toPrecision(12)).toString(); }

/** Notes that describe entities a plan normally contains (door-swing arcs,
 * furniture blocks, dimensions, open linework) rather than a boundary that
 * failed to measure. They are shown with the drawing but do not make it partial.
 */
export function isInformationalDxfWarning(warning) {
  return /^Measurements for these DXF entity types|^\d+ open polylines were not treated/.test(String(warning));
}

/** Extract native, unit-aware measurements from ASCII DXF model-space boundaries.
 * Supported geometry is deliberately limited to simple closed, straight-sided
 * LWPOLYLINE entities. Curves, block transforms, holes and units are not guessed.
 */
export function extractDxfDocument(buffer, { filePath: _filePath } = {}) {
  const base = { status: 'unsupported', method: 'dxf-ascii-geometry', pages: [], warnings: [], isDrawing: false };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ...base, warnings: ['DXF input is empty.'] };
  if (buffer.length > MAX_BYTES) return { ...base, warnings: ['DXF exceeds the 30 MB extraction limit.'] };
  if (buffer.subarray(0, 22).toString('ascii').startsWith('AutoCAD Binary DXF')) return { ...base, warnings: ['Binary DXF is unsupported; export an ASCII DXF with drawing units.'] };
  if (buffer.includes(0)) return { ...base, warnings: ['Binary CAD data is unsupported; export ASCII DXF, IFC or LandXML.'] };
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines = source.split(/\r\n|\n|\r/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length % 2 || lines.length > 2_000_000) return { ...base, status: 'error', warnings: ['Malformed or oversized DXF group-code data.'] };
  const pairs = [];
  for (let i = 0; i < lines.length; i += 2) {
    if (!/^\s*\d{1,4}\s*$/.test(lines[i])) return { ...base, status: 'error', warnings: ['Invalid DXF group code.'] };
    pairs.push({ code: Number(lines[i]), value: lines[i + 1].trim() });
  }
  if (!pairs.some((pair) => pair.code === 0 && pair.value === 'SECTION') || !pairs.some((pair) => pair.code === 0 && pair.value === 'EOF')) {
    return { ...base, status: 'error', warnings: ['A complete ASCII DXF SECTION/EOF structure is required.'] };
  }
  let openSection = false;
  let ended = false;
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (ended && pair.code !== 999) return { ...base, status: 'error', warnings: ['DXF contains data after EOF.'] };
    if (pair.code !== 0) continue;
    if (pair.value === 'SECTION') {
      if (openSection || pairs[i + 1]?.code !== 2) return { ...base, status: 'error', warnings: ['Invalid DXF section structure.'] };
      openSection = true;
    } else if (pair.value === 'ENDSEC') {
      if (!openSection) return { ...base, status: 'error', warnings: ['Unexpected DXF ENDSEC.'] };
      openSection = false;
    } else if (pair.value === 'EOF') {
      if (openSection) return { ...base, status: 'error', warnings: ['DXF section is truncated before EOF.'] };
      ended = true;
    }
  }
  const warnings = [];
  const warn = (value) => { if (warnings.length < 50 && !warnings.includes(value)) warnings.push(value); };
  const entities = [];
  let unitsCode = 0;
  let section = '';
  let entity;
  let sawEntities = false;
  for (let i = 0; i < pairs.length; i += 1) {
    const pair = pairs[i];
    if (pair.code === 0 && pair.value === 'SECTION') { section = pairs[++i]?.code === 2 ? pairs[i].value : ''; continue; }
    if (pair.code === 0 && pair.value === 'ENDSEC') { section = ''; entity = null; continue; }
    if (section === 'HEADER' && pair.code === 9 && pair.value === '$INSUNITS') {
      const next = pairs[i + 1];
      if (next?.code === 70) unitsCode = Number(next.value);
    }
    if (section !== 'ENTITIES') continue;
    sawEntities = true;
    if (pair.code === 0) {
      if (entities.length >= MAX_ENTITIES) { warn(`Only the first ${MAX_ENTITIES} model entities were inspected.`); break; }
      entity = { type: pair.value, groups: [], index: entities.length };
      entities.push(entity);
    } else if (entity) entity.groups.push(pair);
  }
  if (!sawEntities) return { ...base, status: 'error', warnings: ['The DXF has no ENTITIES section.'] };
  const units = UNITS.get(unitsCode);
  if (!units) warn(`DXF $INSUNITS ${unitsCode || '(unitless or absent)'} is unsupported or unknown; no physical measurements were calculated.`);
  const model = entities.filter((item) => numeric(item, 67) === 0 && /^(?:|model)$/i.test(first(item, 410)));
  const labels = model.filter((item) => ['TEXT', 'MTEXT'].includes(item.type)).map((item) => {
    const text = plainText(item.groups.filter((pair) => [1, 3].includes(pair.code)).map((pair) => pair.value).join(''));
    // DXF TEXT horizontal alignment relocates the insertion point to group 11.
    const aligned = item.type === 'TEXT' && (numeric(item, 72) !== 0 || numeric(item, 73) !== 0);
    const standardPlane = numeric(item, 210) === 0 && numeric(item, 220) === 0 && numeric(item, 230, 1) === 1;
    return { text, point: [numeric(item, aligned ? 11 : 10, NaN), numeric(item, aligned ? 21 : 20, NaN)], elevation: numeric(item, aligned ? 31 : 30), standardPlane, elementId: first(item, 5), layer: first(item, 8, '0') };
  }).filter((item) => item.standardPlane && item.text && item.text.length <= 150 && /[a-z]/i.test(item.text) && item.point.every(Number.isFinite));
  const handleCounts = new Map();
  for (const item of model) {
    const handle = first(item, 5).toUpperCase();
    if (handle) handleCounts.set(handle, (handleCounts.get(handle) ?? 0) + 1);
  }
  const polygons = [];
  const budget = { remaining: 5_000_000 };
  let skipped = 0;
  for (const item of model) {
    if (item.type !== 'LWPOLYLINE') continue;
    if (!(numeric(item, 70) & 1)) { skipped += 1; continue; }
    const identity = first(item, 5, `entity-${item.index}`).toUpperCase();
    if ((handleCounts.get(identity) ?? 0) > 1) { warn(`Duplicate DXF handle ${identity}; ambiguous entity measurements were skipped.`); continue; }
    if (item.groups.some((pair) => pair.code === 42 && Number(pair.value) !== 0)) { warn(`Entity ${identity} contains curved bulge segments; curved areas are not supported.`); continue; }
    if (numeric(item, 210) !== 0 || numeric(item, 220) !== 0 || numeric(item, 230, 1) !== 1 || numeric(item, 39) !== 0) {
      warn(`Entity ${identity} uses a transformed or extruded plane; its measurements were skipped.`); continue;
    }
    if (item.groups.some((pair) => [40, 41, 43].includes(pair.code) && Number(pair.value) !== 0)) {
      warn(`Entity ${identity} has a nonzero polyline width; its area boundary is ambiguous.`); continue;
    }
    const vertices = [];
    let pending;
    let malformed = false;
    for (const pair of item.groups) {
      if (pair.code === 10) { if (pending) malformed = true; pending = [Number(pair.value)]; }
      if (pair.code === 20) { if (!pending) { malformed = true; continue; } pending.push(Number(pair.value)); vertices.push(pending); pending = null; }
    }
    if (pending) malformed = true;
    const declaredVertices = numeric(item, 90, vertices.length);
    if (declaredVertices !== vertices.length) malformed = true;
    if (vertices.length > 1 && vertices[0][0] === vertices.at(-1)[0] && vertices[0][1] === vertices.at(-1)[1]) vertices.pop();
    if (malformed || vertices.length < 3 || vertices.length > MAX_VERTICES || vertices.some((v) => v.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e12))) {
      warn(`Entity ${identity} has invalid or excessive boundary vertices; it was skipped.`); continue;
    }
    if (!isSimple(vertices, budget)) {
      warn(budget.remaining < 0 ? 'Geometry complexity limit reached; remaining boundaries were skipped.' : `Entity ${identity} is self-intersecting or degenerate; its area was skipped.`);
      if (budget.remaining < 0) break;
      continue;
    }
    const area = areaOf(vertices);
    if (!(area > 0)) { warn(`Entity ${identity} has zero area; it was skipped.`); continue; }
    polygons.push({ vertices, extent: extent(vertices), identity, layer: first(item, 8, '0'), area, perimeter: perimeterOf(vertices), elevation: numeric(item, 38) });
    if (polygons.length >= MAX_POLYGONS) { warn(`Only the first ${MAX_POLYGONS} closed boundaries were indexed.`); break; }
  }
  if (skipped) warn(`${skipped} open polylines were not treated as area boundaries.`);
  const unsupported = [...new Set(model.filter((item) => !['LWPOLYLINE', 'TEXT', 'MTEXT', 'LINE', 'POINT'].includes(item.type)).map((item) => item.type))];
  if (unsupported.length) warn(`Measurements for these DXF entity types are not supported: ${unsupported.join(', ')}. Export spaces/quantities as IFC when available.`);
  const xs = polygons.flatMap((p) => [p.extent.minX, p.extent.maxX]);
  const ys = polygons.flatMap((p) => [p.extent.minY, p.extent.maxY]);
  const bounds = xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
    : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-12);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-12);
  // Bound spatial label matching separately from geometry extraction. If the
  // budget is exhausted, keep measurements and decline all room associations.
  const containedByPolygon = new Map(polygons.map((polygon) => [polygon, []]));
  const membership = new Map();
  let labelBudget = 5_000_000;
  let labelsComplete = labels.length <= 2_000;
  if (labelsComplete) {
    searchLabels: for (const label of labels) {
      const containing = [];
      for (const polygon of polygons) {
        labelBudget -= 1;
        const [x, y] = label.point;
        const e = polygon.extent;
        if (labelBudget < 0) { labelsComplete = false; break searchLabels; }
        if (Math.abs(label.elevation - polygon.elevation) > 1e-8) continue;
        if (x <= e.minX || x >= e.maxX || y <= e.minY || y >= e.maxY) continue;
        labelBudget -= polygon.vertices.length;
        if (labelBudget < 0) { labelsComplete = false; break searchLabels; }
        if (inside(label.point, polygon.vertices)) { containing.push(polygon); containedByPolygon.get(polygon).push(label); }
      }
      membership.set(label, containing);
    }
  }
  if (!labelsComplete) warn('Text association complexity limit reached; boundaries were left without room or parcel names.');
  const annotations = [];
  const geometries = [];
  for (const polygon of polygons) {
    const contained = containedByPolygon.get(polygon);
    const candidates = labelsComplete ? contained.filter((label) => membership.get(label)?.length === 1) : [];
    const name = candidates.length === 1 && contained.length === 1 ? candidates[0].text : null;
    if (contained.length && !name) warn(`Entity ${polygon.identity} has ambiguous text labels; no room or parcel name was assigned.`);
    const box = { x: (polygon.extent.minX - bounds.minX) / spanX, y: (bounds.maxY - polygon.extent.maxY) / spanY,
      width: (polygon.extent.maxX - polygon.extent.minX) / spanX, height: (polygon.extent.maxY - polygon.extent.minY) / spanY };
    const geometry = { type: 'polygon', vertices: polygon.vertices, units: units?.name ?? null, elevation: polygon.elevation,
      normalizedVertices: polygon.vertices.map(([x, y]) => [(x - bounds.minX) / spanX, (bounds.maxY - y) / spanY]) };
    geometries.push({ elementId: polygon.identity, layer: polygon.layer, label: name, geometry, bbox: box });
    if (!units) continue;
    for (const [kind, propertyName, numericValue, outputUnits] of [
      ['area', 'Area', polygon.area * units.factor ** 2, units.area],
      ['perimeter', 'Perimeter', polygon.perimeter * units.factor, units.linear],
    ]) {
      annotations.push({ id: `drawing-${hash(`DXF|${polygon.identity}|${propertyName}`)}`, pageNumber: 1, sheetNumber: null,
        label: name ?? (polygon.layer !== '0' ? polygon.layer : `Boundary ${polygon.identity}`), kind, propertyName,
        value: `${format(numericValue)} ${outputUnits}`, numericValue: Number(numericValue.toPrecision(12)), units: outputUnits,
        rawText: `${name ? `${name}; ` : ''}LWPOLYLINE ${polygon.identity}; layer ${polygon.layer}; ${propertyName} ${format(numericValue)} ${outputUnits}; $INSUNITS ${unitsCode} (${units.name})`,
        bbox: box, confidence: 1, extractionMethod: 'dxf_closed_polyline_geometry', measurementBasis: 'geometry',
        elementId: polygon.identity, entityType: 'LWPOLYLINE', layer: polygon.layer, geometry,
        semantics: name ? 'labelled_boundary' : 'closed_boundary',
      });
    }
  }
  if (!polygons.length) warn('No supported closed planar LWPOLYLINE boundaries were found. Lines, blocks and circles remain unmeasured.');
  const text = model.filter((item) => ['TEXT', 'MTEXT', 'ATTRIB'].includes(item.type)).map((item) => plainText(item.groups.filter((pair) => [1, 3].includes(pair.code)).map((pair) => pair.value).join(''))).filter(Boolean).join('\n').slice(0, 300_000);
  return { status: annotations.length ? (warnings.some((warning) => !isInformationalDxfWarning(warning)) ? 'partial' : 'ready') : 'unsupported', method: base.method, warnings,
    isDrawing: true, format: 'dxf', pageCount: 1, sourceUnits: units?.name ?? null, unitsCode,
    pages: [{ pageNumber: 1, sheetNumber: null, title: 'DXF model space', width: spanX, height: spanY, text,
      annotations, words: [], geometry: geometries, coordinateSystem: { units: units?.name ?? null, bounds, yAxis: 'up' }, isDrawing: true }] };
}
