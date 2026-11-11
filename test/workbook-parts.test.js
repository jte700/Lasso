// A workbook is a zip of parts, one per sheet plus parts every sheet reads
// (its shared strings, styles and the workbook itself). Saving one sheet
// changes only that sheet's part, so the others keep the objects they were
// read as, and only the edited sheet is read again.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { storedZip } from './fixtures/workbook.js';
import { sheetSignatures } from '../src/dependencies/workbook-parts.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };

const sheetXml = (rows) => `<worksheet><sheetData>${rows.map((cells, index) => `<row r="${index + 1}">${cells.map((value, column) => {
  const reference = `${String.fromCharCode(65 + column)}${index + 1}`;
  return /^-?\d+(?:\.\d+)?$/.test(value) ? `<c r="${reference}"><v>${value}</v></c>`
    : `<c r="${reference}" t="inlineStr"><is><t>${value}</t></is></c>`;
}).join('')}</row>`).join('')}</sheetData></worksheet>`;

const SHEETS = ['North', 'South', 'West'];
const regionRows = (name, edited = null) => [['Item', 'Q1', 'Q2'],
  ...Array.from({ length: 6 }, (_, index) => [`${name} ${index + 1}`, String(edited === index ? 999 : index * 10), String(index * 20)])];

/** A workbook of three regions; `edits` maps a sheet name to the row it changes. */
function regions(edits = {}, { styles = '<styleSheet/>' } = {}) {
  return storedZip({
    'xl/workbook.xml': `<workbook><sheets>${SHEETS.map((name, index) =>
      `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${SHEETS.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': styles,
    ...Object.fromEntries(SHEETS.map((name, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(regionRows(name, edits[name]))])),
  });
}

async function folder(t) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-workbook-parts-')));
  const root = path.join(sandbox, 'Sales');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'regions.xlsx'), regions());
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const read = [];
  const original = app.dependencies.readWorkbookSheets;
  app.dependencies.readWorkbookSheets = function readSheets(buffer, only) {
    read.push(only ? [...only].sort() : 'all');
    return original.call(this, buffer, only);
  };
  const save = (buffer) => {
    fs.writeFileSync(path.join(root, 'regions.xlsx'), buffer);
    app.timeline.capture(project.id, actor);
    app.dependencies.ensureIndex(project.id);
  };
  const value = (label) => app.dependencies.objectsAt(project.id).find((object) => object.label === label)?.valueText;
  return { app, project, read, save, value };
}

test('Editing one sheet of a workbook re-reads only that sheet', async (t) => {
  // Arrange
  const { read, save, value } = await folder(t);

  // Act
  save(regions({ South: 2 }));

  // Assert
  assert.deepEqual(read, [['South']]);
  assert.equal(value('South 3 · Q1'), '999');
  assert.equal(value('North 3 · Q1'), '20', 'a sheet that did not change keeps its values');
  assert.equal(value('West 6 · Q2'), '100');
});

test('A change to a part every sheet reads re-reads the whole workbook', async (t) => {
  // Arrange
  const { read, save } = await folder(t);

  // Act
  save(regions({ South: 2 }, { styles: '<styleSheet><numFmts count="0"/></styleSheet>' }));

  // Assert
  assert.deepEqual(read, ['all']);
});

test('A sheet whose edit keeps its size and whose checksum is left at zero is still read again', () => {
  // Arrange: the test workbooks, like some writers, leave every checksum at zero.
  const before = sheetSignatures(regions({ North: 1 }));

  // Act
  const after = sheetSignatures(regions({ North: 2 }));

  // Assert
  assert.notEqual(after[0].signature, before[0].signature);
});

test('A sheet keeps its signature until its own part or a shared part changes', () => {
  // Arrange
  const before = sheetSignatures(regions());

  // Act
  const southEdited = sheetSignatures(regions({ South: 1 }));
  const stylesEdited = sheetSignatures(regions({}, { styles: '<styleSheet><fonts/></styleSheet>' }));

  // Assert
  assert.deepEqual(before.map((sheet) => sheet.name), SHEETS);
  assert.equal(southEdited[0].signature, before[0].signature);
  assert.notEqual(southEdited[1].signature, before[1].signature);
  assert.equal(southEdited[2].signature, before[2].signature);
  assert.ok(stylesEdited.every((sheet, index) => sheet.signature !== before[index].signature));
  assert.equal(sheetSignatures(Buffer.from('not a workbook')), null);
});

