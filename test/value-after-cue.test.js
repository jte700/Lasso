import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { detectClaimSpans } from '../src/dependencies/claim-detection.js';
import { writingSourceContext } from '../src/dependencies/writing-context.js';
import { workbook } from './fixtures/workbook.js';

const actor = { id: 'human:value-cue-writer', displayName: 'Value cue writer', actorType: 'HUMAN_SELF' };

// A month-end close as an accountant keeps it: the reconciliation as a CSV
// and again in the close workbook, beside the payables.
const RECONCILIATION_CSV = `Reconciliation Item,Amount CAD,Explanation
Bank statement closing balance,134900,2026-09-30 statement
Deposit in transit,7800,Customer receipt recorded September 30; cleared October 2
Outstanding supplier payments,-17300,Payments issued September 29; cleared October 3
Adjusted bank balance,125400,Statement balance plus deposit less outstanding payments
Cash per trial balance,125400,Account 1000
Unreconciled difference,0,Adjusted bank balance less cash per trial balance
`;
const RECONCILIATION_SHEET = {
  1: ['Reconciliation item', 'Amount', 'Explanation'],
  2: ['Bank statement closing balance', '134900', '2026-09-30 statement'],
  3: ['Deposit in transit', '7800', 'Customer receipt recorded September 30; cleared October 2'],
  4: ['Outstanding supplier payments', '-17300', 'Payments issued September 29; cleared October 3'],
  5: ['Adjusted bank balance', '125400', 'Statement balance plus deposit less outstanding payments'],
};
const PAYABLES_CSV = `Supplier,Invoice,Due Date,Outstanding CAD,Status as of 2026-10-11
Maple Paper Distribution,BILL-1160,2026-09-17,22000,Overdue
Harbour Office Furniture,BILL-1174,2026-10-12,18400,Due within seven days
TOTAL,,,40400,Agrees with trial balance
`;
// A finance folder that defines its terms beside the figures.
const DICTIONARY_CSV = `Variable,Description,Units
Revenue,Sales revenue recorded during September 2026 before expenses,CAD
Gross profit,Revenue less cost of goods sold for September 2026,CAD
`;
const BUDGET_CSV = `Account,September Budget CAD,September Actual CAD,Actual Minus Budget CAD,Department
Revenue,500000,485000,-15000,Sales
Gross profit,205000,193000,-12000,Finance
`;

async function closeFolders(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-value-cue-'));
  const accountant = path.join(sandbox, 'Accountant');
  const finance = path.join(sandbox, 'Finance');
  for (const root of [accountant, finance]) fs.mkdirSync(root);
  fs.writeFileSync(path.join(accountant, 'Bank-Reconciliation.csv'), RECONCILIATION_CSV);
  fs.writeFileSync(path.join(accountant, 'Accounting-Close.xlsx'), workbook('Bank Reconciliation', RECONCILIATION_SHEET));
  fs.writeFileSync(path.join(accountant, 'Accounts-Payable.csv'), PAYABLES_CSV);
  fs.writeFileSync(path.join(finance, 'Data-Dictionary.csv'), DICTIONARY_CSV);
  fs.writeFileSync(path.join(finance, 'Budget-vs-Actual.csv'), BUDGET_CSV);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([accountant, finance].map((root) => fs.realpathSync(root)), actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
const first = (prediction) => prediction.workspaceCompletions[0];
const firstValue = (prediction) => first(prediction)?.dependencyCandidate?.valueText;

test('a row named before "was" offers its value before any column name', async (t) => {
  // Arrange
  const app = await closeFolders(t);

  // Act
  const deposit = await typed(app, 'The deposit in transit was ');
  const adjusted = await typed(app, 'The adjusted bank balance is ');

  // Assert
  assert.equal(firstValue(deposit), '7800', JSON.stringify(deposit.workspaceCompletions.map((item) => item.replacementText)));
  assert.equal(firstValue(adjusted), '125400', JSON.stringify(adjusted.workspaceCompletions.map((item) => item.replacementText)));
});

test('a figure named before "was" beats the dictionary entry that defines it', async (t) => {
  // Arrange
  const app = await closeFolders(t);

  // Act
  const prediction = await typed(app, 'Revenue for September was ');

  // Assert
  assert.equal(firstValue(prediction), '485000', JSON.stringify(prediction.workspaceCompletions.map((item) => item.replacementText)));
});

test('Tab after "was" writes only the value, at the caret', async (t) => {
  // Arrange
  const app = await closeFolders(t);
  const text = 'The deposit in transit was ';

  // Act
  const suggestion = first(await typed(app, text));

  // Assert
  assert.equal(suggestion.replacementText, '7800');
  assert.equal(suggestion.claimStart, text.length);
  assert.equal(suggestion.claimEnd, text.length);
});

test('a value begun after "was" is the row\'s value, not a column', async (t) => {
  // Arrange
  const app = await closeFolders(t);

  // Act
  const prediction = await typed(app, 'Gross profit was 1');

  // Assert
  const offered = prediction.claims.flatMap((claim) => claim.candidates.map((candidate) => candidate.valueText));
  assert.equal(offered[0], '193000', JSON.stringify(offered));
});

test('a supplier whose name holds "Paper" is a company, not a citation', async (t) => {
  // Arrange
  const app = await closeFolders(t);

  // Act
  const owed = await typed(app, 'Maple Paper Distribution is owed ');
  const citing = 'The paper by Okafor et al';

  // Assert
  assert.equal(firstValue(owed), '22000', JSON.stringify(owed.workspaceCompletions.map((item) => item.replacementText)));
  assert.equal(writingSourceContext(citing, citing.length).literatureIntent, true, 'a real citation is still read as one');
  assert.ok(detectClaimSpans(citing).some((claim) => claim.type === 'LITERATURE'));
  assert.equal(detectClaimSpans('Maple Paper Distribution is owed ').some((claim) => claim.type === 'LITERATURE'), false);
});
