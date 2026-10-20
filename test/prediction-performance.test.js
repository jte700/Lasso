import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';
import { BoundedCache } from '../src/cache.js';

const actor = { id: 'human:cache-test', displayName: 'Cache test', actorType: 'HUMAN_SELF' };

function fixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-prediction-cache-'));
  const root = path.join(temporary, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nSupplies,120\nTravel,80\n');
  fs.writeFileSync(path.join(root, 'dictionary.csv'), 'Variable,Description,Units\nSupplies,Original definition,dollars\n');
  fs.writeFileSync(path.join(root, 'draft.md'), '# Draft\n\nSupplies were 120.\n');
  const app = createApplication({ dataDir: path.join(temporary, 'history'), watchProjects: false });
  const { project } = app.timeline.importProject(root, actor, { watch: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  return { app, root, project };
}

test('bounded derived caches evict old values and do not retain an oversized value', () => {
  const cache = new BoundedCache({ maxEntries: 2, maxWeight: 6, weight: (value) => value.length });
  cache.set('first', 'aaa').set('second', 'bb');
  assert.equal(cache.get('first'), 'aaa');
  cache.set('third', 'ccc');
  assert.equal(cache.has('second'), false);
  assert.equal(cache.weight, 6);
  cache.set('large', '1234567');
  assert.equal(cache.has('large'), false);
  assert.equal(cache.size, 2);
  cache.set('first', 'a');
  assert.equal(cache.weight, 4);
  cache.clear();
  assert.equal(cache.weight, 0);
  assert.equal(cache.size, 0);
});

test('unchanged extraction is reused while dictionary changes and historical objects stay correct', (t) => {
  const { app, root, project } = fixture(t);
  const oldSnapshot = project.currentSnapshotId;
  const original = app.dependencies.objectsAt(project.id).find((object) =>
    object.path === 'data.csv' && object.objectType === 'DATASET_VALUE' && object.metadata.variable === 'Supplies');
  assert.equal(original.metadata.definition, 'Original definition');
  const sourceHash = original.contentHash;
  const get = app.timeline.blobs.get.bind(app.timeline.blobs);
  let sourceReads = 0;
  app.timeline.blobs.get = (hash) => { if (hash === sourceHash) sourceReads += 1; return get(hash); };
  fs.writeFileSync(path.join(root, 'dictionary.csv'), 'Variable,Description,Units\nSupplies,Revised definition,CAD\n');
  const capture = app.timeline.capture(project.id, actor);
  const current = app.dependencies.objectsAt(project.id).find((object) => object.id === original.id);
  assert.equal(sourceReads, 0, 'unchanged source content was not reread or extracted');
  assert.equal(current.snapshotId, capture.snapshot.id);
  assert.equal(current.metadata.definition, 'Revised definition');
  assert.equal(current.metadata.units, 'CAD');
  assert.doesNotMatch(current.searchText, /original definition/);
  assert.equal(app.dependencies.objectsAt(project.id, oldSnapshot).find((object) => object.id === original.id)
    .metadata.definition, 'Original definition');
  fs.unlinkSync(path.join(root, 'dictionary.csv'));
  app.timeline.capture(project.id, actor);
  const withoutDefinition = app.dependencies.objectsAt(project.id).find((object) => object.id === original.id);
  assert.equal(withoutDefinition.metadata.definition, undefined);
  assert.equal(withoutDefinition.metadata.dictionaryPath, undefined);
  assert.doesNotMatch(withoutDefinition.searchText, /revised definition/);
});

test('warm object and ranking caches preserve renames, project isolation and fresh usage', (t) => {
  const { app, root, project } = fixture(t);
  const oldSnapshot = project.currentSnapshotId;
  const first = app.dependencies.search(project.id, 'Supplies');
  const original = first.find((object) => object.path === 'data.csv');
  assert.ok(original);
  const warm = app.dependencies.search(project.id, 'Supplies');
  assert.deepEqual(warm.map((object) => [object.id, object.score, object.ranking.tier]),
    first.map((object) => [object.id, object.score, object.ranking.tier]));
  app.dependencies.recordRecommendationUsage(project.id, { objectId: original.id, kind: 'accept', sessionId: 'fresh' });
  assert.ok(app.dependencies.search(project.id, 'Supplies').find((object) => object.id === original.id).ranking.usageBoost > 0);
  fs.renameSync(path.join(root, 'data.csv'), path.join(root, 'renamed.csv'));
  app.timeline.capture(project.id, actor);
  const renamed = app.dependencies.search(project.id, 'Supplies').find((object) => object.id === original.id);
  assert.equal(renamed.path, 'renamed.csv');
  assert.ok(renamed.ranking.usageBoost > 0);
  assert.equal(app.dependencies.search(project.id, 'Supplies', { snapshotId: oldSnapshot })
    .find((object) => object.id === original.id).path, 'data.csv');
  fs.writeFileSync(path.join(root, 'data.csv'), 'Metric,Value\nReplacement,999\n');
  app.timeline.capture(project.id, actor);
  const replacement = app.dependencies.search(project.id, 'Replacement');
  assert.equal(replacement[0].ranking.usageBoost, 0);
  const foreignRoot = path.join(root, 'other');
  fs.mkdirSync(foreignRoot);
  fs.writeFileSync(path.join(foreignRoot, 'other.csv'), 'Metric,Value\nOther,5\n');
  const other = app.timeline.importProject(foreignRoot, actor, { watch: false }).project;
  assert.throws(() => app.dependencies.objectsAt(other.id, oldSnapshot), { status: 400 });
  assert.deepEqual(app.dependencies.ranking.rank(other.id, [original], { query: 'Supplies' }), []);
});

test('warm prediction features retain identical results after cache eviction', (t) => {
  const { app, project } = fixture(t);
  const input = { text: 'Supplies were 120.', documentPath: 'draft.md' };
  const simplify = (prediction) => prediction.claims.flatMap((claim) => claim.candidates)
    .map((object) => [object.id, object.score, object.matchStrength, object.ranking.reason]);
  const cold = simplify(app.dependencies.predict(project.id, input));
  const warm = simplify(app.dependencies.predict(project.id, input));
  assert.ok(cold.length);
  assert.deepEqual(warm, cold);
  app.dependencies.objectCache.clear();
  app.dependencies.ranking.close();
  assert.deepEqual(simplify(app.dependencies.predict(project.id, input)), cold);
  const all = app.dependencies.objectsAt(project.id);
  all.length = 0;
  assert.ok(app.dependencies.objectsAt(project.id).length, 'consumer array edits do not damage cached retrieval');
});
