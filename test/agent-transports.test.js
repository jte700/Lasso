import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { openEngine } from '../src/agent/engine.js';
import { connect, ensureServer, openLocal } from '../src/agent/client.js';
import { discoveryPath, Lifecycle, readDiscovery, serveAgentApi } from '../src/agent/rest.js';
import { agentLibrary } from './fixtures/agent-library.js';

const CLI = fileURLToPath(new URL('../src/agent/cli.js', import.meta.url));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts `lasso-agent mcp` the way an AI host does, and speaks JSON-RPC to it. */
function startMcp(t, dataDir, scope = ['*']) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'mcp', '--data-dir', dataDir,
    ...scope.flatMap((folder) => ['--scope', folder])], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const stray = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); } else stray.push(message);
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  t.after(() => { if (child.exitCode == null) child.kill(); });
  let next = 1;
  const request = (method, params) => {
    const id = next++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  const call = async (name, args) => {
    const response = await request('tools/call', { name, arguments: args });
    return { ...response.result, value: JSON.parse(response.result.content[0].text) };
  };
  return { child, request, call, raw: (line) => child.stdin.write(`${line}\n`), stray, exited, stderr: () => stderr };
}

test('an MCP host starts Lasso on stdio, reads exact lines, and the process exits when the host disconnects', async (t) => {
  // Arrange
  const { app, dataDir } = await agentLibrary(t);
  const mcp = startMcp(t, dataDir);

  // Act
  const started = Date.now();
  const initialized = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'Test Host', version: '1' } });
  mcp.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const listed = await mcp.request('tools/list', {});
  const lines = await mcp.call('lasso_inspect', { items: [{ file: 'app.py', folder: 'Api', lines: '5-12' }] });
  const firstResultMs = Date.now() - started;
  const ambiguous = await mcp.call('lasso_inspect', { items: [{ file: 'app.py', lines: '1' }] });
  const suggestion = await mcp.call('lasso_suggest', { queries: [{ text: 'North division', fields: ['Revenue'] }] });
  const revenue = suggestion.value.results[0].candidates.find((candidate) => candidate.fields?.Revenue).fields.Revenue;
  const bound = await mcp.call('lasso_bind', { task: 'mcp-task', bind: { revenue: revenue.h }, template: 'Revenue: {{revenue}}' });
  const invalid = await mcp.call('lasso_inspect', { items: 'not a list' });
  const unknownTool = await mcp.request('tools/call', { name: 'lasso_delete', arguments: {} });
  const unknownMethod = await mcp.request('resources/list', {});
  const ping = await mcp.request('ping');
  mcp.child.stdin.end();
  const code = await mcp.exited;

  // Assert
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'lasso');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['lasso_suggest', 'lasso_inspect', 'lasso_bind']);
  assert.equal(lines.isError, undefined);
  assert.equal(lines.value.items[0].text.split('\n').length, 8);
  assert.equal(lines.value.items[0].text.split('\n')[0], 'def handle(request):');
  assert.equal(ambiguous.value.items[0].error.code, 'ambiguous');
  assert.match(bound.value.text, /^Revenue: (12\.4|11\.9) \[1\]$/);
  assert.equal(invalid.isError, true);
  assert.equal(invalid.value.error.code, 'invalid_request');
  assert.equal(unknownTool.error.code, -32602);
  assert.equal(unknownMethod.error.code, -32601);
  assert.deepEqual(ping.result, {});
  assert.equal(code, 0, mcp.stderr());
  assert.ok(firstResultMs < 5000, `first result after ${firstResultMs} ms`);
  const recorded = app.db.prepare(`SELECT a.id, a.actor_type FROM agent_bindings b JOIN actors a ON a.id = b.actor_id
    WHERE b.task_id = 'mcp-task'`).get();
  assert.deepEqual({ ...recorded }, { id: 'agent:mcp:test-host', actor_type: 'AI_AGENT' });
});

