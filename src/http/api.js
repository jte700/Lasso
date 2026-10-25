import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { buildPreview } from '../history/preview.js';
import { HttpError } from '../history/errors.js';
import { DEFAULT_EVENT_PAGE } from '../history/service.js';
import { renderSharePage, renderUnavailable, renderInspectorPanel } from '../sharing/share-page.js';
import { buildFullShareDocument, buildInspectorPreview, buildSharePreview, buildSlideShareDocument, isTextPreviewPath, usesStructuredLayout, detectsCsvDelimiter } from '../sharing/share-preview.js';
import { fullTextLayout } from '../sharing/text-layout.js';
import { isMarkdownPath } from '../sharing/markdown.js';
import { buildModelPreview } from '../dependencies/model-preview.js';
import { redactModelPlan } from '../sharing/model-redaction.js';
import { citedPartModel } from '../sharing/cited-part.js';
import { buildShareDownload, downloadDisposition } from '../sharing/share-download.js';
import { drawingDiscovery } from '../dependencies/drawing-discovery.js';
import { buildSafePdf, pdfShareRequest } from '../sharing/pdf-share.js';
import { normalizePdfExcerpt, normalizeRedactions, offeredShareScopes } from '../sharing/object-share.js';
import { isPresentationPath } from '../dependencies/presentation-extraction.js';
import { singleSlidePresentation } from '../sharing/slide-export.js';
import { refusalReason, WORKSPACE_PAGE_HEADERS } from './request-guard.js';
import { passiveInlineType } from './passive-types.js';

// Rows on each side of a cited cell in the suggestion card. The card shows as
// many as fit around the citation, so a footnote still has its table above it.
const ASSIST_TABLE_RADIUS = 4;
// Rows of a cited column the card can scroll through; it counts the rest.
const ASSIST_COLUMN_ROWS = 100;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readJson(request, limit = 25 * 1024 * 1024) {
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

function sendJson(response, status, value) {
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
const SHARE_PAGE_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
};

function sendHtml(response, status, html, headers = {}) {
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

function sendBinary(response, status, content, contentType, headers = {}) {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': content.length,
    'cache-control': 'private, max-age=3600',
    ...headers,
  });
  response.end(content);
}

function actorFrom(body) {
  return body.actor ?? {
    id: body.actorId,
    displayName: body.actorName,
    actorType: body.actorType,
  };
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'This is not a valid address.');
  }
}

function match(pathname, pattern) {
  const result = pathname.match(pattern);
  return result ? result.slice(1).map(decodePathSegment) : null;
}

