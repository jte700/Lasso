import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { drawingReferenceMatch } from '../src/dependencies/drawing-discovery.js';

const actor = { id: 'human:trigger-test', displayName: 'Trigger test', actorType: 'HUMAN_SELF' };

async function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-triggers-'));
  const root = path.join(temporary, 'Finance');
  fs.mkdirSync(root);
  const files = {
    'Income-Statement.csv': 'Account,September Actual CAD,Classification\nRevenue,485000,Income\n'
      + 'Gross profit,193000,Subtotal\nSalaries and wages,76000,Expense\nMarketing,14000,Expense\n'
      + 'Cost of goods sold,292000,Expense\n',
    'Department-Budget.csv': 'Department,September Budget CAD,September Actual CAD\n'
      + 'People,74000,76000\nFacilities,21000,21100\nTechnology,6000,6500\n',
    'Accounts-Payable.csv': 'Supplier,Invoice,Outstanding CAD\nMaple Paper Distribution,BILL-1160,22000\n'
      + 'Harbour Office Furniture,BILL-1174,18400\n',
    'Change-Register.csv': 'Change ID,Description,Amount CAD\nCO-001,Roof curb repair,4800\nCO-002,Additional bollards,2200\n',
    'Data-Dictionary.csv': 'Variable,Description,Units\nRevenue,Sales revenue recorded during September,CAD\n',
  };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(root)], actor);
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return app;
}

const predict = (app, text, extra = {}) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, ...extra });
const labels = async (app, text, extra) => (await predict(app, text, extra)).claims
  .flatMap((claim) => claim.candidates.map((candidate) => candidate.completionText ?? candidate.label));

async function accept(app, text) {
  const claim = (await predict(app, text)).claims.find((item) => item.candidates.length);
  const source = claim.candidates[0];
  const accepted = `${text.slice(0, claim.start)}${source.completionText}`;
  const link = {
    projectId: source.projectId, blockIndex: 0, start: claim.start, end: accepted.length,
    sourceObjectId: source.id, sourceSnapshotId: source.snapshotId,
  };
  return { accepted, pendingDependencies: [link] };
}

test('the first word of a document suggests a source after two letters', async (t) => {
  const app = await fixture(t);
  for (const [typed, expected] of [['Re', 'Revenue'], ['Gro', 'Gross profit'], ['Sal', 'Salaries and wages'],
    ['Mar', 'Marketing'], ['Cost of goo', 'Cost of goods sold']]) {
    assert.equal((await labels(app, typed))[0], expected, typed);
  }
});

test('a new sentence starts a fresh suggestion even right after an accepted source', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Reven');
  assert.equal(accepted, 'Revenue');
  // Inside the same sentence, the accepted source still offers its values.
  const values = await predict(app, `${accepted} was `, { pendingDependencies });
  assert.equal(values.workspaceHeading, 'Values for Revenue');
  for (const next of [' was high. Gross pr', ' was high.\nGross pr', ' was high! Gross pr', ' was high? Gross pr',
    ' was 485000 CAD. Gross pr', ' was 485000.\nGross pr', ' was “high.” Gross pr', ' was 485000 and gross pr']) {
    const text = `${accepted}${next}`;
    const prediction = await predict(app, text, { pendingDependencies });
    assert.equal(prediction.workspaceHeading, undefined, JSON.stringify(text));
    assert.equal(prediction.claims[0]?.candidates[0]?.completionText, 'Gross profit', JSON.stringify(text));
  }
});

test('a second source named after "and" replaces the accepted source context', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Reven');
  assert.equal((await labels(app, `${accepted} and gross pr`, { pendingDependencies }))[0], 'Gross profit');
  // Decimal points and abbreviations do not end the sentence.
  for (const tail of [' was 4.8', ' vs. ', ', e.g. ', ' was approx. ']) {
    const prediction = await predict(app, `${accepted}${tail}`, { pendingDependencies });
    assert.equal(prediction.workspaceHeading, 'Values for Revenue', JSON.stringify(tail));
  }
});

