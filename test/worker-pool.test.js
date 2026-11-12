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
