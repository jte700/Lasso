import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.js';

const createdAt = '2026-10-01T09:15:00.000Z';
const closesAt = '2026-10-03T09:15:00.000Z';
const earlier = '2026-10-02T00:00:00.000Z';

/// A store from before the 48-hour limit, holding links that never expire,
/// links that outlast the limit, and a link that already closes sooner.
function legacyStore(databasePath) {
  const db = new DatabaseSync(databasePath);
  for (const name of fs.readdirSync('migrations').sort().filter((name) => Number(name.split('_')[0]) < 23)) {
    db.exec(fs.readFileSync(path.join('migrations', name), 'utf8'));
  }
  // The grants stand alone; their projects and sources do not matter here.
  db.exec('PRAGMA foreign_keys = OFF');
  const objectGrant = db.prepare(`
    INSERT INTO object_share_grants(id, project_id, object_id, object_version_id, token, created_by_actor_id, created_at, expires_at)
    VALUES (?, 'project', 'object', 'version', ?, 'actor', ?, ?)
  `);
  const dependencyGrant = db.prepare(`
    INSERT INTO dependency_share_grants(id, dependency_id, token, access_scope, created_by_actor_id, created_at, expires_at)
    VALUES (?, 'dependency', ?, 'CONTEXT', 'actor', ?, ?)
  `);
  for (const [token, expiresAt] of [['never', null], ['month', '2026-10-31T09:15:00.000Z'], ['sooner', earlier]]) {
    objectGrant.run(`object-${token}`, `object-${token}`, createdAt, expiresAt);
    dependencyGrant.run(`dependency-${token}`, `dependency-${token}`, createdAt, expiresAt);
  }
  db.close();
}

test('existing share links close 48 hours after they were made', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-share-lifetime-'));
  const databasePath = path.join(root, 'test.sqlite');
  legacyStore(databasePath);
  const db = openDatabase({ databasePath });
  try {
    for (const table of ['object_share_grants', 'dependency_share_grants']) {
      const expiry = Object.fromEntries(db.prepare(`SELECT token, expires_at FROM ${table}`).all()
        .map((row) => [row.token.replace(/^\w+-/, ''), row.expires_at]));
      assert.deepEqual(expiry, { never: closesAt, month: closesAt, sooner: earlier }, table);
    }
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
