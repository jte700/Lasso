import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

const actor = { id: 'human:scope-switcher', displayName: 'Scope switcher', actorType: 'HUMAN_SELF' };

// Two folders that both hold a Revenue line, as a writer's finance and plans folders might.
async function twoFolders(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-only-folder-'));
  const finance = path.join(sandbox, 'Finance');
  const plans = path.join(sandbox, 'Plans');
  fs.mkdirSync(finance);
  fs.mkdirSync(plans);
  fs.writeFileSync(path.join(finance, 'Income-Statement.csv'), 'Account,Actual\nRevenue,485000\nNet income,48000\n');
  fs.writeFileSync(path.join(plans, 'Targets.csv'), 'Account,Target\nRevenue,600000\nHeadcount,42\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
  await app.workspace.add([fs.realpathSync(finance), fs.realpathSync(plans)], actor);
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  const ids = Object.fromEntries(app.workspace.state().directories.map((directory) => [directory.name, directory.id]));
  return { app, finance: ids.Finance, plans: ids.Plans };
}

const typed = (app, text, extra = {}) => app.workspace.predict({ text, cursor: text.length, blockIndex: 0, ...extra });

// Every folder a suggestion on the card came from.
function foldersSuggested(prediction) {
  const items = [...prediction.claims.flatMap((claim) => claim.candidates), ...prediction.sourceCompletions,
    ...prediction.workspaceCompletions, ...(prediction.completion ? [prediction.completion] : [])];
  return new Set(items.map((item) => item.projectId ?? item.dependencyCandidate?.projectId));
}

test('with no folder chosen every switched-on folder answers', async (t) => {
  const { app, finance, plans } = await twoFolders(t);
  const prediction = await typed(app, 'Reven');
  assert.deepEqual(foldersSuggested(prediction), new Set([finance, plans]));
});

test('a chosen folder alone answers while the writer types', async (t) => {
  const { app, finance, plans } = await twoFolders(t);
  const fromPlans = await typed(app, 'Reven', { onlyProjectId: plans });
  assert.deepEqual(foldersSuggested(fromPlans), new Set([plans]));
  const fromFinance = await typed(app, 'Reven', { onlyProjectId: finance });
  assert.deepEqual(foldersSuggested(fromFinance), new Set([finance]));
});

test('a chosen folder that is switched off suggests nothing rather than every folder', async (t) => {
  const { app, plans } = await twoFolders(t);
  await app.workspace.toggle(plans, false, actor);
  const prediction = await typed(app, 'Reven', { onlyProjectId: plans });
  assert.equal(foldersSuggested(prediction).size, 0);
});
