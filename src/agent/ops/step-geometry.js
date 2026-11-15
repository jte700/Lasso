// Geometry for assemblies (paper §6.2): rigid transforms, exact bounds of
// recognised primitives, and two-sided convex approximations for refinement.
//
// A box is its own exact convex polytope. A cylinder has an inscribed prism
// (inside it: if two inner shapes interpenetrate, the solids do) and a
// circumscribed prism (around it: if two outer shapes are apart, the solids
// are). Refinement doubles the prism's sides until one test settles the
// question or the budget runs out; the gap or depth is then an interval.
// Anything else gets only an outer box: it can be certified apart, never in contact.

export const vec = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]; },
};

/** 4×4 row-major rigid transforms acting on column vectors. */
export const mat = {
  identity: () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  multiply: (a, b) => a.map((row) => [0, 1, 2, 3].map((column) => row.reduce((sum, value, index) => sum + value * b[index][column], 0))),
  apply: (m, p) => [0, 1, 2].map((row) => m[row][0] * p[0] + m[row][1] * p[1] + m[row][2] * p[2] + m[row][3]),
  rotate: (m, d) => [0, 1, 2].map((row) => m[row][0] * d[0] + m[row][1] * d[1] + m[row][2] * d[2]),
  invertRigid: (m) => {
    const r = [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
    const t = [m[0][3], m[1][3], m[2][3]];
    const rt = r.map((row) => -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]));
    return [[...r[0], rt[0]], [...r[1], rt[1]], [...r[2], rt[2]], [0, 0, 0, 1]];
  },
  translation: ([x, y, z]) => [[1, 0, 0, x], [0, 1, 0, y], [0, 0, 1, z], [0, 0, 0, 1]],
  /** A placement from origin, z axis and x direction (AXIS2_PLACEMENT_3D): local → parent. */
  placement: (origin, z = [0, 0, 1], x = [1, 0, 0]) => {
    const zAxis = vec.unit(z);
    const xAxis = vec.unit(vec.sub(x, vec.scale(zAxis, vec.dot(x, zAxis))));
    const yAxis = vec.cross(zAxis, xAxis);
    return [[xAxis[0], yAxis[0], zAxis[0], origin[0]], [xAxis[1], yAxis[1], zAxis[1], origin[1]], [xAxis[2], yAxis[2], zAxis[2], origin[2]], [0, 0, 0, 1]];
  },
  rotationZ: (degrees) => {
    const c = Math.cos(degrees * Math.PI / 180);
    const s = Math.sin(degrees * Math.PI / 180);
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  },
};

/** True when a transform is rigid (orthonormal, right-handed) within tolerance. */
export function isRigid(m, tolerance = 1e-6) {
  const columns = [0, 1, 2].map((column) => [m[0][column], m[1][column], m[2][column]]);
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(vec.norm(columns[i]) - 1) > tolerance) return false;
    for (let j = i + 1; j < 3; j += 1) if (Math.abs(vec.dot(columns[i], columns[j])) > tolerance) return false;
  }
  return vec.dot(vec.cross(columns[0], columns[1]), columns[2]) > 0;
}

// ── primitives in world space ───────────────────────────────────────────────

/** A shape's world form. Box: {kind:'box', center, axes[3], half[3]}; cylinder: {kind:'cylinder', base, axis, radius, length}; other: {kind:'bounds', min, max}. */
export function worldShape(shape, transform) {
  if (shape.kind === 'box') {
    const center = mat.apply(transform, shape.center);
    return { kind: 'box', center, axes: shape.axes.map((axis) => mat.rotate(transform, axis)), half: shape.half };
  }
  if (shape.kind === 'cylinder') {
    return { kind: 'cylinder', base: mat.apply(transform, shape.base), axis: mat.rotate(transform, shape.axis), radius: shape.radius, length: shape.length };
  }
  // Conservative: the transformed corners of the local bounds.
  const corners = [];
  for (const x of [shape.min[0], shape.max[0]]) for (const y of [shape.min[1], shape.max[1]]) for (const z of [shape.min[2], shape.max[2]]) corners.push(mat.apply(transform, [x, y, z]));
  return { kind: 'bounds', min: [0, 1, 2].map((k) => Math.min(...corners.map((p) => p[k]))), max: [0, 1, 2].map((k) => Math.max(...corners.map((p) => p[k]))) };
}

