// Writes small but structurally complete STEP AP214 B-rep exchange files.
// Expected test values come from these authored coordinates, never from the
// reader under test. Each model mirrors what CAD exporters emit: complex unit
// and context instances, shared vertices, seam edges and assembly placements.

const real = (value) => {
  const text = String(Number(value.toPrecision(15)));
  return /[.eE]/.test(text) ? text : `${text}.`;
};

class StepWriter {
  constructor() { this.lines = []; this.next = 1; this.vertices = new Map(); }
  add(text) { const id = `#${this.next++}`; this.lines.push(`${id}=${text};`); return id; }
  point(p) { return this.add(`CARTESIAN_POINT('',(${p.map(real).join(',')}))`); }
  direction(d) { return this.add(`DIRECTION('',(${d.map(real).join(',')}))`); }
  placement(origin, z = [0, 0, 1], x = [1, 0, 0]) {
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.direction(z)},${this.direction(x)})`);
  }
  vertex(p) {
    // sin(2π) is not exactly zero; arcs ending at 360° share the 0° vertex.
    const key = p.map((value) => (Math.abs(value) < 5e-10 ? 0 : value).toFixed(9)).join(',');
    if (!this.vertices.has(key)) this.vertices.set(key, this.add(`VERTEX_POINT('',${this.point(p)})`));
    return this.vertices.get(key);
  }
  line(p0, p1) {
    const d = p1.map((value, index) => value - p0[index]);
    const size = Math.hypot(...d);
    const line = this.add(`LINE('',${this.point(p0)},${this.add(`VECTOR('',${this.direction(d.map((value) => value / size))},${real(size)})`)})`);
    return this.add(`EDGE_CURVE('',${this.vertex(p0)},${this.vertex(p1)},${line},.T.)`);
  }
  // Counter-clockwise arc about +Z from angle a to b (degrees) at height z.
  arc(center, radius, a, b, z) {
    const at = (angle) => [center[0] + radius * Math.cos(angle * Math.PI / 180), center[1] + radius * Math.sin(angle * Math.PI / 180), z];
    const circle = this.add(`CIRCLE('',${this.placement([center[0], center[1], z])},${real(radius)})`);
    const full = Math.abs(b - a) >= 360;
    return this.add(`EDGE_CURVE('',${this.vertex(at(a))},${this.vertex(full ? at(a) : at(b))},${circle},.T.)`);
  }
  orient(edge, forward = true) { return this.add(`ORIENTED_EDGE('',*,*,${edge},${forward ? '.T.' : '.F.'})`); }
  loop(edges, outer = true, sense = true) {
    const loop = this.add(`EDGE_LOOP('',(${edges.join(',')}))`);
    return this.add(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${loop},${sense ? '.T.' : '.F.'})`);
  }
  face(bounds, surface, sameSense = true) {
    return this.add(`ADVANCED_FACE('',(${bounds.join(',')}),${surface},${sameSense ? '.T.' : '.F.'})`);
  }
  // Counter-clockwise rectangle in the plane z, from corner (x0, y0) to (x1, y1).
  rectangle([x0, y0], [x1, y1], z) {
    const corners = [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];
    const loop = this.loop(corners.map((corner, index) => this.orient(this.line(corner, corners[(index + 1) % 4]))));
    return this.face([loop], this.add(`PLANE('',${this.placement([x0, y0, z])})`));
  }
  surfaceModel(name, faces) {
    return this.add(`SHELL_BASED_SURFACE_MODEL('${name}',(${this.add(`OPEN_SHELL('',(${faces.join(',')}))`)}))`);
  }
}

function units(writer, unit) {
  const millimetre = writer.add('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
  let length = millimetre;
  if (unit === 'in') {
    const conversion = writer.add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),${millimetre})`);
    const dimensions = writer.add('DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.)');
    length = writer.add(`( CONVERSION_BASED_UNIT('INCH',${conversion}) LENGTH_UNIT() NAMED_UNIT(${dimensions}) )`);
  }
  const radian = writer.add('( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )');
  const steradian = writer.add('( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )');
  const uncertainty = writer.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${length},'distance_accuracy_value','confusion accuracy')`);
  return writer.add(`( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${radian},${steradian})) REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY') )`);
}

/** Extruded plate: outline segments are {line:[p0,p1]} or {arc:{center,radius,from,to}}
 * in counter-clockwise order; holes are {center, radius, split}. */