test('an MCP host is answered in the newest protocol version Lasso knows when it asks for an unknown one, and cancellations are honoured', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const mcp = startMcp(t, dataDir);

  // Act
  const initialized = await mcp.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'Old' } });
  mcp.raw([
    JSON.stringify({ jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'lasso_suggest', arguments: { queries: [{ text: 'grant' }] } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'slow' } }),
  ].join('\n'));
  mcp.raw('{not json');
  const after = await mcp.request('ping');
  await wait(50);
  mcp.child.stdin.end();
  await mcp.exited;

  // Assert
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(after.result, {});
  assert.ok(!mcp.stray.some((message) => message.id === 'slow'), 'a cancelled request gets no response');
  assert.ok(mcp.stray.some((message) => message.error?.code === -32700), 'a malformed line is a parse error');
});

test('an MCP server launched without a scope explains how to share folders instead of answering', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const mcp = startMcp(t, dataDir, []);

  // Act
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Host' } });
  const refused = await mcp.call('lasso_suggest', { queries: [{ text: 'grant' }] });
  mcp.child.stdin.end();
  await mcp.exited;

  // Assert
  assert.equal(refused.isError, true);
  assert.equal(refused.value.error.code, 'scope_not_configured');
});

test('the REST API refuses requests without its token, from web pages, or addressed to another host', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const served = await serveAgentApi({ dataDir, scope: ['*'], open: () => openEngine({ dataDir, scope: ['*'] }), idleSeconds: 0, log: () => {} });
  t.after(() => served.stop('test over'));
  const body = JSON.stringify({ items: [{ file: 'app.py', folder: 'Api', lines: '1' }] });
  const post = (headers) => fetch(`${served.url}/agent/v1/inspect`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  const token = { authorization: `Bearer ${served.token}` };

  // Act
  const anonymous = await post({});
  const wrongToken = await post({ authorization: 'Bearer nope' });
  const fromPage = await post({ ...token, origin: 'https://example.com' });
  const crossSite = await post({ ...token, 'sec-fetch-site': 'cross-site' });
  // fetch never sends a Host of the caller's choosing; a rebound DNS name does.
  const rebound = await new Promise((resolve, reject) => {
    const sent = http.request(`${served.url}/agent/v1/inspect`, { method: 'POST',
      headers: { ...token, host: 'attacker.example', 'content-type': 'application/json' } }, (response) => {
      response.resume();
      resolve({ status: response.statusCode });
    });
    sent.on('error', reject);
    sent.end(body);
  });
  const allowed = await post(token);
  const second = await serveAgentApi({ dataDir, scope: ['*'], open: () => { throw new Error('must not open'); }, log: () => {} });

  // Assert
  assert.equal(anonymous.status, 401);
  assert.equal(wrongToken.status, 401);
  assert.equal(fromPage.status, 403);
  assert.equal(crossSite.status, 403);
  assert.equal(rebound.status, 403);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).items[0].text, 'import json');
  assert.equal(second, null, 'one server per library');
  assert.equal(fs.statSync(discoveryPath(dataDir)).mode & 0o777, 0o600, 'the token file is readable by its owner only');
  assert.equal(served.url.startsWith('http://127.0.0.1:'), true);
});