/** A one-sheet workbook written the way some other tools write it. */
function writtenAs({ prefix = '', quote = '"', name = 'Budget' }) {
  const tag = (element) => (prefix ? `${prefix}:${element}` : element);
  const sheet = `<${tag('worksheet')}><${tag('sheetData')}>`
    + `<${tag('row')} r="1"><${tag('c')} r="A1" t="inlineStr"><${tag('is')}><${tag('t')}>Item</${tag('t')}></${tag('is')}></${tag('c')}><${tag('c')} r="B1" t="inlineStr"><${tag('is')}><${tag('t')}>Cost</${tag('t')}></${tag('is')}></${tag('c')}></${tag('row')}>`
    + `<${tag('row')} r="2"><${tag('c')} r="A2" t="inlineStr"><${tag('is')}><${tag('t')}>Pump</${tag('t')}></${tag('is')}></${tag('c')}><${tag('c')} r="B2"><${tag('v')}>420</${tag('v')}></${tag('c')}></${tag('row')}>`
    + `</${tag('sheetData')}></${tag('worksheet')}>`;
  return storedZip({
    'xl/workbook.xml': `<${tag('workbook')}><${tag('sheets')}><${tag('sheet')} name=${quote}${name}${quote} sheetId=${quote}1${quote} r:id=${quote}rId1${quote}/></${tag('sheets')}></${tag('workbook')}>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id=${quote}rId1${quote} Target=${quote}worksheets/sheet1.xml${quote}/></Relationships>`,
    'xl/worksheets/sheet1.xml': sheet,
  });
}

test('A workbook keeps its objects when its sheet name has an entity or its tags are prefixed or single-quoted', async (t) => {
  // Arrange
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-workbook-names-')));
  const root = path.join(sandbox, 'Books');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'entity.xlsx'), writtenAs({ name: 'R&amp;D' }));
  fs.writeFileSync(path.join(root, 'prefixed.xlsx'), writtenAs({ prefix: 'x' }));
  fs.writeFileSync(path.join(root, 'quoted.xlsx'), writtenAs({ quote: "'" }));
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });

  // Act
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const objects = app.dependencies.objectsAt(project.id);
  const pump = (file) => objects.find((object) => object.path === file && object.label === 'Pump · Cost');

  // Assert
  assert.equal(pump('entity.xlsx')?.valueText, '420');
  assert.equal(pump('entity.xlsx')?.metadata.sheet, 'R&D');
  assert.equal(pump('prefixed.xlsx')?.valueText, '420');
  assert.equal(pump('quoted.xlsx')?.valueText, '420');
  assert.deepEqual(sheetSignatures(writtenAs({ name: 'R&amp;D' })).map((sheet) => sheet.name), ['R&D']);
});

test('A workbook whose sheet list cannot be read is read whole rather than as no sheets', () => {
  // Arrange
  const noSheets = storedZip({ 'xl/workbook.xml': '<workbook><sheets/></workbook>' });

  // Act
  const signatures = sheetSignatures(noSheets);

  // Assert
  assert.equal(signatures, null);
});

test('Renaming a sheet reads the workbook again, and its objects carry the new name', async (t) => {
  // Arrange
  const { read, save, app, project } = await folder(t);
  const renamed = storedZip({
    'xl/workbook.xml': `<workbook><sheets>${['North', 'Coast', 'West'].map((name, index) =>
      `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships>${SHEETS.map((_, index) =>
      `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
    'xl/styles.xml': '<styleSheet/>',
    ...Object.fromEntries(SHEETS.map((name, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(regionRows(name))])),
  });

  // Act
  save(renamed);
  const sheets = new Set(app.dependencies.objectsAt(project.id).map((object) => object.metadata.sheet).filter(Boolean));

  // Assert: the workbook part changed, which every sheet reads, so all are read again.
  assert.deepEqual(read, ['all']);
  assert.deepEqual([...sheets].sort(), ['Coast', 'North', 'West']);
});
