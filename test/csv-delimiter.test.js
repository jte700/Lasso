import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { csvDelimiter, parseDelimited } from '../src/history/diff.js';

const actor = { id: 'human:csv', displayName: 'CSV', actorType: 'HUMAN_SELF' };

test('semicolon spreadsheet exports are read as columns, and comma files are unchanged', () => {
  assert.equal(csvDelimiter('Item;Cost\nPaper;12\nInk;30\n'), ';');
  assert.equal(csvDelimiter('﻿Item;Cost\r\nPaper;12\r\n'), ';');
  assert.equal(csvDelimiter('Item,Cost\nPaper;A4,12\n'), ',');
  assert.equal(csvDelimiter('Note\n"a;b"\n'), ',');
  assert.equal(csvDelimiter('Item;Cost\nPaper;12;extra\n'), ',');
  assert.deepEqual(parseDelimited('Item;Cost\nPaper;"1;2"\n', ','), [['Item', 'Cost'], ['Paper', '1;2']]);
  assert.deepEqual(parseDelimited('Item;Cost\nPaper;12\n', ',', { detect: false }), [['Item;Cost'], ['Paper;12']]);
});

test('semicolon CSV sources index values and keep redactions on their own cells', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-csv-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Costs.csv'), 'Item;Cost;Owner\nPaper;12;PRIVATE_OWNER_A\nInk;30;Lee\nToner;55;Kim\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  const objects = app.dependencies.objectsAt(project.id);
  assert.ok(objects.some((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '12'));
  assert.ok(!objects.some((object) => object.label.includes(';')));

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const source = objects.find((object) => object.objectType === 'DATASET_VALUE' && object.valueText === '12');
  const share = async (redactions) => {
    const response = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectId: source.id, versionId: source.versionId, actor, accessScope: 'REDACTED', redactions }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).share;
  };
  const created = await share([{ kind: 'CELL', sheet: 0, row: 1, column: 2, effect: 'BLANK' }]);
  assert.equal(created.redactions[0].delimiter, ';');
  const page = await (await fetch(`${base}/d/${created.token}`)).text();
  assert.doesNotMatch(page, /PRIVATE_OWNER_A/);
  assert.match(page, />Paper</);
  assert.match(page, />12</);

  // A cell redaction stored before semicolons were recognised covered the
  // whole comma-read line, and must still cover it.
  const legacy = await share([{ kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLANK' }]);
  app.db.prepare('UPDATE object_share_grants SET redactions_json=? WHERE token=?')
    .run(JSON.stringify([{ kind: 'CELL', sheet: 0, row: 1, column: 0, effect: 'BLANK' }]), legacy.token);
  const legacyPage = await (await fetch(`${base}/d/${legacy.token}`)).text();
  assert.doesNotMatch(legacyPage, /PRIVATE_OWNER_A/);
  const headers = (await fetch(`${base}/d/${legacy.token}`)).headers;
  assert.match(headers.get('content-security-policy'), /default-src 'none'/);
});
