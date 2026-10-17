import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

test('redaction chooser and recipient use every column, late row and complete passage of the same pinned source', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-share-parity-'));
  const root = path.join(sandbox, 'Sources');
  fs.mkdirSync(root);
  const rows = Array.from({ length: 35 }, (_, row) => Array.from({ length: 12 }, (_, column) =>
    row === 0 ? `Field ${column + 1}` : `record_${row}_field_${column + 1}`));
  rows[30][10] = 'PRIVATE_LATE_COLUMN_VALUE';
  fs.writeFileSync(path.join(root, 'Capacity.csv'), rows.map(row => row.join(',')).join('\n'));
  const blocks = Array.from({ length: 12 }, (_, index) =>
    `Section ${index + 1} ${'complete passage words '.repeat(20)}end_of_section_${index + 1}.`);
  blocks[8] = 'PRIVATE_FULL_PASSAGE';
  fs.writeFileSync(path.join(root, 'Follow-up.txt'), blocks.join('\n\n'));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const actor = { id: 'human:qa', displayName: 'QA', actorType: 'HUMAN_SELF' };
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  app.dependencies.ensureIndex(project.id);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const sourceFor = filename => app.db.prepare(`SELECT v.id AS versionId, v.object_id AS objectId
    FROM scientific_object_versions v JOIN scientific_objects o ON o.id=v.object_id
    WHERE o.project_id=? AND v.path=? LIMIT 1`).get(project.id, filename);

  for (const filename of ['Capacity.csv', 'Follow-up.txt']) {
    const source = sourceFor(filename);
    assert.ok(source);
    const local = await (await fetch(`${base}/api/dependency-objects/${source.objectId}/document?version=${source.versionId}`)).json();
    const document = local.document;
    const redactions = filename.endsWith('.csv')
      ? [{ kind: 'CELL', sheet: 0, row: 30, column: 10, effect: 'BLUR' },
        { kind: 'CELL', sheet: 0, row: 2, column: 1, effect: 'BLANK' }]
      : [{ kind: 'BLOCK', block: 8, effect: 'BLANK' }];
    if (document.kind === 'table') assert.deepEqual(document.sheets[0].rows, rows);
    else assert.deepEqual(document.blocks, blocks);
    const created = await fetch(`${base}/api/projects/${project.id}/object-shares`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...source, actor, accessScope: 'REDACTED', redactions }),
    });
    assert.equal(created.status, 201);
    const { share } = await created.json();
    // A later edit must not change either the chooser data or the shared view.
    fs.writeFileSync(path.join(root, filename), 'Changed after sharing');
    const page = await (await fetch(`${base}/d/${share.token}`)).text();
    assert.doesNotMatch(page, /PRIVATE_LATE_COLUMN_VALUE|PRIVATE_FULL_PASSAGE|Changed after sharing|Download original/);
    if (document.kind === 'table') {
      for (const [row, values] of document.sheets[0].rows.entries()) {
        for (const [column, value] of values.entries()) {
          const masked = redactions.some(mask => mask.row === row && mask.column === column);
          assert.equal(page.includes(`>${value}</td>`), !masked, `${row}:${column}`);
        }
      }
      assert.match(page, /redaction blur/);
      assert.match(page, /redaction blank/);
    } else {
      for (const [index, block] of document.blocks.entries()) {
        assert.equal(page.includes(block), index !== 8, `section ${index}`);
      }
    }
    assert.ok(!page.includes(sandbox));
    assert.equal((await fetch(`${base}/d/${share.token}/download`)).status, 403);
  }
});
