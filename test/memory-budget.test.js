// Every derived-data cache weighs what it holds against one shared budget,
// so together they stay under it however many there are, and the budget
// shrinks to a small floor once the server has had no requests for a while.

import test from 'node:test';
import assert from 'node:assert/strict';
import { BoundedCache, MemoryBudget } from '../src/cache.js';

const kilobytes = (count) => count * 1024;

test('Caches that share a budget stay under it together', () => {
  // Arrange
  const budget = new MemoryBudget({ maxBytes: kilobytes(100) });
  const first = new BoundedCache({ maxEntries: 100, budget, bytes: (value) => value.length });
  const second = new BoundedCache({ maxEntries: 100, budget, bytes: (value) => value.length });

  // Act
  for (let index = 0; index < 10; index += 1) first.set(`a${index}`, 'x'.repeat(kilobytes(10)));
  for (let index = 0; index < 5; index += 1) second.set(`b${index}`, 'x'.repeat(kilobytes(10)));

  // Assert
  assert.ok(budget.bytes <= kilobytes(100));
  assert.equal(second.size, 5, 'the most recently used entries are kept');
  assert.equal(first.size, 5, 'the oldest entries of any cache go first');
  assert.equal(first.has('a0'), false);
  assert.equal(first.has('a9'), true);
});

test('Reading an entry keeps it over older ones in other caches', () => {
  // Arrange
  const budget = new MemoryBudget({ maxBytes: kilobytes(30) });
  const first = new BoundedCache({ budget, bytes: (value) => value.length });
  const second = new BoundedCache({ budget, bytes: (value) => value.length });
  first.set('old', 'x'.repeat(kilobytes(10)));
  second.set('middle', 'x'.repeat(kilobytes(10)));
  second.set('newer', 'x'.repeat(kilobytes(10)));

  // Act
  first.get('old');
  second.set('newest', 'x'.repeat(kilobytes(10)));

  // Assert
  assert.equal(first.has('old'), true);
  assert.equal(second.has('middle'), false);
});

test('A budget shrinks to its floor when the server is idle and grows back on use', () => {
  // Arrange
  const budget = new MemoryBudget({ maxBytes: kilobytes(100), idleBytes: kilobytes(20) });
  const cache = new BoundedCache({ maxEntries: 100, budget, bytes: (value) => value.length });
  for (let index = 0; index < 8; index += 1) cache.set(`k${index}`, 'x'.repeat(kilobytes(10)));

  // Act
  budget.idle();
  const idleBytes = budget.bytes;
  budget.active();
  for (let index = 8; index < 16; index += 1) cache.set(`k${index}`, 'x'.repeat(kilobytes(10)));

  // Assert
  assert.ok(idleBytes <= kilobytes(20));
  assert.equal(cache.has('k7'), true, 'the most recent entries survive the shrink');
  assert.ok(budget.bytes > kilobytes(20), 'an active server uses the whole budget again');
});

test('Clearing or deleting from a cache gives its bytes back to the budget', () => {
  // Arrange
  const budget = new MemoryBudget({ maxBytes: kilobytes(100) });
  const cache = new BoundedCache({ budget, bytes: (value) => value.length });
  cache.set('a', 'x'.repeat(kilobytes(10)));
  cache.set('b', 'x'.repeat(kilobytes(10)));

  // Act
  cache.delete('a');
  const afterDelete = budget.bytes;
  cache.clear();

  // Assert
  assert.equal(afterDelete, kilobytes(10));
  assert.equal(budget.bytes, 0);
});

test('A cache without a budget behaves as before', () => {
  // Arrange
  const cache = new BoundedCache({ maxEntries: 2 });

  // Act
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);

  // Assert
  assert.deepEqual([...cache.entries.keys()], ['b', 'c']);
});

