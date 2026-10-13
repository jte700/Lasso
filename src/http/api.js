import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { buildPreview } from '../history/preview.js';
import { HttpError } from '../history/errors.js';
import { renderSharePage, renderUnavailable, renderInspectorPanel } from '../sharing/share-page.js';
import { buildFullShareDocument, buildSharePreview } from '../sharing/share-preview.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
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

function sendHtml(response, status, html) {
  const body = Buffer.from(html, 'utf8');
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
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

function match(pathname, pattern) {
  const result = pathname.match(pattern);
  return result ? result.slice(1).map(decodeURIComponent) : null;
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
  });
  response.end(content);
  return true;
}

export function createRequestHandler(timeline, rfi, dependencies, config, objectShares, terminal = null, workspace = null) {
  return async function requestHandler(request, response) {
    try {
      const url = new URL(request.url, 'http://localhost');
      const { pathname } = url;

      // Public share links. Deliberately ahead of the API and static routes,
      // and reachable without any session.
      let shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const token = shareParameters[0];
        const resolved = objectShares.resolveShare(token);
        if (resolved.status !== 'OK') {
          return sendHtml(response, resolved.status === 'NOT_FOUND' ? 404 : 410,
            renderUnavailable(resolved.status));
        }
        let preview = null;
        let document = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          const sourceFile = file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null;
          preview = buildSharePreview(sourceFile, resolved.source.anchor, resolved.source.metadata);
          if (resolved.share.accessScope === 'REDACTED') document = buildFullShareDocument(sourceFile);
        } catch { preview = null; document = null; }
        return sendHtml(response, 200, renderSharePage(resolved, token, preview, document));
      }

      shareParameters = match(pathname, /^\/d\/([A-Za-z0-9_-]{16,128})\/download$/);
      if (request.method === 'GET' && shareParameters && objectShares) {
        const file = objectShares.sourceFile(shareParameters[0]);
        if (file.status !== 'OK') {
          const status = file.status === 'NOT_FOUND' ? 404 : file.status === 'SCOPE_RESTRICTED' ? 403 : 410;
          return sendHtml(response, status, renderUnavailable(file.status));
        }
        // Only the basename is ever published, and quotes/newlines are stripped
        // so the header cannot be split.
        const filename = path.basename(String(file.filename)).replace(/["\r\n\\]/g, '_');
        return sendBinary(response, 200, file.content, file.contentType, {
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
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
          preview = buildSharePreview(
            file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null,
            resolved.source.anchor, resolved.source.metadata);
        } catch { preview = null; }
        return sendHtml(response, 200, renderInspectorPanel(resolved, referenceId, preview));
      }

      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, service: 'scientific-version-timeline' });
      }
      if (workspace) {
        if (request.method === 'GET' && pathname === '/api/workspace') {
          return sendJson(response, 200, workspace.state());
        }
        if (request.method === 'POST' && pathname === '/api/workspace/directories') {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.add(body.rootPaths, actorFrom(body)));
        }
        const directory = match(pathname, /^\/api\/workspace\/directories\/([^/]+)$/);
        if (request.method === 'POST' && directory) {
          const body = await readJson(request);
          return sendJson(response, 200, await workspace.toggle(directory[0], body.active, actorFrom(body)));
        }
        if (request.method === 'POST' && pathname === '/api/workspace/dependencies/predict') {
          return sendJson(response, 200, { prediction: await workspace.predict(await readJson(request)) });
        }
        if (request.method === 'GET' && pathname === '/api/workspace/source-library') {
          return sendJson(response, 200, { objects: workspace.search(url.searchParams.get('query') ?? '', {
            documentProjectId: url.searchParams.get('documentProjectId'),
            documentPath: url.searchParams.get('documentPath'), context: url.searchParams.get('context'),
            limit: Number.MAX_SAFE_INTEGER, diversify: false, enrich: false,
          }).map(({ searchText, contentHash, metadata, ...object }) => object) });
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
          return sendJson(response, 200, { preview: workspace.terminalPreview(body.ref) });
        }
        if (request.method === 'POST' && pathname === '/api/workspace/terminal') {
          const body = await readJson(request);
          return sendJson(response, 200, { result: await workspace.terminalRun(body.input, actorFrom(body), body) });
        }
      }
      const localObjectParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)$/);
      if (request.method === 'GET' && localObjectParameters) {
        const object = dependencies.objectById(localObjectParameters[0]);
        if (!object) throw new HttpError(404, 'Indexed object not found.');
        return sendJson(response, 200, { object });
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
            file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null);
        } catch { document = null; }
        return sendJson(response, 200, {
          source: resolved.source, path: resolved.internal.filePath, document,
        });
      }

      const localObjectPreviewParameters = match(pathname, /^\/api\/dependency-objects\/([^/]+)\/preview$/);
      if (request.method === 'GET' && localObjectPreviewParameters && objectShares) {
        const versionId = url.searchParams.get('version');
        const resolved = objectShares.describe(localObjectPreviewParameters[0], versionId);
        if (resolved.status !== 'OK') throw new HttpError(404, 'Indexed object not found.');
        let preview = null;
        try {
          const file = timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
          preview = buildSharePreview(
            file ? { path: file.path, content: timeline.blobs.get(file.contentHash) } : null,
            resolved.source.anchor, resolved.source.metadata);
        } catch { preview = null; }
        return sendJson(response, 200, {
          source: resolved.source, path: resolved.internal.filePath, preview,
        });
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
        const capture = timeline.capture(project.id, actorFrom(body), {
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
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/events$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, { events: timeline.listEvents(parameters[0]) });
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
        const preview = buildPreview(snapshot, file, timeline.blobs.get(file.contentHash));
        return sendJson(response, 200, { preview });
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
        return sendJson(response, 200, {
          result: terminal.executor.run(parameters[0], body.input, actorFrom(body), {
            documentPath: body.documentPath, context: body.context,
          }),
        });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/terminal\/session$/);
      if (request.method === 'GET' && parameters && terminal) {
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
        return sendJson(response, 200, { preview: terminal.executor.preview(parameters[0], body.ref) });
      }

      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/dependencies\/predict$/);
      if (request.method === 'POST' && parameters) {
        const body = await readJson(request);
        return sendJson(response, 200, { prediction: dependencies.predict(parameters[0], body) });
      }
      parameters = match(pathname, /^\/api\/projects\/([^/]+)\/source-library$/);
      if (request.method === 'GET' && parameters) {
        // The library groups by file itself, so keep every matching indexed
        // object while using the same query, document and usage ranking.
        const objects = dependencies.search(parameters[0], url.searchParams.get('query') ?? '', {
          documentPath: url.searchParams.get('documentPath'),
          context: url.searchParams.get('context'),
          limit: Number.MAX_SAFE_INTEGER, diversify: false, enrich: false,
        }).map(({ searchText, contentHash, metadata, ...object }) => object);
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
        return sendBinary(response, 200, sourceFile.content, sourceFile.contentType, {
          'content-disposition': `inline; filename="${filename}"`,
        });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/viewer$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, {
          viewer: dependencies.dependencySourceViewer(parameters[0], {
            sheet: url.searchParams.get('sheet'),
          }),
        });
      }
      parameters = match(pathname, /^\/api\/dependencies\/([^/]+)\/preview$/);
      if (request.method === 'GET' && parameters) {
        return sendJson(response, 200, {
          preview: dependencies.dependencyPreview(parameters[0], {
            contextRadius: url.searchParams.get('contextRadius'),
          }),
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
