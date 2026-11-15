// The cell picker's sheet: the spreadsheet or CSV a suggestion cites, as
// cells to highlight from, with the cited cell, row or column highlighted.

import { HttpError } from '../history/errors.js';
import { sheetDocument } from '../sharing/sheet-document.js';
import { match, sendJson } from './responses.js';

const TABLE_FILE_TYPES = new Set(['table', 'spreadsheet']);

/** Answers the request when it is this route; whether it did. */
export async function sheetRoutes({ request, response, url, pathname, timeline, dependencies, objectShares }) {
  const parameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/sheet$/);
  if (request.method !== 'GET' || !parameters || !objectShares) return false;
  const resolved = objectShares.describe(parameters[0], url.searchParams.get('version'),
    { snapshotId: url.searchParams.get('snapshot') });
  if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
  const filePath = resolved.internal.filePath;
  const file = timeline.snapshotFile(resolved.internal.snapshotId, filePath);
  if (!file || !TABLE_FILE_TYPES.has(file.fileType)) throw new HttpError(415, 'This file has no cells to pick from.');
  const name = resolved.source.filename;
  if (!timeline.blobs.has(file.contentHash)) {
    sendJson(response, 200, { source: resolved.source, path: filePath,
      document: { name, unavailable: 'This version of the file is no longer stored.' } });
    return true;
  }
  const buffer = timeline.blobs.get(file.contentHash);
  const requested = String(url.searchParams.get('sheet') ?? '').trim();
  const { window, anchor, tables } = dependencies.viewerTables(file, buffer, resolved.source.anchor, requested || null);
  const table = tables.find((candidate) => candidate.name === requested)
    ?? tables.find((candidate) => candidate.name === resolved.source.anchor?.sheet) ?? tables[0];
  const document = table
    ? sheetDocument({ name, table, anchor, sheets: window?.sheets ?? tables.map((candidate) => candidate.name),
      delimited: file.fileType === 'table' && !window })
    : { name, unavailable: 'This file could not be read.' };
  sendJson(response, 200, { source: resolved.source, path: filePath, document });
  return true;
}
