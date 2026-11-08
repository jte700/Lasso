// Part instances of a STEP assembly, for agents: where each one sits, and how
// two of them stand to each other, from the assembly's own placements. The
// placements are read with the app's STEP parser (readStepModel), composed
// into the assembly's frame; a relation is computed by the structural
// framework's geometry operators (structural/adapters.js) and checked by its
// compiler (structural/compiler.js), so a placement the parser could not
// settle, or a matrix that is not a rotation and a translation, is refused
// rather than guessed. Pure functions; the caller authorizes and reads files.

import { geometryContextFromStepModel, rigidMatrix, STRUCTURAL_WARNING, StructuralAdapterError } from './structural/adapters.js';
import { compileContext } from './structural/compiler.js';

const fold = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Four decimals: placements are written to the micrometre, and float noise ("1e-16") goes.
const number = (value) => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
};
const AXES = ['x', 'y', 'z'];

/** A world (assembly-frame) 4×4 transform from the parser's { r: 3×3 row-major, t }. */
function transformOf(matrix) {
  const { r, t } = matrix;
  return [[r[0], r[1], r[2], t[0]], [r[3], r[4], r[5], t[1]], [r[6], r[7], r[8], t[2]], [0, 0, 0, 1]];
}

/**
 * How a rotation turns, as people say it: "turned 90° about z", or about an
 * axis given as a unit vector when it is no coordinate axis. Null when it
 * does not turn.
 */
export function turnOf(rotation) {
  const [[a, b, c], [d, e, f], [g, h, i]] = rotation;
  const angle = Math.acos(Math.min(1, Math.max(-1, (a + e + i - 1) / 2)));
  if (angle < 1e-9) return null;
  let axis;
  if (Math.PI - angle < 1e-6) {
    // Half a turn: the axis is the rotation's +1 eigenvector, read from its diagonal.
    const x = Math.sqrt(Math.max(0, (a + 1) / 2));
    const y = Math.sqrt(Math.max(0, (e + 1) / 2)) * (x > 1e-9 ? Math.sign(b || 1) : 1);
    const z = Math.sqrt(Math.max(0, (i + 1) / 2)) * (x > 1e-9 ? Math.sign(c || 1) : Math.sign(f || 1));
    axis = [x, y, z];
  } else {
    const s = 2 * Math.sin(angle);
    axis = [(h - f) / s, (c - g) / s, (d - b) / s];
  }
  const length = Math.hypot(...axis);
  axis = axis.map((value) => value / length);
  const named = AXES.findIndex((_, index) => Math.abs(Math.abs(axis[index]) - 1) < 1e-6);
  return { degrees: number(angle * 180 / Math.PI),
    about: named >= 0 ? `${axis[named] < 0 ? '-' : ''}${AXES[named]}` : axis.map(number) };
}

/**
 * The assembly's part instances: each with the label people and the file use
 * for it (its last name in the assembly tree, "Pin:2"), its path, its part,
 * and its placement in the assembly frame. Instances whose names repeat are
 * told apart by their order ("Pin #1", "Pin #2"), as their files list them.
 */
export function instancesOf(model) {
  const settled = !(model.warnings ?? []).some((warning) => STRUCTURAL_WARNING.test(String(warning)));
  const paths = model.occurrences.map((occurrence) => occurrence.path.join('/'));
  const seen = new Map();
  return model.occurrences.map((occurrence, index) => {
    const duplicates = paths.filter((path) => path === paths[index]).length;
    const order = (seen.get(paths[index]) ?? 0) + 1;
    seen.set(paths[index], order);
    const name = occurrence.path.at(-1);
    const label = duplicates > 1 ? `${name} #${order}` : name;
    let placement = null;
    if (settled) {
      try {
        const transform = rigidMatrix(transformOf(occurrence.matrix), `placement of ${label}`);
        placement = { at: transform.slice(0, 3).map((row) => number(row[3])), turn: turnOf(transform.slice(0, 3).map((row) => row.slice(0, 3))) };
      } catch (error) {
        if (!(error instanceof StructuralAdapterError)) throw error;
      }
    }
    return { id: `occurrence:${index}`, label, path: duplicates > 1 ? `${paths[index]} #${order}` : paths[index],
      part: model.parts[occurrence.part]?.name ?? null, placement };
  });
}