test('values for an accepted variable leave out its data dictionary description and units', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Reven');
  const values = (await predict(app, `${accepted} was `, { pendingDependencies })).workspaceCompletions
    .map((item) => item.replacementText);
  assert.ok(values.includes('485000 CAD'), values.join(' | '));
  assert.ok(!values.includes('CAD'), values.join(' | '));
  assert.ok(!values.some((value) => value.startsWith('Sales revenue')), values.join(' | '));
  // Units belong to amounts, not to words such as a classification.
  assert.ok(!values.includes('Income CAD'), values.join(' | '));
});

test('named rows such as departments and suppliers are suggested by their names', async (t) => {
  const app = await fixture(t);
  assert.equal((await labels(app, 'Fac'))[0], 'Facilities');
  assert.equal((await labels(app, 'We paid Harbour Off'))[0], 'Harbour Office Furniture');
  assert.equal((await labels(app, 'Maple Pa'))[0], 'Maple Paper Distribution');
  // Rows keyed by an identifier column ("Change ID") are codes, not names.
  assert.deepEqual(await labels(app, 'Co'), ['Cost of goods sold']);
});

const completions = async (app, text, pendingDependencies) => {
  const prediction = await predict(app, text, { pendingDependencies });
  return { heading: prediction.workspaceHeading, items: prediction.workspaceCompletions.map((item) => item.replacementText) };
};

test('an accepted named row offers its columns and then its own values', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Fac');
  assert.equal(accepted, 'Facilities');
  const columns = await completions(app, `${accepted} for the `, pendingDependencies);
  assert.equal(columns.heading, 'Columns for Facilities');
  assert.deepEqual(columns.items, ['September Budget CAD', 'September Actual CAD']);
  assert.equal((await completions(app, `${accepted} in Septem`, pendingDependencies)).heading, 'Columns for Facilities');
  // A value cue lists that row's values, not other departments' (74000, 6000...).
  const values = await completions(app, `${accepted} budget was `, pendingDependencies);
  assert.equal(values.heading, 'Values for Facilities');
  assert.deepEqual([...values.items].sort(), ['21000', '21100']);
  // Naming a column narrows to that one cell.
  const cell = await completions(app, `${accepted} September Budget CAD was `, pendingDependencies);
  assert.equal(cell.heading, 'Value for Facilities · September Budget CAD');
  assert.deepEqual(cell.items, ['21000']);
});

test('an accepted supplier row offers its invoice and outstanding amount', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'We paid Harbour Off');
  assert.equal(accepted, 'We paid Harbour Office Furniture');
  const columns = await completions(app, `${accepted} for `, pendingDependencies);
  assert.equal(columns.heading, 'Columns for Harbour Office Furniture');
  assert.deepEqual([...columns.items].sort(), ['Invoice', 'Outstanding CAD']);
  const values = await completions(app, `${accepted} Outstanding CAD of `, pendingDependencies);
  assert.deepEqual(values.items, ['18400']);
});

test('an accepted variable row keeps offering its values across the table', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Reven');
  const columns = await completions(app, `${accepted} for the `, pendingDependencies);
  assert.equal(columns.heading, 'Columns for Revenue');
  const values = await completions(app, `${accepted} was `, pendingDependencies);
  assert.equal(values.heading, 'Values for Revenue');
  assert.ok(values.items.includes('485000 CAD'), values.items.join(' | '));
});

test('a partial word inside a drawing name does not claim the typed word', () => {
  const drawing = { id: 'drawing', objectType: 'DRAWING', label: 'Cedar Lane Floor Plan Rev03',
    path: 'Cedar-Lane-Floor-Plan-Rev03.dxf', anchor: { kind: 'cad-model' },
    metadata: { format: 'DXF', extractionStatus: 'ready' } };
  assert.equal(drawingReferenceMatch(drawing, 'Rev'), null);
  assert.equal(drawingReferenceMatch(drawing, 'Lan'), null);
  for (const query of ['Ced', 'Cedar', 'Rev03', 'Lane', 'Cedar Lane Fl', 'Floor Plan Rev']) {
    assert.ok(drawingReferenceMatch(drawing, query), query);
  }
});
