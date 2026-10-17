import polygonClipping from 'polygon-clipping';

const MAX_POINTS = 400_000;
const MAX_CLIP_WORK = 8_000_000;
const finitePoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
function boundsOf(rings) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) for (const [x, y] of ring) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}
const overlaps = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const contains = (a, b) => a.minX <= b.minX && a.maxX >= b.maxX && a.minY <= b.minY && a.maxY >= b.maxY;
const rectangleRing = r => [[r.minX, r.minY], [r.maxX, r.minY], [r.maxX, r.maxY], [r.minX, r.maxY], [r.minX, r.minY]];

/** Region coordinates are normalized to preview.bounds, with Y down from maxY.
 * No original geometry or text is returned beneath any region. BLUR uses the
 * same removal as BLANK; its appearance is drawn from synthetic shapes only.
 */
export function redactModelPlan(preview, regions) {
  if (preview?.kind !== 'model-plan') throw new Error('A drawing preview is required for drawing redactions.');
  const b = preview.bounds;
  if (!b || !['minX', 'minY', 'maxX', 'maxY'].every(key => Number.isFinite(b[key])) || b.maxX <= b.minX || b.maxY <= b.minY) throw new Error('The drawing bounds are invalid.');
  if (!Array.isArray(regions) || !regions.length || regions.length > 64) throw new Error('Select between one and 64 drawing regions.');
  const width = b.maxX - b.minX, height = b.maxY - b.minY;
  const masks = regions.map(region => {
    if (region.kind !== 'DRAWING' || !['BLUR', 'BLANK'].includes(region.effect)
      || !['x', 'y', 'width', 'height'].every(key => typeof region[key] === 'number' && Number.isFinite(region[key]))
      || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
      || region.x + region.width > 1 || region.y + region.height > 1) throw new Error('Invalid drawing redaction region.');
    return { minX: b.minX + region.x * width, maxX: b.minX + (region.x + region.width) * width,
      minY: b.maxY - (region.y + region.height) * height, maxY: b.maxY - region.y * height, effect: region.effect };
  });
  let work = 0, pointCount = 0;
  const charge = count => { work += count; if (work > MAX_CLIP_WORK) throw new Error('The redacted drawing is too complex. Select a larger region or use a smaller source.'); };
  const account = count => { pointCount += count; if (pointCount > MAX_POINTS) throw new Error('The redacted drawing exceeds the preview complexity limit.'); };
  const rectangleUnion = polygonClipping.union(...masks.map(mask => [rectangleRing(mask)]));
  const drawing = [], elements = [];
  let serial = 0;
  for (const element of preview.elements ?? []) {
    const rings = element.polygons;
    if (!Array.isArray(rings) || !rings.length || rings.some(ring => !Array.isArray(ring) || ring.length < 3 || !ring.every(finitePoint))) throw new Error('Invalid drawing polygons.');
    const bounds = boundsOf(rings), relevant = masks.filter(mask => overlaps(mask, bounds));
    if (relevant.some(mask => contains(mask, bounds))) continue;
    let polygons = rings;
    if (relevant.length) {
      const count = rings.reduce((n, ring) => n + ring.length, 0);
      if (rings.length > 512) throw new Error('The redacted drawing has too many polygon rings.');
      charge(count * Math.max(1, rings.length) + count * relevant.length);
      // Plan rings use even-odd fill, including disjoint exteriors and holes.
      const subject = rings.length === 1 ? [rings] : polygonClipping.xor(...rings.map(ring => [ring]));
      polygons = polygonClipping.difference(subject, rectangleUnion).flat();
    }
    if (!polygons.length) continue;
    account(polygons.reduce((n, ring) => n + ring.length, 0));
    elements.push({ id: `shared-${++serial}`, role: element.role === 'space' ? 'space' : 'context',
      polygons, bounds: boundsOf(polygons), selected: false });
  }
  for (const item of preview.drawing ?? []) {
    if (item.type === 'text') {
      if (!finitePoint(item.point) || typeof item.text !== 'string' || !Number.isFinite(item.height) || item.height <= 0
        || !Number.isFinite(item.rotation ?? 0) || !Number.isFinite(item.widthScale ?? 1)) throw new Error('Invalid drawing text.');
      // Bounds follow the shared renderer's anchor, multiline baselines and
      // rotation. Each line gets a conservative glyph advance and descender
      // allowance, rather than a circle extending both sides of the anchor.
      const lines = item.text.split('\n'), scale = item.widthScale ?? 1;
      if (scale <= 0) throw new Error('Invalid drawing text width.');
      const firstOffset = item.verticalAlign === 'middle' ? -(lines.length - 1) * item.height * .6
        : item.verticalAlign === 'bottom' ? -(lines.length - 1) * item.height * 1.2 : 0;
      const angle = (item.rotation ?? 0) * Math.PI / 180, co = Math.cos(angle), si = Math.sin(angle);
      const [glyphTop, glyphBottom] = item.verticalAlign === 'top' ? [-.25, 1.5]
        : item.verticalAlign === 'middle' ? [-1, 1]
          : item.verticalAlign === 'bottom' ? [-1.5, .25] : [-1.5, .5];
      const envelopes = lines.flatMap((line, index) => {
        if (!line) return [];
        // The public renderer uses a plain sans font. 1.5em per ASCII glyph,
        // 2em per non-ASCII code point and an 8-character tab allowance safely
        // exceed its normal advances without inventing measured text widths.
        const advances = [...line].reduce((sum, glyph) => sum + (glyph === '\t' ? 12 : glyph.codePointAt(0) > 127 ? 2 : 1.5), 0);
        const width = advances * item.height * scale, margin = item.height * .25;
        const left = (item.align === 'middle' ? -width / 2 : item.align === 'end' ? -width : 0) - margin * scale;
        const right = left + width + margin * scale * 2;
        const baseline = firstOffset + index * item.height * 1.2;
        // Text has its own Y reflection inside the model's world transform.
        const bottom = -baseline - glyphBottom * item.height - margin;
        const top = -baseline - glyphTop * item.height + margin;
        return [boundsOf([[[left, bottom], [right, bottom], [right, top], [left, top]]
          .map(([x, y]) => [item.point[0] + x * co - y * si, item.point[1] + x * si + y * co])])];
      });
      charge(masks.length * Math.max(envelopes.length, 1));
      if (masks.some(mask => envelopes.some(envelope => overlaps(mask, envelope)))) continue;
      account(1);
      drawing.push({ id: `shared-${++serial}`, type: 'text', point: [...item.point], text: item.text,
        height: item.height, rotation: item.rotation ?? 0, align: item.align, verticalAlign: item.verticalAlign,
        widthScale: item.widthScale ?? 1, elevation: 0, layer: '' });
      continue;
    }
    if (item.type !== 'path') continue;
    if (!Array.isArray(item.points) || item.points.length < 2 || !item.points.every(finitePoint)) throw new Error('Invalid drawing path.');
    const relevant = masks.filter(mask => overlaps(mask, boundsOf([item.points])));
    if (!relevant.length) {
      account(item.points.length);
      drawing.push({ id: `shared-${++serial}`, type: 'path', points: item.points.map(point => [...point]), closed: Boolean(item.closed), elevation: 0, layer: '', ...(Number.isFinite(item.lineweight) ? { lineweight: item.lineweight } : {}) });
      continue;
    }
    if (relevant.some(mask => contains(mask, boundsOf([item.points])))) continue;
    const count = item.points.length - (item.closed ? 0 : 1);
    charge(count * relevant.length);
    // Subtract the union of line-rectangle parameter intervals. Sending the
    // original polyline with an SVG clip would disclose its hidden vertices.
    for (let i = 0; i < count; i += 1) {
      const a = item.points[i], end = item.points[(i + 1) % item.points.length], dx = end[0] - a[0], dy = end[1] - a[1];
      const cuts = relevant.map(mask => {
        let low = 0, high = 1;
        for (const [origin, delta, min, max] of [[a[0], dx, mask.minX, mask.maxX], [a[1], dy, mask.minY, mask.maxY]]) {
          if (delta === 0) { if (origin < min || origin > max) return null; continue; }
          const t1 = (min - origin) / delta, t2 = (max - origin) / delta;
          low = Math.max(low, Math.min(t1, t2)); high = Math.min(high, Math.max(t1, t2));
          if (high < low) return null;
        }
        return [low, high];
      }).filter(Boolean).sort((x, y) => x[0] - y[0]);
      let cursor = 0;
      const add = (from, to) => {
        if (to - from < 1e-12) return;
        account(2);
        drawing.push({ id: `shared-${++serial}`, type: 'path', points: [[a[0] + dx * from, a[1] + dy * from], [a[0] + dx * to, a[1] + dy * to]], closed: false, elevation: 0, layer: '', ...(Number.isFinite(item.lineweight) ? { lineweight: item.lineweight } : {}) });
      };
      for (const [from, to] of cuts) { if (from > cursor) add(cursor, from); cursor = Math.max(cursor, to); }
      if (cursor < 1) add(cursor, 1);
    }
  }
  if (drawing.length > 25_000 || elements.length > 25_000) throw new Error('The redacted drawing exceeds the preview complexity limit.');
  // Strict whitelist: hashes, paths, IDs, labels, source text, selection,
  // properties, layer names and original bounding boxes never cross this edge.
  return { kind: 'model-plan', format: preview.format === 'dxf' ? 'dxf' : 'ifc', units: preview.units,
    projection: 'plan', fillRule: 'evenodd', bounds: { ...b }, focusBounds: { ...b },
    elements, drawing, selected: null, storey: null, redacted: true, redactionRegions: masks,
    warnings: ['Marked regions were removed before sharing. Drawing text near a region may also be removed to protect complete labels.'] };
}
