import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openEngine } from '../src/agent/engine.js';
import { TextIndex } from '../src/agent/text-index.js';
import { actor, agentLibrary } from './fixtures/agent-library.js';

test('the full-text index ranks versions by BM25, is filled from the store on demand, and catches up after a capture', async (t) => {
  // Arrange
  const { app, dataDir, sandbox, folders } = await agentLibrary(t);
  const engine = openEngine({ dataDir, scope: ['*'] });
  t.after(() => engine.close());
  const index = new TextIndex(engine.db, dataDir);
  t.after(() => index.close());
  const current = (versionIds) => {
    const objects = new Map(engine.dependencies.objectsAt(folders.Finance).map((object) => [object.versionId, object]));
    return versionIds.map(({ versionId }) => objects.get(versionId)).filter(Boolean);
  };

  // Act
  const complete = index.sync();
  const grant = current(index.search(['grant', 'revenue', 'figure']));
  const again = index.sync();
  fs.writeFileSync(path.join(sandbox, 'Finance', 'notes.md'), '# Notes\n\nThe North division revenue figure excludes the one-time grant.\n\nThe West office opened a showroom in May.\n');
  app.timeline.capture(folders.Finance, actor);
  app.dependencies.ensureIndex(folders.Finance);
  const caughtUp = index.sync();
  const showroom = current(index.search(['showroom']));

  // Assert
  assert.equal(complete, true);
  assert.equal(again, true, 'nothing new to index');
  assert.match(grant[0].valueText, /excludes the one-time grant/, 'the passage with the rarest words first');
  assert.equal(caughtUp, true);
  assert.deepEqual(showroom.map((object) => object.valueText), ['The West office opened a showroom in May.'], 'a version recorded after the first fill is found');
  assert.ok(fs.existsSync(path.join(dataDir, 'derived', 'agent-text.sqlite')));
});
