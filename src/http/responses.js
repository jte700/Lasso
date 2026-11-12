// How the server reads requests and answers them: JSON bodies in and out,
// pages, files and conversions, the static workbench files, and the page a
// connected app's sign-in returns to. Shared by api.js and its route files.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { downloadDisposition } from '../sharing/share-download.js';
import { renderUnavailable } from '../sharing/share-page.js';
import { WORKSPACE_PAGE_HEADERS } from './request-guard.js';
import { drawingDiscovery } from '../dependencies/drawing-discovery.js';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function readJson(request, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  // Every route reads named fields, so null, strings and arrays are client errors.
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return value;
}

export function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

// Recipient pages run no script and load nothing from elsewhere. If shared
// text ever escaped its escaping, the browser would still refuse to run it.
export const SHARE_PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};

export function sendHtml(response, status, html, headers = {}) {
  const body = Buffer.from(html, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  response.end(body);
}

export function sendBinary(response, status, content, contentType, headers = {}) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': content.length,
    'cache-control': 'private, max-age=3600',
    ...headers,
  });
  response.end(content);
}

/** A share's download in the format its recipient chose, or why it cannot be. */
export function sendConversion(response, converted) {
  if (converted.status !== 'OK') {
    return sendHtml(response, converted.status === 'CONVERSION_FAILED' ? 500 : 422,
      renderUnavailable(converted.status), SHARE_PAGE_HEADERS);
  }
  return sendBinary(response, 200, converted.content, converted.contentType, {
    'content-disposition': downloadDisposition(converted.filename),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}

export function actorFrom(body) {
  return body.actor ?? {
    id: body.actorId,
    displayName: body.actorName,
    actorType: body.actorType,
  };
}

export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'This is not a valid address.');
  }
}

export function match(pathname, pattern) {
  const result = pathname.match(pattern);
  return result ? result.slice(1).map(decodePathSegment) : null;
}

/** Whether the old browser workbench is wanted: by the Windows app, which asks for it, or on Windows. */
export function opensWorkbench(url) {
  return process.platform === 'win32' || url.searchParams.get('platform') === 'windows';
}

export function serveStatic(publicDir, pathname, response) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(publicDir, relative);
  const root = path.resolve(publicDir);
  if (!target.startsWith(`${root}${path.sep}`) && target !== root) return false;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const extension = path.extname(target).toLowerCase();
  const content = fs.readFileSync(target);
  response.writeHead(200, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': content.length,
    'cache-control': 'no-store',
    ...WORKSPACE_PAGE_HEADERS,
  });
  response.end(content);
  return true;
}

// The page the browser lands on after signing in to a connected app. It runs
// no script; the Connect window sees the connection change on its own.
export function signInPage(title, message, ok) {
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Lasso</title><style>
:root{color-scheme:light dark;--bg:#f5f3f1;--ink:#000;--ink2:rgba(0,0,0,.6);--card:#fff;--accent:#1f9d55;--bad:#c2410c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--ink:#f5f4f2;--ink2:rgba(245,244,242,.62);--card:#1f1f1e;--accent:#3fd977;--bad:#ff8a4c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:420px;margin:24px;padding:32px 30px;border-radius:18px;background:var(--card);box-shadow:0 1px 2px rgba(0,0,0,.05),0 18px 40px rgba(0,0,0,.08);text-align:center}
.mark{width:44px;height:44px;margin:0 auto 14px;border-radius:50%;display:grid;place-items:center;font-size:22px;color:#fff;background:${ok ? 'var(--accent)' : 'var(--bad)'}}
h1{margin:0 0 6px;font-size:21px;letter-spacing:-.01em}p{margin:0;color:var(--ink2)}</style></head>
<body><main><div class="mark" aria-hidden="true">${ok ? '&#10003;' : '!'}</div><h1>${escape(title)}</h1><p>${escape(message)}</p></main></body></html>`;
}

export function sourceLibraryEntry(source) {
  const { searchText, contentHash, metadata, ...object } = source;
  const drawing = source.searchAliases ? null : drawingDiscovery(source);
  return drawing ? { ...object, label: drawing.label, searchAliases: drawing.aliases } : object;
}
