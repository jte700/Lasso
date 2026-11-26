// Shared by the connected-app tests: a network answered from a table of
// handlers, an application on a scratch data folder, and a wait for a sync.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplication } from '../../src/server.js';

/** A network that answers from a table of handlers, recording what was asked. */
export function network(routes) {
  const calls = [];
  const fetch = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    const route = routes.find(([pattern]) => (typeof pattern === 'string' ? url.startsWith(pattern) : pattern.test(url)));
    if (!route) return new Response(JSON.stringify({ error: { message: `No route for ${url}` } }), { status: 404 });
    const answer = await route[1](url, options);
    if (answer instanceof Response) return answer;
    return new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), {
      status: 200, headers: { 'content-type': typeof answer === 'string' ? 'text/calendar' : 'application/json' } });
  };
  return { fetch, calls };
}

export async function application(t, fetch, overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lasso-connections-'));
  const app = createApplication({ dataDir, watchProjects: false, syncConnections: false, notionSpacingMs: 0,
    connectorApps: {}, fetch, port: 4319, ...overrides });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, dataDir };
}

export async function settled(app, id) {
  for (let attempt = 0; attempt < 200; attempt++) {
    await app.connections.syncing.get(id)?.catch(() => {});
    const connection = app.workspace.state().connections.find((entry) => entry.id === id);
    if (connection && !['syncing', 'connecting'].includes(connection.status)) return connection;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The connection did not finish syncing.');
}
