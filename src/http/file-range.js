// A file sent the way media players ask for it: whole, or one byte range at
// a time (HTTP Range), streamed from disk rather than read into memory. A
// player seeks a video by asking for the bytes around the moment it wants.

import fs from 'node:fs';

/**
 * The single byte range a Range header asks for, within a file of `size`
 * bytes: `{ start, end }` inclusive, null for the whole file, or false when
 * the range lies outside the file.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | null | false}
 */
export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const length = Math.min(Number(match[2]), size);
    return length > 0 ? { start: size - length, end: size - 1 } : false;
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start < size && start <= end ? { start, end } : false;
}

/**
 * Sends `filePath` whole or in the range the request asks for.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} filePath
 * @param {string} contentType
 */
export function sendFileRange(request, response, filePath, contentType) {
  const { size } = fs.statSync(filePath);
  const range = byteRange(request.headers.range, size);
  const headers = { 'content-type': contentType, 'accept-ranges': 'bytes', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff' };
  if (range === false) {
    response.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    response.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  response.writeHead(range ? 206 : 200, { ...headers, 'content-length': size ? end - start + 1 : 0,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  if (request.method === 'HEAD' || size === 0) {
    response.end();
    return;
  }
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}
