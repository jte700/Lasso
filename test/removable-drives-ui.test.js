import test from 'node:test';
import assert from 'node:assert/strict';
import { compactDrivePaths } from '../public/removable-drives.js';

test('drive folder selections collapse descendants while retaining unrelated sibling scopes', () => {
  assert.deepEqual(compactDrivePaths(['Notes/2026', 'Research/Methods', 'Research', 'Research', 'Research-old', 'Notes/2025']), ['Research', 'Notes/2025', 'Notes/2026', 'Research-old']);
});

test('whole-drive indexing dominates all folder selections without confusing similar names', () => {
  assert.deepEqual(compactDrivePaths(['Data', 'Database', 'Data/Raw']), ['Data', 'Database']);
  assert.deepEqual(compactDrivePaths(['Data/Raw', '.', 'Research']), ['.']);
  assert.deepEqual(compactDrivePaths([]), []);
});
