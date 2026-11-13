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
      + 'People,74000,76000\nFacilities,21000,21100\nTechnology,6000,6500\nSecurity,9000,9000\n',
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

test('the first word of a document suggests a source after three letters', async (t) => {
  const app = await fixture(t);
  for (const [typed, expected] of [['Rev', 'Revenue'], ['Gro', 'Gross profit'], ['Sal', 'Salaries and wages'],
    ['Mar', 'Marketing'], ['Cost of goo', 'Cost of goods sold']]) {
    assert.equal((await labels(app, typed))[0], expected, typed);
  }
  // Two letters begin too many everyday words ("Re" of "Really") to name a source.
  assert.deepEqual(await labels(app, 'Re'), []);
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
  assert.deepEqual(await labels(app, 'Cos'), ['Cost of goods sold']);
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

test('a cell tabbed after its row and column ends the source focus', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Fac');
  const columns = await predict(app, `${accepted} for the `, { pendingDependencies });
  const column = columns.workspaceCompletions.find((item) => item.replacementText === 'September Budget CAD');
  const named = `${accepted} for the ${column.replacementText}`;
  const link = (item, text) => ({ projectId: item.projectId, blockIndex: 0, start: item.claimStart, end: text.length,
    sourceObjectId: item.dependencyCandidate.id, sourceSnapshotId: item.dependencyCandidate.snapshotId });
  const links = [...pendingDependencies, link(column, named)];
  const cell = (await predict(app, `${named} was `, { pendingDependencies: links })).workspaceCompletions[0];
  assert.equal(cell.replacementText, '21000');
  const text = `${named} was ${cell.replacementText}`;
  const after = [...links, link(cell, text)];
  // The cell is the end of Facilities: its column's other cells are not offered next.
  for (const tail of ['', ' ', ' and ']) {
    const prediction = await predict(app, `${text}${tail}`, { pendingDependencies: after });
    assert.equal(prediction.workspaceHeading, undefined, JSON.stringify(tail));
    assert.deepEqual(prediction.workspaceCompletions, [], JSON.stringify(tail));
  }
  // Any source can follow, joined or not.
  assert.equal((await labels(app, `${text} with Mark`, { pendingDependencies: after }))[0], 'Marketing');
  // Text in a classification column is a value too ("Income").
  const revenue = await accept(app, 'Reven');
  const kinds = await predict(app, `${revenue.accepted} is classed as `, { pendingDependencies: revenue.pendingDependencies });
  const kind = kinds.workspaceCompletions.find((item) => item.replacementText === 'Income');
  assert.ok(kind, kinds.workspaceCompletions.map((item) => item.replacementText).join(' | '));
  const classed = `${revenue.accepted} is classed as Income`;
  const released = await predict(app, `${classed} `, { pendingDependencies: [...revenue.pendingDependencies, link(kind, classed)] });
  assert.equal(released.workspaceHeading, undefined);
});

test('every cell of an accepted row is listed, equal values included, so the arrows reach each one', async (t) => {
  const app = await fixture(t);
  const { accepted, pendingDependencies } = await accept(app, 'Secur');
  assert.equal(accepted, 'Security');
  const values = await completions(app, `${accepted} was `, pendingDependencies);
  assert.equal(values.heading, 'Values for Security');
  // Its budget and actual are both 9000: two cells, two places in the list.
  assert.deepEqual(values.items, ['9000', '9000']);
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

test('typing the first digits of a value after an accepted source completes that value', async (t) => {
  const app = await fixture(t);
  // A variable, a column and a named row: "was 48" is the value being typed, not a row such as "CON4".
  // The digits pick out the value they begin (6500, not 21100 or 76000), and "budget" its column.
  for (const [typed, tail, digits, expected] of [['Reven', ' was ', '48', '485000 CAD'],
    ['September Act', ' was ', '2', '21100'], ['September Act', ' was ', '65', '6500'],
    ['Fac', ' budget was ', '21', '21000']]) {
    const { accepted, pendingDependencies } = await accept(app, typed);
    const text = `${accepted}${tail}${digits}`;
    const prediction = await predict(app, text, { pendingDependencies });
    assert.equal(prediction.workspaceHeading, `Values for ${accepted}`, text);
    const [first] = prediction.workspaceCompletions;
    assert.equal(first?.replacementText, expected, text);
    // Tab replaces the typed digits rather than appending after them.
    assert.deepEqual([first.claimStart, first.claimEnd], [text.length - digits.length, text.length], text);
  }
});

// Accepts one particular indexed source, as Tab does when the card offers it.
function linkTo(app, file, label, accepted) {
  const projectId = app.workspace.state().activeProjectIds[0];
  const source = app.dependencies.objectsAt(projectId).find((object) => object.path === file && object.label === label);
  const start = accepted.length - label.length;
  return [{ projectId, blockIndex: 0, start, end: accepted.length, sourceObjectId: source.id, sourceSnapshotId: source.snapshotId }];
}

test('an accepted column of a table keyed by row names offers the cells of that column', async (t) => {
  const app = await fixture(t);
  // Income-Statement.csv keys its rows by account, so each cell is stored under its row's name.
  const accepted = 'September Actual CAD';
  const pendingDependencies = linkTo(app, 'Income-Statement.csv', accepted, accepted);
  const values = (await completions(app, `${accepted} was `, pendingDependencies)).items;
  // The statement's own cells come first.
  for (const amount of ['485000', '193000', '14000']) {
    assert.ok(values.slice(0, 5).some((value) => value.split(' ')[0] === amount), values.join(' | '));
  }
  // A text column offers its words: the account classifications.
  const classes = (await completions(app, 'Classification is ', linkTo(app, 'Income-Statement.csv', 'Classification', 'Classification'))).items;
  for (const value of ['Income', 'Expense']) assert.ok(classes.includes(value), classes.join(' | '));
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
