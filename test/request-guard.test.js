import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../src/server.js';

async function startApp(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-guard-'));
  const folder = path.join(sandbox, 'Client-Files');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'notes.md'), '# Notes\n');
  const app = createApplication({ dataDir: path.join(sandbox, 'data'), watchProjects: false, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return { app, folder, port: app.server.address().port };
}

function send(port, { method = 'GET', pathname, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, method, path: pathname,
      headers: { ...(payload ? { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } },
    (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const actor = { id: 'human:test', displayName: 'Test', actorType: 'HUMAN_SELF' };

test('a web page on another site cannot add a work directory', async (t) => {
  // Arrange
  const { app, folder, port } = await startApp(t);

  // Act: a cross-site "simple" POST needs no CORS preflight.
  const response = await send(port, { method: 'POST', pathname: '/api/workspace/directories',
    headers: { origin: 'http://attacker.example' }, body: { rootPaths: [folder], actor } });

  // Assert
  assert.equal(response.status, 403);
  assert.equal(app.workspace.projects().length, 0);
});

test('a rebound hostname cannot read the local API', async (t) => {
  const { port } = await startApp(t);
  const response = await send(port, { pathname: '/api/workspace', headers: { host: `attacker.example:${port}` } });
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.text, /Client-Files/);
});

test('the browser workspace and the desktop app keep working', async (t) => {
  const { app, folder, port } = await startApp(t);
  const fromBrowser = await send(port, { method: 'POST', pathname: '/api/workspace/directories',
    headers: { origin: `http://127.0.0.1:${port}` }, body: { rootPaths: [folder], actor } });
  const fromDesktopApp = await send(port, { pathname: '/api/workspace', headers: { host: `localhost:${port}` } });
  assert.equal(fromBrowser.status, 200);
  assert.equal(fromDesktopApp.status, 200);
  assert.equal(app.workspace.projects().length, 1);
});

test('a local page on a different port is treated as another site', async (t) => {
  const { port } = await startApp(t);
  const response = await send(port, { method: 'POST', pathname: '/api/workspace/directories',
    headers: { origin: 'http://localhost:5173' }, body: { rootPaths: ['/tmp'], actor } });
  assert.equal(response.status, 403);
});

test('share pages stay reachable through a configured share address', async (t) => {
  const { port } = await startApp(t);
  const response = await send(port, { pathname: '/d/AAAAAAAAAAAAAAAAAAAAAAAA', headers: { host: 'share.example.com' } });
  assert.notEqual(response.status, 403);
});

test('the workspace page cannot be framed by another site', async (t) => {
  const { port } = await startApp(t);
  const response = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, resolve).on('error', reject);
  });
  response.resume();
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
});
