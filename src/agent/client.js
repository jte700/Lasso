// Using Lasso's evidence service from Node, with or without a server.
//
//   openLocal()  runs the engine inside the calling process: no port, no
//                token, gone when the caller closes it.
//   connect()    reaches the shared REST server for the library, starting it
//                first if it is not running, and holds a lease on it until
//                close() so it is not stopped while this client needs it.
//
// Both return the same four methods, answered by the same service.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEngine, resolveDataDir } from './engine.js';
import { slugActor } from './identity.js';
import { readDiscovery } from './rest.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));
const sameScope = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

export function openLocal({ dataDir = null, scope, client = 'node' } = {}) {
  const engine = openEngine({ dataDir: resolveDataDir(dataDir), scope });
  const actor = slugActor(`agent:local:${client}`, `${client} (in process)`);
  const run = (operation) => (body = {}) => engine.metrics.measure(operation, 'local', () => engine.evidence[operation](body, actor));
  return { ask: run('ask'), suggest: run('suggest'), inspect: run('inspect'), bind: run('bind'), status: () => engine.evidence.status(),
    metrics: () => engine.metrics.snapshot(), engine, close: async () => engine.close() };
}

async function healthy(record, timeoutMs = 1500) {
  try {
    const response = await fetch(`${record.url}/agent/v1/status`, { headers: { authorization: `Bearer ${record.token}` },
      signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch { return false; }
}

/**
 * The library's running REST server, started in the background when there is
 * none. The server outlives this call; it stops itself once idle.
 */
export async function ensureServer({ dataDir = null, scope, idleSeconds = 300, timeoutMs = 20_000 } = {}) {
  const library = resolveDataDir(dataDir);
  const running = readDiscovery(library);
  if (running && await healthy(running)) {
    if (!sameScope(running.scope ?? [], scope ?? [])) {
      throw new Error(`Lasso's agent API is already running for this library with scope ${JSON.stringify(running.scope)}. `
        + 'Stop it (lasso-agent stop) or use the same scope.');
    }
    return { ...running, started: false };
  }
  const logFile = path.join(library, 'agent', 'rest.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const log = fs.openSync(logFile, 'a', 0o600);
  const args = ['--disable-warning=ExperimentalWarning', CLI, 'serve', '--data-dir', library, '--idle', String(idleSeconds),
    ...(scope ?? []).flatMap((folder) => ['--scope', folder])];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = readDiscovery(library);
    if (record && await healthy(record)) return { ...record, started: record.pid === child.pid };
    if (child.exitCode != null && child.exitCode !== 0) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Lasso's agent API did not start; see ${logFile}.`);
}

export async function connect({ dataDir = null, scope, idleSeconds = 300, client = 'node', lease = true } = {}) {
  const record = await ensureServer({ dataDir, scope, idleSeconds });
  const headers = { authorization: `Bearer ${record.token}`, 'content-type': 'application/json', 'x-lasso-client': client };
  const call = async (method, route, body) => {
    const response = await fetch(`${record.url}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value?.error?.message ?? `Lasso answered ${response.status}.`);
      Object.assign(error, { status: response.status, code: value?.error?.code, details: value?.error });
      throw error;
    }
    return value;
  };
  let held = null;
  let renewal = null;
  if (lease) {
    held = await call('POST', '/agent/v1/leases', { ttl_ms: 60_000 });
    renewal = setInterval(() => { call('PUT', `/agent/v1/leases/${held.lease}`, { ttl_ms: 60_000 }).catch(() => {}); }, 20_000);
    renewal.unref();
  }
  return {
    url: record.url,
    pid: record.pid,
    started: record.started,
    ask: (body) => call('POST', '/agent/v1/ask', body),
    suggest: (body) => call('POST', '/agent/v1/suggest', body),
    inspect: (body) => call('POST', '/agent/v1/inspect', body),
    bind: (body) => call('POST', '/agent/v1/bind', body),
    status: () => call('GET', '/agent/v1/status'),
    metrics: () => call('GET', '/agent/v1/metrics'),
    async close() {
      clearInterval(renewal);
      if (held) await call('DELETE', `/agent/v1/leases/${held.lease}`).catch(() => {});
    },
  };
}

