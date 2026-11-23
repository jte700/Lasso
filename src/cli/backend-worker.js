// The interactive CLI's library, opened in a worker thread so the shell
// keeps drawing while a question is answered. Requests are answered one at
// a time, in order, as { type: 'reply', id, value | error }.

import { parentPort, workerData } from 'node:worker_threads';
import { openBackend } from './backend.js';

let backend;
try {
  backend = openBackend(workerData);
  parentPort.postMessage({ type: 'ready', dataDir: backend.dataDir });
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: error.message });
  process.exit(0);
}

let queue = Promise.resolve();
parentPort.on('message', (message) => {
  if (message?.type === 'close') {
    queue = queue.then(() => {
      backend.close();
      process.exit(0);
    });
    return;
  }
  queue = queue.then(async () => {
    try {
      const value = await backend.call(message.method, ...(message.args ?? []));
      parentPort.postMessage({ type: 'reply', id: message.id, value: plain(value) });
    } catch (error) {
      parentPort.postMessage({ type: 'reply', id: message.id, error: error.message ?? String(error), status: error.status ?? null });
    }
  });
});

/** Results cross threads as JSON: no functions, no class instances. */
const plain = (value) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));
