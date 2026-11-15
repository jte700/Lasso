// The assembly adapter (paper §6.2). It reads a STEP assembly into
// occurrences with identity (a path of instance names), part definitions,
// composed placements in millimetres and recognised solids: boxes and right
// circular cylinders exactly, anything else as a conservative bounding box.
// Global questions (counts over every level, overall extent, interference
// over every pair of solids, clearance along a direction) are computed
// locally; a pair is called overlapping only when inner approximations
// interpenetrate, and apart only when outer ones are separated.

import { aabb, boundsOverlap, clearanceAlong, gapBetween, isRigid, mat, relate, unionBounds, vec, worldShape } from './step-geometry.js';
import { parseStep, part } from './step-parse.js';
import { fmt, form, head, OpError, plural, result } from './common.js';

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const showPoint = (p) => `(${p.map((value) => fmt(round(value))).join(', ')})`;
const showBounds = (box) => `x ${fmt(round(box.min[0]))}..${fmt(round(box.max[0]))}, y ${fmt(round(box.min[1]))}..${fmt(round(box.max[1]))}, z ${fmt(round(box.min[2]))}..${fmt(round(box.max[2]))}`;

// ── reading the file ────────────────────────────────────────────────────────

function lengthUnit(entities) {
  for (const entity of entities.values()) {
    if (!part(entity, 'LENGTH_UNIT')) continue;
    const si = part(entity, 'SI_UNIT');
    if (si) {
      const prefix = si.args[0]?.enum ?? null;
      const factor = { MILLI: 1, CENTI: 10, DECI: 100, KILO: 1e6 }[prefix] ?? (prefix === null ? 1000 : null);
      if (factor !== null) return { name: prefix === 'MILLI' ? 'mm' : prefix === null ? 'm' : `${prefix.toLowerCase()}metre`, toMm: factor };
    }
    const converted = part(entity, 'CONVERSION_BASED_UNIT');
    if (converted && /inch/i.test(converted.args[0])) return { name: 'inch', toMm: 25.4 };
    if (converted && /foot|feet/i.test(converted.args[0])) return { name: 'foot', toMm: 304.8 };
  }
  return null;
}

