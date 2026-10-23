import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:typed-history', displayName: 'Typed history', actorType: 'HUMAN_SELF' };
const ledger = value => `Metric,Value\nCapacity,${value}\nDemand,19\n`;

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-typed-history-'));
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.csv'), ledger(12));
  fs.writeFileSync(path.join(root, 'b.csv'), ledger(24));
  fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n\nCapacity is reviewed annually.\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false });
  const project = app.timeline.importProject(root, actor).project;
  app.dependencies.ensureIndex(project.id);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { app, project, root };
}

test('typed object resolution preserves carried versions, removals, restorations and historical ordering', t => {
  const { app, project, root } = fixture(t);
  const store = app.timeline.objectVersions;
  const types = new Set(['DATASET', 'DATASET_VALUE']);
  const snapshots = [project.currentSnapshotId];
  fs.writeFileSync(path.join(root, 'a.csv'), ledger(15));
  snapshots.push(app.timeline.capture(project.id, actor).snapshot.id);
  fs.unlinkSync(path.join(root, 'b.csv'));
  snapshots.push(app.timeline.capture(project.id, actor).snapshot.id);
  fs.writeFileSync(path.join(root, 'b.csv'), ledger(24));
  snapshots.push(app.timeline.capture(project.id, actor).snapshot.id);
  const expected = snapshots.map(id => store.resolved(id, { fresh: true }).rows.filter(row => types.has(row.object_type)));
  assert.ok(expected[1].some(row => row.path === 'b.csv' && row.recorded_snapshot_id !== snapshots[1]),
    'the fixture includes carried versions');
  assert.ok(!expected[2].some(row => row.path === 'b.csv'), 'the fixture includes a nearer removal');
  assert.ok(expected[3].some(row => row.path === 'b.csv'), 'the fixture includes a restoration');
  store.clear();
  t.mock.method(store, 'resolved', () => { throw new Error('Typed lookup loaded unrelated objects'); });
  for (let index = 0; index < snapshots.length; index++) {
    const result = store.resolvedTypes(snapshots[index], types);
    assert.deepEqual(result.rows, expected[index], 'typed rows keep the full resolution order and shape');
    assert.equal(result.snapshotId, snapshots[index]);
    assert.equal(result.version, index + 1);
    assert.deepEqual([...result.byObject.values()], result.rows);
  }
});

test('typed objectsAt maps only requested valid types without replacing the complete object cache', t => {
  const { app, project } = fixture(t);
  const all = app.dependencies.objectsAt(project.id);
  const expected = all.filter(object => ['DATASET', 'DATASET_VALUE'].includes(object.objectType));
  app.dependencies.objectCache.clear();
  t.mock.method(app.timeline.objectVersions, 'resolved', () => { throw new Error('Typed lookup resolved the full snapshot'); });
  const actual = app.dependencies.objectsAt(project.id, null, ['DATASET_VALUE', 'invalid-type', 'DATASET']);
  assert.deepEqual(actual, expected);
  assert.ok(!app.dependencies.objectCache.has(project.currentSnapshotId), 'partial results cannot stand in for the full snapshot');
  assert.ok(actual.every(object => object.snapshotId === project.currentSnapshotId && object.projectId === project.id));
});

test('typed resolution queries selected project/type and object-ID indexes for both versions and removals', t => {
  const { app, project } = fixture(t);
  const store = app.timeline.objectVersions;
  const prepare = app.db.prepare.bind(app.db), plans = [];
  t.mock.method(app.db, 'prepare', sql => {
    const statement = prepare(sql);
    if (!sql.includes('FROM scientific_objects candidate')) return statement;
    return { all(...args) {
      plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args));
      return statement.all(...args);
    } };
  });
  const result = store.resolvedTypes(project.currentSnapshotId, ['DATASET']);
  assert.equal(result.rows.length, 2);
  assert.equal(plans.length, 1);
  const detail = plans[0].map(row => row.detail).join('\n');
  assert.equal((detail.match(/SEARCH candidate USING INDEX scientific_object_project_type_idx/g) ?? []).length, 2);
  assert.match(detail, /SEARCH v .*\(object_id=\?\)/);
  assert.match(detail, /SEARCH r .*\(object_id=\?\)/);
  assert.doesNotMatch(detail, /SCAN (?:candidate|v|r)\b/);
  assert.deepEqual(store.resolvedTypes(project.currentSnapshotId, []).rows, []);
  assert.deepEqual(store.resolvedTypes(project.currentSnapshotId, ["DATASET') OR 1=1 --"]).rows, []);
  assert.deepEqual(store.resolvedTypes('missing-snapshot', ['DATASET']).rows, []);
});
