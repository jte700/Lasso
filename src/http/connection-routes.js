// Connected apps: the page a sign-in returns to, and the routes that list,
// configure, sync and remove them.

import { readJson, sendJson, sendHtml, match, signInPage } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function connectionRoutes({ request, response, url, pathname, connections, workspace }) {
  await (async () => {
    if (connections && request.method === 'GET' && pathname === '/connect/callback') {
      try {
        const connection = await connections.completeSignIn(Object.fromEntries(url.searchParams));
        return sendHtml(response, 200, signInPage(`${connection.providerName} is connected`,
          'Lasso is bringing in your items now. You can close this tab and return to Lasso.', true));
      } catch (error) {
        if ((error.status ?? 500) >= 500) console.error(error);
        return sendHtml(response, error.status ?? 500, signInPage('Lasso could not connect',
          (error.status ?? 500) >= 500 ? 'An unexpected error occurred. Try again from the Connect window.' : error.message, false));
      }
    }
    if (connections && pathname.startsWith('/api/connections')) {
      if (request.method === 'GET' && pathname === '/api/connections') {
        return sendJson(response, 200, { catalog: connections.catalog({ native: url.searchParams.get('native') === '1' }),
          connections: workspace.state({ pending: true }).connections });
      }
      if (request.method === 'POST' && pathname === '/api/connections') {
        return sendJson(response, 201, await connections.create(await readJson(request, 64 * 1024)));
      }
      const app = match(pathname, /^\/api\/connections\/apps\/([^/]+)$/);
      if (request.method === 'POST' && app) {
        return sendJson(response, 200, { catalog: connections.configureApp(app[0], await readJson(request, 16 * 1024)) });
      }
      const action = match(pathname, /^\/api\/connections\/([^/]+)\/(sync|sign-in|items)$/);
      if (request.method === 'POST' && action) {
        const [id, verb] = action;
        if (verb === 'sync') return sendJson(response, 200, { connection: await connections.sync(id) });
        if (verb === 'sign-in') return sendJson(response, 200, connections.reauthorize(id));
        const body = await readJson(request, 32 * 1024 * 1024);
        return sendJson(response, 200, { connection: await connections.receive(id, body.events) });
      }
      const connection = match(pathname, /^\/api\/connections\/([^/]+)$/);
      if (request.method === 'POST' && connection) {
        const body = await readJson(request, 4096);
        // The menu reads the whole workspace back, as it does for a folder's switch.
        const changed = await connections.setActive(connection[0], body.active);
        return sendJson(response, 200, { ...workspace.state({ pending: true }), connection: changed });
      }
      if (request.method === 'DELETE' && connection) {
        return sendJson(response, 200, await connections.disconnect(connection[0]));
      }
    }
  })();
  return response.headersSent || response.writableEnded;
}