function readAssembly(text) {
  const { entities, schema } = parseStep(text);
  const get = (reference) => (reference && typeof reference === 'object' && 'ref' in reference ? entities.get(reference.ref) : null);
  const unit = lengthUnit(entities);
  const scale = unit?.toMm ?? 1;
  const point = (reference) => get(reference).args[1].map((value) => value * scale);
  const direction = (reference) => (reference ? vec.unit(get(reference).args[1]) : null);
  const placementMatrix = (reference) => {
    const entity = get(reference);
    if (!entity || entity.type !== 'AXIS2_PLACEMENT_3D') return null;
    return mat.placement(point(entity.args[1]), direction(entity.args[2]) ?? [0, 0, 1], direction(entity.args[3]) ?? [1, 0, 0]);
  };

  const definitions = new Map();
  for (const [id, entity] of entities) {
    if (entity.type !== 'PRODUCT_DEFINITION') continue;
    const formation = get(entity.args[2]);
    const product = get(formation?.args[2]);
    definitions.set(id, { id, name: product?.args[1] || product?.args[0] || `definition #${id}`, description: typeof product?.args[2] === 'string' ? product.args[2] : '', representations: [], solids: [], children: [] });
  }
  const shapeOf = new Map();
  const occurrenceShape = new Map();
  for (const [id, entity] of entities) {
    if (entity.type === 'PRODUCT_DEFINITION_SHAPE') {
      const target = entity.args[2]?.ref;
      if (definitions.has(target)) shapeOf.set(id, target);
      else if (entities.get(target)?.type === 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') occurrenceShape.set(id, target);
    }
  }
  const representationOwner = new Map();
  for (const entity of entities.values()) {
    if (entity.type !== 'SHAPE_DEFINITION_REPRESENTATION') continue;
    const definition = shapeOf.get(entity.args[0]?.ref);
    if (definition) { definitions.get(definition).representations.push(entity.args[1].ref); representationOwner.set(entity.args[1].ref, definition); }
  }
  // Plain representation relationships link a definition's shape to its geometry.
  const linked = new Map();
  for (const entity of entities.values()) {
    if (entity.type !== 'SHAPE_REPRESENTATION_RELATIONSHIP') continue;
    const [a, b] = [entity.args[2]?.ref, entity.args[3]?.ref];
    if (!linked.has(a)) linked.set(a, []);
    if (!linked.has(b)) linked.set(b, []);
    linked.get(a).push(b);
    linked.get(b).push(a);
  }
  for (const definition of definitions.values()) {
    const seen = new Set();
    const queue = [...definition.representations];
    while (queue.length) {
      const representation = queue.shift();
      if (seen.has(representation)) continue;
      seen.add(representation);
      for (const next of linked.get(representation) ?? []) if (!representationOwner.has(next) || representationOwner.get(next) === definition.id) queue.push(next);
      const entity = entities.get(representation);
      for (const item of entity?.args?.[1] ?? []) {
        const solid = get(item);
        if (solid?.type === 'MANIFOLD_SOLID_BREP') definition.solids.push(recognise(solid, get, point, direction, placementMatrix, scale));
      }
    }
  }
  // Occurrences: NAUO plus the transformation its context-dependent representation carries.
  const usages = new Map();
  for (const [id, entity] of entities) {
    if (entity.type !== 'NEXT_ASSEMBLY_USAGE_OCCURRENCE') continue;
    usages.set(id, { id, name: entity.args[1] || entity.args[0] || `occurrence #${id}`, parent: entity.args[3]?.ref, child: entity.args[4]?.ref, transform: null, problem: null });
  }
  for (const entity of entities.values()) {
    if (entity.type !== 'CONTEXT_DEPENDENT_SHAPE_REPRESENTATION') continue;
    const usage = usages.get(occurrenceShape.get(entity.args[1]?.ref));
    if (!usage) continue;
    const relation = get(entity.args[0]);
    const withTransform = part(relation, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
    const transformation = get(withTransform?.args[0]);
    if (transformation?.type !== 'ITEM_DEFINED_TRANSFORMATION') { usage.problem = 'placement is not an item-defined transformation'; continue; }
    const from = placementMatrix(transformation.args[2]);
    const to = placementMatrix(transformation.args[3]);
    if (!from || !to) { usage.problem = 'placement axes missing'; continue; }
    usage.transform = mat.multiply(to, mat.invertRigid(from));
    if (!isRigid(usage.transform)) usage.problem = 'placement is not rigid';
  }
  for (const usage of usages.values()) definitions.get(usage.parent)?.children.push(usage);
  const children = new Set([...usages.values()].map((usage) => usage.child));
  const roots = [...definitions.values()].filter((definition) => !children.has(definition.id) && definition.children.length);
  return { schema, unit, definitions, roots };
}

/** A B-rep solid as an exact box, an exact cylinder, or conservative bounds. */
function recognise(solid, get, point, direction, placementMatrix, scale) {
  const shell = get(solid.args[1]);
  const faces = (shell?.args[1] ?? []).map(get);
  const surfaces = faces.map((face) => get(face.args[2]));
  const vertices = new Map();
  const edges = [];
  const circles = [];
  for (const face of faces) {
    for (const bound of face.args[1].map(get)) {
      for (const oriented of get(bound.args[1]).args[1].map(get)) {
        const edge = get(oriented.args[3]);
        const ends = [edge.args[1], edge.args[2]].map((reference) => {
          const vertexPoint = get(reference);
          const p = point(vertexPoint.args[1]);
          vertices.set(reference.ref, p);
          return reference.ref;
        });
        edges.push(ends);
        const curve = get(edge.args[3]);
        if (curve?.type === 'CIRCLE') circles.push({ center: point(get(curve.args[1]).args[1]), radius: curve.args[2] * scale });
      }
    }
  }
  const points = [...vertices.values()];
  const kinds = surfaces.map((surface) => surface?.type);
  // Box: six planes, eight corners, three orthogonal edges from one corner spanning all of them.
  if (kinds.length === 6 && kinds.every((kind) => kind === 'PLANE') && points.length === 8) {
    const [first] = vertices.keys();
    const neighbours = [...new Set(edges.filter((pair) => pair.includes(first)).map((pair) => (pair[0] === first ? pair[1] : pair[0])))];
    if (neighbours.length === 3) {
      const origin = vertices.get(first);
      const spans = neighbours.map((id) => vec.sub(vertices.get(id), origin));
      const orthogonal = [[0, 1], [0, 2], [1, 2]].every(([i, j]) => Math.abs(vec.dot(vec.unit(spans[i]), vec.unit(spans[j]))) < 1e-9);
      const expected = [];
      for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) expected.push(vec.add(origin, vec.add(vec.scale(spans[0], a), vec.add(vec.scale(spans[1], b), vec.scale(spans[2], c)))));
      const matches = expected.every((candidate) => points.some((p) => vec.norm(vec.sub(p, candidate)) < 1e-6));
      if (orthogonal && matches) {
        // Edges listed along local x, y, z where the box is square to its own frame.
        const dominant = (span) => [0, 1, 2].reduce((best, k) => (Math.abs(span[k]) > Math.abs(span[best]) ? k : best), 0);
        if (new Set(spans.map(dominant)).size === 3) spans.sort((a, b) => dominant(a) - dominant(b));
        const center = vec.add(origin, vec.scale(vec.add(spans[0], vec.add(spans[1], spans[2])), 0.5));
        return { kind: 'box', center, axes: spans.map(vec.unit), half: spans.map((span) => vec.norm(span) / 2), size: spans.map(vec.norm) };
      }
    }
  }
  // Cylinder: one cylindrical surface (possibly split) and two planes square to its axis.
  const cylinders = surfaces.filter((surface) => surface?.type === 'CYLINDRICAL_SURFACE');
  const planes = surfaces.filter((surface) => surface?.type === 'PLANE');
  if (cylinders.length >= 1 && planes.length === 2 && cylinders.length + planes.length === surfaces.length) {
    const frames = cylinders.map((surface) => ({ placement: placementMatrix(surface.args[1]), radius: surface.args[2] }));
    const axis = [frames[0].placement[0][2], frames[0].placement[1][2], frames[0].placement[2][2]];
    const anchor = [frames[0].placement[0][3], frames[0].placement[1][3], frames[0].placement[2][3]];
    const sameAxis = frames.every((frame) => Math.abs(Math.abs(vec.dot([frame.placement[0][2], frame.placement[1][2], frame.placement[2][2]], axis)) - 1) < 1e-9 && Math.abs(frame.radius - frames[0].radius) < 1e-9);
    const square = planes.every((plane) => {
      const frame = placementMatrix(plane.args[1]);
      return Math.abs(Math.abs(vec.dot([frame[0][2], frame[1][2], frame[2][2]], axis)) - 1) < 1e-9;
    });
    if (sameAxis && square) {
      const along = [...points, ...circles.map((circle) => circle.center)].map((p) => vec.dot(vec.sub(p, anchor), axis));
      const low = Math.min(...along);
      const high = Math.max(...along);
      return { kind: 'cylinder', base: vec.add(anchor, vec.scale(axis, low)), axis, radius: frames[0].radius * scale, length: high - low };
    }
  }
  // Anything else: the bounds of its points, widened by the largest radius of any curve (conservative).
  const pad = Math.max(0, ...circles.map((circle) => circle.radius));
  return { kind: 'bounds', min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])) - pad), max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])) + pad) };
}

