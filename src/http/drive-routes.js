// Removable drives: listing them and their folders, and recording folders on them.

import { timingSafeEqual } from 'node:crypto';
import { HttpError } from '../history/errors.js';
import { readJson, sendJson, actorFrom, match } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function driveRoutes({ request, response, url, pathname, timeline, config }) {
  await (async () => {
    if (pathname.startsWith('/api/drives') && timeline.drives) {
      // Native inventory is privileged: an arbitrary webpage cannot invent
      // a mounted volume and thereby grant access to an arbitrary folder.
      if (request.method === 'POST') {
        const origin = request.headers.origin;
        if ((origin && origin !== `http://${request.headers.host}`)
          || request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Drive actions must come from Lasso.');
      }
      if (request.method === 'POST' && pathname === '/api/drives/sync') {
        const expected = Buffer.from(config.driveToken ?? '');
        const actual = Buffer.from(String(request.headers['x-lasso-drive-token'] ?? ''));
        if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          throw new HttpError(403, 'Drive discovery requires the desktop host.');
        }
        const body = await readJson(request, 128 * 1024);
        return sendJson(response, 200, timeline.drives.sync(body.volumes));
      }
      if (request.method === 'GET' && pathname === '/api/drives') {
        return sendJson(response, 200, timeline.drives.list());
      }
      const driveRoute = match(pathname, /^\/api\/drives\/([^/]+)\/(folders|index|decision)$/);
      if (driveRoute) {
        const [driveId, operation] = driveRoute;
        if (request.method === 'GET' && operation === 'folders') {
          return sendJson(response, 200, timeline.drives.folders(driveId, url.searchParams.get('path') ?? '.'));
        }
        if (request.method === 'POST' && operation === 'index') {
          const body = await readJson(request, 128 * 1024);
          return sendJson(response, 200, timeline.drives.index(driveId, body.paths, actorFrom(body)));
        }
        if (request.method === 'POST' && operation === 'decision') {
          const body = await readJson(request, 4096);
          return sendJson(response, 200, timeline.drives.decision(driveId, body.action));
        }
      }
    }
  })();
  return response.headersSent || response.writableEnded;
}
