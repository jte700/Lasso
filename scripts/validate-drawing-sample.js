import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createApplication } from '../src/server.js';
import { buildStepView } from '../src/dependencies/step-geometry.js';

// Run against the checked-in, unmodified downloads. No network, real project,
// or user database is used. --pdf additionally exercises local PDF tooling.
// STEP samples are checked against values established without Lasso's reader.
const fixtures = fileURLToPath(new URL('../test/fixtures/drawings/', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'sources.json'), 'utf8'));
const includePdf = process.argv.includes('--pdf');
const selected = manifest.fixtures.filter((entry) => includePdf || entry.format !== 'PDF');
const actor = { id: 'human:drawing-validation', displayName: 'Drawing validation', actorType: 'HUMAN_SELF' };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-public-drawings-'));
const projectRoot = path.join(sandbox, 'Public model samples');
fs.mkdirSync(projectRoot);
let application;
const report = [];

function closeEnough(actual, expected, context) {
  assert.ok(Number.isFinite(actual), `${context}: expected a finite numeric value`);
  assert.ok(Math.abs(actual - expected) <= Math.max(1e-9, Math.abs(expected) * 1e-12),
    `${context}: expected ${expected}, got ${actual}`);
}

try {
  for (const sample of selected) {
    const buffer = fs.readFileSync(path.join(fixtures, sample.file));
    assert.equal(buffer.length, sample.sizeBytes, `${sample.file}: downloaded source size`);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), sample.sha256, `${sample.file}: downloaded source hash`);
    fs.writeFileSync(path.join(projectRoot, sample.file), buffer);
  }
  application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  const { project } = application.timeline.importProject(projectRoot, actor, { watch: false });
  application.dependencies.ensureIndex(project.id);
  const facts = application.dependencies.objectsAt(project.id, null, ['DRAWING_ANNOTATION']);
  const ifc = selected.find((sample) => sample.format === 'IFC4 STEP');
  for (const expected of ifc.expectedFacts) {
    const matches = facts.filter((fact) => fact.path === ifc.file
      && fact.metadata.globalId === expected.globalId && fact.metadata.propertyName === expected.property);
    assert.equal(matches.length, 1, `${expected.name} ${expected.property}: one structured IFC fact`);
    const fact = matches[0];
    closeEnough(fact.metadata.numericValue, expected.value, fact.label);
    assert.equal(fact.metadata.units, 'm²');
    assert.equal(fact.metadata.roomName, expected.name);
    assert.equal(fact.metadata.roomNumber, expected.roomNumber);
    assert.equal(fact.metadata.stepId, expected.entityId);
    assert.equal(fact.metadata.propertyStepId, expected.quantityEntityId);
    assert.equal(fact.metadata.measurementBasis, 'model-property');
    assert.equal(fact.anchor.kind, 'cad-property');
    assert.equal(fact.anchor.elementId, expected.globalId);
    assert.ok(fact.metadata.rawText.includes(`${expected.quantityEntityId}= IFCQUANTITYAREA`));
    report.push({ file: fact.path, label: fact.label, value: fact.valueText,
      elementId: fact.metadata.globalId, quantity: fact.metadata.propertyStepId });
  }
  const civil = selected.find((sample) => sample.format === 'LandXML 1.2');
  const expectedRoad = civil.expectedFacts[0];
  const roads = facts.filter((fact) => fact.path === civil.file && /main road/i.test(fact.label)
    && fact.metadata.kind === 'length' && Math.abs(fact.metadata.numericValue - expectedRoad.value) < 1e-9);
  assert.equal(roads.length, 1, 'Main Road alignment length is an indexed native fact');
  closeEnough(roads[0].metadata.numericValue, expectedRoad.value, 'Main Road length');
  assert.equal(roads[0].metadata.units, 'ft');
  assert.equal(roads[0].metadata.measurementBasis, 'model-property');
  assert.equal(roads[0].anchor.kind, 'cad-property');
  assert.equal(roads[0].metadata.entityType, 'Alignment');
  assert.equal(roads[0].metadata.sourceUnits, 'foot');
  assert.equal(roads[0].metadata.sourcePropertyPath, '/LandXML/Alignments[name="Site 1"]/Alignment[name="Main Road"]/@length');
  report.push({ file: roads[0].path, label: roads[0].label, value: roads[0].valueText });

  // STEP B-rep measurements are indexed to ten significant digits.
  const closeToIndexed = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= Math.abs(expected) * 5e-10;
  for (const sample of selected.filter((entry) => entry.format.startsWith('STEP'))) {
    const stepFacts = facts.filter((fact) => fact.path === sample.file);
    for (const expected of sample.expectedFacts) {
      const matches = stepFacts.filter((fact) => fact.anchor.elementId === expected.part && fact.metadata.featureType === expected.featureType
        && fact.metadata.propertyName === expected.property && closeToIndexed(fact.metadata.numericValue, expected.value)
        && (!expected.featureIdPrefix || fact.anchor.featureId.startsWith(expected.featureIdPrefix)));
      const context = `${sample.file} ${expected.part} ${expected.featureType} ${expected.property} ${expected.value}`;
      assert.equal(matches.length, 1, `${context}: one indexed STEP fact`);
      const fact = matches[0];
      assert.equal(fact.metadata.units, expected.unit, context);
      if (expected.count) assert.equal(fact.metadata.count, expected.count, `${context}: feature count`);
      assert.equal(fact.metadata.measurementBasis, 'geometry');
      assert.equal(fact.anchor.kind, 'cad-property');
      report.push({ file: fact.path, label: fact.label, value: fact.valueText, count: fact.metadata.count, featureId: fact.anchor.featureId });
    }
    // Each cited part and feature must also render as a highlighted preview.
    const buffer = fs.readFileSync(path.join(fixtures, sample.file));
    const cited = stepFacts.find((fact) => fact.metadata.featureType === 'hole') ?? stepFacts[0];
    const view = await buildStepView(buffer, { elementId: cited.anchor.elementId, featureId: cited.anchor.featureId });
    assert.ok(view.elements.some((element) => element.selected && element.lines.length), `${sample.file}: highlighted preview`);
    report.push({ file: sample.file, preview: view.selected.label, previewBytes: Buffer.byteLength(JSON.stringify(view)) });
  }
  const datumTargets = facts.find((fact) => fact.path === 'nist_ftc_07_asme1_ap242-e2.stp' && fact.label === 'nist_ftc_07_asme1 overall Z extent');
  assert.ok(datumTargets.metadata.rawText.includes('MANIFOLD_SOLID_BREP'), 'the extent cites the solid, not a datum-target surface');

  const ask = (question, expectedValue, units) => {
    const result = application.terminal.executor.run(project.id, `ask ${question}`, actor);
    assert.equal(result.ok, true, question);
    assert.equal(result.data?.answered, true, `${question}: ${result.headline}`);
    closeEnough(result.data.numericValue, expectedValue, question);
    assert.equal(result.data.units, units, question);
    assert.ok(result.data.object && result.data.path && result.data.locator, `${question}: grounded source reference`);
    assert.equal(result.results.length, 1, `${question}: one cited source`);
    report.push({ question, answer: result.data.value, source: result.data.path, locator: result.data.locator });
    return result;
  };
  ask('What is the net floor area of Schlafzimmer?', 21.410325, 'm²');
  ask('What is the gross floor area of Schlafzimmer?', 22.0725, 'm²');
  ask('What is the net floor area of Buero?', 12.59545, 'm²');
  const converted = ask('What is the net square footage of Schlafzimmer?', 21.410325 / 0.09290304, 'ft²');
  assert.equal(converted.data.conversion.sourceNumericValue, 21.410325);
  assert.equal(converted.data.conversion.definition, '1 ft = 0.3048 m');
  ask('What is the length of Main Road?', expectedRoad.value, 'ft');
  ask('What is the diameter of the nist_ctc_01_asme1_rd Ø35 hole?', 35, 'mm');
  // Overall size is three extents; the solid's height is offered, not a datum-target span.
  const size = application.terminal.executor.run(project.id, 'ask What is the length of nist_ftc_07_asme1?', actor);
  assert.equal(size.data?.reason, 'AMBIGUOUS_DRAWING_VALUE', 'an unqualified part length offers its X, Y and Z extents');
  assert.deepEqual(size.results.map((item) => item.value).sort(), ['12.26794919 in', '5.35 in', '8.767949192 in']);
  report.push({ question: 'What is the length of nist_ftc_07_asme1?', ambiguous: size.results.map((item) => `${item.title}: ${item.value}`) });
  const ambiguous = application.terminal.executor.run(project.id, 'ask What is the area of Schlafzimmer?', actor);
  assert.equal(ambiguous.data?.answered, false, 'Unqualified area must not choose between net and gross');
  assert.equal(ambiguous.data.reason, 'AMBIGUOUS_DRAWING_VALUE');
  const missing = application.terminal.executor.run(project.id, 'ask What is the net floor area of Imaginary Room?', actor);
  assert.equal(missing.data?.answered, false, 'Missing rooms must not invent an area');
  assert.equal(missing.data.reason, 'NO_EXPLICIT_DRAWING_VALUE');

  if (includePdf) {
    const matches = facts.filter((fact) => fact.path === 'ncsu-office-kit.pdf' && fact.metadata.pageNumber === 17
      && fact.label === 'Small Conference' && fact.metadata.kind === 'room_area');
    assert.equal(matches.length, 1, 'PDF page 17 has a single Small Conference area');
    assert.equal(matches[0].metadata.numericValue, 180);
    assert.equal(matches[0].metadata.units, 'ft²');
    assert.ok(matches[0].anchor.bbox, 'PDF area retains its source location');
    ask('What is the square footage of Small Conference on page 17?', 180, 'ft²');
  }
  console.log(JSON.stringify({ status: 'passed', samples: selected.map(({ file, sha256 }) => ({ file, sha256 })),
    indexedMeasurements: facts.length, checks: report, ambiguityAndMissingValueChecks: 'passed' }, null, 2));
} finally {
  if (application) await application.close();
  fs.rmSync(sandbox, { recursive: true, force: true });
}