// ── occurrences ─────────────────────────────────────────────────────────────

/** Expands the definition tree into occurrences with paths and world transforms. */
function expandOccurrences(assembly, overrides = new Map()) {
  const occurrences = [];
  const walk = (definition, world, path, depth, parent) => {
    for (const usage of definition.children) {
      const name = `${path ? `${path}/` : ''}${usage.name}`;
      const local = overrides.get(name) ?? usage.transform;
      const child = assembly.definitions.get(usage.child);
      const occurrence = { path: name, name: usage.name, definition: child?.name ?? '?', description: child?.description ?? '', depth, parent, local, problem: usage.problem ?? (local ? null : 'no placement'),
        world: local && world ? mat.multiply(world, local) : null, isAssembly: Boolean(child?.children.length), solids: [] };
      occurrences.push(occurrence);
      if (child) {
        occurrence.solids = child.solids.map((shape) => (occurrence.world ? worldShape(shape, occurrence.world) : null));
        walk(child, occurrence.world, name, depth + 1, occurrence);
      }
    }
  };
  for (const root of assembly.roots) walk(root, mat.identity(), '', 1, null);
  return occurrences;
}

// ── the adapter ─────────────────────────────────────────────────────────────

export function openAssembly(buffer, { path: filePath, revision, hash = revision }) {
  const started = performance.now();
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const assembly = readAssembly(text);
  const base = { name: revision, occurrences: expandOccurrences(assembly), overrides: new Map(), clashes: null };
  const indexMs = performance.now() - started;

  const solidsOf = (state) => state.occurrences.filter((occurrence) => !occurrence.isAssembly && occurrence.solids.length)
    .flatMap((occurrence) => occurrence.solids.map((shape, index) => ({ occurrence, shape, index, box: shape ? aabb(shape) : null })));
  const stateFor = (params, session) => {
    const name = params.rev ?? params.base ?? revision;
    if (name === revision || name === 'r1') return base;
    const derived = session.revisions.get(name);
    if (!derived) throw new OpError(`unknown revision ${name}; this file is ${revision}`);
    if (derived.file !== hash) throw new OpError(`revision ${name} was derived from an earlier version of this file, which has since changed; redo the what-if`, 'stale');
    return derived;
  };
  const resolve = (state, query, { allowMany = false } = {}) => {
    const wanted = String(query ?? '').trim().replace(/^\/+/, '');
    if (!wanted) throw new OpError('name an occurrence, as in "Motor:1" or "Roller set:1/Roller assembly:15"');
    const exact = state.occurrences.filter((occurrence) => occurrence.path === wanted);
    if (exact.length) return exact;
    const suffix = state.occurrences.filter((occurrence) => occurrence.path.endsWith(`/${wanted}`));
    if (suffix.length === 1 || (allowMany && suffix.length)) return suffix;
    if (suffix.length > 1) throw new OpError(`"${wanted}" is ambiguous: ${head(suffix.map((occurrence) => occurrence.path), 6).join(', ')}`);
    // "Drive unit" for Drive unit:1: a name without its number, when one occurrence has it.
    const bare = state.occurrences.filter((occurrence) => occurrence.path.split('/').at(-1).replace(/:\d+$/, '').toLowerCase() === wanted.toLowerCase());
    if (bare.length === 1 || (allowMany && bare.length)) return bare;
    if (bare.length > 1) throw new OpError(`"${wanted}" names ${bare.length} occurrences: ${head(bare.map((occurrence) => occurrence.path), 6).join(', ')}; name one with its number`);
    throw new OpError(`no occurrence "${wanted}"`);
  };
  const subtree = (state, occurrence) => state.occurrences.filter((item) => item === occurrence || item.path.startsWith(`${occurrence.path}/`));
  const exactShapes = (solids) => solids.every((solid) => solid.shape && solid.shape.kind !== 'bounds');

  /** Every pair of solids, broad phase by bounds (sweep along x), narrow phase by inner/outer refinement. */
  function clashes(state, only = null) {
    const solids = solidsOf(state).filter((solid) => solid.shape);
    const sorted = [...solids].sort((a, b) => a.box.min[0] - b.box.min[0]);
    const narrow = [];
    let pairs = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length && sorted[j].box.min[0] < sorted[i].box.max[0]; j += 1) {
        const a = sorted[i];
        const b = sorted[j];
        if (only && !only(a) && !only(b)) continue;
        if (boundsOverlap(a.box, b.box)) narrow.push([a, b]);
      }
    }
    const count = solids.length;
    pairs = (count * (count - 1)) / 2;
    const results = narrow.map(([a, b]) => ({ a, b, ...relate(a.shape, b.shape) }));
    return { solids: count, pairs, narrow: narrow.length, results, missing: solidsOf(state).filter((solid) => !solid.shape).length };
  }
  const clashesOf = (state) => (state.clashes ??= clashes(state));
  const pairName = (item) => `${item.a.occurrence.path} × ${item.b.occurrence.path}`;
  const interval = ([low, high]) => (high === null || high === undefined ? `≥ ${fmt(round(low))} mm` : Math.abs(high - low) < 5e-4 ? `${fmt(round(low))} mm` : `${fmt(round(low))}–${fmt(round(high))} mm`);

  function treeLines(state, rootPath = null, maxDepth = Infinity) {
    // Children grouped by definition: "Roller assembly ×20 [Roller tube ×1, Bearing ×2, Circlip ×1]".
    const describe = (parent, depth) => {
      const kids = state.occurrences.filter((occurrence) => occurrence.parent === parent);
      const groups = new Map();
      for (const kid of kids) {
        if (!groups.has(kid.definition)) groups.set(kid.definition, []);
        groups.get(kid.definition).push(kid);
      }
      return [...groups].map(([definition, members]) => {
        const inner = members[0].isAssembly && depth < maxDepth ? ` [${describe(members[0], depth + 1)}]` : '';
        const range = members.length === 1 ? members[0].name : `${members[0].name}…${members.at(-1).name.split(':').pop()}`;
        return `${definition} ×${members.length} (${range})${inner}`;
      }).join(', ');
    };
    const root = rootPath ? resolve(state, rootPath)[0] : null;
    return describe(root, 1);
  }

  function card() {
    const solids = solidsOf(base);
    const kinds = { box: 0, cylinder: 0, bounds: 0 };
    for (const solid of solids) if (solid.shape) kinds[solid.shape.kind] += 1;
    const leafCounts = new Map();
    for (const occurrence of base.occurrences) if (!occurrence.isAssembly) leafCounts.set(occurrence.definition, (leafCounts.get(occurrence.definition) ?? 0) + 1);
    const problems = base.occurrences.filter((occurrence) => occurrence.problem);
    const box = unionBounds(solids.filter((solid) => solid.box).map((solid) => solid.box));
    const depth = Math.max(...base.occurrences.map((occurrence) => occurrence.depth));
    const lines = [
      `${filePath} · rev ${revision} · STEP ${assembly.schema?.split(' ')[0] ?? ''}, unit ${assembly.unit?.name ?? 'unknown (taken as mm)'}; ${plural(base.occurrences.length, 'occurrence')} (${plural(solids.length, 'solid part')}) in ${depth} levels; ${plural(assembly.definitions.size, 'definition')}`,
      `root ${assembly.roots.map((root) => root.name).join(', ')}: ${treeLines(base)}`,
      `part counts over every level: ${[...leafCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ')}`,
      `overall bounds (${exactShapes(solids) ? 'exact' : 'conservative'}): ${showBounds(box)} → ${fmt(round(box.max[0] - box.min[0]))} × ${fmt(round(box.max[1] - box.min[1]))} × ${fmt(round(box.max[2] - box.min[2]))} mm`,
      `solids recognised: ${kinds.box} boxes and ${kinds.cylinder} cylinders exactly; ${kinds.bounds} other (bounds only)${problems.length ? `; ${plural(problems.length, 'occurrence')} without a valid placement: ${head(problems.map((item) => `${item.path} (${item.problem})`), 4).join(', ')}` : '; every placement valid and rigid'}`,
    ];
    return lines.join('\n');
  }

  const OPS_HELP = [
    'ops (batch several in one call). Occurrences are named by path or a unique tail of it: "Motor:1", "Roller assembly:15/Bearing:2".',
    ' {op:"tree", under?:"Frame:1", depth?:2} the hierarchy, children grouped by definition',
    ' {op:"find", name?:"Bolt*", def?:"Bearing", under?:"Guard:1", where?:"zmax > 900"} occurrences with world bounds (where: xmin xmax ymin ymax zmin zmax with < > and/or)',
    ' {op:"count", under?:"Frame:1"} part counts by definition, every level',
    ' {op:"bounds", of?:"Drive unit:1"} world bounds of an occurrence or of everything',
    ' {op:"clash", under?:…, with?:"Motor:1"} every pair of solids that interpenetrates; also apart pairs whose bounds overlap and anything unresolved',
    ' {op:"distance", a:"Motor:1", b:"Guard end panel:1"} smallest gap between two occurrences (interval)',
    ' {op:"clearance", move:"Roller assembly:15", from:"Cross member:4", dir:[0,0,1]} least travel along dir that clears it (interval)',
    ' {op:"pose", a:"Bolt M8:1", b:"Bolt M8:2"} b relative to a: offset in a\'s frame, rotation, distance',
    ' {op:"whatif", move:{"Roller assembly:15":{dz:10}, "Drive unit:1":{dx:-20}}, base?:"r2"} moves occurrences in world mm on a copy; re-checks clashes; new revision (pass rev to other ops)',
  ].join('\n');

  const describeOccurrence = (occurrence) => {
    const boxes = solidsOf({ occurrences: subtreeFlat(occurrence) }).filter((solid) => solid.box).map((solid) => solid.box);
    const bounds = boxes.length ? showBounds(unionBounds(boxes)) : 'no solids';
    return `${occurrence.path} [${occurrence.definition}] ${bounds}${occurrence.problem ? ` (${occurrence.problem})` : ''}`;
  };
  // An occurrence and every occurrence below it (shapes are on each occurrence already).
  const subtreeFlat = (occurrence) => {
    const out = [];
    const visit = (node) => { out.push(node); for (const kid of node.kids ?? []) visit(kid); };
    visit(occurrence);
    return out;
  };
  const linkKids = (state) => {
    for (const occurrence of state.occurrences) occurrence.kids = [];
    for (const occurrence of state.occurrences) occurrence.parent?.kids.push(occurrence);
  };
  linkKids(base);

  const whereFilter = (expression) => {
    if (!expression) return () => true;
    const clauses = String(expression).split(/\s+or\s+/i).map((disjunct) => disjunct.split(/\s+and\s+/i).map((term) => {
      const match = /^\s*(xmin|xmax|ymin|ymax|zmin|zmax)\s*(<=|>=|<|>|=)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(term);
      if (!match) throw new OpError(`cannot read where "${term}"; use e.g. "zmax > 900 and xmin < 100"`);
      const key = match[1].toLowerCase();
      const value = Number(match[3]);
      return (box) => {
        const actual = box[key.endsWith('min') ? 'min' : 'max'][{ x: 0, y: 1, z: 2 }[key[0]]];
        return { '<': actual < value, '>': actual > value, '<=': actual <= value, '>=': actual >= value, '=': Math.abs(actual - value) < 1e-6 }[match[2]];
      };
    }));
    return (box) => clauses.some((terms) => terms.every((test) => test(box)));
  };
  const glob = (pattern) => new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

  const ops = {
    tree(params, session) {
      const state = stateFor(params, session);
      return result({ provenance: 'format', revision: state.name, coverage: { universe: `${plural(state.occurrences.length, 'occurrence')}`, complete: true },
        forms: [form('full', treeLines(state, params.under ?? null, params.depth ?? Infinity))] });
    },
    find(params, session) {
      const state = stateFor(params, session);
      const scope = params.under ? subtree(state, resolve(state, params.under)[0]) : state.occurrences;
      const test = whereFilter(params.where);
      const name = params.name ? glob(params.name) : null;
      const definition = params.def ? glob(params.def) : null;
      const hits = scope.filter((occurrence) => {
        if (name && !name.test(occurrence.name) && !name.test(occurrence.path)) return false;
        if (definition && !definition.test(occurrence.definition)) return false;
        if (params.where) {
          if (occurrence.isAssembly) return false;
          const boxes = occurrence.solids.filter(Boolean).map(aabb);
          if (!boxes.length || !test(unionBounds(boxes))) return false;
        }
        return true;
      });
      const listing = hits.map(describeOccurrence);
      return result({ provenance: 'computed', revision: state.name, coverage: { universe: `${plural(scope.length, 'occurrence')}${params.under ? ` under ${params.under}` : ', every level'}`, complete: true },
        guarantee: params.where ? 'bounds are exact for recognised boxes and cylinders' : 'names and definitions as written in the file',
        forms: [form('full', `${plural(hits.length, 'occurrence')}\n${listing.join('\n')}`), ...(listing.length > 30 ? [form('head', `${plural(hits.length, 'occurrence')}; first 30:\n${listing.slice(0, 30).join('\n')}`, false)] : [])] });
    },
    count(params, session) {
      const state = stateFor(params, session);
      const scope = params.under ? subtree(state, resolve(state, params.under)[0]) : state.occurrences;
      const counts = new Map();
      for (const occurrence of scope) if (!occurrence.isAssembly) counts.set(occurrence.definition, (counts.get(occurrence.definition) ?? 0) + 1);
      const assemblies = scope.filter((occurrence) => occurrence.isAssembly).length;
      const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
      return result({ provenance: 'format', revision: state.name, coverage: { universe: `${plural(scope.length, 'occurrence')}${params.under ? ` under ${params.under}` : ''}, every level`, complete: true },
        forms: [form('full', `${plural(total, 'part')} (+${plural(assemblies, 'subassembly occurrence', 'subassembly occurrences')}): ${[...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(', ')}`)] });
    },
    bounds(params, session) {
      const state = stateFor(params, session);
      const scope = params.of ? subtree(state, resolve(state, params.of)[0]) : state.occurrences;
      const solids = solidsOf({ occurrences: scope });
      const box = unionBounds(solids.filter((solid) => solid.box).map((solid) => solid.box));
      return result({ status: exactShapes(solids) ? 'exact' : 'bounded', provenance: 'computed', revision: state.name,
        coverage: { universe: `${plural(solids.length, 'solid')}${params.of ? ` of ${params.of}` : ''}`, complete: true },
        forms: [form('full', `${params.of ?? 'everything'}: ${showBounds(box)}; size ${fmt(round(box.max[0] - box.min[0]))} × ${fmt(round(box.max[1] - box.min[1]))} × ${fmt(round(box.max[2] - box.min[2]))} mm`)] });
    },
    clash(params, session) {
      const state = stateFor(params, session);
      let report = clashesOf(state);
      let universe = `all ${report.pairs.toLocaleString('en-US')} pairs of ${plural(report.solids, 'solid')}`;
      const keep = (paths) => (item) => paths.has(item.a.occurrence) || paths.has(item.b.occurrence);
      let results = report.results;
      if (params.with) {
        const members = new Set(subtree(state, resolve(state, params.with)[0]));
        results = results.filter(keep(members));
        universe = `every pair involving ${params.with}`;
      }
      if (params.under) {
        const members = new Set(subtree(state, resolve(state, params.under)[0]));
        results = results.filter((item) => members.has(item.a.occurrence) && members.has(item.b.occurrence));
        universe = `every pair inside ${params.under}`;
      }
      const overlaps = results.filter((item) => item.status === 'overlap');
      const unresolved = results.filter((item) => item.status === 'unresolved');
      const contacts = results.filter((item) => item.status === 'contact');
      const near = results.filter((item) => item.status === 'apart');
      const lines = [`${plural(overlaps.length, 'interpenetrating pair')}${overlaps.length ? ':' : ''}`,
        ...overlaps.map((item) => `  ${pairName(item)}: depth ${interval(item.depth)}`),
        // How deep two solids overlap was read as how far to lift one clear of the other (live run, 13 November 2026).
        ...(overlaps.length ? [`  (depth is how deep a pair interpenetrates, not how far to move one clear: for that, clearance move:${JSON.stringify(overlaps[0].a.occurrence.path)} from:${JSON.stringify(overlaps[0].b.occurrence.path)} dir:[0,0,1])`] : []),
        `${plural(contacts.length, 'pair')} touching (exact)${contacts.length ? `: ${head(contacts.map(pairName), 10).join('; ')}` : ''}`,
        `${plural(unresolved.length, 'pair')} unresolved after refinement${unresolved.length ? `: ${head(unresolved.map(pairName), 10).join('; ')}` : ''}`,
        `${plural(near.length, 'pair')} whose bounding boxes overlap but solids are apart${near.length ? `: ${head(near.map((item) => `${pairName(item)} (gap ${interval(item.gap)})`), 8).join('; ')}` : ''}`,
        `every other pair is separated by its bounding boxes`];
      return result({ status: unresolved.length || report.missing ? 'bounded' : 'exact', provenance: 'computed', revision: state.name,
        coverage: { universe, complete: true },
        guarantee: 'overlap certified by inscribed shapes, separation by circumscribing ones; boxes and cylinders exact', forms: [form('full', lines.join('\n'))] });
    },
    distance(params, session) {
      const state = stateFor(params, session);
      const [a] = resolve(state, params.a);
      const [b] = resolve(state, params.b);
      const left = solidsOf({ occurrences: subtree(state, a) }).filter((solid) => solid.shape);
      const right = solidsOf({ occurrences: subtree(state, b) }).filter((solid) => solid.shape);
      let best = null;
      for (const x of left) for (const y of right) {
        const gap = gapBetween(x.shape, y.shape);
        if (!best || gap[0] < best.gap[0]) best = { gap, x, y };
      }
      if (!best) throw new OpError('no solids to measure');
      const overlapping = best.gap[0] === 0 ? ` (they meet or overlap; see clash)` : '';
      return result({ status: best.gap[1] === null ? 'bounded' : Math.abs(best.gap[1] - best.gap[0]) < 5e-4 ? 'exact' : 'bounded', provenance: 'computed', revision: state.name,
        coverage: { universe: `${left.length} × ${right.length} solid pairs`, complete: true },
        forms: [form('full', `smallest gap ${params.a} ↔ ${params.b}: ${interval(best.gap)}${overlapping}, between ${best.x.occurrence.path} and ${best.y.occurrence.path}`)] });
    },
    clearance(params, session) {
      const state = stateFor(params, session);
      const [moving] = resolve(state, params.move);
      const [fixed] = resolve(state, params.from);
      const direction = vec.unit(params.dir ?? [0, 0, 1]);
      const movers = solidsOf({ occurrences: subtree(state, moving) }).filter((solid) => solid.shape);
      const blockers = solidsOf({ occurrences: subtree(state, fixed) }).filter((solid) => solid.shape);
      let low = 0;
      let high = 0;
      const limiting = [];
      for (const x of movers) for (const y of blockers) {
        if (!boundsOverlap(x.box, y.box)) continue;
        const [lower, upper] = clearanceAlong(x.shape, y.shape, direction);
        if (lower === null || upper === null) return result({ status: 'unknown', forms: [form('full', `cannot bound clearance for ${x.occurrence.path}: shape not recognised`)] });
        if (upper > 0) limiting.push(`${x.occurrence.path} ${interval([lower, upper])}`);
        low = Math.max(low, lower);
        high = Math.max(high, upper);
      }
      return result({ status: Math.abs(high - low) < 5e-4 ? 'exact' : 'bounded', provenance: 'computed', revision: state.name,
        coverage: { universe: `${movers.length} × ${blockers.length} solid pairs`, complete: true },
        forms: [form('full', `moving ${params.move} along ${showPoint(direction)}: clears ${params.from} after ${interval([low, high])}${limiting.length ? `; limiting parts: ${limiting.join('; ')}` : ' (already clear)'}`)] });
    },
    pose(params, session) {
      const state = stateFor(params, session);
      const [a] = resolve(state, params.a);
      const [b] = resolve(state, params.b);
      if (!a.world || !b.world) return result({ status: 'unknown', forms: [form('full', 'a placement is missing or invalid')] });
      const relative = mat.multiply(mat.invertRigid(a.world), b.world);
      const offset = [relative[0][3], relative[1][3], relative[2][3]];
      const trace = relative[0][0] + relative[1][1] + relative[2][2];
      const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2))) * 180 / Math.PI;
      return result({ provenance: 'computed', revision: state.name, coverage: { universe: 'two placements', complete: true },
        forms: [form('full', `${params.b} relative to ${params.a}: offset ${showPoint(offset)} mm in ${params.a}'s frame; turned ${fmt(round(angle))}°; origins ${fmt(round(vec.norm(offset)))} mm apart`)] });
    },
    whatif(params, session) {
      const parent = stateFor({ rev: params.base }, session);
      const moves = Object.entries(params.move ?? {});
      if (!moves.length) throw new OpError('whatif needs move:{"Occurrence:1":{dx,dy,dz}}');
      const overrides = new Map(parent.overrides);
      const edits = [];
      for (const [query, delta] of moves) {
        const [occurrence] = resolve(parent, query);
        const shift = [Number(delta.dx ?? delta.x ?? 0), Number(delta.dy ?? delta.y ?? 0), Number(delta.dz ?? delta.z ?? 0)];
        if (!shift.every(Number.isFinite)) throw new OpError(`move for ${query} needs numbers dx, dy, dz (mm)`);
        // A world-frame translation, expressed in the occurrence's parent frame.
        const parentWorld = occurrence.parent?.world ?? mat.identity();
        const newWorld = mat.multiply(mat.translation(shift), occurrence.world);
        overrides.set(occurrence.path, mat.multiply(mat.invertRigid(parentWorld), newWorld));
        edits.push(`${occurrence.path} moved ${showPoint(shift)} mm`);
      }
      const occurrences = expandOccurrences(assembly, overrides);
      const state = { name: `r${session.revisions.size + 2}`, file: hash, occurrences, overrides, clashes: null };
      linkKids(state);
      // Only pairs with a moved solid can change; every other pair's result is reused from the parent revision.
      const movedPaths = new Set();
      for (const [path] of overrides) for (const occurrence of occurrences) if (occurrence.path === path || occurrence.path.startsWith(`${path}/`)) movedPaths.add(occurrence.path);
      const previous = clashesOf(parent);
      const changed = (solid) => movedPaths.has(solid.occurrence.path);
      const fresh = clashes(state, changed);
      const kept = previous.results.filter((item) => !changed(item.a) && !changed(item.b))
        .map((item) => ({ ...item, a: rebind(state, item.a), b: rebind(state, item.b) }));
      state.clashes = { ...fresh, results: [...kept, ...fresh.results.filter((item) => changed(item.a) || changed(item.b))] };
      session.revisions.set(state.name, state);
      const key = (item) => [item.a.occurrence.path, item.b.occurrence.path].sort().join(' × ');
      const before = new Set(previous.results.filter((item) => item.status === 'overlap').map(key));
      const after = state.clashes.results.filter((item) => item.status === 'overlap');
      const afterKeys = new Set(after.map(key));
      const box = unionBounds(solidsOf(state).filter((solid) => solid.box).map((solid) => solid.box));
      const lines = [`revision ${state.name} = ${parent.name} with ${edits.join('; ')}`,
        `interpenetrating pairs now (${after.length}): ${after.map((item) => `${key(item)} depth ${interval(item.depth)}`).join('; ') || 'none'}`,
        `new: ${after.filter((item) => !before.has(key(item))).map(key).join('; ') || 'none'}; resolved: ${[...before].filter((name) => !afterKeys.has(name)).join('; ') || 'none'}`,
        `overall bounds: ${showBounds(box)} (${fmt(round(box.max[0] - box.min[0]))} × ${fmt(round(box.max[1] - box.min[1]))} × ${fmt(round(box.max[2] - box.min[2]))} mm)`,
        `rechecked ${plural(fresh.narrow, 'candidate pair')} with a moved solid; reused ${plural(kept.length, 'pair result')}`];
      return result({ provenance: 'computed', revision: state.name, coverage: { universe: `all pairs of ${plural(fresh.solids, 'solid')}`, complete: true },
        guarantee: 'moved solids rechecked against every other solid; other pairs unchanged by a rigid move', forms: [form('full', lines.join('\n'))] });
    },
  };

  const fullText = () => {
    const lines = [`STEP assembly ${filePath}, unit ${assembly.unit?.name ?? 'unknown'}. Part definitions (geometry in each part's own frame):`];
    for (const definition of assembly.definitions.values()) {
      if (definition.children.length || !definition.solids.length) continue;
      for (const shape of definition.solids) {
        if (shape.kind === 'box') lines.push(`- ${definition.name}: box ${shape.size.map((value) => fmt(round(value))).join(' × ')} mm, corner at ${showPoint(vec.sub(shape.center, shape.axes.reduce((sum, axis, index) => vec.add(sum, vec.scale(axis, shape.half[index])), [0, 0, 0])))}, edges along ${shape.axes.map(showPoint).join(', ')}`);
        else if (shape.kind === 'cylinder') lines.push(`- ${definition.name}: cylinder radius ${fmt(round(shape.radius))} mm, length ${fmt(round(shape.length))} mm, axis ${showPoint(shape.axis)} from base centre ${showPoint(shape.base)}`);
        else lines.push(`- ${definition.name}: solid within ${showBounds(shape)}`);
      }
    }
    lines.push('', 'Occurrences (path [definition]: placement in the parent\'s frame as origin, z axis, x axis; a child\'s placement composes with its parent\'s):');
    for (const occurrence of base.occurrences) {
      const local = occurrence.local;
      lines.push(local ? `${occurrence.path} [${occurrence.definition}]: origin ${showPoint([local[0][3], local[1][3], local[2][3]])}, z ${showPoint([local[0][2], local[1][2], local[2][2]])}, x ${showPoint([local[0][0], local[1][0], local[2][0]])}`
        : `${occurrence.path} [${occurrence.definition}]: no valid placement`);
    }
    return lines.join('\n');
  };

  return { kind: 'assembly', revision, indexMs, opsHelp: OPS_HELP, card, fullText, ops, base, assembly };
}

/** The same solid in another revision's occurrence list (by path and index). */
function rebind(state, solid) {
  const occurrence = state.occurrences.find((item) => item.path === solid.occurrence.path);
  return { ...solid, occurrence };
}
