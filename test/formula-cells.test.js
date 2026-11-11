// A worksheet cell that holds a formula says so, and when its value changes
// because an input did, the suggestion card reads the change as recalculated
// rather than edited.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { storedZip } from './fixtures/workbook.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

/** Two inputs and their total, written as Excel writes a formula with its cached value. */
const totals = (rent, payroll) => storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Rent</t></is></c><c r="B2"><v>${rent}</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Payroll</t></is></c><c r="B3"><v>${payroll}</v></c></row>
    <row r="4"><c r="A4" t="inlineStr"><is><t>Total</t></is></c><c r="B4"><f>B2+B3</f><v>${rent + payroll}</v></c></row>
  </sheetData></worksheet>`,
});

test('A formula cell says so, and its changed value reads as recalculated', async (t) => {
  // Arrange
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-formulas-')));
  const root = path.join(sandbox, 'Budget');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), totals(4200, 18400));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const cell = (label) => app.dependencies.objectsAt(project.id).find((object) => object.label === label);

  // Act
  fs.writeFileSync(path.join(root, 'budget.xlsx'), totals(4200, 19250));
  app.timeline.capture(project.id, actor);
  app.dependencies.ensureIndex(project.id);
  const snapshotId = app.timeline.getProject(project.id).currentSnapshotId;
  const total = cell('Total · Amount');
  const payroll = cell('Payroll · Amount');

  // Assert
  assert.equal(total.metadata.formula, true);
  assert.equal(payroll.metadata.formula, undefined);
  assert.equal(app.dependencies.suggestionChange(project.id, snapshotId, total)?.kind, 'recalculated');
  assert.equal(app.dependencies.suggestionChange(project.id, snapshotId, payroll)?.kind, 'edited');
});
