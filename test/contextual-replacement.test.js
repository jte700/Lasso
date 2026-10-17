import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

async function finance(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-contextual-replacement-'));
  const root = path.join(temporary, 'Finance');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Finance.csv'), 'Department,Actual,Budget\nPeople,76000,74000\nMarketing,14000,16000\nSales,4200,5000\n');
  const app = createApplication({ dataDir: path.join(temporary, 'state'), watchProjects: false });
  t.after(async () => { await app.close(); fs.rmSync(temporary, { recursive: true, force: true }); });
  await app.workspace.add([root], { id: 'system:replacement', displayName: 'Replacement test', actorType: 'SYSTEM' });
  return app;
}

test('contextual workspace suggestions replace the active word even when it is not a source-name prefix', async t => {
  const app = await finance(t);
  for (const opening of ['the marketing rows for our ', 'the marketing rows 🏢 for our ']) {
    const text = `${opening}spe`;
    const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
    const suggestion = prediction.workspaceCompletions.find(item => item.dependencyCandidate.label === 'Department');
    assert.ok(suggestion);
    assert.equal(suggestion.claimStart, opening.length);
    assert.equal(suggestion.claimEnd, text.length);
    assert.equal(text.slice(suggestion.claimStart, suggestion.claimEnd), 'spe');
    assert.equal(text.slice(0, suggestion.claimStart) + suggestion.replacementText, opening + 'Department');
  }
});

test('completed connectors and word boundaries remain insertion points', async t => {
  const app = await finance(t);
  for (const text of ['the marketing rows for our', 'the marketing rows for our ', 'the marketing rows for our spe ']) {
    const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
    const suggestion = prediction.workspaceCompletions.find(item => item.dependencyCandidate.label === 'Department');
    assert.ok(suggestion, text);
    assert.equal(suggestion.claimStart, text.length, text);
    assert.equal(suggestion.claimEnd, text.length, text);
  }
});

test('a matched field prefix retains its exact range before trailing whitespace', async t => {
  const app = await finance(t);
  const opening = 'the marketing rows for our ';
  const text = opening + 'dep ';
  const prediction = await app.workspace.predict({ text, cursor: text.length, blockIndex: 0 });
  const claim = prediction.claims.find(item => item.type === 'STUDY_VARIABLE');
  assert.equal(claim.start, opening.length);
  assert.equal(claim.end, text.length - 1);
  assert.equal(claim.text, 'dep');
  assert.ok(claim.candidates.some(item => item.label === 'Department'));
});