function serveStatic(publicDir, pathname, response) {
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

function sourceLibraryEntry(source) {
  const { searchText, contentHash, metadata, ...object } = source;
  const drawing = source.searchAliases ? null : drawingDiscovery(source);
  return drawing ? { ...object, label: drawing.label, searchAliases: drawing.aliases } : object;
}

// The page the browser lands on after signing in to a connected app. It runs
// no script; the Connect window sees the connection change on its own.
function signInPage(title, message, ok) {
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

export function createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal = null, workspace = null, connections = null, ranch = null) {
  const resolvedModelPreview = resolved => dependencies.sourceModelPreview({ ...resolved.source,
    path: resolved.internal.filePath, snapshotId: resolved.internal.snapshotId });
  const resolvedModelDocument = async resolved => {
    const model = await resolvedModelPreview(resolved);
    return model?.kind === 'model-plan' ? { ...model, focusBounds: { ...model.bounds } } : model;
  };
  // The public view and exported excerpt resolve the same pinned content and
  // apply the same disclosure scope before either is rendered.
  const sharedContent = async resolved => {
    let preview = null, document = null;
    try {
      const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
      const sourceFile = file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null;
      preview = buildSharePreview(sourceFile, resolved.source.anchor, resolved.source.metadata);
      // A 3D model's cited part is shared as its own view, never as the file.
      if (resolved.share.accessScope === 'INDEXED' && /\.(?:step|stp)$/i.test(resolved.internal.filePath)) {
        return { preview, document: citedPartModel(await resolvedModelPreview(resolved)) };
      }
      // A deck is shared whole, or as the slide the citation is on and nothing else.
      if (isPresentationPath(resolved.internal.filePath)) {
        if (resolved.share.accessScope === 'DOCUMENT') return { preview: null, document: buildFullShareDocument(sourceFile) };
        if (resolved.share.accessScope !== 'INDEXED') return { preview: null, document: null };
        const slide = buildSlideShareDocument(sourceFile, resolved.source.anchor, resolved.source.metadata);
        return { preview: null, document: slide && { ...slide,
          // Made only when the slide is downloaded.
          slideFile: () => singleSlidePresentation(sourceFile.content, slide.slide) } };
      }
      const pdfRequest = pdfShareRequest(resolved);
      if (pdfRequest && sourceFile?.content) {
        const content = await buildSafePdf(sourceFile.content, pdfRequest);
        const pages = [...new Set(pdfRequest.regions?.map(region => region.page) ?? [])].sort((a, b) => a - b);
        const excerptLocation = pages.length ? `${pages.length > 1 ? 'Pages' : 'Page'} ${pages.join(', ')}`
          : pdfRequest.page ? `Page ${pdfRequest.page}` : '';
        document = { kind: 'pdf', safe: true, redacted: resolved.share.accessScope === 'REDACTED',
          fileUrl: `/d/${encodeURIComponent(resolved.share.token)}/source`, page: 1, location: excerptLocation, content };
        return { preview: null, document };
      }
      if (resolved.share.accessScope !== 'INDEXED') {
        document = await resolvedModelDocument(resolved)
          ?? (resolved.share.accessScope === 'REDACTED'
            ? buildFullShareDocument(sourceFile, {
              structuredLayout: usesStructuredLayout(resolved.share.redactions, fullTextLayout(resolved.internal.filePath)),
              detectCsvDelimiter: detectsCsvDelimiter(resolved.share.redactions) })
            // The original is downloadable in this scope, so Markdown can be read in full.
            : isMarkdownPath(resolved.internal.filePath) ? buildFullShareDocument(sourceFile) : null);
        if (resolved.share.accessScope === 'DOCUMENT' && /\.pdf$/i.test(resolved.internal.filePath)) {
          document = { ...buildFullShareDocument(sourceFile, { visualPdf: true }),
            fileUrl: `/d/${encodeURIComponent(resolved.share.token)}/source`,
            page: Math.max(1, Number(resolved.source.anchor?.pageNumber ?? resolved.source.metadata?.pageNumber) || 1) };
        }
        if (resolved.share.accessScope === 'REDACTED' && /\.(?:dxf|ifc)$/i.test(resolved.internal.filePath)) {
          document = redactModelPlan(document, resolved.share.redactions);
        }
      }
    } catch { preview = null; document = null; }
    return { preview, document };
  };
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;
      const refusal = refusalReason(request, pathname);
      if (refusal) return sendJson(response, 403, { error: { message: refusal } });

      // Public share links. Deliberately ahead of the API and static routes,
      // and reachable without any session.
      let shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const token = shareParameters[0];
        const resolved = objectShares.resolveShare(token);
        if (resolved.status !== 'OK') {
          return sendHtml(response, resolved.status === 'NOT_FOUND' ? 404 : 410,
            renderUnavailable(resolved.status), SHARE_PAGE_HEADERS);
        }
        const { preview, document } = await sharedContent(resolved);
        return sendHtml(response, 200, renderSharePage(resolved, token, preview, document), SHARE_PAGE_HEADERS);
      }

      shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})\/excerpt$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const resolved = objectShares.resolveShare(shareParameters[0]);
        if (resolved.status !== 'OK') {
          return sendHtml(response, resolved.status === 'NOT_FOUND' ? 404 : 410, renderUnavailable(resolved.status), SHARE_PAGE_HEADERS);
        }
        const { preview, document } = await sharedContent(resolved);
        const excerpt = buildShareDownload(resolved, preview, document);
        if (!excerpt) return sendHtml(response, 422, renderUnavailable('EXCERPT_UNAVAILABLE'), SHARE_PAGE_HEADERS);
        return sendBinary(response, 200, excerpt.content, excerpt.contentType, {
          'content-disposition': downloadDisposition(excerpt.filename),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }

      shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})\/source$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const resolved = objectShares.resolveShare(shareParameters[0]);
        if (resolved.status !== 'OK') return sendHtml(response, resolved.status === 'NOT_FOUND' ? 404 : 410, renderUnavailable(resolved.status), SHARE_PAGE_HEADERS);
        if (resolved.share.accessScope !== 'DOCUMENT') {
          const { document } = await sharedContent(resolved);
          if (!document?.safe || !document.content) return sendHtml(response, 403, renderUnavailable('SCOPE_RESTRICTED'), SHARE_PAGE_HEADERS);
          return sendBinary(response, 200, document.content, 'application/pdf', {
            'content-disposition': downloadDisposition(resolved.source.filename).replace(/^attachment;/, 'inline;'),
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          });
        }
        // Original bytes remain restricted to DOCUMENT grants. Other grants
        // above can serve only a newly rendered, disclosure-limited PDF.
        const file = objectShares.sourceFile(shareParameters[0]);
        if (file.status !== 'OK') {
          const status = file.status === 'NOT_FOUND' ? 404 : file.status === 'SCOPE_RESTRICTED' ? 403 : 410;
          return sendHtml(response, status, renderUnavailable(file.status), SHARE_PAGE_HEADERS);
        }
        if (file.contentType !== 'application/pdf') {
          return sendHtml(response, 415, renderUnavailable('EXCERPT_UNAVAILABLE'), SHARE_PAGE_HEADERS);
        }
        return sendBinary(response, 200, file.content, file.contentType, {
          'content-disposition': downloadDisposition(file.filename).replace(/^attachment;/, 'inline;'),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }

      shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})\/download$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const file = objectShares.sourceFile(shareParameters[0]);
        if (file.status !== 'OK') {
          const status = file.status === 'NOT_FOUND' ? 404 : file.status === 'SCOPE_RESTRICTED' ? 403 : 410;
          return sendHtml(response, status, renderUnavailable(file.status), SHARE_PAGE_HEADERS);
        }
        // Only the basename is ever published, and quotes/newlines are stripped
        // so the header cannot be split.
        return sendBinary(response, 200, file.content, file.contentType, {
          'content-disposition': downloadDisposition(file.filename),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }

      // Local source inspector for an overlay-highlighted dependency. Local
      // only: it resolves an indexed object directly and mints no token.
      if (request.method === 'GET' && pathname === '/inspect' && objectShares) {
        const objectId = url.searchParams.get('object');
        const versionId = url.searchParams.get('version');
        const referenceId = url.searchParams.get('reference');
        const resolved = objectShares.describe(objectId, versionId);
        if (resolved.status !== 'OK') {
          return sendHtml(response, 404, renderUnavailable('NOT_FOUND'));
        }
        let preview = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          const content = file ? timeline.blobs.get(file.contentHash) : null;
          preview = buildInspectorPreview(
            file ? { path: file.path, content } : null,
            resolved.source.anchor, resolved.source.metadata, resolved.source.label, resolved.source.objectType,
            { matchText: url.searchParams.get('text') ?? '',
              window: file ? dependencies.tableWindow(file, content, resolved.source.anchor ?? {}, { before: 6, after: 6 }) : null });
          if (preview && ['pdf', 'image'].includes(preview.kind)) {
            const query = `?version=${encodeURIComponent(versionId ?? resolved.internal.versionId)}`;
            preview.fileUrl = `/api/dependency-objects/${encodeURIComponent(objectId)}/source${query}`;
          }
        } catch { preview = null; }
        preview = await resolvedModelPreview(resolved) ?? preview;
        const shareable = offeredShareScopes(resolved.internal.filePath, resolved.source.anchor).length > 0;
        // The Mac app reads this before the page loads, so Tab never offers a link the page does not.
        return sendHtml(response, 200, renderInspectorPanel(resolved, referenceId, preview, { shareable }),
          { 'x-lasso-shareable': shareable ? '1' : '0' });
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, service: 'scientific-version-timeline' });
      }
      if (workspace) {
        if (request.method === 'GET' && pathname === '/api/workspace/activity') {
          return sendJson(response, 200, { activity: workspace.activity({ sourceObjectIds: url.searchParams.getAll('sourceObjectId') }) });
        }
        if (request.method === 'GET' && pathname === '/api/workspace') {
          return sendJson(response, 200, workspace.state({ pending: url.searchParams.get('pending') === '1' }));
        }
        if (request.method === 'POST' && pathname === '/api/workspace/directories') {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.add(body.rootPaths, actorFrom(body)));
        }
        if (request.method === 'DELETE' && pathname === '/api/workspace/directories') {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.removeMany(body.projectIds));
        }
        const fix = match(pathname, /^\/api\/workspace\/directories\/([^/]+)\/fix$/);
        if (request.method === 'POST' && fix) {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.fixIssue(fix[0], actorFrom(body)));
        }
        const directory = match(pathname, /^\/api\/workspace\/directories\/([^/]+)$/);
        if (request.method === 'POST' && directory) {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.toggle(directory[0], body.active, actorFrom(body)));
        }
        if (request.method === 'DELETE' && directory) {
          return sendJson(response, 200, await workspace.remove(directory[0]));
        }
        if (request.method === 'POST' && pathname === '/api/workspace/dependencies/predict') {
          return sendJson(response, 200, { prediction: await workspace.predict(await readJson(request)) });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/source-library') {
          return sendJson(response, 200, { objects: workspace.search(url.searchParams.get('query') ?? '', {
            documentProjectId: url.searchParams.get('documentProjectId'),
            documentPath: url.searchParams.get('documentPath'), context: url.searchParams.get('context'),
            limit: Number.MAX_SAFE_INTEGER, diversify: false, enrich: false,
          }).map(sourceLibraryEntry) });
        }
        const review = match(pathname, /^\/api\/workspace\/source-review\/([^/]+)$/);
        if (review && ['GET', 'POST'].includes(request.method)) {
          const body = request.method === 'POST' ? await readJson(request) : null;
          const plan = workspace.sourceValuePlan(review[0]);
          if (request.method === 'GET') return sendJson(response, 200, { plan });
          if (JSON.stringify(body.expectedPlan) !== JSON.stringify(plan)) {
            throw new HttpError(409, 'The source or document changed. Review the updated comparison before continuing.');
          }
          if (!['apply', 'keep'].includes(body.action)) throw new HttpError(400, 'Choose an update action.');
          return sendJson(response, 200, { result: workspace.applySourceValuePlan(review[0], body.action, actorFrom(body), plan) });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/terminal/session') {
          // Its Changes count reads value history; a long one is read off
          // this thread first so the server keeps answering meanwhile.
          await workspace.readValueHistory();
          return sendJson(response, 200, { session: workspace.terminalSession() });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/terminal/complete') {
          return sendJson(response, 200, { completion: workspace.terminalComplete(url.searchParams.get('input') ?? '', {
            documentPath: url.searchParams.get('documentPath'), context: url.searchParams.get('context'),
            surface: url.searchParams.get('surface'),
          }) });
        }
        if (request.method === 'POST' && pathname === '/api/workspace/terminal/preview') {
          const body = await readJson(request);
          const preview = workspace.terminalPreview(body.ref);
          const source = terminal.executor.previewSource(body.ref.projectId, body.ref);
          const model = source ? await dependencies.sourceModelPreview(source) : null;
          return sendJson(response, 200, { preview: model ?? preview });
        }
        if (request.method === 'POST' && pathname === '/api/workspace/terminal') {
          const body = await readJson(request);
          await workspace.readValueHistory();
          return sendJson(response, 200, { result: await workspace.terminalRun(body.input, actorFrom(body), body) });
        }
      }
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
          return sendJson(response, 200, ranch.sheet(file));
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
      if (request.method === 'GET' && pathname === '/api/sharing/status' && objectShares) {
        const baseUrl = objectShares.baseUrl();
        const host = new URL(baseUrl).hostname;
        const localOnly = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(host);
        return sendJson(response, 200, { baseUrl, localOnly });
      }
      const localObjectParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)$/);
      if (request.method === 'GET' && localObjectParameters) {
        const object = dependencies.objectById(localObjectParameters[0]);
        if (!object) throw new HttpError(404, 'Indexed object not found.');
        return sendJson(response, 200, { object });
      }

      const localObjectSourceParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/source$/);
      if (request.method === 'GET' && localObjectSourceParameters && objectShares) {
        const resolved = objectShares.describe(localObjectSourceParameters[0], url.searchParams.get('version'));
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
        const content = file ? timeline.blobs.get(file.contentHash) : null;
        if (!content) throw new HttpError(404, 'The source file is unavailable.');
        // Inline viewing is restricted to passive formats. HTML and SVG source
        // must never acquire the local API's origin through this endpoint.
        const type = passiveInlineType(file.path);
        if (!type) throw new HttpError(415, 'This file format cannot be viewed inline.');
        return sendBinary(response, 200, content, type, {
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'content-disposition': 'inline',
        });
      }

      const localObjectDocumentParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/document$/);
      if (request.method === 'GET' && localObjectDocumentParameters && objectShares) {
        const versionId = url.searchParams.get('version');
        const resolved = objectShares.describe(localObjectDocumentParameters[0], versionId);
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        let document = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          document = buildFullShareDocument(
            file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null, { visualPdf: true });
          if (document?.kind === 'pdf') {
            const query = `?version=${encodeURIComponent(versionId ?? resolved.internal.versionId)}`;
            document.fileUrl = `/api/dependency-objects/${encodeURIComponent(localObjectDocumentParameters[0])}/source${query}`;
            document.page = Math.max(1, Number(resolved.source.anchor?.pageNumber ?? resolved.source.metadata?.pageNumber) || 1);
          }
        } catch { document = null; }
        document = await resolvedModelDocument(resolved) ?? document;
        return sendJson(response, 200, {
          source: resolved.source, path: resolved.internal.filePath, document,
          shareScopes: offeredShareScopes(resolved.internal.filePath, resolved.source.anchor),
        });
      }

      const localPdfPreviewParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/pdf-preview$/);
      if (request.method === 'POST' && localPdfPreviewParameters && objectShares) {
        const resolved = objectShares.describe(localPdfPreviewParameters[0], url.searchParams.get('version'));
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        if (!/\.pdf$/i.test(resolved.internal.filePath)) throw new HttpError(415, 'Select a PDF document.');
        const body = await readJson(request);
        const accessScope = String(body.accessScope ?? 'INDEXED').toUpperCase();
        if (!['INDEXED', 'REDACTED'].includes(accessScope)) throw new HttpError(400, 'Select an excerpt or redaction preview.');
        const share = { accessScope, excerpt: normalizePdfExcerpt(body.excerpt, accessScope),
          redactions: normalizeRedactions(body.redactions ?? [], accessScope) };
        const pdfRequest = pdfShareRequest({ ...resolved, share });
        if (!pdfRequest) throw new HttpError(422, 'Select text or an area from the PDF before sharing.');
        const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
        const content = file ? timeline.blobs.get(file.contentHash) : null;
        if (!content) throw new HttpError(404, 'The indexed PDF is unavailable.');
        let pdf;
        try { pdf = await buildSafePdf(content, pdfRequest); } catch { throw new HttpError(422, 'The selected PDF excerpt could not be rendered. Select the text or area again.'); }
        return sendBinary(response, 200, pdf, 'application/pdf', { 'content-disposition': 'inline',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      }

      const localObjectPreviewParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/preview$/);
      if (request.method === 'GET' && localObjectPreviewParameters && objectShares) {
        const versionId = url.searchParams.get('version');
        const resolved = objectShares.describe(localObjectPreviewParameters[0], versionId);
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        let preview = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          const sourceFile = file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null;
          // A table too large to read here previews from the table index.
          const window = file ? dependencies.tableWindow(file, sourceFile.content, resolved.source.anchor ?? {},
            { before: ASSIST_TABLE_RADIUS, after: Math.max(ASSIST_TABLE_RADIUS, ASSIST_COLUMN_ROWS) }) : null;
          preview = path.extname(file?.path ?? '').toLowerCase() === '.pdf'
            ? buildInspectorPreview(sourceFile, resolved.source.anchor, resolved.source.metadata, resolved.source.label, resolved.source.objectType)
            : buildSharePreview(sourceFile, resolved.source.anchor, resolved.source.metadata, ASSIST_TABLE_RADIUS,
              resolved.source.objectType, { display: true, columnRows: ASSIST_COLUMN_ROWS, window });
          // Text, Markdown and Word sources show the cited passage in context.
          if (!preview && isTextPreviewPath(file?.path)) {
            preview = buildInspectorPreview(sourceFile, resolved.source.anchor, resolved.source.metadata,
              resolved.source.label, resolved.source.objectType, { matchText: url.searchParams.get('text') ?? '' });
          }
          if (preview?.kind === 'pdf') {
            const query = `?version=${encodeURIComponent(versionId ?? resolved.internal.versionId)}`;
            preview.fileUrl = `/api/dependency-objects/${encodeURIComponent(localObjectPreviewParameters[0])}/source${query}`;
          }
        } catch { preview = null; }
        preview = await resolvedModelPreview(resolved) ?? preview;
        return sendJson(response, 200, {
          source: resolved.source, path: resolved.internal.filePath, preview,
          // What the share composer's "Cited part only" would publish.
          citedPart: citedPartModel(preview),
          shareScopes: offeredShareScopes(resolved.internal.filePath, resolved.source.anchor),
        });
      }

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

      if (request.method === 'GET' && pathname === '/api/projects') {
        return sendJson(response, 200, { projects: timeline.listProjects() });
      }
      if (request.method === 'POST' && pathname === '/api/projects/import') {
        const body = await readJson(request);
        const result = timeline.importProject(body.rootPath, actorFrom(body), { name: body.name, watch: body.watch !== false });
        return sendJson(response, result.imported ? 201 : 200, result);
      }

      let parameters = match(pathname, /^\/api\/projects\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { project: timeline.getProject(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/open$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        const project = timeline.getProject(parameters[0]);
        workspace?.requireActive(project.id);
        const capture = project.availability === 'offline' ? { changed: false, offline: true }
          : timeline.capture(project.id, actorFrom(body), {
            expectedSnapshotId: body.expectedSnapshotId,
            source: 'OPEN_RECONCILE',
          });
        dependencies.ensureIndex(project.id);
        dependencies.warmPredictionCaches(project.id);
        timeline.watchProject(project.id, actorFrom(body));
        return sendJson(response, 200, { project: timeline.getProject(project.id), capture });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/capture$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        const capture = timeline.capture(parameters[0], actorFrom(body), {
          expectedSnapshotId: body.expectedSnapshotId,
          source: body.source ?? 'EXPLICIT_CHECKPOINT',
        });
        return sendJson(response, capture.changed ? 201 : 200, capture);
      }
      // Re-read the files with the current reader. A capture finds nothing when
      // only the reader improved, so this records the better reading as its own
      // version and leaves every earlier one as it was read then.
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/reindex$/);
      if (parameters && ['GET', 'POST'].includes(request.method)) {
        if (request.method === 'GET') {
          return sendJson(response, 200, { freshness: dependencies.indexFreshness(parameters[0]) });
        }
        const body = await readJson(request);
        const reindexed = dependencies.reindex(parameters[0], actorFrom(body), {
          expectedSnapshotId: body.expectedSnapshotId,
          reason: body.reason,
          initiatedBy: body.initiatedBy,
        });
        return sendJson(response, reindexed.changed ? 201 : 200, { reindexed });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/events$/);
      if (request.method === 'GET' && parameters) {
        // Newest first, one page at a time; `nextBefore` reads the next page.
        const page = Object.fromEntries(['limit', 'before'].filter((name) => url.searchParams.has(name))
          .map((name) => [name, Number(url.searchParams.get(name))]));
        const events = timeline.listEvents(parameters[0], page);
        const full = events.length === (page.limit ?? DEFAULT_EVENT_PAGE);
        return sendJson(response, 200, { events, nextBefore: full ? events.at(-1).resultingVersion : null });
      }
      parameters = match(pathname, /^\/api\/events\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { event: timeline.getEvent(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/snapshots\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { snapshot: timeline.getSnapshot(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/snapshots\/([^/]+)\/preview$/);
      if (request.method === 'GET' && parameters) {
        const snapshot = timeline.getSnapshot(parameters[0]);
        const filePath = url.searchParams.get('path');
        const file = timeline.snapshotFile(snapshot.id, filePath);
        if (!file) throw new HttpError(404, 'File is not present in this snapshot.');
        const content = timeline.blobs.get(file.contentHash);
        const properties = buildPreview(snapshot, file, content);
        // A viewer that moved on to another file closes its request; a model
        // still waiting its turn is then not made.
        const waiting = new AbortController();
        response.once('close', () => { if (!response.writableFinished) waiting.abort(); });
        const model = await buildModelPreview({ path: file.path, content }, {
          anchor: { elementId: url.searchParams.get('elementId') || undefined, featureId: url.searchParams.get('featureId') || undefined },
          signal: waiting.signal,
        });
        const preview = model ? { ...properties, ...model } : properties;
        return sendJson(response, 200, { preview });
      }
      parameters = match(pathname, /^\/api\/snapshots\/([^/]+)\/source$/);
      if (request.method === 'GET' && parameters) {
        const snapshot = timeline.getSnapshot(parameters[0]);
        const file = timeline.snapshotFile(snapshot.id, url.searchParams.get('path'));
        if (!file) throw new HttpError(404, 'File is not present in this snapshot.');
        if (path.extname(file.path).toLowerCase() !== '.pdf') throw new HttpError(415, 'This file format cannot be viewed inline.');
        return sendBinary(response, 200, timeline.blobs.get(file.contentHash), 'application/pdf', {
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline',
        });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/rfi$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 200, { rfi: rfi.request(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/agent-edits$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, { execution: timeline.proposeAgentEdit(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/agent-edits\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { execution: timeline.getExecution(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/agent-edits\/([^/]+)\/approve$/);
      if (request.method === 'POST' && parameters) {
        return sendJson(response, 201, timeline.approveAgentEdit(parameters[0]));
      }
      parameters = match(pathname, /^\/api\/agent-edits\/([^/]+)\/reject$/);
      if (request.method === 'POST' && parameters) {
        return sendJson(response, 200, { execution: timeline.rejectAgentEdit(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/provenance$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, { link: timeline.addProvenanceLink(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/documents$/);
      if (request.method === 'GET' && parameters) {
        const filePath = url.searchParams.get('path');
        return sendJson(response, 200, filePath
          ? { document: dependencies.getDocument(parameters[0], filePath) }
          : { documents: dependencies.listDocuments(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/documents\/save$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        const capture = dependencies.saveDocument(parameters[0], body, actorFrom(body));
        return sendJson(response, 201, { capture, project: timeline.getProject(parameters[0]) });
      }
      // ── terminal ──────────────────────────────────────────────────────
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/terminal$/);
      if (request.method === 'POST' && parameters && terminal) {
        const body = await readJson(request);
        await terminal.graph.readFolderHistories([parameters[0]]);
        return sendJson(response, 200, {
          result: terminal.executor.run(parameters[0], body.input, actorFrom(body), {
            documentPath: body.documentPath, context: body.context,
          }),
        });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/terminal\/session$/);
      if (request.method === 'GET' && parameters && terminal) {
        // Its Changes count reads value history (see the workspace session).
        await terminal.graph.readFolderHistories([parameters[0]]);
        return sendJson(response, 200, { session: terminal.executor.banner(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/terminal\/complete$/);
      if (request.method === 'GET' && parameters && terminal) {
        return sendJson(response, 200, {
          completion: terminal.executor.complete(parameters[0], url.searchParams.get('input') ?? '', {
            documentPath: url.searchParams.get('documentPath'), context: url.searchParams.get('context'),
            surface: url.searchParams.get('surface'),
          }),
        });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/terminal\/preview$/);
      if (request.method === 'POST' && parameters && terminal) {
        const body = await readJson(request);
        const source = terminal.executor.previewSource(parameters[0], body.ref);
        const model = source ? await dependencies.sourceModelPreview(source) : null;
        return sendJson(response, 200, { preview: model ?? terminal.executor.preview(parameters[0], body.ref) });
      }

      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependencies\/predict$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 200, { prediction: dependencies.predict(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/source-library$/);
      if (request.method === 'GET' && parameters) {
        // Keep server-side query, document and usage ranking while decorating
        // immutable drawings with readable discovery names for both libraries.
        const objects = dependencies.search(parameters[0], url.searchParams.get('query') ?? '', {
          documentPath: url.searchParams.get('documentPath'),
          context: url.searchParams.get('context'),
          limit: Number.MAX_SAFE_INTEGER, diversify: false, enrich: false,
        }).map(sourceLibraryEntry);
        return sendJson(response, 200, { objects });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/source-review\/([^/]+)$/);
      if (parameters && ['GET', 'POST'].includes(request.method)) {
        const [projectId, objectId] = parameters;
        const body = request.method === 'POST' ? await readJson(request) : null;
        const plan = dependencies.planSourceValueUpdate(projectId, objectId);
        if (request.method === 'GET') return sendJson(response, 200, { plan });
        if (JSON.stringify(body.expectedPlan) !== JSON.stringify(plan)) {
          throw new HttpError(409, 'The source or document changed. Review the updated comparison before continuing.');
        }
        if (!['apply', 'keep'].includes(body.action)) throw new HttpError(400, 'Choose an update action.');
        const result = body.action === 'keep'
          ? dependencies.keepCurrentValue(projectId, objectId, actorFrom(body))
          : dependencies.applySourceValueUpdate(projectId, objectId, actorFrom(body));
        return sendJson(response, 200, { result });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependency-objects$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { objects: dependencies.search(parameters[0], url.searchParams.get('query') ?? '', {
          documentPath: url.searchParams.get('documentPath'),
        }) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/recommendation-usage$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 200, { usage: dependencies.recordRecommendationUsage(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependencies\/batch$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, dependencies.linkMany(parameters[0], body, actorFrom(body)));
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependencies$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, dependencies.link(parameters[0], body, actorFrom(body)));
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependencies\/audit$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { audit: dependencies.audit(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/object-shares$/);
      if (request.method === 'POST' && parameters && objectShares) {
        const body = await readJson(request);
        return sendJson(response, 201, {
          share: objectShares.createShare({
            projectId: parameters[0],
            objectId: body.objectId,
            versionId: body.versionId ?? null,
            actor: actorFrom(body),
            expiresAt: body.expiresAt ?? null,
            accessScope: body.accessScope ?? 'DOCUMENT',
            redactions: body.redactions ?? [],
            excerpt: body.excerpt ?? null,
          }),
        });
      }
      if (request.method === 'GET' && parameters && objectShares) {
        return sendJson(response, 200, { shares: objectShares.listShares(parameters[0]) });
      }

      parameters = match(pathname, /^\/api\/object-shares\/([^/]+)\/revoke$/);
      if (request.method === 'POST' && parameters && objectShares) {
        return sendJson(response, 200, objectShares.revokeShare(parameters[0]));
      }

      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/figure-image$/);
      if (request.method === 'GET' && parameters) {
        const rendered = dependencies.figurePreviewImage(parameters[0]);
        return sendBinary(response, 200, rendered.image, 'image/png');
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/source-file$/);
      if (request.method === 'GET' && parameters) {
        const sourceFile = dependencies.dependencySourceFile(parameters[0]);
        const filename = String(sourceFile.filename).replace(/["\r\n]/g, '_');
        // "Open separately" shows passive formats in a tab and downloads the
        // rest, so an SVG or HTML source cannot run script as this origin.
        const inline = passiveInlineType(sourceFile.filename);
        return sendBinary(response, 200, sourceFile.content, inline ?? 'application/octet-stream', {
          'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
          'x-content-type-options': 'nosniff',
        });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/viewer$/);
      if (request.method === 'GET' && parameters) {
        const viewer = dependencies.dependencySourceViewer(parameters[0], { sheet: url.searchParams.get('sheet') });
        const model = await dependencies.dependencyModelPreview(parameters[0]);
        return sendJson(response, 200, {
          viewer: model ? { ...viewer, ...model } : viewer,
        });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/preview$/);
      if (request.method === 'GET' && parameters) {
        const preview = dependencies.dependencyPreview(parameters[0], { contextRadius: url.searchParams.get('contextRadius') });
        const model = await dependencies.dependencyModelPreview(parameters[0]);
        return sendJson(response, 200, {
          preview: model ? { ...preview, content: model } : preview,
        });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/share$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { sharing: dependencies.dependencyShareSettings(parameters[0]) });
      }
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, { sharing: dependencies.configureDependencyShare(parameters[0], body, actorFrom(body)) });
      }
      parameters = match(pathname, /^\/api\/dependency-shares\/([^/]+)$/);
      if (request.method === 'DELETE' && parameters) {
        return sendJson(response, 200, dependencies.revokeDependencyShare(parameters[0]));
      }
      parameters = match(pathname, /^\/api\/shared-dependencies\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { shared: dependencies.sharedDependency(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { dependency: dependencies.getDependency(parameters[0]) });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/revise$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 201, dependencies.revise(parameters[0], actorFrom(body), body));
      }

      if (request.method === 'GET' && serveStatic(config.publicDir, pathname, response)) return;
      sendJson(response, 404, { error: { message: 'Not found.' } });
    } catch (error) {
      // The client cancelled the request, for example a superseded prediction
      // while typing. There is nobody to answer and nothing went wrong.
      // A fully read request is also "destroyed", so check the connection.
      if (error?.code === 'ECONNRESET' || response.socket?.destroyed) return;
      const status = error.status ?? 500;
      if (status >= 500) console.error(error);
      sendJson(response, status, {
        error: {
          message: status >= 500 ? 'An unexpected error occurred.' : error.message,
          details: error.details,
        },
      });
    }
  };
}