test('The server shrinks its caches after a while without requests', async (t) => {
  // Arrange
  const { createApplication } = await import('../src/server.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-memory-budget-'));
  const application = createApplication({ dataDir: sandbox, watchProjects: false, port: 0,
    cacheBytes: kilobytes(400), cacheIdleBytes: kilobytes(40), cacheIdleMs: 20 });
  t.after(async () => { await application.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const budget = application.timeline.memoryBudget;
  const cache = new BoundedCache({ maxEntries: 100, budget, bytes: (value) => value.length });
  application.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => application.server.once('listening', resolve));
  await fetch(`http://127.0.0.1:${application.server.address().port}/api/health`).catch(() => null);
  for (let index = 0; index < 20; index += 1) cache.set(`k${index}`, 'x'.repeat(kilobytes(10)));
  const active = budget.bytes;

  // Act
  await new Promise((resolve) => setTimeout(resolve, 80));

  // Assert
  assert.ok(active > kilobytes(100));
  assert.ok(budget.bytes <= kilobytes(40));
});

test('An index that read a large changed file gives its garbage back, and a small one does not', async (t) => {
  // Arrange
  const { createApplication } = await import('../src/server.js');
  const { releaseAfterWork, COLLECT_AFTER_BYTES } = await import('../src/memory.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-memory-release-'));
  const root = path.join(sandbox, 'Tables');
  fs.mkdirSync(root);
  const rows = (count, edited) => ['Item,Value', ...Array.from({ length: count }, (_, index) =>
    `Item ${index},${index === edited ? 1 : index * 7}`)].join('\n');
  fs.writeFileSync(path.join(root, 'large.csv'), rows(30_000, -1));
  fs.writeFileSync(path.join(root, 'small.csv'), rows(10, -1));
  const application = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false, port: 0 });
  t.after(async () => { await application.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const writer = { id: 'human:writer', displayName: 'Writer', actorType: 'HUMAN_SELF' };
  const project = application.timeline.importProject(root, writer, { watch: false }).project;
  application.dependencies.ensureIndex(project.id);
  const released = [];
  application.dependencies.releaseMemory = (bytes) => { released.push(bytes); return releaseAfterWork(bytes); };

  // Act
  fs.writeFileSync(path.join(root, 'small.csv'), rows(10, 3));
  application.timeline.capture(project.id, writer);
  application.dependencies.ensureIndex(project.id);
  fs.writeFileSync(path.join(root, 'large.csv'), rows(30_000, 3));
  application.timeline.capture(project.id, writer);
  application.dependencies.ensureIndex(project.id);

  // Assert
  assert.equal(released.length, 2);
  assert.ok(released[0] < COLLECT_AFTER_BYTES, 'only the small file was read for the first edit');
  assert.ok(released[1] >= COLLECT_AFTER_BYTES, 'only the large file was read for the second edit');
  assert.equal(releaseAfterWork(released[0]), false);
  assert.equal(releaseAfterWork(released[1]), true);
});

test('Suggestions after an idle spell or a full budget read no folder again', async (t) => {
  // Arrange: a folder whose objects alone are over the whole budget.
  const { createApplication } = await import('../src/server.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-typing-caches-'));
  const folder = path.join(sandbox, 'Accounting');
  fs.mkdirSync(folder);
  const rows = ['Line item,Current period'];
  for (let index = 0; index < 400; index += 1) rows.push(`Expense item ${index},${index * 10}`);
  rows.push('Other revenue,197');
  fs.writeFileSync(path.join(folder, 'income.csv'), `${rows.join('\n')}\n`);
  const application = createApplication({ dataDir: path.join(sandbox, 'state'), watchProjects: false,
    cacheBytes: kilobytes(64), cacheIdleBytes: kilobytes(8) });
  t.after(async () => { await application.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await application.workspace.add([folder]);
  const typed = 'The other reven';
  await application.workspace.predict({ text: typed, cursor: typed.length, blockIndex: 0 });
  const versions = application.timeline.objectVersions;
  let reads = 0;
  for (const name of ['resolved', 'resolvedTypes']) {
    const original = versions[name].bind(versions);
    versions[name] = (...args) => { reads += 1; return original(...args); };
  }

  // Act
  application.timeline.memoryBudget.idle();
  application.timeline.memoryBudget.active();
  const next = 'The other revenu';
  const prediction = await application.workspace.predict({ text: next, cursor: next.length, blockIndex: 0 });

  // Assert
  assert.equal(reads, 0, 'the objects suggestions read on each key stay in memory');
  assert.ok((prediction.claims ?? []).some((claim) => claim.candidates?.some((candidate) => /other revenue/i.test(candidate.label))));
});
