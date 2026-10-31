// Lasso's local REST API for scripts, apps and custom agents. It is started
// on demand (`lasso-agent ensure`, or the Node client), answers on loopback
// only, and stops by itself once no request has arrived for its idle time and
// no client holds a lease on it. A client that needs it to stay up between
// requests takes a lease and renews it; the server never stops under one.
//
// Loopback is not a boundary by itself: any local page can send requests to
// 127.0.0.1. Every request therefore needs the bearer token written to the
// data folder (readable by this user only), and any request a browser marks
// as coming from a page (an Origin or Sec-Fetch-Site header) is refused.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { errorBody } from './errors.js';
import { slugActor } from './identity.js';
import { formatAnswer } from './render.js';

const BODY_LIMIT = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const DEFAULT_LEASE_MS = 60_000;
const MAX_LEASE_MS = 10 * 60_000;
const SHUTDOWN_DEADLINE_MS = 2500;

export const discoveryPath = (dataDir) => path.join(dataDir, 'agent', 'rest.json');
const lockPath = (dataDir) => path.join(dataDir, 'agent', 'rest.lock');

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

/** The running server's address and token, or null when none is recorded or its process is gone. */
export function readDiscovery(dataDir) {
  try {
    const record = JSON.parse(fs.readFileSync(discoveryPath(dataDir), 'utf8'));
    return processAlive(record.pid) ? record : null;
  } catch { return null; }
}

function writePrivate(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, contents, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Takes the one-server-per-library lock, clearing a lock whose process has gone. */
function acquireLock(dataDir) {
  const file = lockPath(dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file, { force: true }); } catch { /* gone */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(file, 'utf8'));
      if (processAlive(holder)) return null;
      fs.rmSync(file, { force: true });
    }
  }
  return null;
}

/** Counts requests in flight and live leases; reports idle once both are zero for `idleMs`. */
export class Lifecycle {
  constructor({ idleMs, now = Date.now }) {
    this.idleMs = idleMs;
    this.now = now;
    this.inFlight = 0;
    this.leases = new Map();
    this.lastActivity = now();
  }

  begin() { this.inFlight += 1; this.lastActivity = this.now(); }
  end() { this.inFlight -= 1; this.lastActivity = this.now(); }

  lease(ttlMs = DEFAULT_LEASE_MS, id = crypto.randomUUID()) {
    const ttl = Math.min(MAX_LEASE_MS, Math.max(1000, Number(ttlMs) || DEFAULT_LEASE_MS));
    this.leases.set(id, this.now() + ttl);
    return { lease: id, ttl_ms: ttl };
  }

  renew(id, ttlMs) { return this.leases.has(id) ? this.lease(ttlMs, id) : null; }
  release(id) { return this.leases.delete(id); }

  liveLeases() {
    const at = this.now();
    for (const [id, expires] of this.leases) if (expires <= at) this.leases.delete(id);
    return this.leases.size;
  }

  idle() {
    return this.idleMs > 0 && this.inFlight === 0 && this.liveLeases() === 0 && this.now() - this.lastActivity >= this.idleMs;
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) return { error: [413, 'Request body is too large.'] };
    chunks.push(chunk);
  }
  if (!chunks.length) return { value: {} };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: [400, 'Request body must be a JSON object.'] };
    return { value };
  } catch {
    return { error: [400, 'Request body must be valid JSON.'] };
  }
}

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

function sendText(response, text) {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(text);
}