/**
 * The instances an ask names, by label ("Pin:2", "pin 2") or by path when a
 * label repeats: `{ named, ambiguous }`, where ambiguous lists labels that
 * name several instances and that the ask does not settle by path.
 */
export function namedInstances(instances, text) {
  const asked = ` ${fold(text)} `;
  const has = (value) => asked.includes(` ${fold(value)} `);
  const byPath = instances.filter((instance) => instance.path.includes('/') && has(instance.path.split('/').slice(1).join(' ')));
  const named = [...byPath];
  const ambiguous = [];
  for (const instance of instances) {
    if (named.includes(instance) || !has(instance.label)) continue;
    const same = instances.filter((other) => fold(other.label) === fold(instance.label));
    if (same.length > 1 && !same.some((other) => byPath.includes(other))) {
      if (!ambiguous.some((entry) => fold(entry.label) === fold(instance.label))) ambiguous.push({ label: instance.label, paths: same.map((other) => other.path) });
      continue;
    }
    named.push(instance);
  }
  // In the order the ask names them: "Pin:2 relative to Pin:1" is Pin:2 seen from Pin:1.
  const at = (instance) => Math.min(...[instance.label, instance.path.split('/').slice(1).join(' ')].filter(Boolean)
    .map((value) => asked.indexOf(` ${fold(value)} `)).filter((index) => index >= 0));
  return { named: [...new Set(named)].sort((left, right) => at(left) - at(right)), ambiguous };
}

/**
 * How instance `b` stands to instance `a`: b's origin and turn in a's frame,
 * the distance between their origins, and the unsigned angle between each of
 * their like-named axes, computed by the structural geometry operators over
 * the two validated placements. `source` is the file revision ({ id, revision }),
 * the only revision the compiler accepts. Throws StructuralAdapterError when
 * a placement is not settled or not rigid, or the unit is unknown.
 */
export function relationOf(model, a, b, source) {
  const queries = [{ id: 'pose', op: 'relative_transform', a: a.id, b: b.id },
    ...AXES.map((axis) => ({ id: `angle-${axis}`, op: 'axis_angle', a: a.id, b: b.id, axisA: axis, axisB: axis }))];
  const graph = geometryContextFromStepModel(model, { source, queries });
  const compiled = compileContext({ ...graph, budgetBytes: 1 << 20 });
  if (compiled.payload.status !== 'complete_for_declared_requirements') {
    const reasons = compiled.audit.rejectedAlternatives.flatMap((alternative) => alternative.reasons);
    throw new StructuralAdapterError('incomplete', `The relation could not be computed: ${reasons.join('; ') || compiled.payload.missing.join(', ')}.`);
  }
  const results = compiled.payload.evidence.filter((record) => record.id.includes(':result:')).map((record) => JSON.parse(record.text));
  const pose = results.find((result) => result.operation === 'relative_transform');
  const offset = pose.transform.slice(0, 3).map((row) => number(row[3]));
  const angles = Object.fromEntries(AXES.map((axis) => [axis, number(results.find((result) => result.operation === 'axis_angle' && result.axis_a === axis).angle_degrees)]));
  return { unit: pose.length_unit, offset, distance: number(Math.hypot(...pose.transform.slice(0, 3).map((row) => row[3]))),
    turn: turnOf(pose.transform.slice(0, 3).map((row) => row.slice(0, 3))), angles,
    checked: { solver: compiled.audit.solver, records: compiled.audit.validatedRecordIds.length } };
}
