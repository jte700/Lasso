// AI writers: which there are, starting one ahead of its first prompt, and
// a prompt answered as a stream of events, one JSON object a line, so the
// apps write the words as they arrive. Closing the connection stops the writer.

import { HttpError } from '../history/errors.js';
import { LONGEST_PROMPT } from '../writing/service.js';
import { WriterError } from '../writing/codex.js';
import { match, readJson, sendJson } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function writingRoutes({ request, response, pathname, writing }) {
  if (request.method === 'GET' && pathname === '/api/writing/agents') {
    sendJson(response, 200, { agents: writing.agents() });
    return true;
  }
  const prepared = match(pathname, /^\/api\/writing\/agents\/([^/]+)\/prepare$/);
  if (request.method === 'POST' && prepared) {
    try {
      sendJson(response, 200, await writing.prepare(prepared[0]));
    } catch (error) {
      if (!(error instanceof WriterError)) throw error;
      sendJson(response, 200, { ready: false, code: error.code, message: error.message });
    }
    return true;
  }
  if (request.method !== 'POST' || pathname !== '/api/writing') return false;
  const body = await readJson(request);
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) throw new HttpError(400, 'A prompt is required.');
  if (prompt.length > LONGEST_PROMPT) throw new HttpError(400, 'That prompt is too long.');
  if (typeof body.agent !== 'string') throw new HttpError(400, 'A writer is required.');
  writing.requireAgent(body.agent);
  const stop = new AbortController();
  let finished = false;
  response.on('close', () => { if (!finished) stop.abort(); });
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  await writing.write({ agent: body.agent, prompt, onlyProjectId: typeof body.onlyProjectId === 'string' ? body.onlyProjectId : null },
    (event) => { if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`); }, stop.signal);
  finished = true;
  response.end();
  return true;
}
