import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { detectClaimSpans } from '../src/dependencies/claim-detection.js';

const actor = { id: 'human:identifier-test', displayName: 'Identifier test', actorType: 'HUMAN_SELF' };

// The invoice number sits in the second column: the row is named by its supplier.
const PAYABLES_CSV = `Supplier,Invoice,Due Date,Outstanding CAD,Status
Maple Paper Distribution,BILL-1160,2026-09-17,22000,Overdue
Harbour Office Furniture,BILL-1174,2026-10-12,18400,Due within seven days
`;

// "INV" begins the Invoice column's name as well as the ledger's references.
const LEDGER_CSV = `Date,Account,Reference,Amount CAD
2026-09-30,Accounts payable,INV-0921,1200
2026-09-30,Office supplies,INV-0934,640
`;

// Accounts are named by their code; the account name is a cell beside it.
const TRIAL_BALANCE_CSV = `Account Code,Account,Debit CAD,Credit CAD
2000,Accounts payable,0,61400
2200,Income tax payable,0,14500
6500,Office supplies,1250,0
`;

const STATEMENT_CSV = `Account,September Actual CAD,Classification
Revenue,485000,Income
Cost of goods sold,292000,Expense
Gross profit,193000,Subtotal
`;

const JOURNAL_CSV = `Journal ID,Reference,Description
JE-0905,PAYROLL-SEP,September payroll accrual
JE-0906,FA-SEP,Monthly depreciation
`;

async function payables(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-identifiers-'));
  const root = path.join(sandbox, 'Accountant');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Accounts-Payable.csv'), PAYABLES_CSV);
  fs.writeFileSync(path.join(root, 'General-Ledger.csv'), LEDGER_CSV);
  fs.writeFileSync(path.join(root, 'Trial-Balance.csv'), TRIAL_BALANCE_CSV);
  fs.writeFileSync(path.join(root, 'Income-Statement.csv'), STATEMENT_CSV);
  fs.writeFileSync(path.join(root, 'Journal.csv'), JOURNAL_CSV);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

/** What Tab would write for each suggestion offered for an identifier. */
async function written(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return prediction.claims.flatMap((claim) => claim.candidates.map((candidate) => candidate.completionText ?? candidate.label));
}

test('an identifier in a column other than the first is offered when typed in full', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const offered = await written(app, 'BILL-1160');

  // Assert
  assert.deepEqual(offered, ['BILL-1160']);
});

test('an identifier typed in lower or mixed case is found as it is in capitals', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const lower = await written(app, 'bill-1160');
  const mixed = await written(app, 'Paid Bill-1160');

  // Assert
  assert.deepEqual(lower, ['BILL-1160']);
  assert.deepEqual(mixed, ['BILL-1160']);
});

test('a begun identifier offers each one it begins and no other', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const both = await written(app, 'BILL-11');
  const one = await written(app, 'bill-117');

  // Assert
  assert.deepEqual([...both].sort(), ['BILL-1160', 'BILL-1174']);
  assert.deepEqual(one, ['BILL-1174']);
});

test('an identifier whose letters begin a column name is offered, not the column', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const whole = await written(app, 'INV-0921');
  const lower = await written(app, 'inv-0921');
  const begun = await written(app, 'inv-09');

  // Assert
  assert.deepEqual(whole, ['INV-0921']);
  assert.deepEqual(lower, ['INV-0921']);
  assert.deepEqual([...begun].sort(), ['INV-0921', 'INV-0934']);
});

test('a column whose examples list the identifier is not offered for it', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const offered = await written(app, 'BILL-1174');

  // Assert
  assert.ok(!offered.includes('Invoice'), JSON.stringify(offered));
});

/** What Tab would write for every suggestion of any kind, and the typed span it rewrites. */
async function rewrites(app, text) {
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  return [
    ...prediction.claims.flatMap((claim) => claim.candidates.map((candidate) => ({
      writes: candidate.completionText ?? candidate.label, over: text.slice(claim.start, claim.end) }))),
    ...prediction.workspaceCompletions.map((item) => ({
      writes: item.replacementText, over: text.slice(item.claimStart, item.claimEnd) })),
  ];
}

test('a supplier whose name holds "paper" is offered when typed in lower case', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const whole = await rewrites(app, 'maple paper distribution');
  const begun = await rewrites(app, 'We paid maple paper dis');

  // Assert
  assert.deepEqual(whole[0], { writes: 'Maple Paper Distribution', over: 'maple paper distribution' });
  assert.deepEqual(begun[0], { writes: 'Maple Paper Distribution', over: 'maple paper dis' });
});

test('a text cell typed in full is written over as the cell holds it', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const inSentence = await rewrites(app, 'The bill is due within seven days');
  const alone = await rewrites(app, 'due within seven days');

  // Assert
  assert.ok(inSentence.some((item) => item.writes === 'Due within seven days' && item.over === 'due within seven days'),
    JSON.stringify(inSentence));
  assert.deepEqual(alone[0], { writes: 'Due within seven days', over: 'due within seven days' });
});

