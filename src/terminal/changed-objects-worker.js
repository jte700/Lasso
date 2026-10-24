// Reads which objects changed in value history, off the server's thread. A
// folder's whole history, or a large re-reading of it, means reading every
// version involved, which takes a minute on a slow disk; the server keeps
// answering meanwhile and takes the answer as if it had read it itself.

import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { readChangedObjects } from './changed-objects.js';

const { databasePath, filter, parameters, since } = workerData;
const db = new DatabaseSync(databasePath, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout = 5000');
  // One read transaction, so the newest row read is the one the answer is as of.
  db.exec('BEGIN');
  const read = readChangedObjects(db, filter, parameters, since);
  db.exec('COMMIT');
  parentPort.postMessage(read);
} finally {
  db.close();
}
