// The workspace's routes: its folders, activity, predictions, previews, the
// terminal it runs across folders, and its value plans.

import { HttpError } from '../history/errors.js';
import { readJson, sendJson, actorFrom, match, sourceLibraryEntry } from './responses.js';

/** Answers the request when it is one of these routes; whether it did. */
export async function workspaceRoutes({ request, response, url, pathname, workspace, dependencies, terminal }) {
  await (async () => {
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
  })();
  return response.headersSent || response.writableEnded;
}
