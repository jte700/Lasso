// What an AI wrote: the Mac app reports the writer's answers and pastes from
// AI apps, and asks which parts of a file an AI wrote, by the file's path.

import { HttpError } from '../history/errors.js';
import { readJson, sendJson } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function provenanceRoutes({ request, response, url, pathname, authorship }) {
  if (pathname === '/api/ai-record' && (request.method === 'GET' || request.method === 'PUT')) {
    // Whether Lasso writes its AI record into Word documents, whether prompts go in, and the name it signs with.
    const settings = request.method === 'PUT' ? authorship.identity.update(await readJson(request)) : authorship.identity.settings();
    sendJson(response, 200, settings);
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/ai-marks') {
    const body = await readJson(request);
    sendJson(response, 201, { mark: authorship.record(body) });
    return true;
  }
  if (request.method === 'GET' && pathname === '/api/ai-authorship') {
    // Hook events waiting in the spool are read first, so a file just edited answers at once.
    await authorship.enqueue(() => authorship.ingest());
    await authorship.settled();
    const absolute = url.searchParams.get('path');
    const projectId = url.searchParams.get('projectId');
    if (projectId) {
      const filePath = url.searchParams.get('file');
      if (!filePath) throw new HttpError(400, 'A file path is required.');
      sendJson(response, 200, { found: true, ...authorship.forFile(projectId, filePath) });
      return true;
    }
    if (!absolute) throw new HttpError(400, 'A file path is required.');
    const found = authorship.forPath(absolute);
    sendJson(response, 200, found ? { found: true, ...found } : { found: false, spans: [], marks: [] });
    return true;
  }
  return false;
}
