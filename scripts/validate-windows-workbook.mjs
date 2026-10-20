// Read-only reproduction for the income-statement workbook reported on Windows.
// Copies into isolated temporary history, then removes all copies and snapshots.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplication } from '../src/server.js';
import { buildSharePreview } from '../src/sharing/share-preview.js';
if (!process.argv[2]) throw new Error('Pass the path to income-statement.xlsx.');
const bytes = fs.readFileSync(process.argv[2]);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-income-check-'));
fs.mkdirSync(path.join(sandbox, 'project'));
fs.writeFileSync(path.join(sandbox, 'project', 'income-statement.xlsx'), bytes);
const app = createApplication({ dataDir: path.join(sandbox, 'history'), watchProjects: false });
try {
  const { project } = app.timeline.importProject(path.join(sandbox, 'project'),
    { id: 'human:regression', displayName: 'Regression check', actorType: 'HUMAN_SELF' }, { watch: false });
  const text = 'I was looking at the revenue';
  const prediction = app.dependencies.predict(project.id, { text, cursor: text.length, blockIndex: 0 });
  const candidates = prediction.claims[0].candidates;
  assert.equal(candidates.length, 5);
  assert.equal(candidates[0].label, 'Revenue');
  assert.ok(candidates.some(c => c.label === 'Sales revenue'));
  assert.ok(!candidates.some(c => c.valueText?.includes('inferred numeric')));
  const objects = app.dependencies.objectsAt(project.id);
  const sales = objects.find(o => o.anchor?.rowKey === 'Sales revenue' && o.anchor.column === '2020' && o.metadata.sheet === 'SingleStep');
  assert.equal(sales.valueText, '110000');
  assert.equal(sales.anchor.rowIndex, 5);
  assert.equal(sales.anchor.columnIndex, 3);
  const preview = buildSharePreview({ path: 'income-statement.xlsx', content: bytes }, sales.anchor, sales.metadata);
  assert.equal(preview.rows.find(r => r.cells.some(c => c.cited)).rowNumber, 5);
  assert.equal(preview.rows.flatMap(r => r.cells).find(c => c.cited).value, '110000');
  assert.ok(preview.headers.includes('2020'));
  const followText = text + ' was ';
  const follow = app.dependencies.predict(project.id, { text: followText, cursor: followText.length, blockIndex: 0,
    pendingDependencies: [{ blockIndex: 0, start: 21, end: 28, sourceObjectId: candidates[0].id, sourceSnapshotId: candidates[0].snapshotId }] });
  assert.ok(follow.workspaceCompletions.length > 1);
  assert.ok(follow.workspaceCompletions.every(c => c.dependencyCandidate.path === 'income-statement.xlsx'));
  console.log(JSON.stringify({ status: 'passed', workbookSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    suggestionCount: candidates.length, labels: candidates.map(c => c.label), followOnCount: follow.workspaceCompletions.length,
    exactCellPreview: 'SingleStep!D5', checks: ['Shared string decoding', 'Five revenue alternatives', 'No inferred metadata in name suggestions', 'Exact source cell and period heading', 'Linked-source follow-up choices'],
    liveWindowsInteractionTested: false }, null, 2));
} finally { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }
