// A data dictionary's units for a row ("Revenue is in CAD") belong to that
// row's amounts, not to its percentages, ratios or counts beside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:units-writer', displayName: 'Units writer', actorType: 'HUMAN_SELF' };

const DICTIONARY = `Variable,Description,Units
Revenue,Sales revenue recorded during September,CAD
Rent,Office rent for September,CAD
Closing Cash CAD,Cash after receipts and payments,CAD
`;
const BUDGET = `Account,Actual CAD,Variance %,Variance Share,Invoice Count
Revenue,485000,-3.0%,-0.03,41
Rent,18000,0.0%,0,1
`;
const CASH = `Month,Closing Cash CAD
October,175400
`;

async function finance(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-row-units-'));
  const root = path.join(sandbox, 'Finance');
  fs.mkdirSync(root);
  for (const [file, text] of Object.entries({ 'Data-Dictionary.csv': DICTIONARY, 'Budget.csv': BUDGET, 'Cash.csv': CASH })) {
    fs.writeFileSync(path.join(root, file), text);
  }
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

// fn+Right on a column, as the card sends it, and the values it lists.
async function columnValues(app, text, label) {
  const claim = (await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 })).claims
    .find(item => item.candidates.some(candidate => candidate.label === label));
  assert.ok(claim, `${text} suggests ${label}`);
  const column = claim.candidates.find(candidate => candidate.label === label);
  const focusSource = { projectId: column.projectId, sourceObjectId: column.id, sourceSnapshotId: column.snapshotId,
    start: claim.start, end: claim.end };
  const values = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0, focusSource });
  return values.workspaceCompletions.map(item => item.replacementText);
}

test('a row\'s amounts take its dictionary units, and its percentages, shares and counts keep their own', async t => {
  // Arrange
  const app = await finance(t);

  // Act
  const amounts = await columnValues(app, 'the actual ca', 'Actual CAD');
  const percents = await columnValues(app, 'the variance %', 'Variance %');
  const shares = await columnValues(app, 'the variance share', 'Variance Share');
  const counts = await columnValues(app, 'the invoice count', 'Invoice Count');

  // Assert
  assert.deepEqual(amounts, ['485000 CAD', '18000 CAD']);
  assert.deepEqual(percents, ['-3.0%', '0.0%']);
  assert.deepEqual(shares, ['-0.03', '0']);
  assert.deepEqual(counts, ['41', '1']);
});

test('a column the dictionary names takes its units in every row', async t => {
  // Arrange
  const app = await finance(t);

  // Act
  const closing = await columnValues(app, 'the closing cash', 'Closing Cash CAD');

  // Assert
  assert.deepEqual(closing, ['175400 CAD']);
});
