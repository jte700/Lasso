import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { fileReferenceMatch } from '../src/dependencies/file-reference.js';
import { currentClauseStart } from '../src/dependencies/service.js';
import { bracketPart } from './fixtures/step-models.js';

const actor = { id: 'human:file-reference', displayName: 'File reference test', actorType: 'HUMAN_SELF' };
const label = (object, typed) => fileReferenceMatch(object, typed)?.label ?? null;

const ledger = { objectType: 'DATASET', path: 'Finance/General-Ledger.csv', label: 'General-Ledger', metadata: {} };
const sheet = { objectType: 'DATASET', path: 'Finance-Planning.xlsx', label: 'Finance-Planning · Cash Forecast',
  metadata: { sheet: 'Cash Forecast' } };
const notes = { objectType: 'DOCUMENT', path: 'Month-End-Close.md', label: 'September month end close', anchor: null,
  metadata: { title: 'September month end close' } };
const excerpt = { ...notes, anchor: { kind: 'text-excerpt' }, label: 'Close the books by Friday.' };
const agreement = { objectType: 'PAPER', path: 'Legal/Orchard-Services-Agreement.pdf', label: 'Orchard services agreement',
  metadata: { title: 'Orchard services agreement' } };
const bracket = { objectType: 'DRAWING', path: 'Models/Bracket.step', label: 'Bracket', metadata: { format: 'STEP', title: 'Bracket' } };
const survey = { objectType: 'DRAWING', path: 'Juniper-Site-Survey.landxml', label: 'Fictional Juniper Hub Site',
  metadata: { format: 'LANDXML', title: 'Fictional Juniper Hub Site' } };

test('a file typed by its literal name completes to that name, with the extension once one is typed', () => {
  assert.equal(label(ledger, 'General-Led'), 'General-Ledger');
  assert.equal(label(ledger, 'General-Ledger.cs'), 'General-Ledger.csv');
  assert.equal(label(notes, 'Month-End-Close.m'), 'Month-End-Close.md');
  assert.equal(label(agreement, 'Orchard-Services-Agreement.pd'), 'Orchard-Services-Agreement.pdf');
  assert.equal(label(bracket, 'Bracket.s'), 'Bracket.step');
  assert.equal(label(bracket, 'Bracket.st'), 'Bracket.step');
  assert.equal(label(survey, 'Juniper-Site-Survey.la'), 'Juniper-Site-Survey.landxml');
  assert.equal(label(sheet, 'Finance-Planning.xl'), 'Finance-Planning.xlsx · Cash Forecast', 'the sheet stays named');
  assert.equal(label(ledger, 'General-Ledger.pd'), null, 'another extension is another file');
});

test('a file named in plain words completes to its readable name', () => {
  assert.equal(label(ledger, 'general ledger'), 'General Ledger');
  assert.equal(label(notes, 'month end close'), 'Month End Close', 'the file name the words match exactly');
  assert.equal(label(notes, 'september month'), 'September month end close', 'or the title they begin');
  assert.equal(label(agreement, 'orchard services'), 'Orchard Services Agreement');
  assert.equal(label(sheet, 'cash forecast'), 'Finance Planning · Cash Forecast');
  assert.equal(label(bracket, 'brack'), 'Bracket', 'drawings keep their discovery label');
});

test('ordinary words, wrong order, passages and other extensions do not name a file', () => {
  assert.equal(label(ledger, 'general'), null, 'one word could be anything being written');
  assert.equal(label(ledger, 'ledger general'), null);
  // Words must begin a name: the middle of a free-text title is ordinary prose.
  const salt = { objectType: 'DOCUMENT', path: 'notes.md', label: 'Salt intake and blood pressure in adults', anchor: null,
    metadata: { title: 'Salt intake and blood pressure in adults' } };
  assert.equal(label(salt, 'blood pressure'), null);
  assert.equal(label(salt, 'salt blood'), null);
  assert.equal(label(salt, 'salt intake'), 'Salt intake and blood pressure in adults');
  assert.equal(label(excerpt, 'month end close'), null, 'a passage is not the file');
  assert.equal(label({ ...ledger, objectType: 'DATASET_ROW' }, 'general ledger'), null);
});