test('REST, MCP and in-process calls give the same answer for the same request', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const request = { queries: [{ id: 'a', text: 'North division', fields: ['Revenue', 'Scenario'] }, { id: 'b', text: 'app.py', kind: 'file' },
    { id: 'c', text: 'grant', kind: 'passage' }] };
  const served = await serveAgentApi({ dataDir, scope: ['*'], open: () => openEngine({ dataDir, scope: ['*'] }), idleSeconds: 0, log: () => {} });
  t.after(() => served.stop('test over'));
  const local = openLocal({ dataDir, scope: ['*'] });
  t.after(() => local.close());
  const mcp = startMcp(t, dataDir);
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Host' } });

  // Act
  const viaRest = await (await fetch(`${served.url}/agent/v1/suggest`, { method: 'POST',
    headers: { authorization: `Bearer ${served.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request) })).json();
  const viaMcp = (await mcp.call('lasso_suggest', request)).value;
  const inProcess = local.suggest(request);
  mcp.child.stdin.end();
  await mcp.exited;

  // Assert
  assert.deepEqual(viaRest, inProcess);
  assert.deepEqual(viaMcp, inProcess);
});

test('a leased REST server outlives its idle time, then stops by itself and removes its address once released', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  const served = await serveAgentApi({ dataDir, scope: ['*'], open: () => openEngine({ dataDir, scope: ['*'] }), idleSeconds: 0.4, log: () => {} });
  t.after(() => served.stop('test over'));
  const headers = { authorization: `Bearer ${served.token}`, 'content-type': 'application/json' };
  const lease = await (await fetch(`${served.url}/agent/v1/leases`, { method: 'POST', headers, body: '{"ttl_ms":5000}' })).json();

  // Act
  await wait(1200);
  const whileLeased = await fetch(`${served.url}/agent/v1/status`, { headers });
  const refusedStop = await fetch(`${served.url}/agent/v1/shutdown`, { method: 'POST', headers: { ...headers, authorization: headers.authorization }, body: '{}' });
  await fetch(`${served.url}/agent/v1/leases/${lease.lease}`, { method: 'DELETE', headers });
  await wait(1500);

  // Assert
  assert.equal(whileLeased.status, 200);
  assert.equal((await whileLeased.json()).server.leases, 1);
  assert.equal(refusedStop.status, 409, 'a client holding a lease keeps the server');
  assert.equal(served.server.listening, false, 'stopped once idle and unleased');
  assert.equal(fs.existsSync(discoveryPath(dataDir)), false);
  assert.equal(readDiscovery(dataDir), null);
});

test('a client starts the REST server on demand, a second client reuses it, and stop ends it', async (t) => {
  // Arrange
  const { dataDir } = await agentLibrary(t);
  t.after(async () => {
    const record = readDiscovery(dataDir);
    if (record) try { process.kill(record.pid); } catch { /* gone */ }
  });

  // Act
  const first = await connect({ dataDir, scope: ['*'], idleSeconds: 30, client: 'script-a' });
  const second = await connect({ dataDir, scope: ['*'], idleSeconds: 30, client: 'script-b' });
  const read = await second.inspect({ items: [{ file: 'src/server.js', lines: '3' }] });
  const status = await first.status();
  await assert.rejects(ensureServer({ dataDir, scope: ['Api'] }), /already running/);
  await first.close();
  await second.close();
  const stopped = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'stop', '--data-dir', dataDir]);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('exit', () => resolve(JSON.parse(output)));
  });
  let gone = false;
  for (let attempt = 0; attempt < 60 && !gone; attempt += 1) {
    await wait(50);
    gone = readDiscovery(dataDir) === null;
  }

  // Assert
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(second.pid, first.pid);
  assert.equal(read.items[0].text, 'export function start(port) {');
  assert.equal(status.server.leases, 2);
  assert.equal(stopped.stopping, true);
  assert.equal(gone, true);
});

test('a lifecycle is idle only with no request in flight, no live lease, and its idle time passed', () => {
  // Arrange
  let clock = 0;
  const lifecycle = new Lifecycle({ idleMs: 1000, now: () => clock });

  // Act and assert
  lifecycle.begin();
  clock = 5000;
  assert.equal(lifecycle.idle(), false, 'a request is in flight');
  lifecycle.end();
  const { lease } = lifecycle.lease(2000);
  clock = 6500;
  assert.equal(lifecycle.idle(), false, 'leased');
  clock = 7500;
  assert.equal(lifecycle.idle(), true, 'the lease expired and the idle time passed');
  assert.equal(lifecycle.renew(lease), null, 'an expired lease cannot be renewed');
});
