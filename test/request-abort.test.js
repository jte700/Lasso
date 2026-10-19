import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

test('a request the client cancels mid-upload is not logged as a server error', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-abort-'));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  const logged = [];
  const original = console.error;
  console.error = (...values) => logged.push(values);
  t.after(async () => { console.error = original; await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const request = http.request({ host: '127.0.0.1', port: app.server.address().port, method: 'POST',
    path: '/api/workspace/dependencies/predict', headers: { 'content-type': 'application/json', 'content-length': 1000 } });
  request.on('error', () => {});
  request.write('{"text":"The expected cost of');
  await new Promise((resolve) => setTimeout(resolve, 50));
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(logged, []);
});

test('a malformed percent-encoded path is a client error, not a logged server failure', async (t) => {
  // Arrange
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-uri-'));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  const logged = [];
  const original = console.error;
  console.error = (...values) => logged.push(values);
  t.after(async () => { console.error = original; await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));

  // Act
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/projects/%E0%A4%A`);

  // Assert
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /not a valid address/i);
  assert.deepEqual(logged, []);
});

test('a JSON body that is not an object is a client error', async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-body-'));
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  const logged = [];
  const original = console.error;
  console.error = (...values) => logged.push(values);
  t.after(async () => { console.error = original; await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/workspace/directories`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  assert.equal(response.status, 400);
  assert.deepEqual(logged, []);
});
