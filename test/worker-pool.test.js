// Heavy readers (PDF text, IFC and STEP geometry, large tables) each run in a
// worker of their own. At most two run at once; the rest wait their turn, so
// a folder full of large files cannot start one worker per file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WORKERS, pooled, poolState } from '../src/worker-pool.js';

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('At most two heavy readers run at once', async () => {
  // Arrange
  let running = 0;
  let most = 0;
  const task = (value) => pooled(async () => {
    running += 1;
    most = Math.max(most, running);
    await later(15);
    running -= 1;
    return value;
  });

  // Act
  const results = await Promise.all([1, 2, 3, 4, 5].map(task));

  // Assert
  assert.equal(MAX_WORKERS, 2);
  assert.equal(most, 2);
  assert.deepEqual(results, [1, 2, 3, 4, 5]);
  assert.deepEqual(poolState(), { running: 0, waiting: 0 });
});

test('A reader that fails gives its turn to the next one', async () => {
  // Arrange
  const failing = pooled(async () => { throw new Error('damaged file'); });
  const next = [pooled(async () => 'a'), pooled(async () => 'b'), pooled(async () => 'c')];

  // Act
  const failure = await failing.then(() => null, (error) => error.message);
  const values = await Promise.all(next);

  // Assert
  assert.equal(failure, 'damaged file');
  assert.deepEqual(values, ['a', 'b', 'c']);
  assert.deepEqual(poolState(), { running: 0, waiting: 0 });
});

test('A reader that stops reporting loses its turn and is told to stop its worker', async () => {
  // Arrange
  let stopped = false;
  const stuck = pooled(({ signal }) => new Promise(() => {
    signal.addEventListener('abort', () => { stopped = true; }, { once: true });
  }), { silentMs: 30 });
  const stuckToo = pooled(() => new Promise(() => {}), { silentMs: 30 });
  const next = pooled(async () => 'read');

  // Act
  const failure = await stuck.then(() => null, (error) => error.message);
  await stuckToo.catch(() => null);
  const value = await next;

  // Assert
  assert.match(failure, /silent/);
  assert.equal(stopped, true);
  assert.equal(value, 'read');
  assert.deepEqual(poolState(), { running: 0, waiting: 0 });
});

test('A reader that keeps reporting keeps its turn past the silence limit', async () => {
  // Arrange
  const steady = pooled(async ({ heard }) => {
    for (let step = 0; step < 6; step += 1) {
      await later(10);
      heard();
    }
    return 'done';
  }, { silentMs: 25 });

  // Act
  const value = await steady;

  // Assert
  assert.equal(value, 'done');
});

test('A preview waiting for a turn goes before indexing that waits', async () => {
  // Arrange
  const order = [];
  const busy = [pooled(() => later(20)), pooled(() => later(20))];
  const indexing = pooled(async () => { order.push('indexing'); });
  const preview = pooled(async () => { order.push('preview'); }, { interactive: true });

  // Act
  await Promise.all([...busy, indexing, preview]);

  // Assert
  assert.deepEqual(order, ['preview', 'indexing']);
  assert.deepEqual(poolState(), { running: 0, waiting: 0 });
});
