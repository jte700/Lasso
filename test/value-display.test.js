// A worksheet stores 18400 and shows it as 18,400 by the cell's number
// format. The card's change line and The Ranch's captions show changed values
// the way the sheet does, in fields of their own beside the stored values. A
// CSV value has no format and stays as written.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { storedZip } from './fixtures/workbook.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

/** A budget whose amounts use Excel's built-in "#,##0" format (style 1). */
const book = (payroll) => storedZip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="3"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>Line</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c></row>
    <row r="2"><c r="A2" t="inlineStr"><is><t>Rent</t></is></c><c r="B2" s="1"><v>4200</v></c></row>
    <row r="3"><c r="A3" t="inlineStr"><is><t>Payroll</t></is></c><c r="B3" s="1"><v>${payroll}</v></c></row>
  </sheetData></worksheet>`,
});
const csv = (payroll) => `Line,Amount\nRent,4200\nPayroll,${payroll}\n`;

function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-display-')));
  const root = path.join(sandbox, 'Budget');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book(18400));
  fs.writeFileSync(path.join(root, 'budget.csv'), csv(18400));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  fs.writeFileSync(path.join(root, 'budget.xlsx'), book(19250));
  fs.writeFileSync(path.join(root, 'budget.csv'), csv(19250));
  app.timeline.capture(project.id, actor);
  app.dependencies.ensureIndex(project.id);
  const snapshotId = app.timeline.getProject(project.id).currentSnapshotId;
  const payroll = (file) => app.dependencies.objectsAt(project.id).find((object) => object.path === file && object.label === 'Payroll · Amount');
  return { app, project, snapshotId, payroll };
}

test('A changed worksheet value is shown in the card as the sheet formats it, and a CSV value as written', (t) => {
  // Arrange
  const { app, project, snapshotId, payroll } = folder(t);

  // Act
  const sheet = app.dependencies.suggestionChange(project.id, snapshotId, payroll('budget.xlsx'));
  const plain = app.dependencies.suggestionChange(project.id, snapshotId, payroll('budget.csv'));

  // Assert
  assert.deepEqual([sheet.previousValue, sheet.currentValue], ['18400', '19250'], 'the stored values are unchanged');
  assert.deepEqual([sheet.previousDisplay, sheet.currentDisplay], ['18,400', '19,250']);
  assert.deepEqual([plain.previousValue, plain.currentValue], ['18400', '19250']);
  assert.equal(plain.previousDisplay, undefined);
  assert.equal(plain.currentDisplay, undefined);
});

test('The Ranch\'s captions show a changed worksheet value as the sheet formats it', (t) => {
  // Arrange
  const { app, project } = folder(t);

  // Act
  const { history } = app.ranch.current().value;
  const view = app.ranch.sheet({ directoryId: project.id, path: 'budget.xlsx' });
  const edited = (file) => history.find((entry) => entry.change === 'edited' && entry.path === file)?.valueChanges?.first;

  // Assert
  assert.deepEqual([edited('budget.xlsx').beforeDisplay, edited('budget.xlsx').afterDisplay], ['18,400', '19,250']);
  assert.equal(edited('budget.csv').beforeDisplay, undefined, 'a CSV value stays as written');
  assert.deepEqual(view.changes.map(({ before, beforeDisplay, afterDisplay }) => [before, beforeDisplay, afterDisplay]),
    [['18400', '18,400', '19,250']]);
});

test('Needs Review rows for a changed worksheet value show both values as the sheet formats them', async (t) => {
  // Arrange
  const { app, project, payroll } = folder(t);
  const { linkReviewItems } = await import('../src/ranch/review.js');
  const cell = payroll('budget.xlsx');
  const link = { id: 'd1', projectId: project.id, documentPath: 'memo.md', status: 'STALE', spanText: 'Payroll came to 18400',
    statusDetails: { linkedSourceValue: '18400', currentSourceValue: '19250' },
    source: { projectId: project.id, path: 'budget.xlsx', label: 'Payroll · Amount', valueText: '18400', anchor: cell.anchor } };

  const { shareReviewItems } = await import('../src/ranch/review.js');
  const share = { id: 's1', drifted: true, directoryId: project.id, path: 'budget.xlsx', fileId: 'f', sharedValue: '18400', currentValue: '19250',
    ...app.ranch.shownValues(project.id, 'budget.xlsx', cell.anchor, { sharedDisplay: '18400', currentDisplay: '19250' }) };

  // Act
  const [changed] = linkReviewItems([link], () => 'f', app.ranch.shownValue);
  const [drifted] = shareReviewItems([share]);

  // Assert
  assert.deepEqual([changed.before, changed.after, changed.beforeDisplay, changed.afterDisplay], ['18400', '19250', '18,400', '19,250']);
  assert.deepEqual([drifted.before, drifted.beforeDisplay, drifted.afterDisplay], ['18400', '18,400', '19,250'], 'so does a drifted share');
});
