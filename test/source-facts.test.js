import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:facts', displayName: 'Facts', actorType: 'HUMAN_SELF' };

function indexFolder(t, files) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-facts-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  return { app, project, objects: app.dependencies.objectsAt(project.id) };
}

test('a large table reports how many rows it really has, not how many were indexed', (t) => {
  // Arrange
  const rows = Array.from({ length: 1500 }, (_, index) => `P${index + 1},${index % 7}`);
  const { objects } = indexFolder(t, { 'Survey.csv': `Participant,Score\n${rows.join('\n')}\n` });

  // Act
  const count = objects.find((object) => object.metadata?.metric === 'row-count');

  // Assert
  assert.equal(count.valueText, 'n = 1500');
  assert.equal(count.metadata.rows, 1500);
});

test('a business document is not cited as written by the first word of its file name', (t) => {
  // Arrange: no author is recorded inside either PDF.
  const { objects } = indexFolder(t, {
    'Orchard-Services-Agreement.pdf': Buffer.from('%PDF-1.4\n'),
    'Johnson_2023.pdf': Buffer.from('%PDF-1.4\n'),
  });

  // Act
  const document = (name) => objects.find((object) => object.path === name && ['PAPER', 'DOCUMENT'].includes(object.objectType));
  const agreement = document('Orchard-Services-Agreement.pdf');
  const paper = document('Johnson_2023.pdf');

  // Assert
  assert.equal(agreement.metadata.author, null);
  assert.equal(agreement.label, 'Orchard Services Agreement', 'labelled by its title, not as a citation');
  assert.equal(paper.metadata.author, 'Johnson', 'a citation-style file name still names its author');
});

test('files that cannot be read are listed as indexing issues instead of disappearing', (t) => {
  // Arrange: a damaged workbook and document, and malformed JSON.
  const { app, project } = indexFolder(t, {
    'Ledger.xlsx': Buffer.from('PK\u0003\u0004 not really a workbook'),
    'Engagement-Letter.docx': Buffer.from('PK\u0003\u0004 not really a document'),
    'settings.json': '{ "rate": 0.15, ',
    'Notes.md': '# Notes\nThe fee is 1200.\n',
  });

  // Act
  const issues = app.terminal.indexing.failures(project.id);
  const byPath = new Map(issues.map((issue) => [issue.path, issue]));

  // Assert
  assert.match(byPath.get('Ledger.xlsx')?.reason ?? '', /workbook could not be read/);
  assert.match(byPath.get('Engagement-Letter.docx')?.reason ?? '', /could not be opened/);
  assert.match(byPath.get('settings.json')?.reason ?? '', /could not be parsed/);
  assert.equal(byPath.has('Notes.md'), false);
});

test('an indexing issue is resolved once the file can be read', (t) => {
  // Arrange
  const { app, project } = indexFolder(t, { 'settings.json': '{ "rate": ' });
  assert.equal(app.terminal.indexing.failures(project.id).length, 1);

  // Act: the file is fixed and the folder captured again.
  fs.writeFileSync(path.join(project.rootPath, 'settings.json'), '{ "rate": 0.15 }');
  app.timeline.capture(project.id, actor);
  app.dependencies.ensureIndex(project.id);

  // Assert
  assert.equal(app.terminal.indexing.failures(project.id).length, 0);
});

test('a file briefly locked keeps its unreadable-content issue, which a retry cannot clear', (t) => {
  // Arrange
  const { app, project } = indexFolder(t, { 'Engagement-Letter.docx': Buffer.from('PK\u0003\u0004 damaged') });
  const indexing = app.terminal.indexing;

  // Act: a scan sees the file locked, then readable again.
  indexing.recordFailures(project.id, [{ path: 'Engagement-Letter.docx', code: 'BUSY', reason: 'file is locked' }]);
  indexing.recordFailures(project.id, []);
  const [issue] = indexing.failures(project.id);

  // Assert
  assert.equal(issue?.code, 'UNREADABLE_CONTENT');
  assert.equal(issue.retryable, false, 'only a change to the file can resolve it');
});
