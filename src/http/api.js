import path from 'node:path';
import { URL } from 'node:url';
import { buildPreview } from '../history/preview.js';
import { sendFileRange } from './file-range.js';
import { BlobReleasedError, HttpError } from '../history/errors.js';
import { DEFAULT_EVENT_PAGE } from '../history/service.js';
import { renderSharePage, renderUnavailable, renderInspectorPanel, renderMenuBarHome } from '../sharing/share-page.js';
import { buildFullShareDocument, buildInspectorPreview, buildSharedExcerpt, buildSharePreview, isTextPreviewPath } from '../sharing/share-preview.js';
import { buildModelPreview } from '../dependencies/model-preview.js';
import { citedPartModel } from '../sharing/cited-part.js';
import { buildShareDownload, downloadDisposition } from '../sharing/share-download.js';
import { conversionFormat, convertedShareDownload, shareConversions } from '../sharing/share-conversion.js';
import { buildPagePdf, slideCount, slidePicture } from '../sharing/document-pages.js';
import { isMarkablePath } from '../sharing/markup.js';
import { offeredShareScopes } from '../sharing/object-share.js';
import { isPresentationPath } from '../dependencies/presentation-extraction.js';
import { refusalReason, WORKSPACE_PAGE_HEADERS } from './request-guard.js';
import { passiveInlineType } from './passive-types.js';
import { actorFrom, match, opensWorkbench, readJson, sendBinary, sendConversion, sendHtml, sendJson, serveStatic, SHARE_PAGE_HEADERS, sourceLibraryEntry } from './responses.js';
import { connectionRoutes } from './connection-routes.js';
import { driveRoutes } from './drive-routes.js';
import { ranchRoutes } from './ranch-routes.js';
import { workspaceRoutes } from './workspace-routes.js';
import { sharedContentReader } from '../sharing/shared-content.js';

// Rows on each side of a cited cell in the suggestion card. The card shows as
// many as fit around the citation, so a footnote still has its table above it.
const ASSIST_TABLE_RADIUS = 4;
// With ?context=wide (the card, which scrolls), the rows on each side it scrolls through.
const ASSIST_SCROLL_TABLE_RADIUS = 30;
// Rows of a cited column the card can scroll through; it counts the rest.
const ASSIST_COLUMN_ROWS = 100;
// With ?context=wide, the lines and Markdown blocks around a cited passage the card scrolls through.
const ASSIST_TEXT_CONTEXT = Object.freeze({ lines: 400, blocksBefore: 200, blocksAfter: 400 });

/**
 * The query naming a described object's version for the requests that follow
 * its preview. When the preview was asked for at a snapshot, the requests
 * that follow stay at it, since the file differs between snapshots a version
 * spans.
 */
function pinnedQuery(versionId, resolved, askedSnapshotId) {
  const version = `?version=${encodeURIComponent(versionId ?? resolved.internal.versionId)}`;
  return askedSnapshotId ? `${version}&snapshot=${encodeURIComponent(resolved.internal.snapshotId)}` : version;
}

