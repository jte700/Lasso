// The passage picker's document: the file a passage suggestion cites, as
// text to highlight from, with the passage highlighted from the typed words.

import { HttpError } from '../history/errors.js';
import { passageDocument, passageKind } from '../sharing/passage-document.js';
import { passageSelection } from '../sharing/passage-selection.js';
import { match, sendJson } from './responses.js';

// The most typed text read for the highlight: the sentence at the caret is all it needs.
const MAX_TYPED = 2000;

/** Answers the request when it is one of these routes; whether it did. */
export async function passageRoutes({ request, response, url, pathname, timeline, dependencies, objectShares }) {
  const parameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/passages$/);
  if (request.method !== 'GET' || !parameters || !objectShares) return false;
  const resolved = objectShares.describe(parameters[0], url.searchParams.get('version'),
    { snapshotId: url.searchParams.get('snapshot') });
  if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
  const filePath = resolved.internal.filePath;
  if (!passageKind(filePath)) throw new HttpError(415, 'This file has no passages to pick from.');
  const file = timeline.snapshotFile(resolved.internal.snapshotId, filePath);
  const video = file?.fileType === 'video';
  const document = passageDocument({
    path: filePath,
    content: file && !video && timeline.blobs.has(file.contentHash) ? timeline.blobs.get(file.contentHash) : null,
    transcript: file && video ? dependencies.keptTranscript(file.contentHash) : null,
  });
  const typed = String(url.searchParams.get('typed') ?? '').slice(-MAX_TYPED);
  // A video plays from its file on this Mac, above its transcript.
  const localPath = video ? dependencies.videoLocalPath(resolved.internal.snapshotId, filePath) : null;
  sendJson(response, 200, { source: resolved.source, path: filePath,
    document: { ...document, localPath, selection: passageSelection(document, resolved.source, typed) } });
  return true;
}
