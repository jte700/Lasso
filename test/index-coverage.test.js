import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:coverage', displayName: 'Coverage', actorType: 'HUMAN_SELF' };

test('large folders index every eligible file and return sources beyond the old 30,000-object cutoff', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-coverage-'));
  const root = path.join(sandbox, 'sources');
  fs.mkdirSync(root);
  const names = Array.from({ length: 16 }, (_, index) => `source-${String(index).padStart(2, '0')}.csv`);
  for (const [index, name] of names.entries()) {
    const rows = Array.from({ length: 1_000 }, (_, row) => `Item ${row},${index * 1000 + row + 1}`);
    fs.writeFileSync(path.join(root, name), `Item,Value\n${rows.join('\n')}\n`);
  }
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const project = app.timeline.importProject(root, actor, { watch: false }).project;
  const tables = app.dependencies.objectsAt(project.id, null, ['DATASET']);
  assert.ok(tables.length > 0);
  assert.ok(tables.every(object => object.objectType === 'DATASET'));
  const objects = app.dependencies.objectsAt(project.id);
  assert.ok(objects.length > 30_000, `expected more than the old retrieval cutoff, got ${objects.length}`);
  assert.deepEqual([...new Set(objects.map(object => object.path))].sort(), names);
  assert.ok(objects.some(object => object.path === names.at(-1) && object.valueText === '16000'));
  assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM index_failures WHERE project_id = ? AND resolved_at IS NULL").get(project.id).count, 0);
  // A smaller typed request must not poison the complete snapshot cache.
  assert.equal(app.dependencies.objectsAt(project.id).length, objects.length);
});
