import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.js';
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
   assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,15);
   assert.ok(db.prepare('PRAGMA table_info(object_share_grants)').all().some(c=>c.name==='access_scope'));
   assert.ok(db.prepare('PRAGMA table_info(recommendation_usage)').all().length);
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
   db.close();db=openDatabase({databasePath});
   assert.equal(db.prepare('SELECT value FROM migration_probe').get().value,'preserved');
  } finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
 });
}
