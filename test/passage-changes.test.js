// A passage is named by its own words, so editing a sentence records a new
// passage and removes the old one. When the new one is mostly the old one's
// words, in the same file, Lasso records that it replaces it: its history
// then reaches back through the old wording, the card can mark the words
// that changed, and The Ranch can tint the passage with what it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { textPdf } from './fixtures/pdf.js';

const actor = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };
const LEAD = 'Weekly log for the north site.';
const PUMP = 'The pump at station four was replaced on Tuesday after the seal failed.';
const PUMP_EDITED = 'The pump at station four was replaced on Thursday after the seal failed.';
const TAIL = 'Flow returned to forty two litres per minute by the afternoon.';

function folder(t, files) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-passage-changes-')));
  const root = path.join(sandbox, 'Site');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  app.dependencies.ensureIndex(project.id);
  const save = (name, content) => {
    fs.writeFileSync(path.join(root, name), content);
    app.timeline.capture(project.id, actor);
    app.dependencies.ensureIndex(project.id);
  };
  const passage = (file, text) => app.dependencies.objectsAt(project.id)
    .find((object) => object.path === file && object.metadata.componentType && object.valueText === text);
  return { app, project, save, passage };
}

test('An edited sentence of a text file keeps the history of its earlier wording', (t) => {
  // Arrange
  const { app, save, passage } = folder(t, { 'log.txt': `${LEAD}\n\n${PUMP}\n\n${TAIL}\n` });

  // Act
  save('log.txt', `${LEAD}\n\n${PUMP_EDITED}\n\n${TAIL}\n`);
  const edited = passage('log.txt', PUMP_EDITED);
  const history = app.dependencies.objectHistory(edited.id);

  // Assert
  assert.deepEqual(history.map((entry) => entry.value), [PUMP_EDITED, PUMP]);
});

test('An edited sentence of a PDF keeps the history of its earlier wording', (t) => {
  // Arrange
  const { app, save, passage } = folder(t, { 'log.pdf': textPdf(`${LEAD} ${PUMP} ${TAIL}`) });

  // Act
  save('log.pdf', textPdf(`${LEAD} ${PUMP_EDITED} ${TAIL}`));
  const edited = passage('log.pdf', PUMP_EDITED);
  const history = app.dependencies.objectHistory(edited.id);

  // Assert
  assert.ok(edited, 'the PDF sentence is a passage');
  assert.deepEqual(history.map((entry) => entry.value), [PUMP_EDITED, PUMP]);
});

test('A new sentence in other words does not take an old one\'s history', (t) => {
  // Arrange
  const { app, save, passage } = folder(t, { 'log.txt': `${LEAD}\n\n${PUMP}\n\n${TAIL}\n` });
  const other = 'Crews cleared gravel from the culvert inlet before the storm arrived.';

  // Act
  save('log.txt', `${LEAD}\n\n${other}\n\n${TAIL}\n`);
  const history = app.dependencies.objectHistory(passage('log.txt', other).id);

  // Assert
  assert.deepEqual(history.map((entry) => entry.value), [other]);
});

test('The Ranch names the passages a file\'s latest version changed, with what they were', (t) => {
  // Arrange
  const text = `${LEAD}\n\n${PUMP}\n\n${TAIL}\n`;
  const { app, project, save } = folder(t, { 'log.txt': text, 'log.pdf': textPdf(`${LEAD} ${PUMP} ${TAIL}`) });

  // Act
  const edited = `${LEAD}\n\n${PUMP_EDITED}\n\n${TAIL}\n`;
  save('log.txt', edited);
  save('log.pdf', textPdf(`${LEAD} ${PUMP_EDITED} ${TAIL}`));
  const plain = app.ranch.passages({ directoryId: project.id, path: 'log.txt' });
  const pdf = app.ranch.passages({ directoryId: project.id, path: 'log.pdf' });

  // Assert
  const sentence = plain.changes.find((change) => change.after === PUMP_EDITED);
  assert.equal(sentence.before, PUMP);
  assert.equal(edited.slice(sentence.start, sentence.end), PUMP_EDITED);
  assert.deepEqual([sentence.lineStart, sentence.lineEnd], [3, 3]);
  assert.ok(sentence.changedAt);
  assert.ok(plain.changes.every((change) => change.before !== change.after));
  const page = pdf.changes.find((change) => change.after === PUMP_EDITED);
  assert.equal(page?.before, PUMP);
  assert.equal(page.pageNumber, 1);
});