function workspace(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-file-reference-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  const drawings = new URL('./fixtures/drawings/', import.meta.url);
  fs.writeFileSync(path.join(root, 'General-Ledger.csv'), 'Account,Debit,Credit\nCash,1200,0\nRevenue,0,1200\n');
  fs.writeFileSync(path.join(root, 'Month-End-Close.md'), '# September month end close\n\nClose the books by Friday.\n');
  fs.writeFileSync(path.join(root, 'Kickoff-Meeting-2026-10-15.txt'), 'Kickoff meeting notes.\nScope agreed with the client.\n');
  fs.writeFileSync(path.join(root, 'Bracket.step'), bracketPart());
  fs.writeFileSync(path.join(root, 'Bracket.SLDPRT'), 'Native part stand-in.\n');
  fs.copyFileSync(new URL('cedar-lane-residence-realistic.dxf', drawings), path.join(root, 'Cedar-Lane-Floor-Plan.dxf'));
  fs.copyFileSync(new URL('cedar-lane-concept-plan.pdf', drawings), path.join(root, 'Cedar-Lane-Concept-Plan.pdf'));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app.workspace.add([fs.realpathSync(root)], actor).then(() => app);
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });

test('every kind of file can be named while typing, and Tab replaces exactly the typed name', async t => {
  const app = await workspace(t);
  const cases = [
    ['General-Ledger.cs', 'General-Ledger.csv', 'General-Ledger.csv'],
    ['I checked the General-Ledger.cs', 'General-Ledger.csv', 'General-Ledger.csv'],
    ['Our general ledger', 'General-Ledger.csv', 'General Ledger'],
    ['Month-End-Close.m', 'Month-End-Close.md', 'Month-End-Close.md'],
    ['See the month end close', 'Month-End-Close.md', 'Month End Close'],
    ['Kickoff-Meeting-2026', 'Kickoff-Meeting-2026-10-15.txt', 'Kickoff-Meeting-2026-10-15'],
    ['Kickoff-Meeting-2026-10-15.tx', 'Kickoff-Meeting-2026-10-15.txt', 'Kickoff-Meeting-2026-10-15.txt'],
    ['Cedar-Lane-Floor-Plan.d', 'Cedar-Lane-Floor-Plan.dxf', 'Cedar-Lane-Floor-Plan.dxf'],
    ['Cedar-Lane-Concept-Plan.pd', 'Cedar-Lane-Concept-Plan.pdf', 'Cedar-Lane-Concept-Plan.pdf'],
    ['Bracket.st', 'Bracket.step', 'Bracket.step'],
    ['Bracket.SL', 'Bracket.SLDPRT', 'Bracket.SLDPRT'],
  ];
  for (const [text, file, inserted] of cases) {
    const prediction = await typed(app, text);
    assert.equal(prediction.claims.length, 1, text);
    const [claim] = prediction.claims;
    const name = text.slice(claim.start);
    assert.ok(text.endsWith(name) && name.length >= Math.min(text.length, 4), `${text}: replaces "${name}"`);
    assert.equal(claim.type, 'ENTITY', text);
    assert.equal(claim.candidates[0].path, file, text);
    assert.equal(claim.candidates[0].label, inserted, text);
    assert.ok(claim.candidates[0].fileReference, `${text}: marked as a file reference for the web editor`);
    assert.equal(prediction.workspaceCompletions.length, 0, text);
  }
  // The measured STEP model comes before the native file kept only as a pointer.
  const both = (await typed(app, 'The Bracket')).claims[0].candidates.map(candidate => candidate.path);
  assert.deepEqual(both, ['Bracket.step', 'Bracket.SLDPRT']);
});

test('a file named in one work directory is not buried by suggestions from another', async t => {
  const app = await workspace(t);
  // Another directory's data matches the same words ("data", "dictionary").
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-file-reference-other-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, 'Data-Dictionary.csv'), 'Variable,Meaning\nArea m2,Floor area in square metres\n');
  fs.writeFileSync(path.join(other, 'Room-Schedule.csv'), 'Room,Area m2\nKitchen,12\nStudy,9\n');
  await app.workspace.add([fs.realpathSync(other)], actor);
  for (const text of ['Data-Dictionary.cs', 'I checked the General-Ledger.cs']) {
    const prediction = await typed(app, text);
    assert.deepEqual([prediction.completion, prediction.workspaceCompletions.length, prediction.sourceCompletions.length], [null, 0, 0], text);
    assert.equal(prediction.claims.length, 1, text);
    assert.ok(prediction.claims[0].candidates.every(candidate => candidate.fileReference), text);
  }
});

