import test from 'node:test';
import assert from 'node:assert/strict';
import { extractStepDocument } from '../src/dependencies/step-extraction.js';
import { parseStepRecord, readStepModel } from '../src/dependencies/step-model.js';
import { extractDesignDocument, drawingDescriptors } from '../src/dependencies/drawing-objects.js';
import { detectFileType } from '../src/history/file-types.js';
import { BRACKET, bracketPart, fixtureAssembly, pinPart } from './fixtures/step-models.js';

const facts = text => extractStepDocument(Buffer.from(text)).pages[0].annotations;
const byLabel = (annotations, label) => annotations.find(annotation => annotation.label === label);

test('STEP records parse simple, complex, typed, string and enumeration values', () => {
  assert.deepEqual(parseStepRecord("CIRCLE('it''s; fine',#12,4.E+00)"), { type: 'CIRCLE', args: ["it's; fine", { ref: 12 }, 4] });
  const unit = parseStepRecord('( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )');
  assert.equal(unit.type, null);
  assert.deepEqual([...unit.parts.keys()], ['LENGTH_UNIT', 'NAMED_UNIT', 'SI_UNIT']);
  assert.deepEqual(unit.parts.get('SI_UNIT'), ['MILLI', 'METRE']);
  assert.deepEqual(parseStepRecord("MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#3)").args[0], { type: 'LENGTH_MEASURE', args: [25.4] });
  assert.equal(parseStepRecord("PRODUCT('\\X2\\00D8\\X0\\8 bolt','',$,(#1))").args[0], 'Ø8 bolt');
  assert.throws(() => parseStepRecord("LINE('',#1,#2"), /Invalid STEP|Unterminated/);
});

