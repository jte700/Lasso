// The Ranch, the Mac app's library window. Read-only apart from visits.

import { downloadDisposition } from '../sharing/share-download.js';
import { readJson, sendJson, sendBinary } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function ranchRoutes({ request, response, url, pathname, ranch }) {
  await (async () => {
    // The Ranch, the Mac app's library window. Read-only apart from visits.
    if (ranch && pathname.startsWith('/api/ranch')) {
      if (request.method === 'GET' && pathname === '/api/ranch') {
        // The window asks every few seconds; an unchanged library is not sent again.
        const { value, tag } = ranch.current();
        if (request.headers['if-none-match'] === tag) {
          response.writeHead(304, { etag: tag, 'cache-control': 'no-cache' });
          return response.end();
        }
        const body = JSON.stringify(value);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body), 'cache-control': 'no-cache', etag: tag });
        return response.end(body);
      }
      if (request.method === 'POST' && pathname === '/api/ranch/visits') {
        return sendJson(response, 200, { visit: ranch.recordVisit(await readJson(request, 16 * 1024)) });
      }
      const file = { directoryId: url.searchParams.get('directory'), path: url.searchParams.get('path') };
      if (request.method === 'GET' && pathname === '/api/ranch/share-target') {
        return sendJson(response, 200, { target: ranch.shareTarget(file) });
      }
      if (request.method === 'GET' && pathname === '/api/ranch/sheet') {
        return sendJson(response, 200, ranch.sheet({ ...file, version: url.searchParams.get('version') }));
      }
      if (request.method === 'GET' && pathname === '/api/ranch/passages') {
        return sendJson(response, 200, ranch.passages(file));
      }
      if (request.method === 'GET' && pathname === '/api/ranch/file') {
        // Saved as a file for Quick Look, never shown as a page of this origin.
        const copy = ranch.fileContent(file);
        return sendBinary(response, 200, copy.content, 'application/octet-stream', {
          'content-disposition': downloadDisposition(copy.name),
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
        });
      }
    }
  })();
  return response.headersSent || response.writableEnded;
}