function plate(writer, { outline, holes, thickness }) {
  const faces = [];
  const bottom = [], top = [];
  const vertical = new Map();
  const verticalEdge = (p) => {
    const key = p.join(',');
    if (!vertical.has(key)) vertical.set(key, writer.line([p[0], p[1], 0], [p[0], p[1], thickness]));
    return vertical.get(key);
  };
  for (const segment of outline) {
    const [start, end] = segment.line ?? [segment.arc, segment.arc].map((arc, index) => {
      const angle = (index ? arc.to : arc.from) * Math.PI / 180;
      return [arc.center[0] + arc.radius * Math.cos(angle), arc.center[1] + arc.radius * Math.sin(angle)];
    });
    const edgeAt = (z) => segment.line ? writer.line([...start, z], [...end, z])
      : writer.arc(segment.arc.center, segment.arc.radius, segment.arc.from, segment.arc.to, z);
    const lower = edgeAt(0), upper = edgeAt(thickness);
    bottom.push(lower); top.push(upper);
    const sideLoop = writer.loop([writer.orient(lower), writer.orient(verticalEdge(end)), writer.orient(upper, false), writer.orient(verticalEdge(start), false)]);
    if (segment.line) {
      const along = [end[0] - start[0], end[1] - start[1]];
      const size = Math.hypot(...along);
      const plane = writer.add(`PLANE('',${writer.placement([...start, 0], [along[1] / size, -along[0] / size, 0], [along[0] / size, along[1] / size, 0])})`);
      faces.push(writer.face([sideLoop], plane));
    } else {
      // Outer rounded corners are convex: the face normal points away from the axis.
      const cylinder = writer.add(`CYLINDRICAL_SURFACE('',${writer.placement([...segment.arc.center, 0])},${real(segment.arc.radius)})`);
      faces.push(writer.face([sideLoop], cylinder, true));
    }
  }
  const bottomHoles = [], topHoles = [];
  for (const hole of holes) {
    const [cx, cy] = hole.center, r = hole.radius;
    const surface = writer.add(`CYLINDRICAL_SURFACE('',${writer.placement([cx, cy, 0])},${real(r)})`);
    if (hole.split) {
      const halves = [[0, 180], [180, 360]].map(([from, to]) => ({ lower: writer.arc([cx, cy], r, from, to, 0), upper: writer.arc([cx, cy], r, from, to, thickness), from, to }));
      const seams = [0, 180].map((angle) => writer.line([cx + r * Math.cos(angle * Math.PI / 180), cy + r * Math.sin(angle * Math.PI / 180), 0], [cx + r * Math.cos(angle * Math.PI / 180), cy + r * Math.sin(angle * Math.PI / 180), thickness]));
      halves.forEach((half, index) => {
        const loop = writer.loop([writer.orient(half.lower), writer.orient(seams[(index + 1) % 2]), writer.orient(half.upper, false), writer.orient(seams[index], false)]);
        faces.push(writer.face([loop], surface, false));
      });
      bottomHoles.push(writer.loop(halves.map((half) => writer.orient(half.lower, false)), false));
      topHoles.push(writer.loop(halves.map((half) => writer.orient(half.upper)), false));
    } else {
      const lower = writer.arc([cx, cy], r, 0, 360, 0), upper = writer.arc([cx, cy], r, 0, 360, thickness);
      const seam = writer.line([cx + r, cy, 0], [cx + r, cy, thickness]);
      const loop = writer.loop([writer.orient(lower), writer.orient(seam), writer.orient(upper, false), writer.orient(seam, false)]);
      // A hole's face normal points toward its axis, out of the material.
      faces.push(writer.face([loop], surface, false));
      bottomHoles.push(writer.loop([writer.orient(lower, false)], false));
      topHoles.push(writer.loop([writer.orient(upper)], false));
    }
  }
  const bottomPlane = writer.add(`PLANE('',${writer.placement([0, 0, 0])})`);
  const topPlane = writer.add(`PLANE('',${writer.placement([0, 0, thickness])})`);
  faces.push(writer.face([writer.loop([...bottom].reverse().map((edge) => writer.orient(edge, false))), ...bottomHoles], bottomPlane, false));
  faces.push(writer.face([writer.loop(top.map((edge) => writer.orient(edge))), ...topHoles], topPlane, true));
  return writer.add(`MANIFOLD_SOLID_BREP('Plate body',${writer.add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
}

/** Cylindrical pin along +Z with a flat, domed, chamfered or pointed tip.
 * A dome or point reaches beyond every boundary edge; a 45° chamfer is a cone
 * frustum whose apex lies beyond the part but outside the face. A split
 * chamfer is two half frustums whose bounds are written reversed (.F.), the
 * way some exporters emit them. */
function pin(writer, { radius, length, tip = 'flat' }) {
  const halves = tip === 'split-chamfer' ? [[0, 180], [180, 360]] : [[0, 360]];
  const bottomCircle = writer.arc([0, 0], radius, 0, 360, 0);
  const topArcs = halves.map(([from, to]) => writer.arc([0, 0], radius, from, to, length));
  const topCircle = topArcs[0];
  const seam = writer.line([radius, 0, 0], [radius, 0, length]);
  const cylinder = writer.add(`CYLINDRICAL_SURFACE('',${writer.placement([0, 0, 0])},${real(radius)})`);
  const faces = [
    writer.face([writer.loop([writer.orient(bottomCircle), writer.orient(seam), ...[...topArcs].reverse().map((arc) => writer.orient(arc, false)), writer.orient(seam, false)])], cylinder, true),
    writer.face([writer.loop([writer.orient(bottomCircle, false)])], writer.add(`PLANE('',${writer.placement([0, 0, 0])})`), false),
  ];
  // The cone narrows by 1 per unit of height toward +Z: semi-angle π/4 about -Z.
  const cone = () => writer.add(`CONICAL_SURFACE('',${writer.placement([0, 0, length], [0, 0, -1])},${real(radius)},${real(Math.PI / 4)})`);
  if (tip === 'split-chamfer') {
    const rimArcs = halves.map(([from, to]) => writer.arc([0, 0], radius - 1, from, to, length + 1));
    const at = (r, angle, z) => [r * Math.cos(angle * Math.PI / 180), r * Math.sin(angle * Math.PI / 180), z];
    const seams = [0, 180].map((angle) => writer.line(at(radius, angle, length), at(radius - 1, angle, length + 1)));
    const surface = cone();
    // Each half's forward loop is top arc, far seam up, rim arc back, near
    // seam down; it is written in reverse order with every edge flipped.
    halves.forEach((_, index) => faces.push(writer.face([writer.loop([writer.orient(seams[index]), writer.orient(rimArcs[index]),
      writer.orient(seams[(index + 1) % 2], false), writer.orient(topArcs[index], false)], true, false)], surface, true)));
    faces.push(writer.face([writer.loop(rimArcs.map((arc) => writer.orient(arc)))], writer.add(`PLANE('',${writer.placement([0, 0, length + 1])})`), true));
  } else if (tip === 'chamfer') {
    const rimCircle = writer.arc([0, 0], radius - 1, 0, 360, length + 1);
    const chamferSeam = writer.line([radius, 0, length], [radius - 1, 0, length + 1]);
    faces.push(writer.face([writer.loop([writer.orient(topCircle), writer.orient(chamferSeam), writer.orient(rimCircle, false), writer.orient(chamferSeam, false)])], cone(), true));
    faces.push(writer.face([writer.loop([writer.orient(rimCircle)])], writer.add(`PLANE('',${writer.placement([0, 0, length + 1])})`), true));
  } else {
    const cap = tip === 'dome' ? writer.add(`SPHERICAL_SURFACE('',${writer.placement([0, 0, length])},${real(radius)})`)
      : tip === 'point' ? cone() : writer.add(`PLANE('',${writer.placement([0, 0, length])})`);
    faces.push(writer.face([writer.loop([writer.orient(topCircle)])], cap, true));
  }
  return writer.add(`MANIFOLD_SOLID_BREP('Pin body',${writer.add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
}

const header = (schema) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Lasso STEP regression model'),'2;1');
FILE_NAME('fixture.step','2026-10-19T00:00:00',('Lasso test'),('Lasso test'),'Lasso STEP fixture writer','Lasso test CAD','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
`;

export const BRACKET = {
  // 100 × 60 × 10 plate whose two right-hand corners are R5 rounds.
  outline: [
    { line: [[0, 0], [95, 0]] },
    { arc: { center: [95, 5], radius: 5, from: -90, to: 0 } },
    { line: [[100, 5], [100, 55]] },
    { arc: { center: [95, 55], radius: 5, from: 0, to: 90 } },
    { line: [[95, 60], [0, 60]] },
    { line: [[0, 60], [0, 0]] },
  ],
  holes: [
    { center: [20, 15], radius: 4 }, { center: [20, 45], radius: 4 },
    { center: [70, 15], radius: 4 }, { center: [70, 45], radius: 4 },
    { center: [45, 30], radius: 6, split: true },
  ],
  thickness: 10,
};

function product(writer, context, name, items) {
  const productContext = writer.add(`PRODUCT_CONTEXT('',${writer.add("APPLICATION_CONTEXT('automotive_design')")},'mechanical')`);
  const productRecord = writer.add(`PRODUCT('${name}','${name}','',(${productContext}))`);
  const formation = writer.add(`PRODUCT_DEFINITION_FORMATION('','',${productRecord})`);
  const definitionContext = writer.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${writer.add("APPLICATION_CONTEXT('automotive_design')")},'design')`);
  const definition = writer.add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const origin = writer.placement([0, 0, 0]);
  const shape = writer.add(`SHAPE_REPRESENTATION('${name}',(${origin}),${context})`);
  writer.add(`SHAPE_DEFINITION_REPRESENTATION(${writer.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`)},${shape})`);
  if (items.length) {
    const brep = writer.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[...items, writer.placement([0, 0, 0])].join(',')}),${context})`);
    writer.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${shape},${brep})`);
  }
  return { definition, shape, origin };
}

function place(writer, parent, child, name, origin, z = [0, 0, 1], x = [1, 0, 0]) {
  const usage = writer.add(`NEXT_ASSEMBLY_USAGE_OCCURRENCE('${name}','${name}','',${parent.definition},${child.definition},$)`);
  const target = writer.placement(origin, z, x);
  const transform = writer.add(`ITEM_DEFINED_TRANSFORMATION('','',${child.origin},${target})`);
  const relation = writer.add(`( REPRESENTATION_RELATIONSHIP('','',${child.shape},${parent.shape}) REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(${transform}) SHAPE_REPRESENTATION_RELATIONSHIP() )`);
  writer.add(`CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(${relation},${writer.add(`PRODUCT_DEFINITION_SHAPE('','',${usage})`)})`);
}

/** PMI datum-target areas, as NIST's CATIA exports write them: surface models
 * in a representation related to the part's shape. One is a 90° patch on the
 * Ø8 hole at (20, 15) between z = 2 and 8; the other a 10 × 10 area 5 mm
 * above the top face, outside the solid. */
function datumTargets(writer, context, shape) {
  const lower = writer.arc([20, 15], 4, 0, 90, 2), upper = writer.arc([20, 15], 4, 0, 90, 8);
  const sides = [0, 90].map((angle) => {
    const [x, y] = [20 + 4 * Math.cos(angle * Math.PI / 180), 15 + 4 * Math.sin(angle * Math.PI / 180)];
    return writer.line([x, y, 2], [x, y, 8]);
  });
  const bore = writer.add(`CYLINDRICAL_SURFACE('',${writer.placement([20, 15, 0])},4.)`);
  const patch = writer.face([writer.loop([writer.orient(lower), writer.orient(sides[1]), writer.orient(upper, false), writer.orient(sides[0], false)])], bore);
  const area = writer.rectangle([40, 5], [50, 15], BRACKET.thickness + 5);
  const targets = writer.add(`MANIFOLD_SURFACE_SHAPE_REPRESENTATION('',(${writer.surfaceModel('Fill.1', [patch])},${writer.surfaceModel('Fill.2', [area])}),${context})`);
  writer.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',${targets},${shape})`);
}