function authorized(request, token) {
  const header = String(request.headers.authorization ?? '');
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function refused(request) {
  let host = null;
  try { host = new URL(`http://${request.headers.host ?? ''}`).hostname; } catch { /* invalid */ }
  if (!LOOPBACK.has(host)) return 'Lasso only answers requests addressed to this computer.';
  const site = request.headers['sec-fetch-site'];
  if (request.headers.origin !== undefined || (site && site !== 'none')) return 'Requests from web pages are not allowed.';
  return null;
}

/**
 * The request handler: one route per evidence operation, plus status,
 * metrics, leases and shutdown. `engine` supplies the shared service.
 */
export function createAgentHandler({ engine, token, lifecycle, onShutdown = () => {}, startedAt = new Date().toISOString() }) {
  return async (request, response) => {
    lifecycle.begin();
    try {
      const reason = refused(request);
      if (reason) return send(response, 403, { error: { code: 'forbidden', message: reason } });
      if (!authorized(request, token)) return send(response, 401, { error: { code: 'unauthenticated', message: 'A valid bearer token is required.' } });
      const { pathname } = new URL(request.url, 'http://127.0.0.1');
      const client = String(request.headers['x-lasso-client'] ?? 'client').slice(0, 60);
      const actor = slugActor(`agent:rest:${client}`, `${client} (REST)`);
      const route = `${request.method} ${pathname}`;
      const operation = { 'POST /agent/v1/ask': 'ask', 'POST /agent/v1/suggest': 'suggest', 'POST /agent/v1/inspect': 'inspect',
        'POST /agent/v1/bind': 'bind' }[route];
      if (operation) {
        const body = await readBody(request);
        if (body.error) return send(response, body.error[0], { error: { code: 'invalid_request', message: body.error[1] } });
        const value = engine.metrics.measure(operation, 'rest', () => engine.evidence[operation](body.value, actor));
        // JSON is the contract; "format": "text" returns the compact text an MCP host shows a model.
        if (body.value.format === 'text') return sendText(response, formatAnswer(operation, value));
        return send(response, 200, value);
      }
      if (route === 'GET /agent/v1/status') {
        return send(response, 200, { ...engine.evidence.status(), server: { pid: process.pid, startedAt,
          idleSeconds: lifecycle.idleMs / 1000, leases: lifecycle.liveLeases() } });
      }
      if (route === 'GET /agent/v1/metrics') return send(response, 200, engine.metrics.snapshot());
      if (route === 'POST /agent/v1/leases') {
        const body = await readBody(request);
        return send(response, 201, lifecycle.lease(body.value?.ttl_ms));
      }
      const leaseRoute = pathname.match(/^\/agent\/v1\/leases\/([A-Za-z0-9-]{1,64})$/);
      if (leaseRoute && request.method === 'PUT') {
        const body = await readBody(request);
        const renewed = lifecycle.renew(leaseRoute[1], body.value?.ttl_ms);
        return renewed ? send(response, 200, renewed) : send(response, 404, { error: { code: 'not_found', message: 'That lease has expired.' } });
      }
      if (leaseRoute && request.method === 'DELETE') return send(response, 200, { released: lifecycle.release(leaseRoute[1]) });
      if (route === 'POST /agent/v1/shutdown') {
        const body = await readBody(request);
        const others = lifecycle.liveLeases();
        if (others && body.value?.force !== true) {
          return send(response, 409, { error: { code: 'in_use', message: `${others} client${others === 1 ? ' holds a lease' : 's hold leases'}; pass force to stop anyway.` } });
        }
        send(response, 202, { stopping: true });
        setImmediate(onShutdown);
        return undefined;
      }
      return send(response, 404, { error: { code: 'not_found', message: `No route for ${route}.` } });
    } catch (error) {
      const body = errorBody(error);
      return send(response, error?.status ?? (body.code === 'internal' ? 500 : 400), { error: body });
    } finally {
      lifecycle.end();
    }
  };
}

/**
 * Starts the API for one library and records where it listens. Resolves to
 * null when another server already serves that library.
 *
 * @param {{ dataDir: string, scope: string[], open: () => object, idleSeconds?: number, port?: number,
 *   log?: (message: string) => void }} options
 */
export async function serveAgentApi({ dataDir, scope, open, idleSeconds = 300, port = 0, log = console.error }) {
  const release = acquireLock(dataDir);
  if (!release) return null;
  let engine;
  try {
    engine = open();
  } catch (error) {
    release();
    throw error;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const lifecycle = new Lifecycle({ idleMs: Math.max(0, idleSeconds) * 1000 });
  const startedAt = new Date().toISOString();
  let stopping = null;
  let timer = null;
  const server = http.createServer();
  const stop = (why) => {
    if (stopping) return stopping;
    log(`Lasso agent API stopping: ${why}.`);
    clearInterval(timer);
    stopping = new Promise((resolve) => {
      const finish = () => {
        try {
          const recorded = JSON.parse(fs.readFileSync(discoveryPath(dataDir), 'utf8'));
          if (recorded.pid === process.pid) fs.rmSync(discoveryPath(dataDir), { force: true });
        } catch { /* already gone */ }
        try { engine.close(); } catch (error) { log(`Closing Lasso failed: ${error.message}`); }
        release();
        resolve();
      };
      server.close(finish);
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), SHUTDOWN_DEADLINE_MS).unref();
    });
    return stopping;
  };
  server.on('request', createAgentHandler({ engine, token, lifecycle, startedAt, onShutdown: () => stop('asked to stop') }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const record = { version: 1, pid: process.pid, url: `http://127.0.0.1:${address.port}`, port: address.port, token,
    scope, dataDir, startedAt, idleSeconds };
  writePrivate(discoveryPath(dataDir), JSON.stringify(record));
  timer = setInterval(() => { if (lifecycle.idle()) stop(`idle for ${idleSeconds}s`); },
    Math.max(250, Math.min(5000, lifecycle.idleMs / 4 || 5000)));
  timer.unref();
  return { ...record, server, engine, lifecycle, stop };
}