test('sentences end at punctuation and a space, not inside names, numbers or abbreviations', () => {
  const start = text => currentClauseStart(text, text.length);
  assert.equal(start('Bracket.st'), 0);
  assert.equal(start('The plate is 4.8 mm and Bracket.st'), 'The plate is 4.8 mm and '.length, 'a clause, not a sentence');
  assert.equal(start('Done. Gross pr'), 'Done.'.length);
  assert.equal(start('Some costs, e.g. gross pr'), 0, 'an abbreviation before lowercase continues the sentence');
  assert.equal(start('As reported by Smith et al. Gross pr'), 'As reported by Smith et al.'.length,
    'before a capital it ends the sentence');
  assert.equal(start('Revenue, costs, etc. Gross pr'), 'Revenue, costs, etc.'.length);
});

test('a variable matched on as many words beats a file named the same in plain words', async t => {
  const app = await workspace(t);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-file-reference-data-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, 'blood_pressure.csv'), 'Patient,Systolic blood pressure,Diastolic blood pressure\nP1,121,80\nP2,134,86\n');
  fs.writeFileSync(path.join(data, 'Net-Income.csv'), 'Month,Net income\nJanuary,1200\nFebruary,1350\n');
  fs.writeFileSync(path.join(data, 'notes.md'), '# Salt intake and blood pressure in adults\n\nNotes.\n');
  await app.workspace.add([fs.realpathSync(data)], actor);
  for (const [text, variable] of [['We measured systolic blood pressure', 'systolic blood pressure'], ['Our net income', 'net income'],
    ['We measured blood pressure', 'blood pressure']]) {
    const [claim] = (await typed(app, text)).claims;
    assert.equal(claim?.type, 'STUDY_VARIABLE', text);
    assert.equal(claim.text.toLowerCase(), variable, text);
  }
  // Spelled as the file is, it is still the file.
  assert.equal((await typed(app, 'Net-Income.cs')).claims[0].candidates[0].path, 'Net-Income.csv');
});

test('a file named by its own words comes before a drawing found only by its type', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-drawing-type-'));
  const root = path.join(sandbox, 'Project');
  fs.mkdirSync(root);
  // A parsed building model is a "floor plan" by its format; the notes are one by name.
  fs.writeFileSync(path.join(root, 'Haus.ifc'), `ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#3=IFCUNITASSIGNMENT((#1,#2));
#4=IFCPROJECT('project',$,'Project',$,$,$,$,$,#3);
#5=IFCSPACE('space-guid',$,'101',$,$,$,$,'Office 101',.ELEMENT.,.INTERNAL.,$);
#6=IFCQUANTITYAREA('NetFloorArea',$,$,12,$);
#7=IFCELEMENTQUANTITY('quantity-guid',$,'Qto_SpaceBaseQuantities',$,$,(#6));
#8=IFCRELDEFINESBYPROPERTIES('relation',$,$,$,(#5),#7);
ENDSEC;END-ISO-10303-21;`);
  fs.writeFileSync(path.join(root, 'Floor-Plan-Notes.md'), '# Floor plan notes\n\nThe kitchen moved north.\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await app.workspace.add([fs.realpathSync(root)], actor);
  const [claim] = (await typed(app, 'Here is the floor plan')).claims;
  assert.deepEqual(claim.candidates.map(candidate => candidate.path), ['Floor-Plan-Notes.md', 'Haus.ifc']);
  assert.equal(claim.candidates[1].ranking.reason, 'Matching drawing type');
  // Named by its own file name, the model is a direct match again.
  assert.equal((await typed(app, 'Here is the Haus')).claims[0].candidates[0].path, 'Haus.ifc');
});

test('citations elsewhere in the paragraph, or a cue such as "the file", do not hide a named dataset', async t => {
  const app = await workspace(t);
  for (const text of ['Costs were reported monthly. I checked the General-Ledger.cs', 'I checked the file General-Ledger.cs',
    'Open the spreadsheet General-Led']) {
    const [claim] = (await typed(app, text)).claims;
    assert.equal(claim?.candidates[0].path, 'General-Ledger.csv', text);
  }
});