/** Supplemental construction geometry: a 200 × 200 plane through the plate. */
function construction(writer, context, shape) {
  const plane = writer.rectangle([-50, -70], [150, 130], 5);
  const geometry = writer.add(`CONSTRUCTIVE_GEOMETRY_REPRESENTATION('supplemental geometry',(${writer.surfaceModel('NONE', [plane])}),${context})`);
  writer.add(`CONSTRUCTIVE_GEOMETRY_REPRESENTATION_RELATIONSHIP('supplemental geometry','',${shape},${geometry})`);
}

/** One plate part. Options scale its geometry or replace its holes so tests
 * can author revisions with known values, or add non-material geometry. */
export function bracketPart({ unit = 'mm', holes = BRACKET.holes, schema = 'AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }', targets = false, supplemental = false } = {}) {
  const writer = new StepWriter();
  const context = units(writer, unit);
  const { shape } = product(writer, context, 'Bracket', [plate(writer, { ...BRACKET, holes })]);
  if (targets) datumTargets(writer, context, shape);
  if (supplemental) construction(writer, context, shape);
  return `${header(schema)}${writer.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** A single pin part; see pin() for the tip shapes. */
export function pinPart({ tip = 'flat' } = {}) {
  const writer = new StepWriter();
  const context = units(writer, 'mm');
  product(writer, context, 'Pin', [pin(writer, { radius: 3, length: 24, tip })]);
  return `${header('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }')}${writer.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** Fixture assembly: the bracket plus two domed pins standing on its top face;
 * the second pin is rotated a quarter turn about Z. */
export function fixtureAssembly({ schema = 'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }' } = {}) {
  const writer = new StepWriter();
  const context = units(writer, 'mm');
  const root = product(writer, context, 'Fixture', []);
  const bracket = product(writer, context, 'Bracket', [plate(writer, BRACKET)]);
  const pinPart = product(writer, context, 'Pin', [pin(writer, { radius: 3, length: 24, tip: 'dome' })]);
  place(writer, root, bracket, 'Bracket:1', [0, 0, 0]);
  place(writer, root, pinPart, 'Pin:1', [20, 15, 10]);
  place(writer, root, pinPart, 'Pin:2', [70, 45, 10], [0, 0, 1], [0, 1, 0]);
  return `${header(schema)}${writer.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}
