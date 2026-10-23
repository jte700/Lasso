// STEP (ISO 10303-21) reader for AP203, AP214 and AP242 CAD exchange files.
// Product structure, units and B-rep topology come from explicit records.
// Measurements use exact analytic edge geometry in the declared length unit;
// an extent that cannot be bounded exactly is omitted rather than estimated.
import { createHash } from 'node:crypto';

const MAX_BYTES = 64_000_000;
const MAX_RECORDS = 1_500_000;
const MAX_OCCURRENCES = 20_000;
const MAX_EDGES = 400_000;
const MAX_ASSEMBLY_DEPTH = 32;
const TAU = Math.PI * 2;
// Full cylinders and circles must leave no angular gap wider than this.
const FULL_TURN_GAP = Math.PI / 12;
const PREFIX = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 0.001, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };
const SI_LENGTH = { '': 'm', MILLI: 'mm', CENTI: 'cm', DECI: 'dm', KILO: 'km', MICRO: 'µm' };
const NAMED_LENGTH = [['in', 25.4], ['ft', 304.8], ['yd', 914.4], ['mil', 0.0254]];
const BODY_TYPES = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']);
const RULED = new Set(['plane', 'cylinder', 'extrusion']);
export class StepReadError extends Error {
  constructor(message, status = 'error') { super(message); this.status = status; }
}

// ── vectors and rigid transforms ─────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const along = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function normalize(vector) {
  const size = Math.hypot(vector[0], vector[1], vector[2]);
  return size > 1e-300 ? [vector[0] / size, vector[1] / size, vector[2] / size] : null;
}
const mod = (value, period) => ((value % period) + period) % period;
// Large point sets must not be spread into Math.min/Math.max arguments.
function extremes(values) {
  let min = Infinity, max = -Infinity;
  for (const value of values) { if (value < min) min = value; if (value > max) max = value; }
  return [min, max];
}

export const IDENTITY = Object.freeze({ r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] });
export const rotate = (m, v) => [m.r[0] * v[0] + m.r[1] * v[1] + m.r[2] * v[2],
  m.r[3] * v[0] + m.r[4] * v[1] + m.r[5] * v[2], m.r[6] * v[0] + m.r[7] * v[1] + m.r[8] * v[2]];
export const transformPoint = (m, p) => { const q = rotate(m, p); return [q[0] + m.t[0], q[1] + m.t[1], q[2] + m.t[2]]; };
export const inverseRotate = (m, v) => [m.r[0] * v[0] + m.r[3] * v[1] + m.r[6] * v[2],
  m.r[1] * v[0] + m.r[4] * v[1] + m.r[7] * v[2], m.r[2] * v[0] + m.r[5] * v[1] + m.r[8] * v[2]];
/** a ∘ b: apply b, then a. */
export function compose(a, b) {
  const r = [];
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
    r.push(a.r[row * 3] * b.r[column] + a.r[row * 3 + 1] * b.r[3 + column] + a.r[row * 3 + 2] * b.r[6 + column]);
  }
  return { r, t: transformPoint(a, b.t) };
}
function invert(m) {
  const r = [m.r[0], m.r[3], m.r[6], m.r[1], m.r[4], m.r[7], m.r[2], m.r[5], m.r[8]];
  const t = rotate({ r }, m.t);
  return { r, t: [-t[0], -t[1], -t[2]] };
}
// ISO 10303-42 build_axes: an absent or parallel reference direction falls
// back to the projected X axis, or Y when the placement axis is ±X.
function frame(origin, z, xHint) {
  const axis = normalize(z ?? [0, 0, 1]) ?? [0, 0, 1];
  const project = (vector) => vector && normalize(along(vector, axis, -dot(vector, axis)));
  const reference = project(xHint) ?? project(Math.abs(axis[0]) < 1 - 1e-12 ? [1, 0, 0] : [0, 1, 0]);
  const y = cross(axis, reference);
  return { r: [reference[0], y[0], axis[0], reference[1], y[1], axis[1], reference[2], y[2], axis[2]], t: origin };
}

// ── ISO 10303-21 syntax ──────────────────────────────────────────────────────
function decodeString(value) {
  return value.replace(/\\X([24])\\([0-9a-f]+)\\X0\\/gi, (_, size, hex) => {
    const width = Number(size) * 2;
    if (hex.length % width) return '';
    let output = '';
    for (let index = 0; index < hex.length; index += width) {
      const code = parseInt(hex.slice(index, index + width), 16);
      if (code > 0x10ffff) return '';
      output += String.fromCodePoint(code);
    }
    return output;
  }).replace(/\\X\\([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, character) => String.fromCharCode(character.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const ENUMERATION = /\.([A-Za-z_][A-Za-z0-9_]*)\./y;

/** Parse a record body. Simple instances return {type, args}; complex
 * (multi-leaf) instances return {type: null, parts: Map(name → args)}. */
export function parseStepRecord(text) {
  let cursor = 0;
  const space = () => { while (cursor < text.length && text.charCodeAt(cursor) <= 32) cursor++; };
  function value(depth) {
    if (depth > 64) throw new Error('STEP value nesting exceeds the supported limit.');
    space();
    const character = text[cursor];
    if (character === "'") {
      let output = '';
      cursor++;
      for (;;) {
        const close = text.indexOf("'", cursor);
        if (close < 0) throw new Error('Unterminated STEP string.');
        output += text.slice(cursor, close);
        if (text[close + 1] === "'") { output += "'"; cursor = close + 2; } else { cursor = close + 1; break; }
      }
      return decodeString(output);
    }
    if (character === '(') { cursor++; return list(depth + 1); }
    if (character === '#') {
      const start = ++cursor;
      while (text.charCodeAt(cursor) >= 48 && text.charCodeAt(cursor) <= 57) cursor++;
      if (start === cursor) throw new Error('Invalid STEP instance reference.');
      return { ref: Number(text.slice(start, cursor)) };
    }
    if (character === '$' || character === '*') { cursor++; return null; }
    if (character === '"') {
      const close = text.indexOf('"', cursor + 1);
      if (close < 0) throw new Error('Unterminated STEP binary value.');
      cursor = close + 1;
      return null;
    }
    if (character === '.') {
      ENUMERATION.lastIndex = cursor;
      const match = ENUMERATION.exec(text);
      if (match) { cursor = ENUMERATION.lastIndex; return match[1].toUpperCase(); }
    }
    NUMBER.lastIndex = cursor;
    let match = NUMBER.exec(text);
    if (match) { cursor = NUMBER.lastIndex; return Number(match[0]); }
    NAME.lastIndex = cursor;
    match = NAME.exec(text);
    if (match) {
      cursor = NAME.lastIndex;
      space();
      if (text[cursor++] !== '(') throw new Error('Invalid STEP typed value.');
      return { type: match[0].toUpperCase(), args: list(depth + 1) };
    }
    throw new Error('Invalid STEP parameter value.');
  }
  function list(depth) {
    const values = [];
    space();
    if (text[cursor] === ')') { cursor++; return values; }
    for (;;) {
      values.push(value(depth));
      space();
      const next = text[cursor++];
      if (next === ')') return values;
      if (next !== ',') throw new Error('Invalid STEP parameter separator.');
    }
  }
  space();
  let result;
  if (text[cursor] === '(') {
    cursor++;
    const parts = new Map();
    for (;;) {
      space();
      if (text[cursor] === ')') { cursor++; break; }
      const typed = value(1);
      if (!typed || typeof typed !== 'object' || !typed.type) throw new Error('Invalid complex STEP instance.');
      parts.set(typed.type, typed.args);
    }
    result = { type: null, parts };
  } else {
    const typed = value(0);
    if (!typed || typeof typed !== 'object' || !typed.type) throw new Error('Invalid STEP instance.');
    result = typed;
  }
  space();
  if (cursor !== text.length) throw new Error('Unexpected text after a STEP instance.');
  return result;
}

function stepStatements(source) {
  // Comments are blanked outside strings; quoted text may contain ';'.
  const clean = source.replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\//g, (part) => part.startsWith('/*') ? ' ' : part);
  const statements = [];
  const pattern = /'(?:[^']|'')*'|;/g;
  let start = 0;
  for (let match = pattern.exec(clean); match; match = pattern.exec(clean)) {
    if (match[0] !== ';') continue;
    statements.push(clean.slice(start, match.index).trim());
    start = match.index + 1;
    if (statements.length > MAX_RECORDS + 1000) throw new StepReadError('STEP exceeds the 1,500,000 record limit.', 'unsupported');
  }
  if (clean.slice(start).trim()) throw new StepReadError('Truncated STEP exchange file.');
  return statements;
}

// ── units and representation contexts ───────────────────────────────────────
function partsOf(record) {
  if (!record) return new Map();
  return record.type ? new Map([[record.type, record.args]]) : record.parts;
}
const refOf = (value) => value && typeof value === 'object' && Number.isInteger(value.ref) ? value.ref : null;
const measure = (value) => typeof value === 'number' ? value : value && typeof value === 'object' && value.type ? measure(value.args?.[0]) : null;

/** Readable unit label for a length expressed as millimetres per unit. */
function lengthLabel(mmPerUnit, name = '') {
  const named = NAMED_LENGTH.find(([, size]) => Math.abs(size - mmPerUnit) <= size * 1e-9);
  if (named) return named[0];
  const si = Object.entries(SI_LENGTH).find(([prefix]) => Math.abs((prefix ? PREFIX[prefix] : 1) * 1000 - mmPerUnit) <= mmPerUnit * 1e-12);
  return si?.[1] ?? (/^(?:inch|in)$/i.test(name) ? 'in' : null);
}

// ── curve evaluation ─────────────────────────────────────────────────────────
function expandKnots(knots, multiplicities) {
  const expanded = [];
  knots.forEach((knot, index) => { for (let count = 0; count < (multiplicities[index] ?? 0); count++) expanded.push(knot); });
  return expanded;
}
function implicitKnots(kind, degree, count) {
  if (kind === 'UNIFORM') return Array.from({ length: count + degree + 1 }, (_, index) => index - degree);
  if (kind === 'QUASI_UNIFORM') {
    const interior = count - degree - 1;
    return [...Array(degree + 1).fill(0), ...Array.from({ length: interior }, (_, index) => index + 1), ...Array(degree + 1).fill(interior + 1)];
  }
  // Piecewise Bézier: degree-multiplicity interior breaks.
  const segments = (count - 1) / degree;
  if (!Number.isInteger(segments) || segments < 1) return null;
  const knots = Array(degree + 1).fill(0);
  for (let segment = 1; segment < segments; segment++) knots.push(...Array(degree).fill(segment));
  knots.push(...Array(degree + 1).fill(segments));
  return knots;
}
export function evaluateBSpline(curve, parameter) {
  const { degree: p, knots: U, points: P, weights: W } = curve;
  const n = P.length - 1;
  let t = Math.min(Math.max(parameter, U[p]), U[n + 1]);
  let k;
  if (t >= U[n + 1]) { k = n; while (k > p && U[k] >= U[k + 1]) k--; t = U[n + 1]; } else {
    let low = p, high = n + 1;
    while (high - low > 1) { const middle = (low + high) >> 1; if (U[middle] <= t) low = middle; else high = middle; }
    k = low;
  }
  const d = [];
  for (let j = 0; j <= p; j++) {
    const weight = W ? W[k - p + j] : 1, point = P[k - p + j];
    d.push([point[0] * weight, point[1] * weight, point[2] * weight, weight]);
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const denominator = U[j + 1 + k - r] - U[j + k - p];
      const alpha = denominator ? (t - U[j + k - p]) / denominator : 0;
      for (let axis = 0; axis < 4; axis++) d[j][axis] = (1 - alpha) * d[j - 1][axis] + alpha * d[j][axis];
    }
  }
  const w = d[p][3] || 1;
  return [d[p][0] / w, d[p][1] / w, d[p][2] / w];
}
function refine(evaluate, low, high, score) {
  // Golden-section search for the maximum of a unimodal neighbourhood.
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = low, b = high, c = b - ratio * (b - a), d = a + ratio * (b - a);
  let fc = score(evaluate(c)), fd = score(evaluate(d));
  for (let iteration = 0; iteration < 80 && b - a > 1e-14 * Math.max(1, Math.abs(a)); iteration++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - ratio * (b - a); fc = score(evaluate(c)); }
    else { a = c; c = d; fc = fd; d = a + ratio * (b - a); fd = score(evaluate(d)); }
  }
  return [[c, fc], [d, fd], [low, score(evaluate(low))], [high, score(evaluate(high))]]
    .reduce((best, [t, value]) => value > best.value ? { t, value } : best, { t: low, value: -Infinity });
}
function inArc(angle, start, sweep) { return mod(angle - start, TAU) <= sweep + 1e-12; }

