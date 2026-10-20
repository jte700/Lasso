import test from 'node:test';
import assert from 'node:assert/strict';
import { watchParent } from '../src/parent-watchdog.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LAUNCHD = 1;

test('shuts the server down once the desktop app that started it is gone', async () => {
  // Arrange
  let parent = 4242;
  let alive = true;
  let orphaned = 0;
  watchParent({ expectedParentPid: 4242, currentParentPid: () => parent, parentIsAlive: () => alive,
    onOrphaned: () => { orphaned += 1; }, intervalMs: 5 });

  // Act
  await tick(20);
  const whileParentAlive = orphaned;
  parent = LAUNCHD;
  alive = false;
  await tick(30);

  // Assert
  assert.equal(whileParentAlive, 0);
  assert.equal(orphaned, 1, 'shutdown runs once, not on every later check');
});

test('a launcher that forks instead of exec-ing does not look like a crash', async () => {
  // The server's parent is the launcher, but the app that started it lives on.
  let orphaned = false;
  const stop = watchParent({ expectedParentPid: 4242, currentParentPid: () => 9001, parentIsAlive: () => true,
    onOrphaned: () => { orphaned = true; }, intervalMs: 5 });
  await tick(25);
  stop();
  assert.equal(orphaned, false);
});

test('the app exiting is noticed even when a launcher remains in between', async () => {
  let alive = true;
  let orphaned = false;
  watchParent({ expectedParentPid: 4242, currentParentPid: () => 9001, parentIsAlive: () => alive,
    onOrphaned: () => { orphaned = true; }, intervalMs: 5 });
  alive = false;
  await tick(25);
  assert.equal(orphaned, true);
});

test('does nothing for a server started from a terminal without a parent pid', async () => {
  let orphaned = false;
  const stop = watchParent({ expectedParentPid: Number.NaN, currentParentPid: () => LAUNCHD,
    parentIsAlive: () => false, onOrphaned: () => { orphaned = true; }, intervalMs: 5 });
  await tick(20);
  stop();
  assert.equal(orphaned, false);
});

test('stopping the watchdog prevents a later shutdown', async () => {
  let alive = true;
  let orphaned = false;
  const stop = watchParent({ expectedParentPid: 77, currentParentPid: () => 77, parentIsAlive: () => alive,
    onOrphaned: () => { orphaned = true; }, intervalMs: 5 });
  stop();
  alive = false;
  await tick(20);
  assert.equal(orphaned, false);
});
