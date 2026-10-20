// Visual ASCII DXF support only. This module never supplies areas, lengths or
// other evidence to measurement extraction. Entity codes follow Autodesk's DXF
// reference: https://help.autodesk.com/cloudhelp/2025/ENU/AutoCAD-DXF/files/index.htm
// Paths are sampled in their source coordinate system before block transforms.
const LIMITS = Object.freeze({ bytes: 30_000_000, pairs: 1_000_000, entities: 50_000,
  primitives: 25_000, points: 400_000, pathPoints: 8192, visits: 200_000,
  text: 4096, totalText: 250_000, blockDepth: 12, array: 1000 });
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const IDENTITY = [1, 0, 0, 1, 0, 0];
const UNITS = new Map([[1, 'in'], [2, 'ft'], [3, 'mi'], [4, 'mm'], [5, 'cm'], [6, 'm'], [7, 'km'],
  [8, 'microin'], [9, 'mil'], [10, 'yd'], [11, 'angstrom'], [12, 'nm'], [13, 'micron'],
  [14, 'dm'], [15, 'dam'], [16, 'hm'], [17, 'Gm'], [18, 'au'], [19, 'ly'], [20, 'pc'],
  [21, 'US survey ft'], [22, 'US survey in'], [23, 'US survey yd'], [24, 'US survey mi']]);
