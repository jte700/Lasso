// Reviews in The Ranch: a folder's changes since it was last approved, the
// comments on them, suggestions applied, changes asked of an AI, files marked
// as looked at, and approvals. Reads are GETs; everything a person does is a POST.

import { decodePathSegment, readJson, sendJson } from './responses.js';

/** The person at this Mac, as the Mac app names them, when a request names no one. */
const DESKTOP = { id: 'human:desktop', displayName: 'Desktop', actorType: 'HUMAN_SELF' };
const actorOf = (body) => body?.actor ?? DESKTOP;
/** The path's parts a pattern captures, decoded; a part it left out is null. */
const parts = (pathname, pattern) => pathname.match(pattern)?.slice(1).map((part) => (part == null ? null : decodePathSegment(part))) ?? null;

/** Answers the request when it is one of these routes; whether it did. */
export async function reviewRoutes({ request, response, url, pathname, reviews }) {
  if (!pathname.startsWith('/api/reviews')) return false;
  const viewer = url.searchParams.get('actor') || DESKTOP.id;
  if (request.method === 'GET' && pathname === '/api/reviews') {
    sendJson(response, 200, { folders: reviews.folders(viewer) });
    return true;
  }
  const thread = parts(pathname, /^\/api\/reviews\/threads\/([^/]+)\/(replies|resolve|apply)$/);
  if (request.method === 'POST' && thread) {
    const [threadId, action] = thread;
    const body = await readJson(request, 256 * 1024);
    if (action === 'replies') sendJson(response, 200, reviews.reply(threadId, body, actorOf(body)));
    if (action === 'resolve') sendJson(response, 200, reviews.resolve(threadId, body.resolved, actorOf(body)));
    if (action === 'apply') sendJson(response, 200, reviews.apply(threadId, actorOf(body)));
    return true;
  }
  const folder = parts(pathname, /^\/api\/reviews\/([^/]+)(?:\/(file|threads|ask|viewed|approve|undo))?$/);
  if (!folder) return false;
  const [directoryId, action] = folder;
  if (request.method === 'GET' && !action) {
    sendJson(response, 200, { review: reviews.summary(directoryId, viewer) });
    return true;
  }
  if (request.method === 'GET' && action === 'file') {
    sendJson(response, 200, { file: reviews.file(directoryId, url.searchParams.get('path'), viewer) });
    return true;
  }
  if (request.method !== 'POST' || !action || action === 'file') return false;
  const body = await readJson(request, 256 * 1024);
  if (action === 'threads') sendJson(response, 200, reviews.comment(directoryId, body, actorOf(body)));
  if (action === 'viewed') sendJson(response, 200, reviews.viewed(directoryId, body.path, body.viewed, actorOf(body)));
  if (action === 'approve') sendJson(response, 200, reviews.approve(directoryId, actorOf(body)));
  if (action === 'undo') sendJson(response, 200, reviews.undo(directoryId, body.approvalId, actorOf(body)));
  if (action === 'ask') {
    // Closing the connection stops the AI.
    const stop = new AbortController();
    let finished = false;
    response.on('close', () => { if (!finished) stop.abort(); });
    try {
      sendJson(response, 200, await reviews.ask(directoryId, body, actorOf(body), stop.signal));
    } finally {
      finished = true;
    }
  }
  return true;
}
