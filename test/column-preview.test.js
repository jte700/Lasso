import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { tableContext } from '../src/dependencies/table-preview.js';
import { buildSharePreview } from '../src/sharing/share-preview.js';

const PAYABLES = [
  'Supplier,Invoice,Invoice Date,Due Date,Outstanding CAD,Status as of 2026-10-11',
  'Maple Paper Distribution,BILL-1160,2026-08-18,2026-09-17,22000,Overdue',
  'Harbour Office Furniture,BILL-1174,2026-09-12,2026-10-12,18400,Due within seven days',
  'North Ridge Technology,BILL-1181,2026-09-20,2026-10-20,35000,Not yet due',
  'Cedar Packaging,BILL-1188,2026-09-25,2026-10-25,17250,Not yet due',
  'Pine Facilities Supply,BILL-1190,2026-09-28,2026-10-28,32500,Not yet due',
  'City Office Consumables,BILL-1192,2026-09-30,2026-10-30,1250,Not yet due',
  'TOTAL,,,,126400,Agrees with trial balance',
].join('\n');
const payables = { path: 'Accounts-Payable.csv', content: Buffer.from(PAYABLES) };
const invoiceDate = { kind: 'table-column', column: 'Invoice Date', columnIndex: 2 };
const rowNumbers = (preview) => preview.rows.map((row) => row.rowNumber);

test('a column suggestion previews every row of its column, not a few rows around the first', () => {
  // Act
  const preview = buildSharePreview(payables, invoiceDate, {}, 4, 'VARIABLE', { display: true, columnRows: 100 });

  // Assert
  assert.deepEqual(rowNumbers(preview), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(preview.rows.at(-2).cells[2].value, '2026-09-30');
  assert.equal(preview.rows.at(-1).cells[0].value, 'TOTAL');
  assert.equal(preview.moreRows, 0);
});

test('a column longer than the preview allows says how many rows it left out', () => {
  // Act
  const preview = buildSharePreview(payables, invoiceDate, {}, 4, 'VARIABLE', { display: true, columnRows: 3 });

  // Assert
  assert.deepEqual(rowNumbers(preview), [1, 2, 3, 4]);
  assert.equal(preview.moreRows, 4);
});

test('a shared column keeps its few rows of context and reports no row count', () => {
  // Act
  const shared = buildSharePreview(payables, invoiceDate, {});
  const cell = buildSharePreview(payables, { kind: 'table-cell', rowIndex: 6, columnIndex: 2 }, {}, 4, 'DATASET_VALUE',
    { display: true, columnRows: 100 });

  // Assert
  assert.deepEqual(rowNumbers(shared), [2, 3, 4]);
  assert.equal('moreRows' in shared, false);
  assert.equal('moreRows' in cell, false, 'a cited cell keeps the rows around it');
});

test('a column window stays inside its Excel table', () => {
  // Arrange
  const table = {
    rows: [['Label', 'Total'], ['Rent', 10], ['Power', 20], ['Water', 30], ['Other table', 'x']],
    rowNumbers: [1, 2, 3, 4, 5],
    tables: [{ firstRow: 1, lastRow: 4, firstColumn: 0, lastColumn: 1, headerRowCount: 1, headers: ['Label', 'Total'] }],
  };
  const column = { kind: 'table-column', column: 'Total', columnIndex: 1 };

  // Act
  const whole = tableContext(table, column, 4, 0, { columnRows: 100 });
  const capped = tableContext(table, column, 4, 0, { columnRows: 2 });

  // Assert
  assert.deepEqual(rowNumbers(whole), [2, 3, 4]);
  assert.equal(whole.moreRows, 0);
  assert.deepEqual(rowNumbers(capped), [2, 3]);
  assert.equal(capped.moreRows, 1);
});

test('the suggestion card preview of a column name lists the whole column', async (t) => {
  // Arrange
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-column-preview-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Accounts-Payable.csv'), PAYABLES);
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const variable = app.db.prepare(`SELECT v.id AS versionId, v.object_id AS objectId
    FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id
    WHERE o.project_id=? AND o.object_type='VARIABLE' AND v.label='Invoice Date'`).get(project.id);

  // Act
  const response = await fetch(`${base}/api/dependency-objects/${variable.objectId}/preview?version=${variable.versionId}`);
  const { preview } = await response.json();

  // Assert
  assert.equal(response.status, 200);
  assert.deepEqual(rowNumbers(preview), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(preview.moreRows, 0);
  assert.equal(preview.location, 'C1 (column header)');
});