export function createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal = null, workspace = null, connections = null, ranch = null) {
  const { resolvedModelPreview, resolvedModelDocument, sharedContent } = sharedContentReader({ timeline, dependencies });
  // A word inserted with a share link previews that link in the inspector,
  // never a link made for another source. One that ended says so.
  const inspectedShare = async (token, objectId) => {
    if (!token || !objectShares) return null;
    const found = objectShares.resolveShare(token);
    if (found.status === 'NOT_FOUND') return null;
    if (found.status !== 'OK') return { status: found.status };
    if (found.share.objectId !== objectId) return null;
    return { status: 'OK', resolved: found, token, ...(await sharedContent(found)) };
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
        if (url.searchParams.has('as')) {
          return sendConversion(response, await convertedShareDownload('excerpt', conversionFormat(url.searchParams.get('as')),
            shareConversions(resolved, preview, document), { excerpt, document }));
        }
        return sendBinary(response, 200, excerpt.content, excerpt.contentType, {
          'content-disposition': downloadDisposition(excerpt.filename),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      }

      // The picture a cited slide's page shows. Other links have none.
      shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})\/slide$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const resolved = objectShares.resolveShare(shareParameters[0]);
        if (resolved.status !== 'OK') {
          return sendHtml(response, resolved.status === 'NOT_FOUND' ? 404 : 410, renderUnavailable(resolved.status), SHARE_PAGE_HEADERS);
        }
        const { document } = await sharedContent(resolved);
        if (!Buffer.isBuffer(document?.picture)) return sendHtml(response, 404, renderUnavailable('NOT_FOUND'), SHARE_PAGE_HEADERS);
        return sendBinary(response, 200, document.picture, 'image/jpeg', {
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
          // A marked Word document or deck arrives as a PDF, and is named as one.
          const original = String(resolved.source.filename ?? 'document');
          const filename = /\.pdf$/i.test(original) ? original : `${original.replace(/\.[^./]+$/, '')}.pdf`;
          return sendBinary(response, 200, document.content, 'application/pdf', {
            'content-disposition': downloadDisposition(filename).replace(/^attachment;/, 'inline;'),
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
        if (url.searchParams.has('as')) {
          const resolved = objectShares.resolveShare(shareParameters[0]);
          const { preview, document } = await sharedContent(resolved);
          return sendConversion(response, await convertedShareDownload('original', conversionFormat(url.searchParams.get('as')),
            shareConversions(resolved, preview, document), { original: file, document }));
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
        const askedSnapshotId = url.searchParams.get('snapshot');
        const referenceId = url.searchParams.get('reference');
        const resolved = objectShares.describe(objectId, versionId, { snapshotId: askedSnapshotId });
        if (resolved.status !== 'OK') {
          return sendHtml(response, 404, renderUnavailable('NOT_FOUND'));
        }
        let preview = null;
        try {
          const found = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          // A video plays from its stored file, at the moment the link cites; its bytes are not read here.
          const video = found?.fileType === 'video' ? found : null;
          const file = video ? null : found;
          const content = file ? timeline.blobs.get(file.contentHash) : null;
          preview = video ? dependencies.videoInspectorPreview(video, resolved.source, url.searchParams.get('time'),
            `/api/dependency-objects/${encodeURIComponent(objectId)}/video${pinnedQuery(versionId, resolved, askedSnapshotId)}`)
            : buildInspectorPreview(
            file ? { path: file.path, content } : null,
            resolved.source.anchor, resolved.source.metadata, resolved.source.label, resolved.source.objectType,
            { matchText: url.searchParams.get('text') ?? '',
              window: file ? dependencies.tableWindow(file, content, resolved.source.anchor ?? {}, { before: 6, after: 6 }) : null });
          if (preview && ['pdf', 'image'].includes(preview.kind)) {
            const query = pinnedQuery(versionId, resolved, askedSnapshotId);
            preview.fileUrl = `/api/dependency-objects/${encodeURIComponent(objectId)}/source${query}`;
          }
          // A deck shows its slides' pictures, slide n's at slidesUrl + n + slidesQuery.
          if (preview?.deck) {
            preview.slidesUrl = `/api/dependency-objects/${encodeURIComponent(objectId)}/slides/`;
            preview.slidesQuery = pinnedQuery(versionId, resolved, askedSnapshotId);
          }
        } catch { preview = null; }
        preview = await resolvedModelPreview(resolved) ?? preview;
        const shared = await inspectedShare(url.searchParams.get('share'), objectId);
        // A word inserted with ⇧⌘⏎ already is its link, so it offers no other.
        const shareable = !shared && offeredShareScopes(resolved.internal.filePath, resolved.source.anchor).length > 0;
        // The Mac app reads this before the page loads, so Tab never offers a link the page does not.
        return sendHtml(response, 200, renderInspectorPanel(resolved, referenceId, preview, { shareable, shared }),
          { 'x-lasso-shareable': shareable ? '1' : '0' });
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, service: 'scientific-version-timeline' });
      }
      if (workspace && await workspaceRoutes({ request, response, url, pathname, workspace, dependencies, terminal })) return;
      if (ranch && await ranchRoutes({ request, response, url, pathname, ranch })) return;
      if (connections && await connectionRoutes({ request, response, url, pathname, connections, workspace })) return;
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
        const resolved = objectShares.describe(localObjectSourceParameters[0], url.searchParams.get('version'),
          { snapshotId: url.searchParams.get('snapshot') });
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
        const askedSnapshotId = url.searchParams.get('snapshot');
        const resolved = objectShares.describe(localObjectDocumentParameters[0], versionId, { snapshotId: askedSnapshotId });
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        let document = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          document = buildFullShareDocument(
            file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null, { visualPdf: true });
          if (document?.kind === 'pdf') {
            const query = pinnedQuery(versionId, resolved, askedSnapshotId);
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

      // The pages the share composer draws on, as a marked copy will show them.
      const localPagesParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/pages$/);
      if (request.method === 'GET' && localPagesParameters && objectShares) {
        const resolved = objectShares.describe(localPagesParameters[0], url.searchParams.get('version'),
          { snapshotId: url.searchParams.get('snapshot') });
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        if (!isMarkablePath(resolved.internal.filePath)) throw new HttpError(415, 'Only PDFs, Word documents and presentations can be marked up.');
        const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
        const content = file ? timeline.blobs.get(file.contentHash) : null;
        if (!content) throw new HttpError(404, 'The document is unavailable.');
        let pages;
        try { pages = await buildPagePdf({ path: file.path, content, contentHash: file.contentHash }); } catch (error) {
          console.error('Lasso could not lay out %s as pages: %s', resolved.internal.filePath, error.message);
          throw new HttpError(422, 'The document couldn’t be shown as pages to mark up.');
        }
        return sendBinary(response, 200, pages, 'application/pdf', { 'content-disposition': 'inline',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      }

      // One slide of a deck as a picture, which the card and the share composer
      // show as it is scrolled to; the slides beside it are drawn with it.
      const localSlideParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/slides\/(\d{1,5})$/);
      if (request.method === 'GET' && localSlideParameters && objectShares) {
        const resolved = objectShares.describe(localSlideParameters[0], url.searchParams.get('version'),
          { snapshotId: url.searchParams.get('snapshot') });
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        if (!isPresentationPath(resolved.internal.filePath)) throw new HttpError(415, 'Only presentations have slides.');
        const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
        const content = file ? timeline.blobs.get(file.contentHash) : null;
        if (!content) throw new HttpError(404, 'The presentation is unavailable.');
        const number = Number(localSlideParameters[1]);
        if (number < 1 || number > slideCount(content, file.contentHash)) throw new HttpError(404, 'The presentation has no such slide.');
        let picture;
        try { picture = await slidePicture(content, number, file.contentHash); } catch (error) {
          console.error('Lasso could not draw slide %d of %s: %s', number, resolved.internal.filePath, error.message);
          throw new HttpError(422, 'This slide couldn’t be drawn.');
        }
        return sendBinary(response, 200, picture, 'image/jpeg', { 'content-disposition': 'inline',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      }

      // A linked video, in the byte ranges the inspector's player asks for.
      const localVideoParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/video$/);
      if (['GET', 'HEAD'].includes(request.method) && localVideoParameters && objectShares) {
        const resolved = objectShares.describe(localVideoParameters[0], url.searchParams.get('version'),
          { snapshotId: url.searchParams.get('snapshot') });
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
        if (file?.fileType !== 'video') throw new HttpError(404, 'This source is not a video.');
        const types = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v' };
        return sendFileRange(request, response, timeline.blobs.rawPath(file.contentHash),
          types[path.extname(file.path).toLowerCase()] ?? 'application/octet-stream');
      }

      const localObjectPreviewParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/preview$/);
      if (request.method === 'GET' && localObjectPreviewParameters && objectShares) {
        const versionId = url.searchParams.get('version');
        // A version spans snapshots whose files differ: the request may name the one to show.
        const askedSnapshotId = url.searchParams.get('snapshot');
        const resolved = objectShares.describe(localObjectPreviewParameters[0], versionId, { snapshotId: askedSnapshotId });
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        let preview = null, sharedExcerpt = null, nearbyExcerpt = null, bytesReleased = null;
        // The suggestion card scrolls, so it asks for more of the source around the citation.
        const wide = url.searchParams.get('context') === 'wide';
        const radius = wide ? ASSIST_SCROLL_TABLE_RADIUS : ASSIST_TABLE_RADIUS;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          // A video plays from its own file, at the quoted moment; its bytes are not read here.
          if (file?.fileType === 'video') {
            const absent = timeline.blobs.has(file.contentHash) ? null : timeline.blobs.absent(file.contentHash);
            return sendJson(response, 200, { source: resolved.source, path: resolved.internal.filePath,
              preview: dependencies.videoPreview(file, resolved.source, url.searchParams.get('text') ?? '',
                dependencies.videoLocalPath(resolved.internal.snapshotId, file.path)),
              citedPart: null, shareScopes: offeredShareScopes(resolved.internal.filePath, resolved.source.anchor),
              ...(absent instanceof BlobReleasedError ? { bytesReleased: absent.describe() } : {}) });
          }
          const sourceFile = file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null;
          // A table too large to read here previews from the table index.
          const window = file ? dependencies.tableWindow(file, sourceFile.content, resolved.source.anchor ?? {},
            { before: radius, after: Math.max(radius, ASSIST_COLUMN_ROWS) }) : null;
          preview = path.extname(file?.path ?? '').toLowerCase() === '.pdf'
            ? buildInspectorPreview(sourceFile, resolved.source.anchor, resolved.source.metadata, resolved.source.label, resolved.source.objectType)
            : buildSharePreview(sourceFile, resolved.source.anchor, resolved.source.metadata, radius,
              resolved.source.objectType, { display: true, columnRows: ASSIST_COLUMN_ROWS, window });
          // Text, Markdown and Word sources show the cited passage in context.
          if (!preview && isTextPreviewPath(file?.path)) {
            preview = buildInspectorPreview(sourceFile, resolved.source.anchor, resolved.source.metadata,
              resolved.source.label, resolved.source.objectType,
              { matchText: url.searchParams.get('text') ?? '', ...(wide ? { context: ASSIST_TEXT_CONTEXT } : {}) });
          }
          if (preview?.kind === 'pdf') {
            const query = pinnedQuery(versionId, resolved, askedSnapshotId);
            preview.fileUrl = `/api/dependency-objects/${encodeURIComponent(localObjectPreviewParameters[0])}/source${query}`;
          }
          // The share composer is shown the table its "Cited part only" publishes.
          if (url.searchParams.get('shared') === '1' && sourceFile) {
            sharedExcerpt = buildSharedExcerpt(sourceFile, resolved.source.anchor, resolved.source.metadata);
            // A cited cell or row may also be shared with the rows around it, which the composer can switch on.
            const nearby = buildSharedExcerpt(sourceFile, resolved.source.anchor, resolved.source.metadata, { nearbyRows: true });
            if (nearby?.rows && JSON.stringify(nearby) !== JSON.stringify(sharedExcerpt)) nearbyExcerpt = nearby;
          }
          // The card asks for the cited slide's picture next; it is already being drawn.
          if (preview?.deck && file) {
            slidePicture(sourceFile.content, preview.slideNumber ?? 1, file.contentHash).catch(() => {});
          }
        } catch (error) {
          preview = null;
          // An old version whose bytes retention released still has its recorded source.
          if (error instanceof BlobReleasedError) bytesReleased = error.describe();
        }
        preview = await resolvedModelPreview(resolved) ?? preview;
        bytesReleased ??= preview?.bytesReleased ?? null;
        return sendJson(response, 200, {
          source: resolved.source, path: resolved.internal.filePath, preview,
          // What the share composer's "Cited part only" would publish.
          citedPart: citedPartModel(preview),
          ...(sharedExcerpt?.rows ? { sharedExcerpt } : {}),
          ...(nearbyExcerpt ? { nearbyExcerpt } : {}),
          shareScopes: offeredShareScopes(resolved.internal.filePath, resolved.source.anchor),
          // Said plainly when the original file of this version was not kept.
          ...(bytesReleased ? { bytesReleased } : {}),
          // The value's past versions, most recent first, read only for previews.
          history: dependencies.previewHistory(localObjectPreviewParameters[0]),
        });
      }

      if (await driveRoutes({ request, response, url, pathname, timeline, config })) return;

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
          result: await terminal.executor.run(parameters[0], body.input, actorFrom(body), {
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
          share: await objectShares.createPublishedShare({
            projectId: parameters[0],
            objectId: body.objectId,
            versionId: body.versionId ?? null,
            snapshotId: typeof body.snapshotId === 'string' ? body.snapshotId : null,
            actor: actorFrom(body),
            expiresAt: body.expiresAt ?? null,
            accessScope: body.accessScope ?? 'DOCUMENT',
            redactions: body.redactions ?? [],
            markup: body.markup ?? [],
            citedIn: body.citedIn ?? null,
            nearbyRows: body.nearbyRows === true,
          }),
        });
      }
      if (request.method === 'GET' && parameters && objectShares) {
        return sendJson(response, 200, { shares: objectShares.listShares(parameters[0]) });
      }

      parameters = match(pathname, /^\/api\/object-shares\/([^/]+)\/revoke$/);
      if (request.method === 'POST' && parameters && objectShares) {
        return sendJson(response, 200, await objectShares.revokeShare(parameters[0]));
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

      // The old browser workbench is the Windows app's window; on a Mac, Lasso is in the menu bar.
      if (request.method === 'GET' && ['/', '/index.html'].includes(pathname) && !opensWorkbench(url)) {
        return sendHtml(response, 200, renderMenuBarHome(), WORKSPACE_PAGE_HEADERS);
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