test('an account name beside its code is offered over a shorter name it ends with', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const whole = await rewrites(app, 'Income tax payable');
  const begun = await rewrites(app, 'We owe income tax pay');

  // Assert
  assert.deepEqual(whole[0], { writes: 'Income tax payable', over: 'Income tax payable' });
  assert.deepEqual(begun[0], { writes: 'Income tax payable', over: 'income tax pay' });
});

test('a one-word value typed whole is offered, though it is an everyday word', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const overdue = await rewrites(app, 'overdue');
  const subtotal = await rewrites(app, 'The line is a Subtotal');
  const begun = await rewrites(app, 'overd');

  // Assert
  assert.deepEqual(overdue[0], { writes: 'Overdue', over: 'overdue' });
  assert.deepEqual(subtotal[0], { writes: 'Subtotal', over: 'Subtotal' });
  assert.ok(!begun.some((item) => item.writes === 'Overdue'), 'a begun everyday word is not yet a value');
});

test('an identifier ending in letters is offered in any case', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const upper = await rewrites(app, 'PAYROLL-SEP');
  const lower = await rewrites(app, 'payroll-sep');
  const short = await rewrites(app, 'Posted as FA-SEP');

  // Assert
  assert.deepEqual(upper[0], { writes: 'PAYROLL-SEP', over: 'PAYROLL-SEP' });
  assert.deepEqual(lower[0], { writes: 'PAYROLL-SEP', over: 'payroll-sep' });
  assert.deepEqual(short[0], { writes: 'FA-SEP', over: 'FA-SEP' });
});

/** A matter's follow-ups beside a clause review named by the matter. */
async function matters(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-matters-'));
  const root = path.join(sandbox, 'Legal');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Matter-Followups.csv'), `Matter ID,Action ID,Action,Due date,Status
LC-26-008,L-003,Collect insurance certificate,2026-10-22,Open
LC-26-008,L-004,File executed agreement,2026-10-16,Complete
LC-26-009,L-005,Review sample supplier terms,2026-10-29,Open
`);
  fs.writeFileSync(path.join(root, 'Clause-Review-LC-26-008.txt'), 'Matter LC-26-008 clause review. The executed agreement was filed on 2026-10-16.\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

test('an identifier with one letter before its number is offered in any case', async (t) => {
  // Arrange
  const app = await matters(t);

  // Act
  const upper = await rewrites(app, 'L-004');
  const lower = await rewrites(app, 'Action l-004');

  // Assert
  assert.deepEqual(upper[0], { writes: 'L-004', over: 'L-004' });
  assert.deepEqual(lower[0], { writes: 'L-004', over: 'l-004' });
  assert.ok(!upper.some((item) => /·/.test(item.writes)), 'the row\'s other cells are not written as their labels');
});

test('an identifier typed in full is offered before a file it names', async (t) => {
  // Arrange
  const app = await matters(t);

  // Act
  const upper = await rewrites(app, 'LC-26-008');
  const lower = await rewrites(app, 'lc-26-008');

  // Assert
  assert.deepEqual(upper[0], { writes: 'LC-26-008', over: 'LC-26-008' });
  assert.deepEqual(lower[0], { writes: 'LC-26-008', over: 'lc-26-008' });
  assert.ok(upper.some((item) => /Clause-Review/.test(item.writes)), 'the file it names is still offered');
});

test('an identifier held in a row named by another identifier is offered', async (t) => {
  // Arrange
  const app = await matters(t);

  // Act
  const offered = await rewrites(app, 'lc-26-009');

  // Assert
  assert.deepEqual(offered[0], { writes: 'LC-26-009', over: 'lc-26-009' });
});

test('a value beginning with "file" is that value, not a request for a file', async (t) => {
  // Arrange
  const app = await matters(t);

  // Act
  const typed = await rewrites(app, 'Next step: file executed agreement');

  // Assert
  assert.deepEqual(typed[0], { writes: 'File executed agreement', over: 'file executed agreement' });
});

test('a paper cited by its title is still read as a citation', async (t) => {
  // Arrange
  const app = await payables(t);

  // Act
  const offered = await rewrites(app, 'the paper distribution of');

  // Assert
  assert.ok(!offered.some((item) => item.writes === 'Maple Paper Distribution'), JSON.stringify(offered));
});

test('plain words are not read as identifiers in any case', () => {
  // Arrange
  const texts = ['bill', 'the bill was paid', 'Bill', 'hello there'];

  // Act
  const entities = texts.flatMap((text) => detectClaimSpans(text).filter((claim) => claim.type === 'ENTITY' && !claim.partial));

  // Assert
  assert.deepEqual(entities, []);
});
