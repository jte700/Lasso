import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.js';
const latestVersion = Math.max(...fs.readdirSync('migrations').map(name => Number(name.split('_')[0])).filter(Number.isFinite));
for (const branch of ['recommendations', 'share-scopes']) {
 test(`upgrades existing migration 014 from ${branch} without losing data`, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-migration-'));
  const databasePath=path.join(root,'test.sqlite');
  let db=new DatabaseSync(databasePath);
  try {
   for (const name of fs.readdirSync('migrations').sort().filter(name=>Number(name.split('_')[0])<14)) db.exec(fs.readFileSync(path.join('migrations',name),'utf8'));
   const migration=branch==='recommendations'?'014_recommendation_usage.sql':'015_scoped_object_shares.sql';
   db.exec(fs.readFileSync(path.join('migrations',migration),'utf8').replace('VALUES (15,','VALUES (14,'));
   db.exec('CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES (\'preserved\')');
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,latestVersion);
   assert.ok(db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='workspace_active'));
   assert.ok(db.prepare('PRAGMA table_info(snapshot_object_indexes)').all().some(c=>c.name==='drawing_index_version'));
   assert.ok(db.prepare('PRAGMA table_info(object_share_grants)').all().some(c=>c.name==='access_scope'));
   assert.ok(db.prepare('PRAGMA table_info(recommendation_usage)').all().length);
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
}

for (const branch of ['workspace', 'drawings']) {
 test(`upgrades migration 016 from ${branch} and preserves both schemas`, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-migration-'));
  const databasePath=path.join(root,'test.sqlite');
  let db=new DatabaseSync(databasePath);
  try {
   for (const name of fs.readdirSync('migrations').sort().filter(name=>Number(name.split('_')[0])<16)) db.exec(fs.readFileSync(path.join('migrations',name),'utf8'));
   const migration=branch==='workspace'?'016_active_workspace.sql':'017_drawing_index.sql';
   db.exec(fs.readFileSync(path.join('migrations',migration),'utf8').replace('VALUES (17,','VALUES (16,'));
   db.exec("CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('preserved')");
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,latestVersion);
   assert.ok(db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='workspace_active'));
   assert.ok(db.prepare('PRAGMA table_info(snapshot_object_indexes)').all().some(c=>c.name==='drawing_index_version'));
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
}

for (const version of [17, 18]) {
 test(`upgrades a database from the external-drives branch at ${version} without replaying its schema`, () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-migration-'));
  const databasePath=path.join(root,'test.sqlite');
  let db=new DatabaseSync(databasePath);
  try {
   // That branch numbered drawing index, spreadsheet coordinates and
   // removable drives 016, 017 and 018 (now 017, 021 and 022).
   for (const name of fs.readdirSync('migrations').sort().filter(name=>Number(name.split('_')[0])<16)) db.exec(fs.readFileSync(path.join('migrations',name),'utf8'));
   const legacy=[['017_drawing_index.sql',17,16],['021_spreadsheet_coordinates.sql',21,17],['022_removable_drives.sql',22,18]].filter(([, , old])=>old<=version);
   for (const [name,current,old] of legacy) db.exec(fs.readFileSync(path.join('migrations',name),'utf8').replace(`VALUES (${current},`,`VALUES (${old},`));
   db.exec("CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('preserved')");
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,latestVersion);
   const columns=table=>db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
   assert.ok(columns('projects').includes('workspace_active'));
   assert.ok(columns('snapshot_object_indexes').includes('drawing_index_version'));
   assert.ok(columns('snapshot_object_indexes').includes('spreadsheet_index_version'));
   assert.ok(columns('object_share_grants').includes('excerpt_json'));
   assert.ok(columns('removable_drives').length && columns('drive_projects').length);
   assert.deepEqual(db.prepare('SELECT version FROM schema_migrations WHERE version >= 16 ORDER BY version').all().map(r=>r.version),
     Array.from({length:latestVersion-15},(_,i)=>i+16));
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
}

test('upgrades a Windows companion store whose migration 018 added the reader column', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-migration-'));
  const databasePath=path.join(root,'test.sqlite');
  let db=new DatabaseSync(databasePath);
  try {
   // That branch applied 001-015, its drawing index as 016, and the reader column as 018.
   for (const name of fs.readdirSync('migrations').sort().filter(name=>Number(name.split('_')[0])<16)) db.exec(fs.readFileSync(path.join('migrations',name),'utf8'));
   db.exec(fs.readFileSync(path.join('migrations','017_drawing_index.sql'),'utf8').replace('VALUES (17,','VALUES (16,'));
   db.exec(`ALTER TABLE snapshot_object_indexes ADD COLUMN extractor_version INTEGER NOT NULL DEFAULT 0;
     INSERT INTO schema_migrations(version, applied_at) VALUES (18, '2026-10-18T00:00:00Z');
     CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('preserved');`);
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,latestVersion);
   assert.ok(db.prepare('PRAGMA table_info(projects)').all().some(c=>c.name==='workspace_active'), 'the folder toggle column is added');
   assert.ok(db.prepare('PRAGMA table_info(snapshot_object_indexes)').all().some(c=>c.name==='extractor_version'));
   assert.ok(db.prepare('PRAGMA table_info(object_share_grants)').all().some(c=>c.name==='excerpt_json'), 'later migrations still apply');
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('a store from either branch ends with the reader column', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lasso-migration-'));
  const db=openDatabase({databasePath:path.join(root,'fresh.sqlite')});
  try {
   assert.ok(db.prepare('PRAGMA table_info(snapshot_object_indexes)').all().some(c=>c.name==='extractor_version'));
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
});