/** Exact axis-aligned bounds for boxes and cylinders; the given bounds otherwise. */
export function aabb(shape) {
  if (shape.kind === 'box') {
    const extent = [0, 1, 2].map((k) => shape.axes.reduce((sum, axis, index) => sum + Math.abs(axis[k]) * shape.half[index], 0));
    return { min: shape.center.map((value, k) => value - extent[k]), max: shape.center.map((value, k) => value + extent[k]) };
  }
  if (shape.kind === 'cylinder') {
    const top = vec.add(shape.base, vec.scale(shape.axis, shape.length));
    const extent = [0, 1, 2].map((k) => shape.radius * Math.sqrt(Math.max(0, 1 - shape.axis[k] ** 2)));
    return { min: [0, 1, 2].map((k) => Math.min(shape.base[k], top[k]) - extent[k]), max: [0, 1, 2].map((k) => Math.max(shape.base[k], top[k]) + extent[k]) };
  }
  return { min: shape.min, max: shape.max };
}

export const unionBounds = (boxes) => ({ min: [0, 1, 2].map((k) => Math.min(...boxes.map((box) => box.min[k]))), max: [0, 1, 2].map((k) => Math.max(...boxes.map((box) => box.max[k]))) });
export const boundsOverlap = (a, b, gap = 0) => [0, 1, 2].every((k) => a.min[k] - gap < b.max[k] && b.min[k] - gap < a.max[k]);

const perpendicular = (axis) => {
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = vec.unit(vec.cross(axis, helper));
  return [u, vec.cross(axis, u)];
};

/** Vertices of a convex polytope approximating a shape: 'exact' (boxes), 'outer' or 'inner' with `sides` for cylinders. */
export function polytope(shape, mode, sides = 32) {
  if (shape.kind === 'box') {
    const points = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      points.push(vec.add(shape.center, vec.add(vec.scale(shape.axes[0], sx * shape.half[0]), vec.add(vec.scale(shape.axes[1], sy * shape.half[1]), vec.scale(shape.axes[2], sz * shape.half[2])))));
    }
    return points;
  }
  if (shape.kind === 'cylinder') {
    const radius = mode === 'outer' ? shape.radius / Math.cos(Math.PI / sides) : shape.radius;
    const [u, v] = perpendicular(shape.axis);
    const top = vec.add(shape.base, vec.scale(shape.axis, shape.length));
    const points = [];
    for (let index = 0; index < sides; index += 1) {
      const angle = (2 * Math.PI * index) / sides;
      const offset = vec.add(vec.scale(u, radius * Math.cos(angle)), vec.scale(v, radius * Math.sin(angle)));
      points.push(vec.add(shape.base, offset), vec.add(top, offset));
    }
    return points;
  }
  if (mode === 'inner') return null;
  const points = [];
  for (const x of [shape.min[0], shape.max[0]]) for (const y of [shape.min[1], shape.max[1]]) for (const z of [shape.min[2], shape.max[2]]) points.push([x, y, z]);
  return points;
}

// ── GJK distance between convex hulls of point sets ─────────────────────────

const support = (points, direction) => {
  let best = points[0];
  let bestValue = vec.dot(best, direction);
  for (let index = 1; index < points.length; index += 1) {
    const value = vec.dot(points[index], direction);
    if (value > bestValue) { bestValue = value; best = points[index]; }
  }
  return best;
};

/** Closest point to the origin on a simplex (1–4 points), with the smallest sub-simplex that contains it. */
function closestOnSimplex(simplex) {
  if (simplex.length === 1) return { point: simplex[0], simplex };
  if (simplex.length === 2) {
    const [a, b] = simplex;
    const ab = vec.sub(b, a);
    const t = -vec.dot(a, ab) / Math.max(vec.dot(ab, ab), 1e-300);
    if (t <= 0) return { point: a, simplex: [a] };
    if (t >= 1) return { point: b, simplex: [b] };
    return { point: vec.add(a, vec.scale(ab, t)), simplex };
  }
  if (simplex.length === 3) return closestOnTriangle(simplex);
  return closestOnTetrahedron(simplex);
}

