import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { bulletDeck } from './fixtures/presentations.js';
import { workbook } from './fixtures/workbook.js';

const actor = { id: 'human:percent-writer', displayName: 'Percent writer', actorType: 'HUMAN_SELF' };
const PRICING = 'Fuel surcharge rises from 6% to 7.5% on 1 October';

// A house model whose lintel is 0.06 m deep, in metres as the model declares.
const HOUSE = `ISO-10303-21;
HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCPROJECT('project',$,'FZK-Haus',$,$,$,$,$,#2);
#4=IFCDOOR('door-guid',$,'Haustuer',$,$,$,$,$,$,$,$,$,$);
#5=IFCPROPERTYSINGLEVALUE('Breite_Sturz_aussen',$,IFCLENGTHMEASURE(0.06),$);
#6=IFCPROPERTYSET('pset-guid',$,'ArchiCADProperties',$,(#5));
#7=IFCRELDEFINESBYPROPERTIES('relation',$,$,$,(#4),#6);
ENDSEC;END-ISO-10303-21;`;

// Six reconciled items, so the sheet's row count reads "n = 6".
const RECONCILIATION = {
  1: ['Date', 'Description', 'Amount'],
  2: ['2026-09-02', 'Deposit in transit', '1250.4'],
  3: ['2026-09-05', 'Outstanding cheque 1041', '-310.25'],
  4: ['2026-09-11', 'Bank service charge', '-18.5'],
  5: ['2026-09-17', 'Interest earned', '4.12'],
  6: ['2026-09-23', 'Outstanding cheque 1048', '-722.9'],
  7: ['2026-09-29', 'Deposit in transit', '980.75'],
};

// Three work directories as a writer adds them: a team's decks, a month-end
// close and a house model. The deck and the close each also hold a real 6%.
async function threeDirectories(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-percent-values-'));
  const roots = ['tidewater', 'Accountant', 'Architecture-Residential'].map((name) => path.join(sandbox, name));
  const [decks, close, house] = roots;
  for (const root of roots) fs.mkdirSync(root);
  fs.writeFileSync(path.join(decks, 'Q3-Sprint-Review.pptx'), bulletDeck([
    { title: 'Pricing change', lines: [PRICING, 'Base fee stays at $4.50 plus $1.20 per kilogram'] },
  ]));
  fs.writeFileSync(path.join(decks, 'Surcharge-History.csv'), 'Month,Fuel surcharge\nJuly,6%\nAugust,6%\nSeptember,6%\n');
  fs.writeFileSync(path.join(close, 'Accounting-Close.xlsx'), workbook('Bank Reconciliation', RECONCILIATION));
  fs.writeFileSync(path.join(close, 'Carrier-Rates.csv'), 'Carrier,Fuel surcharge\nNorthline,6%\nHarbor Freight,6%\n');
  fs.writeFileSync(path.join(house, 'AC20-FZK-Haus.ifc'), HOUSE);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add(roots.map((root) => fs.realpathSync(root)), actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return app;
}

const typed = (app, text) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
const offeredValues = (prediction) => prediction.claims.flatMap((claim) => claim.candidates
  .map((candidate) => `${candidate.valueText} (${candidate.path})`));
const indexed = (app, valueText) => app.workspace.state().directories
  .flatMap((directory) => app.dependencies.objectsAt(directory.id)).some((object) => object.valueText === valueText);

test('a percent never matches a length in metres or a row count', async (t) => {
  // Arrange
  const app = await threeDirectories(t);
  assert.ok(indexed(app, '0.06 m'), 'the house model holds the 0.06 m lintel');
  assert.ok(indexed(app, 'n = 6'), 'the close holds the six reconciled rows');

  // Act
  const prediction = await typed(app, 'Fuel surcharge rises from 6%');

  // Assert
  const values = offeredValues(prediction);
  assert.ok(values.includes('6% (Carrier-Rates.csv)'), values.join(', '));
  assert.deepEqual(values.filter((value) => /^(?:0\.06 m|n = 6) /.test(value)), []);
});

test('a row count still matches a count written as one', async (t) => {
  // Arrange
  const app = await threeDirectories(t);

  // Act
  const prediction = await typed(app, 'The bank reconciliation included n = 6');

  // Assert
  assert.ok(offeredValues(prediction).includes('n = 6 (Accounting-Close.xlsx)'), offeredValues(prediction).join(', '));
});

test('a value written before the words at the caret does not hide the sentence completion', async (t) => {
  // Arrange
  const app = await threeDirectories(t);

  // Act
  const prediction = await typed(app, 'Fuel surcharge rises from 6% to');

  // Assert
  assert.equal(prediction.completion?.insertText, ' 7.5% on 1 October');
  assert.equal(prediction.completion.dependencyCandidate.path, 'Q3-Sprint-Review.pptx');
  assert.deepEqual(offeredValues(prediction), [], 'the 6% already written is not the value being typed');
});
