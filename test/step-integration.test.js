import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../src/server.js';
import { anchorForSpan } from '../src/dependencies/service.js';
import { BRACKET, bracketPart, fixtureAssembly } from './fixtures/step-models.js';

const actor = { id: 'human:cad-reviewer', displayName: 'CAD reviewer', actorType: 'HUMAN_SELF' };

function workspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-integration-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(path.join(root, 'CAD'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CAD', 'bracket.step'), bracketPart());
  fs.writeFileSync(path.join(root, 'Notes.md'), '# Notes\n\nThe mounting holes are 8 mm in diameter and the plate is 100 mm long.\n');
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false };
  const app = createApplication(config);
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { app, project, root };
}

function linkSpan(app, project, source, spanText) {
  const document = app.dependencies.getDocument(project.id, 'Notes.md');
  const index = document.blocks.findIndex(block => block.text.includes(spanText));
  const block = document.blocks[index], start = block.text.indexOf(spanText);
  return app.dependencies.link(project.id, {
    documentPath: 'Notes.md', anchor: anchorForSpan(index, block.type, block.text, start, start + spanText.length),
    spanText, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId, selectionMethod: 'MANUAL',
  }, actor).dependency.id;
}

test('STEP part facts flow through search, questions, model previews and source links', async t => {
  const { app, project, root } = workspace(t);
  // Broad queries show a few results per file; name the feature to reach it.
  const found = app.dependencies.search(project.id, 'Bracket Ø8 hole diameter');
  const hole = found.find(object => object.label === 'Bracket Ø8 hole diameter');
  assert.ok(hole, 'ordinary search discovers measured CAD features');
  assert.equal(hole.objectType, 'DRAWING_ANNOTATION');
  assert.equal(hole.valueText, '8 mm');
  assert.equal(hole.anchor.kind, 'cad-property');
  assert.equal(hole.anchor.featureId, 'hole:8:10');

  const run = question => app.terminal.executor.run(project.id, question, actor);
  const answer = run('What is the diameter of the Bracket Ø8 hole?');
  assert.equal(answer.data.answered, true);
  assert.equal(answer.data.value, '8 mm');
  assert.equal(answer.data.measurementBasis, 'geometry');
  assert.equal(run('What is the radius of the Bracket arc?').data.value, '5 mm');
  assert.equal(run('What is the arc length of the Bracket arc?').data.value, '7.853981634 mm');
  const length = run('What is the length of Bracket?');
  assert.equal(length.data.reason, 'AMBIGUOUS_DRAWING_VALUE', 'X, Y and Z extents are offered rather than guessed');
  assert.equal(length.data.candidates.length, 3);
  assert.equal(run('What is the diameter of the Bracket Ø9 hole?').data.answered, false);

  // Written values carry units; the popup ranks the matching measurement first
  // and does not treat centimetres as millimetres.
  const predicted = text => app.dependencies.predict(project.id, { text, cursor: text.length, blockIndex: 1, documentPath: 'Notes.md' })
    .claims[0].candidates;
  const millimetres = predicted('The Bracket Ø8 hole diameter is 8 mm')[0];
  assert.equal(millimetres.label, 'Bracket Ø8 hole diameter');
  assert.ok(millimetres.reasons.includes('matching value'));
  assert.equal(predicted('The Bracket Ø12 hole diameter is 12 mm')[0].label, 'Bracket Ø12 hole diameter');
  assert.ok(!predicted('The Bracket Ø8 hole diameter is 8 cm').some(candidate => candidate.reasons.includes('matching value')));

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async route => { const response = await fetch(base + route); assert.equal(response.status, 200); return response.json(); };
  const { preview } = await get(`/api/dependency-objects/${hole.id}/preview?version=${hole.versionId}`);
  assert.equal(preview.kind, 'model-plan', preview.reason);
  assert.equal(preview.view, 'Isometric view');
  assert.equal(preview.selected.label, 'Bracket · Ø8 hole');
  assert.equal(preview.elements.filter(element => element.selected).flatMap(element => element.lines).length, 20);
  const { preview: file } = await get(`/api/snapshots/${hole.snapshotId}/preview?path=CAD/bracket.step&elementId=Bracket&featureId=${encodeURIComponent('arc:5:90')}`);
  assert.equal(file.selected.label, 'Bracket · R5 90° arc');
  const { objects } = await get(`/api/projects/${project.id}/source-library`);
  const model = objects.find(object => object.objectType === 'DRAWING' && object.path === 'CAD/bracket.step');
  assert.ok(model.searchAliases.includes('CAD model'));

  const extent = app.dependencies.search(project.id, 'Bracket overall X extent').find(object => object.label === 'Bracket overall X extent');
  const holeLink = linkSpan(app, project, hole, '8 mm');
  const extentLink = linkSpan(app, project, extent, '100 mm');
  const viewer = app.dependencies.dependencySourceViewer(holeLink);
  assert.equal(viewer.kind, 'document');
  assert.match(viewer.text, /CYLINDRICAL_SURFACE\('',#\d+,4\.\)/);
  assert.equal(viewer.text.slice(viewer.selectedStart, viewer.selectedStart + viewer.selectedText.length), viewer.selectedText);
  assert.equal((await app.dependencies.dependencyModelPreview(holeLink)).selected.label, 'Bracket · Ø8 hole');

  // Resize the four Ø8 holes. The plate's extents keep their identity; the
  // Ø8 feature no longer exists and is not silently redirected to Ø10.
  fs.writeFileSync(path.join(root, 'CAD', 'bracket.step'), bracketPart({ holes: BRACKET.holes.map(item => item.split ? item : { ...item, radius: 5 }) }));
  assert.equal(app.timeline.capture(project.id, actor, { source: 'EXPLICIT_CHECKPOINT' }).changed, true);
  assert.equal(app.dependencies.getDependency(holeLink).status, 'BROKEN');
  assert.notEqual(app.dependencies.getDependency(extentLink).status, 'BROKEN');
  assert.equal(app.dependencies.objectsAt(project.id).find(object => object.id === extent.id).valueText, '100 mm');
  assert.equal(app.dependencies.dependencyPreview(holeLink).source.valueText, '8 mm', 'the pinned version keeps its evidence');
  assert.ok(app.dependencies.search(project.id, 'Bracket Ø10 hole diameter').some(object => object.label === 'Bracket Ø10 hole diameter'));
  const pinned = await app.dependencies.dependencyModelPreview(holeLink);
  assert.equal(pinned.selected.label, 'Bracket · Ø8 hole', 'historical previews render the linked source version');
});

test('snapshots indexed before STEP support gain CAD facts lazily without creating timeline edits', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-upgrade-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'fixture.stp'), fixtureAssembly());
  fs.writeFileSync(path.join(root, 'Budget.csv'), 'Item,Cost\nPins,40\n');
  const config = { dataDir: path.join(sandbox, 'history'), watchProjects: false };
  let app = createApplication(config);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  const step = () => app.dependencies.objectsAt(project.id).filter(object => object.path === 'fixture.stp');
  const indexed = step().map(object => object.objectKey).sort();
  const budget = app.dependencies.objectsAt(project.id).find(object => object.path === 'Budget.csv');
  const snapshotId = project.currentSnapshotId;
  const databasePath = app.config.databasePath;
  await app.close();
  // Fixture construction only: rebuild a snapshot indexed by the previous
  // drawing reader, then restore the immutability guard before reopening.
  const legacy = new DatabaseSync(databasePath);
  const guard = legacy.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='scientific_object_versions_immutable_delete'").get().sql;
  legacy.exec('DROP TRIGGER scientific_object_versions_immutable_delete');
  legacy.prepare("DELETE FROM scientific_object_versions WHERE path = 'fixture.stp'").run();
  // Index version 3 is the last one before STEP models (4).
  legacy.prepare('UPDATE snapshot_object_indexes SET drawing_index_version = 3 WHERE snapshot_id = ?').run(snapshotId);
  legacy.exec(guard);
  legacy.close();
  app = createApplication(config);
  assert.deepEqual(step().map(object => object.objectKey).sort(), indexed);
  assert.equal(app.dependencies.objectsAt(project.id).find(object => object.id === budget.id).versionId, budget.versionId, 'earlier objects keep their versions');
  assert.equal(app.db.prepare('SELECT drawing_index_version FROM snapshot_object_indexes WHERE snapshot_id = ?').get(snapshotId).drawing_index_version, 4);
  assert.equal(app.timeline.getProject(project.id).currentSnapshotId, snapshotId);
});