/** Exact [min, max] of d·p along an edge; B-spline extremes are refined
 * from their samples unless only an approximate span is requested. */
export function edgeRange(edge, d, precise = true) {
  if (edge.kind === 'line') { const a = dot(d, edge.p0), b = dot(d, edge.p1); return [Math.min(a, b), Math.max(a, b)]; }
  if (edge.kind === 'circle' || edge.kind === 'ellipse') {
    const a = edge.kind === 'circle' ? edge.radius : edge.semiAxes[0], b = edge.kind === 'circle' ? edge.radius : edge.semiAxes[1];
    const dx = dot(d, edge.xdir), dy = dot(d, edge.ydir), base = dot(d, edge.center);
    const at = (angle) => base + a * Math.cos(angle) * dx + b * Math.sin(angle) * dy;
    const values = [at(edge.start), at(edge.start + edge.sweep)];
    const peak = Math.atan2(b * dy, a * dx);
    for (const angle of [peak, peak + Math.PI]) if (inArc(angle, edge.start, edge.sweep)) values.push(at(angle));
    return extremes(values);
  }
  if (edge.kind === 'bspline' && !precise) {
    return extremes(edge.samples.map((sample) => dot(d, sample.point)));
  }
  if (edge.kind === 'bspline') {
    const evaluate = (t) => evaluateBSpline(edge.curve, t);
    const range = [];
    for (const sign of [-1, 1]) {
      const score = (point) => sign * dot(d, point);
      let best = 0;
      edge.samples.forEach((sample, index) => { if (score(sample.point) > score(edge.samples[best].point)) best = index; });
      const low = edge.samples[Math.max(0, best - 1)].t, high = edge.samples[Math.min(edge.samples.length - 1, best + 1)].t;
      range.push(sign * refine(evaluate, low, high, score).value);
    }
    return range;
  }
  return extremes((edge.points ?? [edge.p0, edge.p1]).map((point) => dot(d, point)));
}

// Edge parameters run along the curve: angles for conics, knots for B-splines,
// and from p0 to p1 for lines.
function edgeEnds(edge) {
  if (edge.kind === 'circle' || edge.kind === 'ellipse') return [edge.start, edge.start + edge.sweep];
  if (edge.kind === 'bspline') return [edge.t0, edge.t1];
  if (edge.kind === 'polyline') return [0, edge.points.length - 1];
  return [0, 1];
}
function edgePoint(edge, parameter) {
  if (edge.kind === 'circle' || edge.kind === 'ellipse') {
    const a = edge.kind === 'circle' ? edge.radius : edge.semiAxes[0], b = edge.kind === 'circle' ? edge.radius : edge.semiAxes[1];
    return along(along(edge.center, edge.xdir, a * Math.cos(parameter)), edge.ydir, b * Math.sin(parameter));
  }
  if (edge.kind === 'bspline') return evaluateBSpline(edge.curve, parameter);
  if (edge.kind === 'polyline') return edge.points[parameter];
  return parameter ? edge.p1 : edge.p0;
}
/** Tangent where the parameter increases; one-sided at a B-spline's ends. */
function edgeTangent(edge, parameter) {
  if (edge.kind === 'circle' || edge.kind === 'ellipse') {
    const a = edge.kind === 'circle' ? edge.radius : edge.semiAxes[0], b = edge.kind === 'circle' ? edge.radius : edge.semiAxes[1];
    return along(along([0, 0, 0], edge.xdir, -a * Math.sin(parameter)), edge.ydir, b * Math.cos(parameter));
  }
  if (edge.kind === 'bspline') {
    const step = (edge.t1 - edge.t0) * 1e-6;
    return sub(evaluateBSpline(edge.curve, Math.min(edge.t1, parameter + step)), evaluateBSpline(edge.curve, Math.max(edge.t0, parameter - step)));
  }
  if (edge.kind === 'polyline') {
    const index = Math.min(Math.max(parameter, 1), edge.points.length - 1);
    return sub(edge.points[index], edge.points[index - 1]);
  }
  return sub(edge.p1, edge.p0);
}
/** Highest point of an edge along d: its value and parameter, and whether it
 * lies at the curve's start or end, inside it, or at a polyline corner. */
function edgePeak(edge, d) {
  const [first, last] = edgeEnds(edge);
  const candidates = [first, last];
  if (edge.kind === 'circle' || edge.kind === 'ellipse') {
    const a = edge.kind === 'circle' ? edge.radius : edge.semiAxes[0], b = edge.kind === 'circle' ? edge.radius : edge.semiAxes[1];
    const offset = mod(Math.atan2(b * dot(d, edge.ydir), a * dot(d, edge.xdir)) - edge.start, TAU);
    if (offset > 1e-9 && offset < edge.sweep - 1e-9) candidates.push(edge.start + offset);
  } else if (edge.kind === 'bspline') {
    let best = 0;
    edge.samples.forEach((sample, index) => { if (dot(d, sample.point) > dot(d, edge.samples[best].point)) best = index; });
    const low = edge.samples[Math.max(0, best - 1)].t, high = edge.samples[Math.min(edge.samples.length - 1, best + 1)].t;
    const { t } = refine((value) => evaluateBSpline(edge.curve, value), low, high, (point) => dot(d, point));
    if (t - first > (last - first) * 1e-9 && last - t > (last - first) * 1e-9) candidates.push(t);
  } else if (edge.kind === 'polyline') {
    for (let index = 1; index < last; index++) candidates.push(index);
  }
  let peak = null;
  for (const parameter of candidates) {
    const value = dot(d, edgePoint(edge, parameter));
    // An interior candidate wins ties, so a level edge is judged at a smooth point.
    if (!peak || value > peak.value || (value === peak.value && parameter !== first && parameter !== last)) peak = { value, parameter };
  }
  peak.at = peak.parameter === first ? 'start' : peak.parameter === last ? 'end' : edge.kind === 'polyline' ? 'corner' : 'inside';
  return peak;
}

/** Points along an edge, with arcs divided at no more than maxStep radians. */
export function sampleEdge(edge, maxStep = Math.PI / 18) {
  if (edge.kind === 'circle' || edge.kind === 'ellipse') {
    const a = edge.kind === 'circle' ? edge.radius : edge.semiAxes[0], b = edge.kind === 'circle' ? edge.radius : edge.semiAxes[1];
    const steps = Math.max(2, Math.ceil(edge.sweep / maxStep));
    return Array.from({ length: steps + 1 }, (_, index) => {
      const angle = edge.start + edge.sweep * index / steps;
      return along(along(edge.center, edge.xdir, a * Math.cos(angle)), edge.ydir, b * Math.sin(angle));
    });
  }
  if (edge.kind === 'bspline') return edge.samples.map((sample) => sample.point);
  if (edge.kind === 'polyline') return [...edge.points];
  return [edge.p0, edge.p1];
}

/** [min, max] of a whole surface along d, or null if unbounded. Exact for
 * spheres and tori; conservative for cones and B-spline surfaces. */
function surfaceBound(surface, d) {
  if (surface.kind === 'sphere') { const c = dot(d, surface.center); return [c - surface.radius, c + surface.radius]; }
  if (surface.kind === 'torus') {
    const c = dot(d, surface.center), axial = dot(d, surface.axis);
    const radial = Math.sqrt(Math.max(0, 1 - axial * axial));
    const reach = surface.major * radial + surface.minor;
    return [c - reach, c + reach];
  }
  if (surface.kind === 'cone') {
    // Rulings end on the boundary or at the apex, which may be inside the face.
    if (!surface.apex) return null;
    const apex = dot(d, surface.apex);
    return [apex, apex];
  }
  if (surface.kind === 'bspline-surface') return extremes(surface.points.map((point) => dot(d, point)));
  return null;
}

// ── model reader ─────────────────────────────────────────────────────────────
/** Throws StepReadError; its status distinguishes unsupported from invalid
 * input. The parsed model is not cached: callers keep only derived results. */
export function readStepModel(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return { ...readModel(bytes), sourceHash: createHash('sha256').update(bytes).digest('hex') };
}