function value(entity, code, fallback = '') { return entity.groups.find(pair => pair.code === code)?.value ?? fallback; }
function parseNumber(raw, code) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(String(raw).trim())) throw new Error(`invalid number in group ${code}`);
  const result = Number(raw);
  if (!Number.isFinite(result) || Math.abs(result) > 1e12) throw new Error(`invalid number in group ${code}`);
  return result;
}
function number(entity, code, fallback = 0) {
  if (entity.groups.filter(pair => pair.code === code).length > 1) throw new Error(`duplicate numeric group ${code}`);
  return parseNumber(value(entity, code, fallback), code);
}
function integer(entity, code, fallback = 0) {
  const result = number(entity, code, fallback);
  if (!Number.isSafeInteger(result)) throw new Error(`invalid integer in group ${code}`);
  return result;
}
function requiredPoint(entity, code = 10) { return [number(entity, code, NaN), number(entity, code + 10, NaN)]; }
function compose(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
function transform(matrix, point) {
  const result = [matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]];
  if (result.some(v => !Number.isFinite(v) || Math.abs(v) > 1e12)) throw new Error('transformed coordinates exceed the drawing limit');
  return result;
}
function checkPlane(entity) {
  if (Math.abs(number(entity, 210)) > 1e-9 || Math.abs(number(entity, 220)) > 1e-9
      || Math.abs(number(entity, 230, 1) - 1) > 1e-9) throw new Error('tilted or reversed drawing plane is unsupported');
  if (number(entity, 39) !== 0) throw new Error('nonzero thickness is unsupported in a 2D preview');
}
function sweep(start, end, full = false) {
  let angle = ((end - start) % TAU + TAU) % TAU;
  if (full || (Math.abs(angle) < 1e-12 && Math.abs(end - start) > 1e-12)) angle = TAU;
  if (angle < 1e-12) throw new Error('curve has no angular span');
  return angle;
}
function sampleCurve(center, axisX, axisY, start, angle, closed = false) {
  // At most 2 degrees per segment, including cardinal points for full circles.
  const segments = Math.max(2, Math.ceil(Math.abs(angle) / (Math.PI / 90)));
  const count = closed ? segments : segments + 1;
  return Array.from({ length: count }, (_, i) => {
    const t = start + angle * i / segments;
    return [center[0] + axisX[0] * Math.cos(t) + axisY[0] * Math.sin(t),
      center[1] + axisX[1] * Math.cos(t) + axisY[1] * Math.sin(t)];
  });
}
function polyline(vertices, closed) {
  if (vertices.length < 2 || vertices.length > LIMITS.pathPoints) throw new Error('polyline vertex count is unsupported');
  const points = [];
  const push = point => { if (points.length >= LIMITS.pathPoints) throw new Error('polyline exceeds the point limit'); points.push(point); };
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length];
    push(a.point);
    if ((!closed && i === vertices.length - 1) || Math.abs(a.bulge) < 1e-12) continue;
    const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1], chord = Math.hypot(dx, dy);
    if (chord <= 1e-12) throw new Error('curved polyline segment has coincident vertices');
    const angle = 4 * Math.atan(a.bulge);
    const offset = chord * (1 - a.bulge * a.bulge) / (4 * a.bulge);
    const center = [(a.point[0] + b.point[0]) / 2 - dy / chord * offset,
      (a.point[1] + b.point[1]) / 2 + dx / chord * offset];
    const radius = chord * (1 + a.bulge * a.bulge) / (4 * Math.abs(a.bulge));
    const start = Math.atan2(a.point[1] - center[1], a.point[0] - center[0]);
    for (const point of sampleCurve(center, [radius, 0], [0, radius], start, angle).slice(1, -1)) push(point);
  }
  return points;
}
function textContent(entity) {
  let raw = entity.groups.filter(p => p.code === 1 || p.code === 3).map(p => p.value).join('');
  if (raw.length > LIMITS.text) throw new Error('text exceeds the character limit');
  raw = raw.replace(/\\U\+([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\[ACFHQTW][^;]*;/gi, '')
    .replace(/\\[LlOoKk]/g, '').replace(/\\S([^;]*);/gi, (_, stack) => stack.replace(/[\^#]/g, '/'))
    .replace(/\\([{}\\])/g, '$1').replace(/[{}]/g, '')
    .replace(/%%d/gi, '°').replace(/%%p/gi, '±').replace(/%%c/gi, 'Ø')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return raw;
}
function parse(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('DXF input is empty.');
  if (buffer.length > LIMITS.bytes) throw new Error('DXF exceeds the 30 MB drawing limit.');
  if (buffer.subarray(0, 22).toString('ascii').startsWith('AutoCAD Binary DXF') || buffer.includes(0)) throw new Error('Binary DXF is unsupported; export ASCII DXF.');
  const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (lines.length % 2 || lines.length > LIMITS.pairs * 2) throw new Error('Malformed or oversized DXF group-code data.');
  const records = [], headers = [];
  let section = null, entity = null, ended = false, sawEntities = false;
  let applicationDepth = 0;
  for (let i = 0; i < lines.length; i += 2) {
    if (!/^\s*\d{1,4}\s*$/.test(lines[i])) throw new Error('Invalid DXF group code.');
    const code = Number(lines[i]), raw = lines[i + 1], text = raw.trim();
    if (code === 0 && (text.length > 64 || !/^[A-Z0-9_]+$/.test(text))) throw new Error('Invalid DXF record type.');
    if (ended) { if (code !== 999) throw new Error('DXF contains data after EOF.'); continue; }
    if (code === 0) {
      if (applicationDepth) throw new Error('Unclosed DXF application group.');
      if (text === 'SECTION') {
        if (section != null || Number(lines[i + 2]) !== 2) throw new Error('Invalid DXF section structure.');
        section = lines[i + 3]?.trim(); i += 2; entity = null;
        if (section === 'ENTITIES') sawEntities = true;
      } else if (text === 'ENDSEC') {
        if (section == null) throw new Error('Unexpected DXF ENDSEC.');
        section = null; entity = null;
      } else if (text === 'EOF') {
        if (section != null) throw new Error('DXF section is truncated before EOF.');
        ended = true; entity = null;
      } else {
        if (section == null) throw new Error('DXF entity outside a section.');
        if (records.length >= LIMITS.entities) throw new Error('DXF exceeds the 50000 entity limit.');
        entity = { type: text, section, groups: [] }; records.push(entity);
      }
    } else if (section == null) { if (code !== 999) throw new Error('DXF data outside a section.'); }
    else if (section === 'HEADER') headers.push({ code, value: text });
    else if (entity) {
      // Application data may use entity-like numeric groups. Do not interpret
      // arbitrary extension data as geometry, visibility or handles.
      if (code === 102) {
        if (text.startsWith('{')) applicationDepth += 1;
        else if (text === '}') { if (!applicationDepth) throw new Error('Unexpected DXF application group end.'); applicationDepth -= 1; }
      } else if (!applicationDepth && code < 1000) entity.groups.push({ code, value: [1, 3].includes(code) ? raw : text });
    }
  }
  if (!ended || !sawEntities || section != null) throw new Error('A complete ASCII DXF ENTITIES/ENDSEC/EOF structure is required.');
  const unitsIndex = headers.findIndex(pair => pair.code === 9 && pair.value === '$INSUNITS');
  const unitPair = headers[unitsIndex + 1];
  const unitsCode = unitsIndex >= 0 && unitPair?.code === 70 && /^\d+$/.test(unitPair.value) ? Number(unitPair.value) : 0;
  return { records, unitsCode };
}

/** Build model-space visual primitives without calculating measurements.
 *
 * Return { primitives, warnings, unitsCode, sourceUnits }. All coordinates and
 * text height remain in declared source units. A path is { id, type:'path',
 * points:[[x,y],...], closed, elevation, layer, lineweight? }; a text primitive
 * is { id, type:'text', point:[x,y], text, height, rotation, align, verticalAlign,
 * widthScale, elevation, layer }. Lineweight is raw DXF group 370, hundredths
 * of a millimetre. Rotation is degrees CCW. Curves are bounded
 * visual approximations, never measurement evidence. IDs retain actual source
 * handles; expanded block children use INSERT-handle/child-handle paths. Array
 * instances append [row,column] to the INSERT handle. Unsupported entities,
 * tilted planes, missing handles and incomplete cached dimensions are warned.
 * Malformed/binary files and file-level complexity violations throw an Error.
 */
export function buildDxfDrawing(buffer) {
  const { records, unitsCode } = parse(buffer);
  const warnings = [], warningSet = new Set();
  let additionalWarnings = false;
  const warn = original => {
    const message = original.length > 500 ? `${original.slice(0, 497)}...` : original;
    if (warningSet.has(message)) return;
    if (warnings.length >= 49) { additionalWarnings = true; return; }
    warningSet.add(message); warnings.push(message);
  };
  const layers = new Map(), blocks = new Map(), handles = new Map(), ambiguousBlocks = new Set();
  const entities = [];
  let block = null;
  for (const entity of records) {
    const handle = value(entity, 5).toUpperCase();
    if (handle) handles.set(handle, (handles.get(handle) || 0) + 1);
    if (entity.section === 'TABLES' && entity.type === 'LAYER') {
      const name = value(entity, 2).toUpperCase();
      if (name.length > 255) throw new Error('DXF layer name exceeds the drawing limit.');
      try { layers.set(name, { hidden: (integer(entity, 70) & 1) !== 0 || number(entity, 62, 7) < 0, lineweight: number(entity, 370, -1) }); }
      catch { warn(`Layer ${name} has invalid visibility data and is hidden.`); layers.set(name, { hidden: true }); }
    }
    if (entity.section === 'BLOCKS') {
      if (entity.type === 'BLOCK') {
        if (block) throw new Error('Nested or unclosed DXF BLOCK definitions.');
        const name = value(entity, 2).toUpperCase();
        if (!name || name.length > 255) throw new Error('Invalid DXF block name.');
        if (blocks.has(name)) { ambiguousBlocks.add(name); warn(`Duplicate block definition ${name} was omitted.`); }
        block = { definition: entity, entities: [], name }; blocks.set(name, block);
      } else if (entity.type === 'ENDBLK') {
        if (!block) throw new Error('Unexpected DXF ENDBLK.');
        block = null;
      } else { if (!block) throw new Error('DXF block entity outside a BLOCK definition.'); block.entities.push(entity); }
    } else if (entity.section === 'ENTITIES') entities.push(entity);
  }
  if (block) throw new Error('Unclosed DXF BLOCK definition.');
  const primitives = [];
  let totalPoints = 0, totalText = 0, visits = 0, exhausted = false;
  const budget = (points = 0, text = 0) => {
    if (primitives.length >= LIMITS.primitives || totalPoints + points > LIMITS.points || totalText + text > LIMITS.totalText) {
      exhausted = true; throw new Error('drawing complexity limit reached; remaining entities were omitted');
    }
    totalPoints += points; totalText += text;
  };
  function emitPath(points, closed, elevation, context, id, layer, lineweight) {
    if (points.length < 2 || points.length > LIMITS.pathPoints) throw new Error('path exceeds the point limit');
    const transformed = points.map(point => transform(context.matrix, point));
    const z = context.z + elevation * context.zScale;
    if (!Number.isFinite(z) || Math.abs(z) > 1e12) throw new Error('invalid transformed elevation');
    budget(points.length);
    primitives.push({ id, type: 'path', points: transformed, closed, elevation: z, layer,
      ...(lineweight >= 0 ? { lineweight } : {}) });
  }
  function visit(list, context) {
    for (let index = 0; index < list.length && !exhausted; index += 1) {
      const entity = list[index];
      visits += 1;
      if (visits > LIMITS.visits) { warn('Drawing expansion complexity limit reached; remaining entities were omitted.'); exhausted = true; return; }
      // Sequence children belong to the POLYLINE and do not produce primitives.
      if (['VERTEX', 'SEQEND', 'ATTRIB', 'ATTDEF'].includes(entity.type)) {
        if (['ATTRIB', 'ATTDEF'].includes(entity.type)) warn('Block attribute text is unsupported and was omitted.');
        continue;
      }
      const rawHandle = value(entity, 5).toUpperCase();
      const id = context.path ? `${context.path}/${rawHandle}` : rawHandle;
      try {
        if (integer(entity, 67) !== 0 || !/^(?:|model)$/i.test(value(entity, 410).trim()) || integer(entity, 60) !== 0) continue;
        const originalLayer = value(entity, 8, '0');
        if (originalLayer.length > 255) throw new Error('layer name exceeds the drawing limit');
        const layer = originalLayer === '0' && context.layer ? context.layer : originalLayer;
        if (layers.get(originalLayer.toUpperCase())?.hidden || layers.get(layer.toUpperCase())?.hidden || number(entity, 62, 256) < 0) continue;
        if (entity.groups.filter(pair => pair.code === 5).length !== 1) throw new Error('source handle is missing or repeated');
        if (!/^[0-9A-F]{1,64}$/.test(rawHandle)) throw new Error('a valid source handle is missing');
        if (handles.get(rawHandle) > 1) throw new Error('duplicate source handle is ambiguous');
        checkPlane(entity);
        let lineweight = number(entity, 370, -1);
        if (lineweight === -1) lineweight = layers.get(layer.toUpperCase())?.lineweight ?? -1;
        if (lineweight === -2) lineweight = context.lineweight ?? -1;
        if (lineweight < -3 || lineweight > 211 || !Number.isInteger(lineweight)) { warn(`DXF ${entity.type} ${rawHandle}: invalid lineweight was omitted.`); lineweight = -1; }
        const path = (points, closed, z = number(entity, 30)) => emitPath(points, closed, z, context, id, layer, lineweight);
        if (entity.type === 'LINE') {
          const z = number(entity, 30);
          if (Math.abs(number(entity, 31) - z) > 1e-8) throw new Error('nonplanar line is unsupported');
          path([requiredPoint(entity), requiredPoint(entity, 11)], false, z);
        } else if (entity.type === 'LWPOLYLINE') {
          const vertices = []; let vertex = null;
          for (const pair of entity.groups) {
            if (pair.code === 10) { vertex = { point: [parseNumber(pair.value, 10), NaN], bulge: 0, hasY: false, hasBulge: false }; vertices.push(vertex); }
            else if (pair.code === 20 && vertex) { if (vertex.hasY) throw new Error('duplicate polyline Y coordinate'); vertex.point[1] = parseNumber(pair.value, 20); vertex.hasY = true; }
            else if (pair.code === 42 && vertex) { if (vertex.hasBulge) throw new Error('duplicate polyline bulge'); vertex.bulge = parseNumber(pair.value, 42); vertex.hasBulge = true; }
            else if ([20, 42].includes(pair.code)) throw new Error('polyline vertex data is malformed');
          }
          if (vertices.length !== integer(entity, 90, vertices.length)) throw new Error('polyline vertex count is inconsistent');
          if (vertices.some(v => [...v.point, v.bulge].some(n => !Number.isFinite(n) || Math.abs(n) > 1e12))) throw new Error('invalid polyline coordinates');
          const flags = integer(entity, 70);
          if (flags < 0 || flags > 129 || (flags & ~(1 | 128))) throw new Error('invalid lightweight polyline flags');
          const closed = !!(flags & 1);
          path(polyline(vertices, closed), closed, number(entity, 38));
          if (entity.groups.some(p => [40, 41, 43].includes(p.code) && Number(p.value) !== 0)) warn('Polyline width is shown as a centerline in the drawing preview.');
        } else if (entity.type === 'POLYLINE') {
          if (integer(entity, 70) < 0 || integer(entity, 70) > 129 || integer(entity, 70) & (2 | 4 | 8 | 16 | 32 | 64)) throw new Error('3D, fitted or mesh polyline is unsupported');
          const vertices = [];
          let next = index + 1;
          while (list[next]?.type === 'VERTEX') {
            const child = list[next++];
            if (integer(child, 70) & (1 | 2 | 8 | 16 | 32 | 64 | 128)) throw new Error('fitted or 3D polyline vertex is unsupported');
            if (number(child, 30) !== 0) throw new Error('nonplanar polyline vertex is unsupported');
            vertices.push({ point: requiredPoint(child), bulge: number(child, 42) });
            if (vertices.length > LIMITS.pathPoints) throw new Error('polyline exceeds the vertex limit');
          }
          if (list[next]?.type !== 'SEQEND') throw new Error('polyline has no closing SEQEND');
          index = next;
          const closed = !!(integer(entity, 70) & 1);
          path(polyline(vertices, closed), closed);
        } else if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
          const center = requiredPoint(entity), radius = number(entity, 40, NaN);
          if (radius <= 0) throw new Error('curve radius must be positive');
          const closed = entity.type === 'CIRCLE';
          const start = closed ? 0 : number(entity, 50, NaN) * DEG;
          const angle = closed ? TAU : sweep(start, number(entity, 51, NaN) * DEG);
          path(sampleCurve(center, [radius, 0], [0, radius], start, angle, closed), closed);
        } else if (entity.type === 'ELLIPSE') {
          if (Math.abs(number(entity, 31)) > 1e-8) throw new Error('tilted ellipse axis is unsupported');
          const center = requiredPoint(entity), axis = requiredPoint(entity, 11), ratio = number(entity, 40, NaN);
          if (Math.hypot(...axis) <= 0 || ratio <= 0 || ratio > 1) throw new Error('invalid ellipse axes');
          const start = number(entity, 41, 0), end = number(entity, 42, TAU), angle = sweep(start, end);
          const closed = Math.abs(angle - TAU) < 1e-10;
          path(sampleCurve(center, axis, [-axis[1] * ratio, axis[0] * ratio], start, angle, closed), closed);
        } else if (entity.type === 'TEXT' || entity.type === 'MTEXT') {
          const text = textContent(entity), height = number(entity, 40, NaN);
          if (!text) continue;
          if (height <= 0) throw new Error('text height must be positive');
          if (entity.type === 'MTEXT' && (integer(entity, 75) !== 0 || ![1, 5].includes(integer(entity, 72, 1)))) throw new Error('vertical or column text layout is unsupported');
          const horizontal = integer(entity, entity.type === 'TEXT' ? 72 : 71, entity.type === 'TEXT' ? 0 : 1);
          const vertical = entity.type === 'TEXT' ? integer(entity, 73) : Math.floor((horizontal - 1) / 3);
          if (entity.type === 'TEXT' && (![0, 1, 2, 4].includes(horizontal) || integer(entity, 71) !== 0 || number(entity, 51) !== 0)) throw new Error('fitted, mirrored or oblique text is unsupported');
          if (entity.type === 'MTEXT' && (horizontal < 1 || horizontal > 9)) throw new Error('invalid text attachment');
          if (entity.type === 'TEXT' && (vertical < 0 || vertical > 3)) throw new Error('invalid text vertical alignment');
          const aligned = entity.type === 'TEXT' && (horizontal !== 0 || vertical !== 0);
          const point = requiredPoint(entity, aligned ? 11 : 10), elevation = number(entity, aligned ? 31 : 30);
          let angle = number(entity, 50) * (entity.type === 'TEXT' ? DEG : 1);
          if (entity.type === 'MTEXT') {
            const directionIndex = entity.groups.findLastIndex(p => p.code === 11), angleIndex = entity.groups.findLastIndex(p => p.code === 50);
            if (directionIndex >= 0 && directionIndex > angleIndex) {
              const direction = requiredPoint(entity, 11);
              if (number(entity, 31) !== 0 || Math.hypot(...direction) <= 0) throw new Error('invalid text direction');
              angle = Math.atan2(direction[1], direction[0]);
            }
          }
          const m = context.matrix, ca = Math.cos(angle), sa = Math.sin(angle);
          const x = [m[0] * ca + m[2] * sa, m[1] * ca + m[3] * sa], y = [-m[0] * sa + m[2] * ca, -m[1] * sa + m[3] * ca];
          const sx = Math.hypot(...x), sy = Math.hypot(...y);
          if (sx <= 0 || sy <= 0 || x[0] * y[1] - x[1] * y[0] <= 0 || Math.abs(x[0] * y[0] + x[1] * y[1]) > sx * sy * 1e-8) throw new Error('skewed or mirrored block text is unsupported');
          const width = entity.type === 'TEXT' ? number(entity, 41, 1) : 1;
          if (width <= 0) throw new Error('invalid text width');
          const z = context.z + elevation * context.zScale;
          if (!Number.isFinite(z) || Math.abs(z) > 1e12 || !Number.isFinite(height * sy) || height * sy > 1e12) throw new Error('invalid transformed text size');
          const widthScale = sx / sy * width;
          if (!Number.isFinite(widthScale) || widthScale > 1e4) throw new Error('transformed text width exceeds the drawing limit');
          const transformedPoint = transform(m, point);
          budget(1, text.length);
          primitives.push({ id, type: 'text', point: transformedPoint, text, height: height * sy,
            rotation: Math.atan2(x[1], x[0]) / DEG,
            align: entity.type === 'TEXT' ? (horizontal === 2 ? 'end' : [1, 4].includes(horizontal) ? 'middle' : 'start') : ['start', 'middle', 'end'][(horizontal - 1) % 3],
            verticalAlign: entity.type === 'TEXT' ? (horizontal === 4 ? 'middle' : ['baseline', 'bottom', 'middle', 'top'][vertical]) : ['top', 'middle', 'bottom'][vertical],
            widthScale, elevation: z, layer });
          if (value(entity, 7, 'STANDARD').toUpperCase() !== 'STANDARD' || entity.groups.some(p => [1, 3].includes(p.code) && /\\[ACFHQTWSps]/i.test(p.value))) warn('CAD text styles and formatting use a plain font in the drawing preview.');
          if (entity.type === 'MTEXT' && number(entity, 41) > 0) warn('MTEXT uses plain font rendering; automatic CAD wrapping and font metrics may differ.');
        } else if (entity.type === 'INSERT' || entity.type === 'DIMENSION') {
          if (entity.type === 'DIMENSION' && [12, 22, 32].some(code => number(entity, code) !== 0)) throw new Error('dimension clone insertion override is unsupported');
          const name = value(entity, 2).trim().toUpperCase(), target = blocks.get(name);
          if (!target || ambiguousBlocks.has(name)) throw new Error(`${entity.type === 'DIMENSION' ? 'dimension has no usable cached drawing block' : `block ${name} is missing or ambiguous`}`);
          if (context.stack.includes(name) || context.stack.length >= LIMITS.blockDepth) throw new Error('recursive block or block depth limit reached');
          if (integer(target.definition, 70) & (4 | 8 | 16)) throw new Error('external reference block is unsupported');
          const base = [number(target.definition, 10), number(target.definition, 20)], bz = number(target.definition, 30);
          const isInsert = entity.type === 'INSERT';
          const position = isInsert ? requiredPoint(entity) : [0, 0], z = isInsert ? number(entity, 30) : 0;
          const sx = isInsert ? number(entity, 41, 1) : 1, sy = isInsert ? number(entity, 42, 1) : 1, sz = isInsert ? number(entity, 43, 1) : 1;
          if (sx === 0 || sy === 0 || sz === 0) throw new Error('block has zero scale');
          const rotation = isInsert ? number(entity, 50) * DEG : 0, co = Math.cos(rotation), si = Math.sin(rotation);
          const columns = isInsert ? integer(entity, 70, 1) : 1, rows = isInsert ? integer(entity, 71, 1) : 1;
          if (columns < 1 || rows < 1 || columns * rows > LIMITS.array) throw new Error('block array exceeds the instance limit');
          const columnSpacing = isInsert ? number(entity, 44) : 0, rowSpacing = isInsert ? number(entity, 45) : 0;
          for (let row = 0; row < rows && !exhausted; row += 1) for (let column = 0; column < columns && !exhausted; column += 1) {
            const ox = column * columnSpacing, oy = row * rowSpacing;
            const local = [co * sx, si * sx, -si * sy, co * sy,
              position[0] + co * ox - si * oy - co * sx * base[0] + si * sy * base[1],
              position[1] + si * ox + co * oy - si * sx * base[0] - co * sy * base[1]];
            visit(target.entities, { matrix: compose(context.matrix, local), z: context.z + context.zScale * (z - bz * sz),
              zScale: context.zScale * sz, layer, lineweight, path: columns * rows > 1 ? `${id}[${row},${column}]` : id, stack: [...context.stack, name] });
          }
        } else warn(`Unsupported DXF ${entity.type} entities were omitted from the drawing preview.`);
      } catch (error) { warn(`DXF ${entity.type} ${rawHandle || '(missing handle)'}: ${error.message}.`); }
    }
  }
  visit(entities, { matrix: IDENTITY, z: 0, zScale: 1, layer: '0', lineweight: -1, path: '', stack: [] });
  if (exhausted && !warnings.some(message => /complexity limit/.test(message))) {
    if (warnings.length >= 49) { warnings.pop(); additionalWarnings = true; }
    warnings.push('Drawing complexity limit reached; remaining entities were omitted.');
  }
  if (!UNITS.has(unitsCode)) warn('Drawing units are unspecified or unsupported; preview coordinates remain in source drawing units.');
  if (!primitives.length) warn('No supported visible planar DXF drawing entities were found.');
  if (additionalWarnings) warnings.push('Additional DXF entities were omitted or simplified; warning details were limited to keep the preview bounded.');
  return { primitives, warnings, sourceUnits: UNITS.get(unitsCode) || null, unitsCode };
}