async function typingWorkspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-typing-'));
  const root = path.join(sandbox, 'Models');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Bracket.step'), bracketPart());
  // A native CAD file is indexed as a model with no measurements.
  fs.writeFileSync(path.join(root, 'Bracket.SLDPRT'), 'Native part stand-in.\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text, extra = {}) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, ...extra });

// Accepts a suggestion the way the native card does: Tab inserts the name and
// the next request carries the link as a pending dependency.
async function acceptName(app, text, label, filePath = 'Bracket.step') {
  const chosen = candidate => candidate.label === label && candidate.path === filePath;
  const claim = (await typed(app, text)).claims.find(item => item.candidates.some(chosen));
  assert.ok(claim, `${text} suggests ${label} from ${filePath}`);
  const source = claim.candidates.find(chosen);
  const accepted = `${text.slice(0, claim.start)}${source.completionText ?? source.label}`;
  return { source, accepted, pendingDependencies: [{ projectId: source.projectId, blockIndex: 0, start: claim.start,
    end: accepted.length, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId }] };
}

const offered = prediction => prediction.workspaceCompletions.map(item => ({
  text: item.replacementText, label: item.dependencyCandidate.label,
}));

test('a CAD part is offered before its measurements, which need as many letters as its name', async t => {
  const app = await typingWorkspace(t);
  const suggested = prediction => [
    ...prediction.claims.flatMap(claim => claim.candidates),
    ...[...prediction.workspaceCompletions, ...prediction.sourceCompletions].map(item => item.dependencyCandidate),
  ].map(candidate => `${candidate.objectType} ${candidate.path}`);
  // Two letters are too few to name the part, so they are too few for the
  // measurements whose labels begin with its name ("Bracket overall X extent").
  const two = await typed(app, 'The br');
  assert.ok(!suggested(two).some(item => item.startsWith('DRAWING_ANNOTATION')), suggested(two).join('\n'));
  // The third letter names the whole files; their values follow once one is accepted.
  const three = await typed(app, 'The bra');
  assert.deepEqual(suggested(three), ['DRAWING Bracket.step', 'DRAWING Bracket.SLDPRT']);
});

test('an accepted CAD feature name offers its measured value', async t => {
  const app = await typingWorkspace(t);
  const { source, accepted, pendingDependencies } = await acceptName(app, 'The Bracket Ø8 hole diam', 'Bracket Ø8 hole diameter');
  assert.equal(source.objectType, 'DRAWING_ANNOTATION');
  assert.equal(accepted, 'The Bracket Ø8 hole diameter');
  const prediction = await typed(app, `${accepted} is`, { pendingDependencies });
  assert.equal(prediction.workspaceHeading, 'Values for Bracket Ø8 hole diameter');
  assert.ok(!prediction.notice, prediction.notice);
  assert.deepEqual(offered(prediction), [{ text: '8 mm', label: 'Bracket Ø8 hole diameter' }]);
  assert.equal(prediction.workspaceCompletions[0].dependencyCandidate.id, source.id);
  // Once the value itself is the linked text, it is not offered again.
  const value = `${accepted} is 8 mm`;
  const stated = await typed(app, `${value} and `, { pendingDependencies: [{ ...pendingDependencies[0],
    start: value.length - 4, end: value.length }] });
  assert.deepEqual(offered(stated), []);
});

test('an accepted CAD part name offers its measurements, ranked by the words after it', async t => {
  const app = await typingWorkspace(t);
  const { source, accepted, pendingDependencies } = await acceptName(app, 'The brack', 'Bracket');
  assert.equal(source.objectType, 'DRAWING');
  assert.equal(source.anchor.kind, 'cad-model');
  assert.equal(accepted, 'The Bracket');

  // The space after the accepted name opens its values; the name is not offered again.
  const spaced = await typed(app, `${accepted} `, { pendingDependencies });
  assert.equal(spaced.workspaceHeading, 'Values for Bracket');
  assert.equal(offered(spaced)[0].text, '100 mm');
  assert.ok(!spaced.claims.some(claim => claim.candidates.some(candidate => candidate.id === source.id)));

  // With nothing more to go on, overall sizes come first, then holes and arcs.
  // Equal values of different features each keep a row: the card names the feature.
  const plain = await typed(app, `${accepted} is`, { pendingDependencies });
  assert.equal(plain.workspaceHeading, 'Values for Bracket');
  assert.deepEqual(offered(plain), [
    { text: '100 mm', label: 'Bracket overall X extent' },
    { text: '60 mm', label: 'Bracket overall Y extent' },
    { text: '10 mm', label: 'Bracket overall Z extent' },
    { text: '12 mm', label: 'Bracket Ø12 hole diameter' },
    { text: '8 mm', label: 'Bracket Ø8 hole diameter' },
    { text: '10 mm', label: 'Bracket Ø12 hole depth' },
    { text: '10 mm', label: 'Bracket Ø8 hole depth' },
    { text: '5 mm', label: 'Bracket R5 90° arc radius' },
  ]);
  // The card's feature line ("Ø8 hole depth") is the label after the part name.
  for (const { dependencyCandidate: candidate } of plain.workspaceCompletions) {
    assert.equal(candidate.anchor.kind, 'cad-property');
    assert.equal(candidate.metadata.entityName, 'Bracket');
    assert.ok(candidate.anchor.label.startsWith('Bracket '), candidate.anchor.label);
  }

  // "four holes" names the four Ø8 holes, and "diameter" their diameter.
  const diameter = await typed(app, `${accepted} has four holes with a diameter of`, { pendingDependencies });
  assert.equal(diameter.workspaceHeading, 'Values for Bracket');
  assert.deepEqual(offered(diameter).slice(0, 2), [
    { text: '8 mm', label: 'Bracket Ø8 hole diameter' },
    { text: '12 mm', label: 'Bracket Ø12 hole diameter' },
  ]);
  const depth = await typed(app, `${accepted} has four holes with a depth of `, { pendingDependencies });
  assert.deepEqual(offered(depth).slice(0, 2), [
    { text: '10 mm', label: 'Bracket Ø8 hole depth' },
    { text: '10 mm', label: 'Bracket Ø12 hole depth' },
  ]);
  // "R5" names a feature here, not a spreadsheet row.
  const radius = await typed(app, `${accepted}'s R5 corners have a radius of`, { pendingDependencies });
  assert.deepEqual(offered(radius)[0], { text: '5 mm', label: 'Bracket R5 90° arc radius' });
  // A value being typed, with or without its unit, is completed by Tab rather than replaced.
  for (const tail of [' is 6', ' is 60 m', ' is 60 mm']) {
    const value = await typed(app, `${accepted}${tail}`, { pendingDependencies });
    assert.deepEqual(offered(value)[0], { text: '60 mm', label: 'Bracket overall Y extent' }, tail);
  }
  // A whole number typed is that value, not a longer one it begins.
  const ten = await typed(app, `${accepted} is 10`, { pendingDependencies });
  assert.deepEqual(offered(ten)[0], { text: '10 mm', label: 'Bracket overall Z extent' });

  // A new sentence is a new subject, as it is after a spreadsheet source.
  const next = await typed(app, `${accepted} is 100 mm long. The`, { pendingDependencies });
  assert.equal(next.workspaceHeading, undefined);

  // A model with nothing measured leaves the sentence to the other suggestions.
  const native = await acceptName(app, 'The brack', 'Bracket', 'Bracket.SLDPRT');
  const unmeasured = await typed(app, `${native.accepted} has a Ø8 hole diam`, { pendingDependencies: native.pendingDependencies });
  assert.equal(unmeasured.workspaceHeading, undefined);
  assert.ok(unmeasured.claims.some(claim => claim.candidates.some(candidate => candidate.label === 'Bracket Ø8 hole diameter')));
});

test('typing a model file name offers that drawing, not facts that match its unfinished extension', async t => {
  const app = await typingWorkspace(t);
  // A dot inside a name does not end the sentence: "st" alone would match every
  // "straight edge" fact while the file being named was never offered.
  for (const text of ['Bracket.st', 'The Bracket.ste', 'I opened Bracket.step']) {
    const prediction = await typed(app, text);
    const [claim, ...others] = prediction.claims;
    assert.equal(others.length, 0, text);
    assert.equal(claim.start, text.indexOf('Bracket'), `${text} replaces the whole typed name`);
    assert.deepEqual(claim.candidates.map(candidate => [candidate.objectType, candidate.path]),
      [['DRAWING', 'Bracket.step']], text);
    assert.deepEqual(offered(prediction), [], text);
  }
  // Sentences still end at punctuation followed by a space.
  const next = await typed(app, 'The plate is 4.5 mm thick. Bracket.st');
  assert.equal(next.claims[0].start, 'The plate is 4.5 mm thick. '.length);
  assert.equal(next.claims[0].candidates[0].path, 'Bracket.step');
});

test('naming a part before a measurement word offers only that part\'s measurements', async t => {
  const app = await typingWorkspace(t);
  // Another model with straight edges of its own sits in a second work directory.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.copyFileSync(new URL('./fixtures/drawings/nist_ctc_01_asme1_rd.stp', import.meta.url), path.join(other, 'nist_ctc_01_asme1_rd.stp'));
  await app.workspace.add([fs.realpathSync(other)], actor);
  assert.ok((await typed(app, 'The length')).claims[0].candidates.some(candidate => candidate.path.startsWith('nist')),
    'unqualified, every model\'s lengths are candidates');
  for (const text of ['The bracket length', 'The Bracket edge', 'The bracket straight edge len']) {
    const [claim] = (await typed(app, text)).claims;
    assert.equal(claim.start, text.toLowerCase().indexOf('bracket'), `${text}: the part's name is replaced too`);
    assert.ok(claim.candidates.length > 0, text);
    assert.ok(claim.candidates.every(candidate => candidate.path === 'Bracket.step'), text);
  }
  const [claim] = (await typed(app, 'The bracket length')).claims;
  assert.ok(claim.candidates.some(candidate => candidate.label === 'Bracket 10 mm straight edge length'));
});

test('a file spelled out after a linked part is offered even when the file is in another directory', async t => {
  const app = await typingWorkspace(t);
  const { accepted, pendingDependencies } = await acceptName(app, 'The brack', 'Bracket');
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-step-ledger-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'Income-Statement.csv'), 'Line,Amount\nRevenue,1200\n');
  await app.workspace.add([fs.realpathSync(other)], actor);
  const text = `${accepted} is shown next to Income-Statement.cs`;
  const prediction = await typed(app, text, { pendingDependencies });
  assert.equal(prediction.claims[0]?.candidates[0].path, 'Income-Statement.csv');
  assert.equal(prediction.claims[0].start, text.indexOf('Income-Statement'));
  assert.equal(prediction.workspaceCompletions.length, 0);
});