function closestOnTriangle([a, b, c]) {
  // Ericson, Real-Time Collision Detection §5.1.5, with the query point at the origin.
  const ab = vec.sub(b, a);
  const ac = vec.sub(c, a);
  const ap = vec.scale(a, -1);
  const d1 = vec.dot(ab, ap);
  const d2 = vec.dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, simplex: [a] };
  const bp = vec.scale(b, -1);
  const d3 = vec.dot(ab, bp);
  const d4 = vec.dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, simplex: [b] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); return { point: vec.add(a, vec.scale(ab, t)), simplex: [a, b] }; }
  const cp = vec.scale(c, -1);
  const d5 = vec.dot(ab, cp);
  const d6 = vec.dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, simplex: [c] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); return { point: vec.add(a, vec.scale(ac, t)), simplex: [a, c] }; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return { point: vec.add(b, vec.scale(vec.sub(c, b), t)), simplex: [b, c] };
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return { point: vec.add(a, vec.add(vec.scale(ab, v), vec.scale(ac, w))), simplex: [a, b, c] };
}

function closestOnTetrahedron([a, b, c, d]) {
  // The origin is inside unless it lies outside one of the faces; then the closest point is on such a face.
  // A flat (degenerate) tetrahedron has no inside: every face is tried.
  const faces = [[a, b, c, d], [a, c, d, b], [a, d, b, c], [b, d, c, a]];
  const volume = Math.abs(vec.dot(vec.sub(d, a), vec.cross(vec.sub(b, a), vec.sub(c, a))));
  const scale = Math.max(vec.norm(vec.sub(b, a)), vec.norm(vec.sub(c, a)), vec.norm(vec.sub(d, a)), 1e-12);
  const flat = volume < 1e-12 * scale ** 3;
  let best = null;
  let inside = !flat;
  for (const [p, q, r, opposite] of faces) {
    const normal = vec.cross(vec.sub(q, p), vec.sub(r, p));
    const originSide = vec.dot(vec.scale(p, -1), normal);
    const oppositeSide = vec.dot(vec.sub(opposite, p), normal);
    if (flat || originSide * oppositeSide < 0) {
      inside = false;
      const candidate = closestOnTriangle([p, q, r]);
      if (!best || vec.dot(candidate.point, candidate.point) < vec.dot(best.point, best.point)) best = candidate;
    }
  }
  if (inside) return { point: [0, 0, 0], simplex: [a, b, c, d] };
  return best;
}

/** Euclidean distance between the convex hulls of two point sets (0 when they meet). */
export function distance(pointsA, pointsB) {
  const minkowski = (direction) => vec.sub(support(pointsA, direction), support(pointsB, vec.scale(direction, -1)));
  let v = vec.sub(pointsA[0], pointsB[0]);
  let simplex = [];
  for (let iteration = 0; iteration < 128; iteration += 1) {
    const length2 = vec.dot(v, v);
    if (length2 < 1e-20) return 0;
    const w = minkowski(vec.scale(v, -1));
    // No further progress towards the origin (or a support point already held): v is the closest point.
    if (length2 - vec.dot(v, w) <= 1e-12 * Math.max(1, length2)) return Math.sqrt(length2);
    if (simplex.some((point) => point[0] === w[0] && point[1] === w[1] && point[2] === w[2])) return Math.sqrt(length2);
    simplex = [...simplex, w];
    const closest = closestOnSimplex(simplex);
    simplex = closest.simplex;
    v = closest.point;
    if (simplex.length === 4) return 0;
  }
  return Math.sqrt(vec.dot(v, v));
}

// ── penetration through separating axes ─────────────────────────────────────

/** Face normals and edge directions of the shape's polytope, for the separating-axis test. */
function axesOf(shape, sides) {
  if (shape.kind === 'box') return { faces: shape.axes, edges: shape.axes };
  if (shape.kind === 'cylinder') {
    const [u, v] = perpendicular(shape.axis);
    const faces = [shape.axis];
    const edges = [shape.axis];
    for (let index = 0; index < sides; index += 1) {
      const angle = (2 * Math.PI * (index + 0.5)) / sides;
      faces.push(vec.add(vec.scale(u, Math.cos(angle)), vec.scale(v, Math.sin(angle))));
      const along = (2 * Math.PI * (index + 1)) / sides;
      edges.push(vec.add(vec.scale(u, -Math.sin(along)), vec.scale(v, Math.cos(along))));
    }
    return { faces, edges };
  }
  return { faces: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], edges: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
}

/**
 * Minimum overlap of the two polytopes' projections over every face normal and edge-pair
 * axis: for convex polytopes this is their penetration depth (≤ 0 when they are apart).
 */