function readModel(bytes) {
  if (!bytes.length) throw new StepReadError('STEP input is empty.');
  if (bytes.length > MAX_BYTES) throw new StepReadError('STEP exceeds the 64 MB extraction limit.', 'unsupported');
  const source = bytes.toString('utf8').replace(/^﻿/, '');
  if (!/^\s*ISO-10303-21\s*;/i.test(source.slice(0, 4096))) throw new StepReadError('Expected a STEP ISO-10303-21 exchange file.');
  const statements = stepStatements(source);
  if (!/^ISO-10303-21$/i.test(statements[0] ?? '') || !/^HEADER$/i.test(statements[1] ?? '') || !/^END-ISO-10303-21$/i.test(statements.at(-1) ?? '')) {
    throw new StepReadError('Expected one STEP HEADER section and a closing END-ISO-10303-21 statement.');
  }
  const header = [];
  const records = new Map();
  const byType = new Map();
  let section = 'HEADER';
  for (const statement of statements.slice(2, -1)) {
    if (/^ENDSEC$/i.test(statement)) { section = null; continue; }
    if (/^DATA\b/i.test(statement) && !section) { section = 'DATA'; continue; }
    if (section === 'HEADER') { header.push(statement); continue; }
    if (section !== 'DATA') throw new StepReadError('STEP contains a statement outside its HEADER and DATA sections.');
    const match = statement.match(/^#(\d+)\s*=\s*([\s\S]*)$/);
    if (!match) throw new StepReadError('Invalid instance in the STEP DATA section.');
    const id = Number(match[1]);
    if (records.has(id)) throw new StepReadError(`Duplicate STEP instance #${id}.`);
    if (records.size >= MAX_RECORDS) throw new StepReadError('STEP exceeds the 1,500,000 record limit.', 'unsupported');
    const type = match[2].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1]?.toUpperCase() ?? null;
    const record = { id, type, text: match[2] };
    if (!type) {
      // Complex instances (units, rational splines, placed relationships)
      // are parsed eagerly so each leaf entity can be found by name.
      try { Object.assign(record, parseStepRecord(match[2])); } catch (error) { throw new StepReadError(`#${id}: ${error.message}`); }
    }
    records.set(id, record);
    for (const name of type ? [type] : record.parts.keys()) {
      if (!byType.has(name)) byType.set(name, []);
      byType.get(name).push(id);
    }
  }
  if (section) throw new StepReadError('A STEP section is not closed with ENDSEC.');
  if (!records.size) throw new StepReadError('The STEP DATA section is empty.');

  const headerValue = (name) => {
    const statement = header.find((part) => new RegExp(`^${name}\\s*\\(`, 'i').test(part));
    try { return statement ? parseStepRecord(statement).args : null; } catch { return null; }
  };
  const schemas = (headerValue('FILE_SCHEMA')?.[0] ?? []).filter((value) => typeof value === 'string');
  if (schemas.some((schema) => /^IFC/i.test(schema))) {
    throw new StepReadError('This exchange file uses an IFC schema. Save it with the .ifc extension to index its building model.', 'unsupported');
  }
  const schema = schemas.join(', ') || '(unspecified)';
  const protocol = /AP242|MANAGED_MODEL_BASED/i.test(schema) ? 'AP242' : /AUTOMOTIVE_DESIGN|AP214/i.test(schema) ? 'AP214'
    : /CONFIG_CONTROL_DESIGN|AP203/i.test(schema) ? 'AP203' : null;
  const fileName = headerValue('FILE_NAME');
  const originatingSystem = typeof fileName?.[5] === 'string' && fileName[5].trim() ? fileName[5].trim() : null;

  const warnings = new Set();
  const get = (ref) => records.get(typeof ref === 'number' ? ref : refOf(ref));
  const args = (record) => {
    if (!record) return [];
    if (!record.type) return null;
    if (!record.args) {
      try { record.args = parseStepRecord(record.text).args; } catch (error) { throw new StepReadError(`#${record.id}: ${error.message}`); }
    }
    return record.args;
  };
  const leaf = (record, name) => record?.type === name ? args(record) : record?.parts?.get(name) ?? null;
  const ids = (name) => byType.get(name) ?? [];
  const recordText = (id) => {
    const record = records.get(id);
    const text = record ? `#${id}=${record.text.replace(/\s+/g, ' ')};` : '';
    return text.length > 320 ? `${text.slice(0, 317)}…` : text;
  };

  // Units are resolved per representation context; geometry is normalised to
  // the model unit with the exact declared factor.
  const unitCache = new Map();
  function unitOf(ref, kind, depth = 0) {
    const record = get(ref);
    if (!record || depth > 8) return null;
    const leaves = partsOf(record.type ? { type: record.type, args: args(record) } : record);
    if (!leaves.has(kind)) return null;
    const si = leaves.get('SI_UNIT');
    if (si) {
      const [prefix, name] = si;
      if (kind === 'LENGTH_UNIT' && name !== 'METRE') return null;
      if (kind === 'PLANE_ANGLE_UNIT' && name !== 'RADIAN') return null;
      const multiplier = prefix == null ? 1 : PREFIX[prefix];
      if (!multiplier) return null;
      return kind === 'LENGTH_UNIT' ? { mm: multiplier * 1000, label: SI_LENGTH[prefix ?? ''] ?? null, source: `${prefix ?? ''}${prefix ? ' ' : ''}METRE` }
        : { radians: multiplier, source: 'RADIAN' };
    }
    const conversion = leaves.get('CONVERSION_BASED_UNIT');
    if (conversion) {
      const [name, measureRef] = conversion;
      const measureRecord = get(measureRef);
      const measureLeaves = measureRecord?.type ? new Map([[measureRecord.type, args(measureRecord)]]) : measureRecord?.parts;
      const withUnit = [...(measureLeaves ?? new Map()).entries()].find(([type, values]) => /MEASURE_WITH_UNIT$/.test(type) && values?.length >= 2)?.[1];
      const factor = measure(withUnit?.[0]);
      const base = withUnit && unitOf(withUnit[1], kind, depth + 1);
      if (!base || !(factor > 0) || !Number.isFinite(factor)) return null;
      return kind === 'LENGTH_UNIT'
        ? { mm: factor * base.mm, label: lengthLabel(factor * base.mm, name), source: String(name || 'conversion-based unit') }
        : { radians: factor * base.radians, source: String(name || 'conversion-based unit') };
    }
    return null;
  }
  function contextOf(ref) {
    const id = refOf(ref) ?? ref;
    if (unitCache.has(id)) return unitCache.get(id);
    const record = get(id);
    const units = leaf(record, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')?.[0] ?? [];
    const length = units.map((unit) => unitOf(unit, 'LENGTH_UNIT')).filter(Boolean);
    const angle = units.map((unit) => unitOf(unit, 'PLANE_ANGLE_UNIT')).filter(Boolean);
    let uncertainty = null;
    for (const item of leaf(record, 'GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT')?.[0] ?? []) {
      const values = leaf(get(item), 'UNCERTAINTY_MEASURE_WITH_UNIT');
      const unit = values && unitOf(values[1], 'LENGTH_UNIT');
      const value = measure(values?.[0]);
      if (unit && value > 0) uncertainty = Math.max(uncertainty ?? 0, value * unit.mm);
    }
    const context = { length: length.length === 1 ? length[0] : null, ambiguous: length.length > 1,
      angle: angle.length === 1 ? angle[0] : null, uncertaintyMm: uncertainty };
    unitCache.set(id, context);
    return context;
  }

  function representation(ref) {
    const record = get(ref);
    if (!record) return null;
    const values = record.type ? (/REPRESENTATION$/.test(record.type) ? args(record) : null) : record.parts.get('REPRESENTATION');
    if (!values || !Array.isArray(values[1])) return null;
    return { id: record.id, name: typeof values[0] === 'string' ? values[0] : '', items: values[1].map(refOf).filter(Boolean), context: refOf(values[2]) };
  }

  // Product definitions and their shape representations.
  const products = new Map();
  for (const id of ids('PRODUCT')) {
    const [productId, name] = args(records.get(id));
    products.set(id, { productId: typeof productId === 'string' ? productId.trim() : '', name: typeof name === 'string' ? name.trim() : '' });
  }
  const formations = new Map();
  for (const type of ['PRODUCT_DEFINITION_FORMATION', 'PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE']) {
    for (const id of ids(type)) formations.set(id, refOf(args(records.get(id))[2]));
  }
  const definitions = new Map();
  for (const type of ['PRODUCT_DEFINITION', 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS']) {
    for (const id of ids(type)) {
      const product = products.get(formations.get(refOf(args(records.get(id))[2])));
      definitions.set(id, { id, name: product?.name || product?.productId || '', productId: product?.productId ?? '' });
    }
  }
  const shapeDefinitions = new Map();
  for (const id of ids('PRODUCT_DEFINITION_SHAPE')) shapeDefinitions.set(id, refOf(args(records.get(id))[2]));
  const definitionReps = new Map();
  for (const id of ids('SHAPE_DEFINITION_REPRESENTATION')) {
    const [definition, rep] = args(records.get(id));
    const owner = shapeDefinitions.get(refOf(definition));
    if (!definitions.has(owner) || !refOf(rep)) continue;
    if (!definitionReps.has(owner)) definitionReps.set(owner, []);
    definitionReps.get(owner).push(refOf(rep));
  }

  // Representation relationships: unplaced links share coordinates; placed
  // links locate assembly components.
  const links = new Map();
  const placed = new Map();
  const link = (a, b) => {
    for (const [from, to] of [[a, b], [b, a]]) {
      if (!links.has(from)) links.set(from, new Set());
      links.get(from).add(to);
    }
  };
  for (const type of ['SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP']) {
    for (const id of ids(type)) {
      const record = records.get(id);
      const values = leaf(record, 'REPRESENTATION_RELATIONSHIP') ?? (record.type ? args(record) : null);
      if (!values) continue;
      const rep1 = refOf(values[2]), rep2 = refOf(values[3]);
      const transformation = refOf(leaf(record, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')?.[0]);
      if (transformation) placed.set(id, { rep1, rep2, transformation });
      else if (rep1 && rep2) link(rep1, rep2);
    }
  }
  function connectedReps(start) {
    const seen = new Set(), queue = [...start];
    while (queue.length) {
      const rep = queue.pop();
      if (seen.has(rep)) continue;
      seen.add(rep);
      for (const next of links.get(rep) ?? []) queue.push(next);
    }
    return seen;
  }
  const repsOfDefinition = new Map();
  const repOwner = new Map();
  for (const [definition, reps] of definitionReps) {
    const connected = connectedReps(reps);
    repsOfDefinition.set(definition, connected);
    for (const rep of connected) if (!repOwner.has(rep)) repOwner.set(rep, definition);
  }

  // The model unit is the most common declared length unit among the shape
  // representations; others are converted with their exact factors.
  const unitVotes = new Map();
  for (const reps of repsOfDefinition.values()) for (const rep of reps) {
    const context = contextOf(representation(rep)?.context);
    if (context.length) unitVotes.set(context.length.mm, (unitVotes.get(context.length.mm) ?? 0) + 1);
    if (context.ambiguous) warnings.add('A STEP representation context declares several length units; its geometry is unmeasured.');
  }
  if (!unitVotes.size) for (const id of ids('GLOBAL_UNIT_ASSIGNED_CONTEXT')) {
    const context = contextOf(id);
    if (context.length) unitVotes.set(context.length.mm, (unitVotes.get(context.length.mm) ?? 0) + 1);
  }
  const modelMm = [...unitVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const unit = modelMm ? { mm: modelMm, label: lengthLabel(modelMm) ?? 'mm', convertedToMm: !lengthLabel(modelMm),
    source: [...unitCache.values()].find((context) => context.length?.mm === modelMm)?.length.source ?? null } : null;
  const outputMm = unit ? (unit.convertedToMm ? 1 : unit.mm) : null;
  if (!unit) warnings.add('The STEP file declares no supported length unit; geometry is shown for reference but no measurements were indexed.');
  if (unitVotes.size > 1) warnings.add(`Representations use ${unitVotes.size} different length units; values are converted to ${unit.label} with their declared factors.`);
  const repScale = (rep) => {
    const context = contextOf(representation(rep)?.context);
    return context.length && outputMm ? { factor: context.length.mm / outputMm, known: true } : { factor: 1, known: false };
  };

  function point(ref, scale = 1) {
    const values = leaf(get(ref), 'CARTESIAN_POINT');
    const coordinates = values?.[1];
    if (!Array.isArray(coordinates) || !coordinates.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
    return [coordinates[0] * scale, (coordinates[1] ?? 0) * scale, (coordinates[2] ?? 0) * scale];
  }
  function direction(ref) {
    const values = leaf(get(ref), 'DIRECTION')?.[1];
    if (!Array.isArray(values) || !values.every(Number.isFinite)) return null;
    return normalize([values[0], values[1] ?? 0, values[2] ?? 0]);
  }
  function placement(ref, scale = 1) {
    const values = leaf(get(ref), 'AXIS2_PLACEMENT_3D');
    const origin = values && point(values[1], scale);
    return origin ? frame(origin, values[2] ? direction(values[2]) : null, values[3] ? direction(values[3]) : null) : null;
  }

  // ── B-rep topology and geometry ────────────────────────────────────────────
  let edgeTotal = 0;
  function curveRecord(ref, depth = 0) {
    const record = get(ref);
    if (!record || depth > 8) return null;
    for (const wrapper of ['SURFACE_CURVE', 'SEAM_CURVE', 'INTERSECTION_CURVE', 'BOUNDED_SURFACE_CURVE', 'TRIMMED_CURVE']) {
      const values = leaf(record, wrapper);
      if (values && record.type) return curveRecord(values[1], depth + 1);
    }
    return record;
  }
  function bsplineCurve(record, xf) {
    let degree, points, knots, weights = null;
    const simple = record.type;
    if (simple === 'B_SPLINE_CURVE_WITH_KNOTS') {
      const values = args(record);
      degree = values[1]; points = values[2];
      knots = expandKnots(values[7] ?? [], values[6] ?? []);
    } else if (['UNIFORM_B_SPLINE_CURVE', 'QUASI_UNIFORM_B_SPLINE_CURVE', 'BEZIER_CURVE'].includes(simple)) {
      const values = args(record);
      degree = values[1]; points = values[2];
      knots = implicitKnots(simple.replace(/_B_SPLINE_CURVE$|_CURVE$/, ''), degree, points?.length ?? 0);
    } else if (!simple && record.parts.has('B_SPLINE_CURVE')) {
      [degree, points] = record.parts.get('B_SPLINE_CURVE');
      const withKnots = record.parts.get('B_SPLINE_CURVE_WITH_KNOTS');
      const implicit = ['UNIFORM_B_SPLINE_CURVE', 'QUASI_UNIFORM_B_SPLINE_CURVE', 'BEZIER_CURVE'].find((name) => record.parts.has(name));
      knots = withKnots ? expandKnots(withKnots[1] ?? [], withKnots[0] ?? [])
        : implicit ? implicitKnots(implicit.replace(/_B_SPLINE_CURVE$|_CURVE$/, ''), degree, points?.length ?? 0) : null;
      weights = record.parts.get('RATIONAL_B_SPLINE_CURVE')?.[0] ?? null;
    } else return null;
    if (!Number.isInteger(degree) || degree < 1 || !Array.isArray(points) || points.length < degree + 1) return null;
    const controlPoints = points.map((ref) => point(ref, xf.scale));
    if (controlPoints.some((value) => !value) || !knots || knots.length !== controlPoints.length + degree + 1) return null;
    if (weights && (weights.length !== controlPoints.length || weights.some((weight) => !(weight > 0)))) return null;
    return { degree, knots, weights, points: controlPoints.map((value) => transformPoint(xf.matrix, value)) };
  }
  function closestParameter(curve, target, low, high) {
    let best = low, bestDistance = Infinity;
    for (let index = 0; index <= 128; index++) {
      const t = low + (high - low) * index / 128;
      const gap = distance(evaluateBSpline(curve, t), target);
      if (gap < bestDistance) { best = t; bestDistance = gap; }
    }
    const step = (high - low) / 128;
    let a = Math.max(low, best - step), b = Math.min(high, best + step);
    for (let iteration = 0; iteration < 80; iteration++) {
      const c = a + (b - a) / 3, d = b - (b - a) / 3;
      if (distance(evaluateBSpline(curve, c), target) < distance(evaluateBSpline(curve, d), target)) b = d; else a = c;
    }
    return (a + b) / 2;
  }
  function readEdge(edgeRef, xf, tolerance) {
    const record = get(edgeRef);
    const values = leaf(record, 'EDGE_CURVE');
    if (!values) return null;
    const startVertex = refOf(values[1]), endVertex = refOf(values[2]);
    const vertexPoint = (ref) => { const vertex = leaf(get(ref), 'VERTEX_POINT'); const raw = vertex && point(vertex[1], xf.scale); return raw && transformPoint(xf.matrix, raw); };
    const p0 = vertexPoint(startVertex), p1 = vertexPoint(endVertex);
    if (!p0 || !p1) return null;
    const sameSense = values[4] !== 'F';
    const closed = startVertex === endVertex || distance(p0, p1) <= tolerance;
    const curve = curveRecord(values[3]);
    const base = { id: record.id, curveId: curve?.id ?? null, p0, p1, closed, sameSense, curveType: curve?.type ?? 'COMPLEX' };
    const circle = leaf(curve, 'CIRCLE'), ellipse = leaf(curve, 'ELLIPSE');
    if (circle || ellipse) {
      const position = placement(circle?.[1] ?? ellipse[1], xf.scale);
      if (!position) return { ...base, kind: 'unsupported' };
      const m = compose(xf.matrix, position);
      const xdir = rotate(m, [1, 0, 0]), ydir = rotate(m, [0, 1, 0]), axis = rotate(m, [0, 0, 1]), center = m.t;
      const semiAxes = circle ? [circle[2] * xf.scale, circle[2] * xf.scale] : [ellipse[2] * xf.scale, ellipse[3] * xf.scale];
      if (!(semiAxes[0] > 0 && semiAxes[1] > 0)) return { ...base, kind: 'unsupported' };
      const angle = (p) => { const v = sub(p, center); return Math.atan2(dot(v, ydir) / semiAxes[1], dot(v, xdir) / semiAxes[0]); };
      const first = sameSense ? p0 : p1, last = sameSense ? p1 : p0;
      const start = angle(first);
      const sweep = closed ? TAU : mod(angle(last) - start, TAU) || TAU;
      return circle ? { ...base, kind: 'circle', center, axis, xdir, ydir, radius: semiAxes[0], start, sweep }
        : { ...base, kind: 'ellipse', center, axis, xdir, ydir, semiAxes, start, sweep };
    }
    // A closed line edge is degenerate; it has zero length and no extent.
    if (leaf(curve, 'LINE')) return { ...base, kind: 'line' };
    const polyline = leaf(curve, 'POLYLINE');
    if (polyline) {
      const points = (polyline[1] ?? []).map((ref) => point(ref, xf.scale)).filter(Boolean).map((value) => transformPoint(xf.matrix, value));
      return points.length >= 2 ? { ...base, kind: 'polyline', points } : { ...base, kind: 'unsupported' };
    }
    const spline = curve && bsplineCurve(curve, xf);
    if (spline) {
      const { degree, knots } = spline;
      let t0 = knots[degree], t1 = knots[knots.length - degree - 1];
      const a = evaluateBSpline(spline, t0), b = evaluateBSpline(spline, t1);
      const endTolerance = Math.max(tolerance * 10, distance(a, b) * 1e-7);
      const matchesEnds = closed ? distance(a, p0) <= endTolerance && distance(b, p0) <= endTolerance
        : (distance(a, p0) <= endTolerance && distance(b, p1) <= endTolerance) || (distance(a, p1) <= endTolerance && distance(b, p0) <= endTolerance);
      if (!matchesEnds) {
        const u0 = closestParameter(spline, p0, t0, t1), u1 = closestParameter(spline, p1, t0, t1);
        [t0, t1] = u0 <= u1 ? [u0, u1] : [u1, u0];
      }
      const spans = new Set(knots.filter((knot) => knot >= t0 && knot <= t1)).size;
      const count = Math.min(256, Math.max(32, spans * 12));
      const samples = Array.from({ length: count + 1 }, (_, index) => {
        const t = t0 + (t1 - t0) * index / count;
        return { t, point: evaluateBSpline(spline, t) };
      });
      return { ...base, kind: 'bspline', curve: spline, t0, t1, samples };
    }
    return { ...base, kind: 'unsupported' };
  }
  function readSurface(ref, xf, angleRadians) {
    const record = get(ref);
    const at = (values) => values && placement(values[1], xf.scale);
    const placed = (position) => position && compose(xf.matrix, position);
    let values;
    if ((values = leaf(record, 'PLANE'))) return { kind: 'plane', id: record.id };
    if ((values = leaf(record, 'CYLINDRICAL_SURFACE'))) {
      const m = placed(at(values));
      return m && values[2] > 0 ? { kind: 'cylinder', id: record.id, center: m.t, axis: rotate(m, [0, 0, 1]), xdir: rotate(m, [1, 0, 0]), ydir: rotate(m, [0, 1, 0]), radius: values[2] * xf.scale } : { kind: 'other', id: record.id, type: 'CYLINDRICAL_SURFACE' };
    }
    if ((values = leaf(record, 'CONICAL_SURFACE'))) {
      const m = placed(at(values));
      const semiAngle = angleRadians && typeof values[3] === 'number' ? values[3] * angleRadians : null;
      const apex = m && semiAngle && Math.abs(Math.tan(semiAngle)) > 1e-12 ? along(m.t, rotate(m, [0, 0, 1]), -(values[2] * xf.scale) / Math.tan(semiAngle)) : null;
      return m ? { kind: 'cone', id: record.id, apex, center: m.t, axis: rotate(m, [0, 0, 1]), xdir: rotate(m, [1, 0, 0]), ydir: rotate(m, [0, 1, 0]) }
        : { kind: 'other', id: record.id, type: 'CONICAL_SURFACE' };
    }
    if ((values = leaf(record, 'SPHERICAL_SURFACE'))) {
      const m = placed(at(values));
      return m ? { kind: 'sphere', id: record.id, center: m.t, radius: values[2] * xf.scale } : { kind: 'other', id: record.id, type: 'SPHERICAL_SURFACE' };
    }
    const degenerate = leaf(record, 'DEGENERATE_TOROIDAL_SURFACE');
    if ((values = leaf(record, 'TOROIDAL_SURFACE') ?? degenerate)) {
      const m = placed(at(values));
      return m ? { kind: 'torus', id: record.id, center: m.t, axis: rotate(m, [0, 0, 1]), major: values[2] * xf.scale, minor: values[3] * xf.scale, degenerate: Boolean(degenerate) }
        : { kind: 'other', id: record.id, type: 'TOROIDAL_SURFACE' };
    }
    if (leaf(record, 'SURFACE_OF_LINEAR_EXTRUSION')) return { kind: 'extrusion', id: record.id };
    const grid = record?.type && /^(?:B_SPLINE_SURFACE_WITH_KNOTS|UNIFORM_SURFACE|QUASI_UNIFORM_SURFACE|BEZIER_SURFACE)$/.test(record.type) ? args(record)[3]
      : record?.parts?.get('B_SPLINE_SURFACE')?.[2];
    if (Array.isArray(grid)) {
      const points = grid.flat().map((value) => point(value, xf.scale));
      if (points.length && points.every(Boolean)) return { kind: 'bspline-surface', id: record.id, points: points.map((value) => transformPoint(xf.matrix, value)) };
    }
    return { kind: 'other', id: record?.id ?? null, type: record?.type ?? 'COMPLEX' };
  }

  /** Reference bodies are drawn but kept out of the part's measured edges and faces. */
  function readBody(bodyId, xf, part, instance, reference = false) {
    const record = get(bodyId);
    const type = record.type;
    const values = args(record);
    const solid = type !== 'SHELL_BASED_SURFACE_MODEL';
    const shells = type === 'SHELL_BASED_SURFACE_MODEL' ? (values[1] ?? []).map((shell) => ({ ref: shell, reversed: false }))
      : [{ ref: values[1], reversed: false }, ...(type === 'BREP_WITH_VOIDS' ? (values[2] ?? []).map((shell) => ({ ref: shell, reversed: false })) : [])];
    const context = contextOf(xf.context);
    const tolerance = Math.max(part.tolerance, 1e-9);
    const bodyName = typeof values[0] === 'string' ? values[0].trim() : '';
    const edges = reference ? part.referenceEdges : part.edges;
    part.bodies.push({ id: bodyId, type, name: bodyName, solid, reference });
    const visitShell = (ref, reversed, depth = 0) => {
      const shell = get(ref);
      if (!shell || depth > 4) return;
      const oriented = leaf(shell, 'ORIENTED_CLOSED_SHELL') ?? leaf(shell, 'ORIENTED_OPEN_SHELL');
      if (oriented) return visitShell(oriented[2], reversed !== (oriented[3] === 'F'), depth + 1);
      const faces = leaf(shell, 'CLOSED_SHELL') ?? leaf(shell, 'OPEN_SHELL');
      for (const faceRef of faces?.[1] ?? []) visitFace(faceRef, reversed);
    };
    const visitFace = (ref, reversed, depth = 0) => {
      const face = get(ref);
      if (!face || depth > 4) return;
      const oriented = leaf(face, 'ORIENTED_FACE');
      if (oriented) return visitFace(oriented[2], reversed !== (oriented[3] === 'F'), depth + 1);
      const faceValues = leaf(face, 'ADVANCED_FACE') ?? leaf(face, 'FACE_SURFACE');
      if (!faceValues) return;
      const surface = readSurface(faceValues[2], xf, context.angle?.radians ?? null);
      // A solid's faces point out of the material once same_sense and shell
      // orientation are applied; surface models carry no inside/outside.
      const outward = solid ? (faceValues[3] !== 'F') !== reversed : null;
      // Each loop has the face on its left, seen from where the surface normal
      // points when same_sense holds and from the opposite side otherwise.
      const entry = { id: face.id, surface, outward, sameSense: faceValues[3] !== 'F', edgeKeys: [], loops: [], untraced: false };
      for (const boundRef of faceValues[1] ?? []) {
        const bound = get(boundRef);
        const boundValues = leaf(bound, 'FACE_OUTER_BOUND') ?? leaf(bound, 'FACE_BOUND');
        const loop = get(boundValues?.[1]);
        const edgeLoop = leaf(loop, 'EDGE_LOOP');
        if (edgeLoop) {
          const traversal = [];
          entry.loops.push(traversal);
          for (const orientedRef of edgeLoop[1] ?? []) {
            const orientedEdge = leaf(get(orientedRef), 'ORIENTED_EDGE');
            const edgeRef = refOf(orientedEdge?.[3]);
            if (!edgeRef) continue;
            traversal.push({ key: `${instance}:${edgeRef}`, forward: (orientedEdge[4] !== 'F') === (boundValues[2] !== 'F') });
            const key = `${instance}:${edgeRef}`;
            if (!edges.has(key)) {
              if (++edgeTotal > MAX_EDGES) throw new StepReadError('STEP exceeds the 400,000 edge limit.', 'unsupported');
              const edge = readEdge(edgeRef, xf, tolerance);
              if (!edge) { warnings.add(`Edge #${edgeRef} has no readable vertices or curve and was skipped.`); continue; }
              edge.key = key;
              edge.faces = [];
              edges.set(key, edge);
              if (edge.kind === 'unsupported' && !reference) part.inexact.add(`${edge.curveType || 'unsupported'} edges`);
            }
            edges.get(key).faces.push(face.id);
            entry.edgeKeys.push(key);
          }
          // A reversed bound runs the loop backwards: last edge first.
          if (boundValues[2] === 'F') traversal.reverse();
          continue;
        }
        // A vertex loop marks a point, such as a sphere's pole, and bounds no area.
        if (!leaf(loop, 'VERTEX_LOOP')) entry.untraced = true;
        const polyLoop = leaf(loop, 'POLY_LOOP');
        if (polyLoop) {
          const points = (polyLoop[1] ?? []).map((ref) => point(ref, xf.scale)).filter(Boolean).map((value) => transformPoint(xf.matrix, value));
          points.forEach((p0, index) => {
            const p1 = points[(index + 1) % points.length];
            if (distance(p0, p1) <= tolerance) return;
            // Faceted loops share no edge entities; key by unordered endpoints.
            const [a, b] = [p0, p1].map((value) => value.map((coordinate) => Math.round(coordinate / tolerance)).join(',')).sort();
            const key = `${instance}:poly:${a}:${b}`;
            if (!edges.has(key)) edges.set(key, { key, id: loop.id, kind: 'line', p0, p1, closed: false, curveType: 'POLY_LOOP', faces: [] });
            edges.get(key).faces.push(face.id);
            entry.edgeKeys.push(key);
          });
        }
      }
      if (reference) return;
      if (!RULED.has(surface.kind)) part.curvedFaces.push(entry);
      part.faces.push(entry);
    };
    for (const shell of shells) visitShell(shell.ref, shell.reversed);
  }

  // Bodies reachable from each product definition (including anonymous
  // mapped representations, placed into the definition's coordinates).
  const nauoChildren = new Map();
  const childDefinitions = new Set();
  for (const id of ids('NEXT_ASSEMBLY_USAGE_OCCURRENCE')) {
    const values = args(records.get(id));
    const parent = refOf(values[3]), child = refOf(values[4]);
    if (!definitions.has(parent) || !definitions.has(child)) continue;
    if (!nauoChildren.has(parent)) nauoChildren.set(parent, []);
    nauoChildren.get(parent).push({ nauo: id, child, name: [values[1], values[0]].find((value) => typeof value === 'string' && value.trim())?.trim() ?? '' });
    childDefinitions.add(child);
  }
  const occurrencePlacement = new Map();
  for (const id of ids('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const [relation, definitionShape] = args(records.get(id));
    const nauo = shapeDefinitions.get(refOf(definitionShape));
    if (nauo) occurrencePlacement.set(nauo, refOf(relation));
  }
  function transformItems(transformationRef) {
    const record = get(transformationRef);
    const values = leaf(record, 'ITEM_DEFINED_TRANSFORMATION');
    if (values) return { item1: refOf(values[2]), item2: refOf(values[3]) };
    return { operator: refOf(transformationRef) };
  }
  function relationTransform(relationId, parent, child) {
    const relation = placed.get(relationId);
    if (!relation) return null;
    const parentReps = repsOfDefinition.get(parent) ?? new Set(), childReps = repsOfDefinition.get(child) ?? new Set();
    const items = transformItems(relation.transformation);
    if (items.operator) {
      const operator = placement(items.operator, repScale(relation.rep1).factor);
      return operator && (childReps.has(relation.rep1) || !parentReps.has(relation.rep1) ? operator : invert(operator));
    }
    // AP214 places rep_1 (component) into rep_2 (assembly); a few writers
    // reverse the pair, so the product structure decides which side is which.
    const childFirst = childReps.has(relation.rep1) || parentReps.has(relation.rep2) || !(childReps.has(relation.rep2) || parentReps.has(relation.rep1));
    const [childItem, childRep, parentItem, parentRep] = childFirst
      ? [items.item1, relation.rep1, items.item2, relation.rep2] : [items.item2, relation.rep2, items.item1, relation.rep1];
    const from = placement(childItem, repScale(childRep).factor), to = placement(parentItem, repScale(parentRep).factor);
    return from && to ? compose(to, invert(from)) : null;
  }

  const bodiesOf = new Map();
  const reachedBodies = new Set();
  const mappedChildren = new Map();
  function collectBodies(definition, reps, xf, sink, depth = 0) {
    for (const repId of reps) {
      const rep = representation(repId);
      if (!rep) continue;
      const scale = repScale(repId);
      for (const item of rep.items) {
        const record = get(item);
        if (!record) continue;
        if (BODY_TYPES.has(record.type)) {
          reachedBodies.add(item);
          sink.push({ id: item, xf: { matrix: xf, scale: scale.factor, context: rep.context }, unitKnown: scale.known });
          continue;
        }
        const mapped = leaf(record, 'MAPPED_ITEM');
        if (!mapped || depth > 8) continue;
        const map = leaf(get(mapped[1]), 'REPRESENTATION_MAP');
        const mappedRep = refOf(map?.[1]);
        const origin = placement(map?.[0], repScale(mappedRep).factor), target = placement(mapped[2], scale.factor);
        if (!mappedRep || !origin || !target) { warnings.add(`Mapped item #${item} has no readable placement and was skipped.`); continue; }
        const local = compose(target, invert(origin));
        const owner = repOwner.get(mappedRep);
        if (owner && owner !== definition) {
          if (!(nauoChildren.get(definition) ?? []).some((child) => child.child === owner)) {
            if (!mappedChildren.has(definition)) mappedChildren.set(definition, []);
            mappedChildren.get(definition).push({ child: owner, transform: compose(xf, local), name: typeof mapped[0] === 'string' ? mapped[0] : '' });
          }
          continue;
        }
        collectBodies(definition, connectedReps([mappedRep]), compose(xf, local), sink, depth + 1);
      }
    }
  }
  for (const [definition, reps] of repsOfDefinition) {
    const sink = [];
    collectBodies(definition, reps, IDENTITY, sink);
    if (sink.length) bodiesOf.set(definition, sink);
  }

  // Parts: one per product definition with geometry, keyed by product name.
  const parts = [];
  const usedKeys = new Map();
  const partKey = (name) => {
    const base = name || 'Part';
    const count = (usedKeys.get(base.toLowerCase()) ?? 0) + 1;
    usedKeys.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  };
  function makePart(name, productId, definition, bodies, fallbackName) {
    // Surface models beside a solid are reference geometry, such as PMI
    // datum-target areas or split surfaces: drawn, but not measured as material.
    const surfaceOnly = (body) => get(body.id).type === 'SHELL_BASED_SURFACE_MODEL';
    const hasSolid = !bodies.every(surfaceOnly);
    const measured = bodies.filter((body) => !(hasSolid && surfaceOnly(body)));
    const bodyName = measured.map((body) => args(get(body.id))[0]).find((value) => typeof value === 'string' && value.trim());
    const tolerances = measured.map((body) => contextOf(body.xf.context).uncertaintyMm).filter((value) => value > 0);
    const part = { key: '', name: name || bodyName?.trim() || fallbackName, productId, definition, bodies: [], edges: new Map(), referenceEdges: new Map(),
      faces: [], curvedFaces: [], inexact: new Set(), unitKnown: measured.every((body) => body.unitKnown),
      tolerance: tolerances.length && outputMm ? extremes(tolerances)[1] / outputMm : 0 };
    part.key = partKey(part.name);
    bodies.forEach((body, instance) => readBody(body.id, body.xf, part, instance, !measured.includes(body)));
    return part;
  }
  const partByDefinition = new Map();
  for (const [definition, bodies] of [...bodiesOf].sort((a, b) => a[0] - b[0])) {
    const info = definitions.get(definition);
    const part = makePart(info.name, info.productId, definition, bodies, 'Part');
    parts.push(part);
    partByDefinition.set(definition, part);
  }
  // Exchange files without product structure still describe solids;
  // supplemental construction geometry belongs to no product's shape.
  const supplemental = new Set(ids('CONSTRUCTIVE_GEOMETRY_REPRESENTATION').flatMap((id) => representation(id)?.items ?? []));
  const orphanParts = [];
  for (const type of BODY_TYPES) for (const id of ids(type)) {
    if (reachedBodies.has(id) || supplemental.has(id)) continue;
    const owner = (ids('ADVANCED_BREP_SHAPE_REPRESENTATION').concat(ids('SHAPE_REPRESENTATION'), ids('MANIFOLD_SURFACE_SHAPE_REPRESENTATION'), ids('FACETED_BREP_SHAPE_REPRESENTATION')))
      .map(representation).find((rep) => rep?.items.includes(id));
    const name = args(get(id))[0];
    const part = makePart(typeof name === 'string' ? name.trim() : '', '', null,
      [{ id, xf: { matrix: IDENTITY, scale: owner ? repScale(owner.id).factor : 1, context: owner?.context ?? null }, unitKnown: owner ? repScale(owner.id).known : false }],
      `Body ${orphanParts.length + 1}`);
    parts.push(part);
    orphanParts.push(part);
  }
  if (!parts.length) throw new StepReadError('No supported B-rep solids or surface models were found. Export solid bodies as STEP AP203, AP214 or AP242.', 'unsupported');

  // Assembly occurrences, with transforms from each component into the root.
  const occurrences = [];
  const childCache = new Map();
  const children = (definition) => childCache.get(definition) ?? childCache.set(definition, [
    ...(nauoChildren.get(definition) ?? []).map((entry) => {
      const relation = occurrencePlacement.get(entry.nauo);
      const transform = relation ? relationTransform(relation, definition, entry.child) : null;
      if (!transform) warnings.add(`Assembly placement for ${entry.name || definitions.get(entry.child)?.name || `#${entry.nauo}`} is missing; it is drawn at its own origin.`);
      return { child: entry.child, transform: transform ?? IDENTITY, name: entry.name };
    }),
    ...(mappedChildren.get(definition) ?? []),
  ]).get(definition);
  let truncated = false;
  function visit(definition, matrix, path, stack) {
    if (occurrences.length >= MAX_OCCURRENCES) { truncated = true; return; }
    if (stack.length > MAX_ASSEMBLY_DEPTH || stack.includes(definition)) { warnings.add('The STEP assembly structure is cyclic or deeper than 32 levels; repeated levels were skipped.'); return; }
    const part = partByDefinition.get(definition);
    if (part) occurrences.push({ part: parts.indexOf(part), matrix, path });
    for (const child of children(definition)) {
      visit(child.child, compose(matrix, child.transform), [...path, child.name || definitions.get(child.child)?.name || ''], [...stack, definition]);
    }
  }
  const roots = [...definitions.keys()].filter((definition) => !childDefinitions.has(definition)
    && (partByDefinition.has(definition) || nauoChildren.has(definition) || mappedChildren.has(definition)));
  for (const root of roots) visit(root, IDENTITY, [definitions.get(root)?.name || ''], []);
  for (const part of parts) {
    if (!occurrences.some((occurrence) => parts[occurrence.part] === part)) occurrences.push({ part: parts.indexOf(part), matrix: IDENTITY, path: [part.name] });
  }
  if (truncated) warnings.add(`Only the first ${MAX_OCCURRENCES} assembly component instances were placed.`);

  for (const part of parts) analysePart(part, unit);
  const rootName = roots.length === 1 ? definitions.get(roots[0])?.name || null : null;
  const assembly = occurrences.length > 1 ? assemblyExtents(parts, occurrences, rootName) : null;
  return { schema, protocol, originatingSystem, unit, parts, occurrences, rootName, assembly, recordCount: records.size,
    warnings: [...warnings], recordText };
}

// ── per-part measurement analysis ───────────────────────────────────────────
const AXES = [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]];

/** Exact [min, max] of a part along d. The range is inexact when an edge curve
 * is unsupported or a curved face could extend beyond its boundary edges by an
 * amount that cannot be bounded exactly. */
export function partRange(part, d, precise = true) {
  let min = Infinity, max = -Infinity;
  for (const edge of part.edges.values()) {
    const [low, high] = edgeRange(edge, d, precise);
    min = Math.min(min, low); max = Math.max(max, high);
  }
  if (!Number.isFinite(min)) return { min: null, max: null, exact: false, reason: 'no boundary edges' };
  if (part.inexact.size) return { min, max, exact: false, reason: [...part.inexact].join(', ') };
  const tolerance = Math.max(part.tolerance, (max - min) * 1e-9, 1e-12);
  const rounding = Math.max(Math.abs(min), Math.abs(max), max - min) * 1e-9;
  // Faces whose surface extreme, rather than an edge, sets each end of the range.
  let lowFace = null, highFace = null;
  for (const face of part.curvedFaces) {
    face.containsApex ??= face.surface.kind === 'cone' ? windingAboutAxis(face, part) !== 0 : null;
    if (face.containsApex === false) continue;
    const bound = surfaceBound(face.surface, d);
    if (bound && bound[0] >= min - tolerance && bound[1] <= max + tolerance) continue;
    // A sphere or ring torus passes the edges only where the face holds the
    // surface's own extreme, whose coordinate is then the exact extent.
    if (bound && hasPeaks(face.surface)) {
      const high = bound[1] > max + tolerance ? holdsPeak(face, part, d, bound[1], rounding) : false;
      const low = bound[0] < min - tolerance ? holdsPeak(face, part, [-d[0], -d[1], -d[2]], -bound[0], rounding) : false;
      if (high !== null && low !== null) {
        if (high) { max = bound[1]; highFace = { id: face.id, kind: face.surface.kind }; }
        if (low) { min = bound[0]; lowFace = { id: face.id, kind: face.surface.kind }; }
        continue;
      }
    }
    return { min, max, exact: false, reason: `${face.surface.type ?? face.surface.kind} face #${face.id}` };
  }
  return { min, max, exact: true, lowFace, highFace };
}

// Along any direction, a sphere or a torus whose tube clears its axis has a
// single highest point (or, for a torus seen along its axis, circle), and the
// surface above any lower height is one connected region.
const hasPeaks = (surface) => surface.kind === 'sphere'
  || (surface.kind === 'torus' && !surface.degenerate && surface.minor > 0 && surface.major > surface.minor);

/** Unit normal of a sphere, torus or cylinder near a point, pointing away from
 * its centre, tube or axis, and the point's distance from the surface. */
function surfaceFrame(surface, point) {
  let offset = sub(point, surface.center), size = surface.radius;
  if (surface.kind !== 'sphere') {
    const radial = along(offset, surface.axis, -dot(offset, surface.axis));
    if (surface.kind === 'cylinder') offset = radial;
    else if (surface.kind === 'torus') {
      const toward = normalize(radial);
      if (!toward) return null;
      offset = along(offset, toward, -surface.major);
      size = surface.minor;
    } else return null;
  }
  const normal = normalize(offset);
  return normal && { normal, gap: Math.abs(Math.hypot(...offset) - size) };
}

/** A face's boundary as oriented edges. Seams are left out, since an edge used
 * in both directions has the face on both sides. Null when a bound was not
 * read as an edge loop or an edge is missing or used the same way twice. */
function faceBoundary(face, part) {
  if (face.untraced) return null;
  const uses = new Map();
  for (const loop of face.loops) for (const { key, forward } of loop) {
    if (!uses.has(key)) uses.set(key, []);
    uses.get(key).push(forward);
  }
  const boundary = [];
  for (const [key, directions] of uses) {
    const edge = part.edges.get(key);
    if (!edge) return null;
    if (directions.length === 2 && directions[0] !== directions[1]) continue;
    if (directions.length !== 1) return null;
    if (edge.kind === 'line' && edge.closed) continue;
    const [forward] = directions;
    // Conic, B-spline and polyline parameters follow the curve, whose sense
    // relative to the edge is same_sense; a line's runs from p0 to p1.
    const alongCurve = (edge.kind === 'line' ? true : edge.sameSense) === forward;
    const [first, last] = edgeEnds(edge);
    boundary.push({ edge, alongCurve, start: forward ? edge.p0 : edge.p1, end: forward ? edge.p1 : edge.p0,
      startParameter: alongCurve ? first : last, endParameter: alongCurve ? last : first });
  }
  return boundary;
}

/** Whether a sphere or ring-torus face holds the surface's highest point along
 * d, at height peak. Above the highest point B of the face boundary, the surface
 * is one connected region that holds the peak and meets no boundary, so the face
 * holds the peak exactly when it lies uphill of its boundary at B. Each local top
 * of the boundary within the model's tolerance of B's height, or within the
 * boundary's own distance from the surface, must agree. Null when that cannot
 * be decided: a missing or untraced edge, a corner shared by several loops, a
 * boundary that strays from its surface by nearly the peak's height above it,
 * or one that tops out where d·p is stationary on the surface. */
function holdsPeak(face, part, d, peak, rounding) {
  if (face.boundary === undefined) face.boundary = faceBoundary(face, part);
  const boundary = face.boundary;
  if (!boundary) return null;
  // Without boundary edges (only seams or vertex loops), the face is the whole surface.
  if (!boundary.length) return true;
  face.boundaryGap ??= extremes(boundary.flatMap(({ edge }) => sampleEdge(edge).map((point) => surfaceFrame(face.surface, point)?.gap ?? Infinity)))[1];
  const peaks = boundary.map((use) => ({ use, ...edgePeak(use.edge, d) }));
  const top = extremes(peaks.map((candidate) => candidate.value))[1];
  if (peak - top <= 2 * face.boundaryGap) return null;
  const near = Math.max(part.tolerance, rounding);
  const window = Math.max(near, 2 * face.boundaryGap);
  const traversal = (use, parameter) => {
    const tangent = edgeTangent(use.edge, parameter);
    return use.alongCurve ? tangent : [-tangent[0], -tangent[1], -tangent[2]];
  };
  const only = (matches) => matches.length === 1 ? matches[0] : null;
  let verdict = null;
  for (const { use, value, parameter, at } of peaks) {
    if (value < top - window) continue;
    if (at === 'corner') return null;
    let point, incoming, outgoing;
    if (at === 'inside') {
      point = edgePoint(use.edge, parameter);
      incoming = outgoing = traversal(use, parameter);
    } else if (parameter === use.startParameter) {
      point = use.start;
      const previous = only(boundary.filter((other) => distance(other.end, point) <= near));
      if (!previous) return null;
      incoming = traversal(previous, previous.endParameter);
      outgoing = traversal(use, parameter);
    } else {
      point = use.end;
      const next = only(boundary.filter((other) => distance(other.start, point) <= near));
      if (!next) return null;
      incoming = traversal(use, parameter);
      outgoing = traversal(next, next.startParameter);
    }
    const side = uphillSide(face, point, incoming, outgoing, d, at !== 'inside');
    // A corner the boundary climbs away from is not a top; the higher point is judged instead.
    if (side === undefined) continue;
    if (side === null || (verdict !== null && side !== verdict)) return null;
    verdict = side;
  }
  return verdict;
}

/** Whether the face lies uphill along d where its boundary passes a point: in
 * the wedge from the leaving direction counter-clockwise, about the face's
 * normal, to the reversed arriving direction. Undefined at a corner the
 * boundary climbs away from, which is not a top of it; null when the uphill
 * direction is undefined or too close to the wedge's sides to judge. */
function uphillSide(face, point, incoming, outgoing, d, corner) {
  const back = [-incoming[0], -incoming[1], -incoming[2]];
  const forth = normalize(outgoing), returned = normalize(back);
  if (!forth || !returned) return null;
  if (corner && (dot(d, forth) > 1e-6 || dot(d, returned) > 1e-6)) return undefined;
  const normal = surfaceFrame(face.surface, point)?.normal;
  if (!normal) return null;
  const slope = along(d, normal, -dot(d, normal));
  if (Math.hypot(...slope) < 1e-6) return null;
  const up = normalize(slope);
  const across = cross(face.sameSense ? normal : [-normal[0], -normal[1], -normal[2]], up);
  const inPlane = (vector) => normalize(along(vector, normal, -dot(vector, normal)));
  const leaving = inPlane(outgoing), returning = inPlane(back);
  if (!leaving || !returning || dot(leaving, up) > 0.5 || dot(returning, up) > 0.5) return null;
  const angle = (vector) => Math.atan2(dot(vector, across), dot(vector, up));
  const wedge = mod(angle(returning) - angle(leaving), TAU);
  if (wedge < 1e-9 || wedge > TAU - 1e-9) return null;
  return mod(-angle(leaving), TAU) < wedge;
}

/** Turns a face's oriented boundary makes about its surface axis. A cone face
 * reaches its apex only when the boundary encircles the axis (a frustum's two
 * rims cancel); otherwise every ruling ends on the boundary. Each edge adds its
 * own sweep, so a skipped edge cannot leave a gap that counts as a turn. */
function windingAboutAxis(face, part) {
  const { center, axis, xdir, ydir } = face.surface;
  let total = 0;
  for (const loop of face.loops) for (const { key, forward } of loop) {
    const edge = part.edges.get(key);
    if (!edge) continue;
    // Curve samples follow the curve's parameter; lines follow the edge.
    const alongSamples = ['circle', 'ellipse', 'bspline', 'polyline'].includes(edge.kind) ? edge.sameSense : true;
    const points = sampleEdge(edge, Math.PI / 36);
    if (alongSamples !== forward) points.reverse();
    let previous = null;
    for (const point of points) {
      const offset = sub(point, center);
      const radial = along(offset, axis, -dot(offset, axis));
      if (Math.hypot(...radial) <= Math.max(part.tolerance, 1e-12)) continue;
      const angle = Math.atan2(dot(radial, ydir), dot(radial, xdir));
      if (previous != null) total += mod(angle - previous + Math.PI, TAU) - Math.PI;
      previous = angle;
    }
  }
  return Math.round(total / TAU);
}

function circleAngle(point, center, xdir, ydir) {
  const v = sub(point, center);
  return Math.atan2(dot(v, ydir), dot(v, xdir));
}
function largestGap(angles) {
  if (!angles.length) return TAU;
  const sorted = [...angles].map((angle) => mod(angle, TAU)).sort((a, b) => a - b);
  let gap = TAU - sorted.at(-1) + sorted[0], after = sorted.at(-1);
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index] - sorted[index - 1] > gap) { gap = sorted[index] - sorted[index - 1]; after = sorted[index - 1]; }
  }
  return { gap, after };
}
const nearlyEqual = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
/** Find-or-create by radius buckets so clustering stays near linear. */
function radiusClusters(tolerance) {
  const buckets = new Map(), step = tolerance * 4, clusters = [];
  return {
    clusters,
    find(radius, matches) {
      const key = Math.round(radius / step);
      for (const near of [key - 1, key, key + 1]) for (const cluster of buckets.get(near) ?? []) if (matches(cluster)) return cluster;
      return null;
    },
    add(cluster) {
      const key = Math.round(cluster.radius / step);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(cluster); clusters.push(cluster);
      return cluster;
    },
  };
}

function analysePart(part, unit) {
  const size = (() => {
    let span = 0;
    for (const [, axis] of AXES) { const range = partRange({ ...part, inexact: new Set(), curvedFaces: [] }, axis, false); if (range.min != null) span = Math.max(span, range.max - range.min); }
    return span;
  })();
  const tolerance = Math.max(part.tolerance, size * 1e-7, 1e-9);
  part.size = size;
  part.extents = unit && part.unitKnown ? AXES.map(([name, axis]) => ({ axis: name, ...partRange(part, axis) })) : [];
  // Measurement notes belong to the index, not to every visual preview.
  part.notes = part.extents.filter((extent) => !extent.exact)
    .map((extent) => `${part.name} ${extent.axis} extent was not indexed: ${extent.reason} may extend beyond its boundary edges.`);

  // Cylindrical faces sharing an axis and radius form one feature, even when a
  // writer splits a full cylinder into halves.
  const cylinderIndex = radiusClusters(tolerance);
  for (const face of part.faces) {
    const surface = face.surface;
    if (surface.kind !== 'cylinder') continue;
    const match = cylinderIndex.find(surface.radius, (cylinder) => nearlyEqual(cylinder.radius, surface.radius, tolerance)
      && Math.abs(dot(cylinder.axis, surface.axis)) >= 1 - 1e-9
      && Math.hypot(...cross(sub(surface.center, cylinder.center), cylinder.axis)) <= tolerance);
    if (match) match.faces.push(face);
    else cylinderIndex.add({ ...surface, faces: [face] });
  }
  const cylinders = cylinderIndex.clusters;
  part.cylinders = [];
  for (const cylinder of cylinders) {
    const edgeKeys = [...new Set(cylinder.faces.flatMap((face) => face.edgeKeys))];
    const angles = [], heights = [];
    for (const key of edgeKeys) {
      for (const point of sampleEdge(part.edges.get(key), Math.PI / 36)) {
        const offset = sub(point, cylinder.center);
        const height = dot(offset, cylinder.axis);
        heights.push(height);
        if (Math.hypot(...along(offset, cylinder.axis, -height)) > tolerance) angles.push(circleAngle(point, cylinder.center, cylinder.xdir, cylinder.ydir));
      }
    }
    if (!heights.length) continue;
    const { gap, after } = largestGap(angles);
    const senses = new Set(cylinder.faces.map((face) => face.outward));
    // Outward face normal toward the axis means material surrounds the void.
    const kind = senses.size !== 1 || senses.has(null) ? 'cylindrical face' : senses.has(false) ? 'hole' : 'cylinder';
    part.cylinders.push({ kind, full: gap < FULL_TURN_GAP, radius: cylinder.radius, center: cylinder.center, axis: cylinder.axis,
      xdir: cylinder.xdir, ydir: cylinder.ydir, h0: extremes(heights)[0], h1: extremes(heights)[1],
      coverage: gap < FULL_TURN_GAP ? null : { start: after + gap, sweep: TAU - gap },
      faceIds: cylinder.faces.map((face) => face.id), surfaceId: cylinder.id, edgeKeys });
  }

  // Circular edges on one circle merge into maximal arcs; a complete circle
  // (for example a hole rim split into two halves) is not an arc.
  const circleIndex = radiusClusters(tolerance);
  for (const edge of part.edges.values()) {
    if (edge.kind !== 'circle') continue;
    const match = circleIndex.find(edge.radius, (circle) => nearlyEqual(circle.radius, edge.radius, tolerance)
      && distance(circle.center, edge.center) <= tolerance && Math.abs(dot(circle.axis, edge.axis)) >= 1 - 1e-9);
    const target = match ?? circleIndex.add({ radius: edge.radius, center: edge.center, axis: edge.axis, xdir: edge.xdir, ydir: edge.ydir, intervals: [] });
    const first = sampleEdge(edge, TAU)[0], last = sampleEdge(edge, TAU).at(-1);
    const reversed = dot(target.axis, edge.axis) < 0;
    const start = circleAngle(reversed ? last : first, target.center, target.xdir, target.ydir);
    target.intervals.push({ start: mod(start, TAU), sweep: Math.min(edge.sweep, TAU), edge });
  }
  part.arcs = [];
  for (const circle of circleIndex.clusters) {
    const angularTolerance = Math.max(1e-9, tolerance / circle.radius);
    const pieces = [];
    for (const interval of circle.intervals) {
      const end = interval.start + interval.sweep;
      if (end > TAU) pieces.push({ from: interval.start, to: TAU, edge: interval.edge }, { from: 0, to: end - TAU, edge: interval.edge });
      else pieces.push({ from: interval.start, to: end, edge: interval.edge });
    }
    pieces.sort((a, b) => a.from - b.from);
    const merged = [];
    for (const piece of pieces) {
      const last = merged.at(-1);
      if (last && piece.from <= last.to + angularTolerance) { last.to = Math.max(last.to, piece.to); last.edges.add(piece.edge.key); }
      else merged.push({ from: piece.from, to: piece.to, edges: new Set([piece.edge.key]) });
    }
    if (merged.length > 1 && merged[0].from <= angularTolerance && merged.at(-1).to >= TAU - angularTolerance) {
      const tail = merged.pop();
      merged[0] = { from: tail.from - TAU, to: merged[0].to, edges: new Set([...tail.edges, ...merged[0].edges]) };
    }
    const covered = merged.reduce((total, arc) => total + arc.to - arc.from, 0);
    if (covered >= TAU - angularTolerance) continue;
    for (const arc of merged) part.arcs.push({ radius: circle.radius, sweep: arc.to - arc.from, edgeKeys: [...arc.edges],
      curveId: part.edges.get([...arc.edges][0]).curveId });
  }
  // Seams close a periodic face on itself, or join split faces of one
  // cylinder; they are representation artifacts rather than model edges.
  const cylinderOfFace = new Map();
  cylinders.forEach((cylinder, index) => { for (const face of cylinder.faces) cylinderOfFace.set(face.id, index); });
  const seam = (edge) => {
    const faces = new Set(edge.faces);
    if (faces.size <= 1 && edge.faces.length > 1) return true;
    const owners = new Set([...faces].map((face) => cylinderOfFace.get(face)));
    return faces.size > 1 && owners.size === 1 && !owners.has(undefined);
  };
  part.lines = [...part.edges.values()].filter((edge) => edge.kind === 'line' && !seam(edge))
    .map((edge) => ({ length: distance(edge.p0, edge.p1), edge })).filter((line) => line.length > tolerance);
  part.featureTolerance = tolerance;
}

function assemblyExtents(parts, occurrences, rootName) {
  const extents = [];
  for (const [name, axis] of AXES) {
    let min = Infinity, max = -Infinity, exact = true;
    const memo = new Map();
    for (const occurrence of occurrences) {
      const part = parts[occurrence.part];
      if (!part.unitKnown) { exact = false; break; }
      const local = inverseRotate(occurrence.matrix, axis);
      const key = `${occurrence.part}|${local.map((value) => value.toFixed(12)).join(',')}`;
      if (!memo.has(key)) memo.set(key, partRange(part, local));
      const range = memo.get(key);
      if (!range.exact) { exact = false; break; }
      const offset = dot(axis, occurrence.matrix.t);
      min = Math.min(min, range.min + offset); max = Math.max(max, range.max + offset);
    }
    extents.push({ axis: name, min, max, exact: exact && Number.isFinite(min) });
  }
  return { name: rootName, extents };
}

// ── indexed features ─────────────────────────────────────────────────────────
// Keep every measurable feature that can fit the file's 4,000-fact budget.
// Small per-kind caps used to discard ordinary CAD details even when the file
// had ample room. Each group yields at least one fact, so this bound cannot
// remove a feature from a file whose complete measurements fit that budget.
const MAX_FEATURE_GROUPS = 4_000;
export const formatLength = (value) => Number(value.toPrecision(10)).toString();
export const formatDegrees = (radians) => Number((radians * 180 / Math.PI).toPrecision(9)).toString();

function groupWithin(items, values, tolerances) {
  // Sorted on the first value, a matching group can only be among the most
  // recent groups whose first value is still within tolerance.
  const groups = [];
  const keyed = items.map((item) => ({ item, key: values(item) })).sort((a, b) => a.key[0] - b.key[0]);
  for (const { item, key } of keyed) {
    let group = null;
    for (let index = groups.length - 1; index >= 0 && key[0] - groups[index].values[0] <= tolerances[0]; index--) {
      if (groups[index].values.every((value, axis) => Math.abs(value - key[axis]) <= tolerances[axis])) { group = groups[index]; break; }
    }
    if (group) group.items.push(item); else groups.push({ values: key, items: [item] });
  }
  return groups;
}

/** Measured features of one part, shared by indexing and previews so a
 * feature's identity and its highlighted edges always agree. Feature IDs are
 * derived from geometry, as STEP carries no persistent face or edge names. */
export function stepFeatures(part, unitLabel) {
  const tolerance = part.featureTolerance;
  const features = [];
  const omitted = {};
  for (const extent of part.extents) {
    if (extent.exact) features.push({ featureId: `extent:${extent.axis}`, type: 'extent', name: `overall ${extent.axis} extent`,
      axis: extent.axis, value: extent.max - extent.min, min: extent.min, max: extent.max, lowFace: extent.lowFace, highFace: extent.highFace,
      count: 1, edgeKeys: null, cylinders: null });
  }
  for (const kind of ['hole', 'cylinder']) {
    const groups = groupWithin(part.cylinders.filter((cylinder) => cylinder.full && cylinder.kind === kind),
      (cylinder) => [cylinder.radius * 2, cylinder.h1 - cylinder.h0], [tolerance * 2, tolerance])
      .sort((a, b) => b.values[0] - a.values[0] || b.values[1] - a.values[1]);
    const available = MAX_FEATURE_GROUPS - features.length;
    if (groups.length > available) omitted[kind] = groups.length - available;
    const kept = groups.slice(0, available);
    const diameterCounts = new Map();
    for (const group of kept) {
      const diameter = formatLength(group.values[0]);
      diameterCounts.set(diameter, (diameterCounts.get(diameter) ?? 0) + 1);
    }
    for (const group of kept) {
      const [diameter, length] = group.values;
      const shared = diameterCounts.get(formatLength(diameter)) > 1;
      features.push({ featureId: `${kind}:${formatLength(diameter)}:${formatLength(length)}`, type: kind,
        name: `Ø${formatLength(diameter)}${shared ? ` × ${formatLength(length)}` : ''} ${kind}`,
        diameter, length, count: group.items.length, surfaceId: group.items[0].surfaceId,
        edgeKeys: [...new Set(group.items.flatMap((cylinder) => cylinder.edgeKeys))], cylinders: group.items });
    }
  }
  const arcs = groupWithin(part.arcs, (arc) => [arc.radius, arc.sweep], [tolerance, Math.max(1e-9, tolerance / Math.max(extremes(part.arcs.map((arc) => arc.radius))[1], 1))])
    .sort((a, b) => b.values[0] - a.values[0] || b.values[1] - a.values[1]);
  const availableArcs = MAX_FEATURE_GROUPS - features.length;
  if (arcs.length > availableArcs) omitted.arc = arcs.length - availableArcs;
  for (const group of arcs.slice(0, availableArcs)) {
    const [radius, sweep] = group.values;
    features.push({ featureId: `arc:${formatLength(radius)}:${formatDegrees(sweep)}`, type: 'arc',
      name: `R${formatLength(radius)} ${formatDegrees(sweep)}° arc`, radius, sweep, arcLength: radius * sweep,
      count: group.items.length, curveId: group.items[0].curveId, edgeKeys: [...new Set(group.items.flatMap((arc) => arc.edgeKeys))], cylinders: null });
  }
  const edges = groupWithin(part.lines, (line) => [line.length], [tolerance]).sort((a, b) => b.values[0] - a.values[0]);
  const availableEdges = MAX_FEATURE_GROUPS - features.length;
  if (edges.length > availableEdges) omitted.edge = edges.length - availableEdges;
  for (const group of edges.slice(0, availableEdges)) {
    const [length] = group.values;
    features.push({ featureId: `edge:${formatLength(length)}`, type: 'edge', name: `${formatLength(length)} ${unitLabel} straight edge`,
      length, count: group.items.length, edgeId: group.items[0].edge.id, edgeKeys: group.items.map((line) => line.edge.key), cylinders: null });
  }
  return { features, omitted };
}