test('a single STEP part indexes exact extents, merged holes, arcs and straight edges in millimetres', () => {
  const result = extractStepDocument(Buffer.from(bracketPart()));
  assert.equal(result.status, 'ready', result.warnings.join('; '));
  assert.equal(result.format, 'STEP');
  assert.equal(result.protocol, 'AP214');
  assert.equal(result.units, 'mm');
  const annotations = result.pages[0].annotations;
  assert.equal(result.pages[0].title, 'Bracket');
  for (const [axis, value] of [['X', 100], ['Y', 60], ['Z', BRACKET.thickness]]) {
    const extent = byLabel(annotations, `Bracket overall ${axis} extent`);
    assert.equal(extent.value, `${value} mm`);
    assert.equal(extent.numericValue, value);
    assert.equal(extent.kind, 'length');
    assert.equal(extent.measurementBasis, 'geometry');
    assert.equal(extent.elementId, 'Bracket');
    assert.equal(extent.featureId, `extent:${axis}`);
  }
  const small = byLabel(annotations, 'Bracket Ø8 hole diameter');
  assert.equal(small.value, '8 mm');
  assert.equal(small.count, 4, 'four authored Ø8 holes form one feature group');
  assert.equal(small.kind, 'diameter');
  assert.match(small.rawText, /CYLINDRICAL_SURFACE\('',#\d+,4\.\)/, 'evidence cites the source surface record');
  assert.equal(byLabel(annotations, 'Bracket Ø8 hole depth').value, '10 mm');
  const split = byLabel(annotations, 'Bracket Ø12 hole diameter');
  assert.equal(split.count, 1, 'a hole written as two half-cylinder faces is still one hole');
  assert.ok(!annotations.some(annotation => /R6\b/.test(annotation.label)), 'semicircle rim edges of a complete hole are not arcs');
  const radius = byLabel(annotations, 'Bracket R5 90° arc radius');
  assert.equal(radius.value, '5 mm');
  assert.equal(radius.count, 4, 'two rounded corners, each with a top and bottom arc');
  assert.equal(radius.kind, 'radius');
  const arcLength = byLabel(annotations, 'Bracket R5 90° arc length');
  assert.equal(arcLength.numericValue, Number((5 * Math.PI / 2).toPrecision(10)));
  assert.equal(arcLength.kind, 'arc_length');
  const edges = annotations.filter(annotation => annotation.kind === 'edge_length').map(annotation => [annotation.numericValue, annotation.count]);
  assert.deepEqual(edges, [[95, 4], [60, 2], [50, 2], [10, 6]], 'seam lines are representation artifacts, not model edges');
  assert.ok(annotations.every(annotation => annotation.units === 'mm' && annotation.confidence === 1));
  assert.equal(new Set(annotations.map(annotation => annotation.id)).size, annotations.length);
});

test('conversion-based inch units are reported in the declared unit with the exact factor', () => {
  const model = readStepModel(Buffer.from(bracketPart({ unit: 'in' })));
  assert.equal(model.unit.label, 'in');
  assert.equal(model.unit.mm, 25.4);
  const annotations = facts(bracketPart({ unit: 'in' }));
  assert.equal(byLabel(annotations, 'Bracket overall X extent').value, '100 in');
  assert.equal(byLabel(annotations, 'Bracket Ø8 hole diameter').units, 'in');
});

test('assemblies place components, keep part identities and omit extents that curved faces could exceed', () => {
  const result = extractStepDocument(Buffer.from(fixtureAssembly()));
  assert.equal(result.protocol, 'AP242');
  assert.equal(result.partCount, 2);
  assert.equal(result.instanceCount, 3);
  assert.equal(result.status, 'partial');
  const annotations = result.pages[0].annotations;
  assert.equal(byLabel(annotations, 'Fixture assembly overall X extent').value, '100 mm');
  assert.equal(byLabel(annotations, 'Fixture assembly overall Y extent').value, '60 mm');
  assert.ok(!byLabel(annotations, 'Fixture assembly overall Z extent'), 'the domed pins make the assembly height uncertain');
  assert.ok(!byLabel(annotations, 'Pin overall Z extent'), 'a hemisphere apex lies beyond every boundary edge');
  assert.equal(byLabel(annotations, 'Pin overall X extent').value, '6 mm');
  assert.ok(result.warnings.some(warning => /Pin Z extent was not indexed: sphere face/.test(warning)));
  const shank = byLabel(annotations, 'Pin Ø6 cylinder diameter');
  assert.equal(shank.instances, 2, 'the pin part is placed twice');
  assert.equal(byLabel(annotations, 'Pin Ø6 cylinder length').value, '24 mm');
  const model = readStepModel(Buffer.from(fixtureAssembly()));
  const pins = model.occurrences.filter(occurrence => model.parts[occurrence.part].name === 'Pin');
  assert.deepEqual(pins.map(pin => pin.matrix.t), [[20, 15, 10], [70, 45, 10]]);
  assert.deepEqual(pins[1].matrix.r.map(value => Math.round(value)), [0, -1, 0, 1, 0, 0, 0, 0, 1], 'quarter-turn placement maps part X to assembly Y');
});

test('a cone limits an extent only when the face actually reaches its apex', () => {
  const z = tip => byLabel(facts(pinPart({ tip })), 'Pin overall Z extent');
  assert.equal(z('flat').value, '24 mm');
  // A 45° chamfer's apex lies 2 mm beyond the tip, outside the frustum face.
  assert.equal(z('chamfer').value, '25 mm');
  assert.equal(z('point'), undefined, 'a pointed tip extends past its only rim edge');
  assert.equal(z('dome'), undefined);
  assert.equal(byLabel(facts(pinPart({ tip: 'chamfer' })), 'Pin overall X extent').value, '6 mm');
  // NIST CTC-05 and FTC-09 write half frustums with reversed (.F.) bounds.
  assert.equal(z('split-chamfer').value, '25 mm', 'a reversed bound is traversed in reverse edge order');
});

test('surface models attached to a solid part are drawn but not measured', () => {
  const result = extractStepDocument(Buffer.from(bracketPart({ targets: true })));
  assert.equal(result.status, 'ready', result.warnings.join('; '));
  const annotations = result.pages[0].annotations;
  // A datum-target area 5 mm above the plate must not stretch its height.
  assert.equal(byLabel(annotations, 'Bracket overall Z extent').value, '10 mm');
  assert.equal(byLabel(annotations, 'Bracket overall X extent').value, '100 mm');
  assert.match(byLabel(annotations, 'Bracket overall Z extent').rawText, /MANIFOLD_SOLID_BREP\('Plate body'/, 'extents cite the solid, not a surface patch');
  assert.equal(byLabel(annotations, 'Bracket Ø8 hole diameter').count, 4, 'a patch on a bore leaves the hole a hole');
  assert.ok(!annotations.some(annotation => /\bR4\b/.test(annotation.label)), 'patch rims are not arcs of the part');
  const edges = annotations.filter(annotation => annotation.kind === 'edge_length').map(annotation => [annotation.numericValue, annotation.count]);
  assert.deepEqual(edges, [[95, 4], [60, 2], [50, 2], [10, 6]]);
  const [part] = readStepModel(Buffer.from(bracketPart({ targets: true }))).parts;
  assert.deepEqual(part.bodies.map(body => [body.type, body.reference]),
    [['SHELL_BASED_SURFACE_MODEL', true], ['SHELL_BASED_SURFACE_MODEL', true], ['MANIFOLD_SOLID_BREP', false]]);
});

test('supplemental construction geometry is not reported as a part', () => {
  const result = extractStepDocument(Buffer.from(bracketPart({ supplemental: true })));
  assert.equal(result.status, 'ready', result.warnings.join('; '));
  assert.equal(result.partCount, 1);
  assert.equal(result.instanceCount, 1);
  assert.deepEqual(result.pages[0].annotations.map(annotation => annotation.label), facts(bracketPart()).map(annotation => annotation.label));
});

test('STEP files join the design index with export guidance for native CAD formats', () => {
  assert.equal(detectFileType('Parts/bracket.STEP'), 'drawing');
  assert.equal(detectFileType('Parts/bracket.stp'), 'drawing');
  assert.equal(detectFileType('Parts/bracket.sldprt'), 'drawing');
  const native = extractDesignDocument({ path: 'Parts/bracket.sldprt' }, Buffer.from('binary'));
  assert.equal(native.status, 'unsupported');
  assert.match(native.warnings[0], /STEP AP242 or AP214/);
  const file = { path: 'Parts/fixture.step', projectFileId: 'file-1', contentHash: 'hash-1' };
  const { drawing, descriptors } = drawingDescriptors(file, Buffer.from(fixtureAssembly()));
  assert.equal(drawing.isDrawing, true);
  const container = descriptors.find(descriptor => descriptor.type === 'DRAWING');
  assert.equal(container.label, 'Fixture');
  assert.equal(container.anchor.kind, 'cad-model');
  assert.equal(container.metadata.format, 'STEP');
  const hole = descriptors.find(descriptor => descriptor.label === 'Bracket Ø8 hole diameter');
  assert.equal(hole.type, 'DRAWING_ANNOTATION');
  assert.equal(hole.anchor.kind, 'cad-property');
  assert.equal(hole.anchor.elementId, 'Bracket');
  assert.equal(hole.anchor.featureId, 'hole:8:10');
  assert.match(hole.metadata.description, /hole bore drilled diameter/);
});

test('feature keys survive re-export and a resized hole becomes a different feature', () => {
  const ids = text => new Map(facts(text).map(annotation => [annotation.label, annotation.id]));
  const original = ids(bracketPart());
  const reexported = ids(bracketPart().replace(/^#(\d+)=/gm, (_, id) => `#${Number(id) + 1000}=`).replace(/#(\d+)(?=[,)\s])/g, (_, id) => `#${Number(id) + 1000}`));
  assert.deepEqual([...reexported], [...original], 'renumbered STEP instances keep every indexed identity');
  const resized = ids(bracketPart({ holes: BRACKET.holes.map(hole => hole.split ? hole : { ...hole, radius: 5 }) }));
  assert.equal(resized.get('Bracket overall X extent'), original.get('Bracket overall X extent'));
  assert.ok(!resized.has('Bracket Ø8 hole diameter'));
  assert.ok(resized.has('Bracket Ø10 hole diameter'));
});

test('malformed, non-CAD and unsupported STEP input is reported without measurements', () => {
  const cases = [
    ['', /empty/],
    ['not a step file', /ISO-10303-21/],
    [bracketPart().replace(/END-ISO-10303-21;\n$/, ''), /Truncated|closing/],
    [bracketPart().replace("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'))", "FILE_SCHEMA(('IFC4'))"), /IFC schema/],
    ["ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n", /No supported B-rep/],
    [bracketPart().replace(/#(\d+)=CARTESIAN_POINT/, '#1=CARTESIAN_POINT'), /Duplicate STEP instance/],
  ];
  for (const [text, message] of cases) {
    const result = extractStepDocument(Buffer.from(text));
    assert.notEqual(result.status, 'ready');
    assert.equal(result.pages.length, 0);
    assert.match(result.warnings.join(' '), message);
  }
  const unitless = extractStepDocument(Buffer.from(bracketPart().replace(/GLOBAL_UNIT_ASSIGNED_CONTEXT\(\([^)]*\)\)/, 'GLOBAL_UNIT_ASSIGNED_CONTEXT(())')));
  assert.equal(unitless.status, 'partial');
  assert.deepEqual(unitless.pages[0].annotations, [], 'geometry without a declared unit is not measured');
  assert.match(unitless.warnings.join(' '), /no supported length unit/);
});