export function penetration(shapeA, pointsA, shapeB, pointsB, sides) {
  const a = axesOf(shapeA, sides);
  const b = axesOf(shapeB, sides);
  const axes = [...a.faces, ...b.faces];
  for (const edgeA of a.edges) for (const edgeB of b.edges) {
    const axis = vec.cross(edgeA, edgeB);
    if (vec.norm(axis) > 1e-9) axes.push(vec.unit(axis));
  }
  let depth = Infinity;
  for (const axis of axes) {
    let minA = Infinity; let maxA = -Infinity; let minB = Infinity; let maxB = -Infinity;
    for (const p of pointsA) { const value = vec.dot(p, axis); if (value < minA) minA = value; if (value > maxA) maxA = value; }
    for (const p of pointsB) { const value = vec.dot(p, axis); if (value < minB) minB = value; if (value > maxB) maxB = value; }
    const overlap = Math.min(maxA - minB, maxB - minA);
    if (overlap < depth) depth = overlap;
    if (depth <= 0) return depth;
  }
  return depth;
}

const SIDES = [16, 32, 64, 128];
const curved = (shape) => shape.kind === 'cylinder';

/**
 * Settles whether two solids interpenetrate. Returns {status: 'apart'|'overlap'|'unresolved', gap: [lo, hi]
 * (apart) or depth: [lo, hi] (overlap), refinements}. `tolerance` treats gaps below it as contact.
 */
export function relate(shapeA, shapeB, { tolerance = 1e-6 } = {}) {
  const exact = !curved(shapeA) && !curved(shapeB) && shapeA.kind !== 'bounds' && shapeB.kind !== 'bounds';
  let lastGap = null;
  for (const sides of exact ? [0] : SIDES) {
    const outerA = polytope(shapeA, 'outer', sides);
    const outerB = polytope(shapeB, 'outer', sides);
    const outerGap = distance(outerA, outerB);
    const innerA = polytope(shapeA, 'inner', sides);
    const innerB = polytope(shapeB, 'inner', sides);
    if (outerGap > tolerance) {
      const upper = innerA && innerB ? distance(innerA, innerB) : null;
      return { status: 'apart', gap: [outerGap, upper], refinements: sides };
    }
    if (innerA && innerB) {
      const depthInner = penetration(shapeA, innerA, shapeB, innerB, sides);
      if (depthInner > tolerance) {
        const depthOuter = penetration(shapeA, outerA, shapeB, outerB, sides);
        return { status: 'overlap', depth: [depthInner, Math.max(depthInner, depthOuter)], refinements: sides };
      }
      // Exact shapes neither apart nor interpenetrating are touching: certain for boxes, never for approximations.
      if (exact) return { status: 'contact', gap: [0, 0], refinements: 0 };
      lastGap = { innerGap: distance(innerA, innerB), depthInner };
    }
    if (exact) break;
  }
  return { status: 'unresolved', detail: lastGap, refinements: exact ? 0 : SIDES.at(-1) };
}

/** Distance between two solids as an interval [outer, inner] at the finest refinement (equal for boxes). */
export function gapBetween(shapeA, shapeB) {
  const sides = SIDES.at(-1);
  const lower = distance(polytope(shapeA, 'outer', sides), polytope(shapeB, 'outer', sides));
  const innerA = polytope(shapeA, 'inner', sides);
  const innerB = polytope(shapeB, 'inner', sides);
  return [lower, innerA && innerB ? distance(innerA, innerB) : null];
}

/**
 * The least distance `moving` must travel along unit `direction` so it no longer
 * overlaps `fixed`, as an interval: inner shapes give a lower bound, outer an upper one.
 */
export function clearanceAlong(moving, fixed, direction, { maximum = 10_000 } = {}) {
  const sides = SIDES.at(-1);
  const bound = (mode) => {
    const a = polytope(moving, mode, sides);
    const b = polytope(fixed, mode, sides);
    if (!a || !b) return null;
    const at = (t) => a.map((p) => vec.add(p, vec.scale(direction, t)));
    // Convex shapes moving in a straight line overlap over one interval of travel: bisect for its end.
    if (distance(a, b) > 1e-9) return 0;
    if (distance(at(maximum), b) <= 1e-9) return Infinity;
    let low = 0;
    let high = maximum;
    for (let step = 0; step < 80 && high - low > 1e-7; step += 1) {
      const middle = (low + high) / 2;
      if (distance(at(middle), b) <= 1e-9) low = middle; else high = middle;
    }
    return high;
  };
  return [bound('inner'), bound('outer')];
}
