// Requests to the local server, and the usage record that ranking learns from.
import { RECOMMENDATION_SESSION_ID, state } from './state.js?v=1';

export async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message ?? `Request failed (${response.status})`);
    error.details = body.error?.details;
    throw error;
  }
  return body;
}

export function recordRecommendationUsage(source, kind, context = {}) {
  const projectId = source?.projectId ?? (Object.hasOwn(context, 'projectId') ? context.projectId : state.project?.id);
  const identity = source?.objectId ? { objectId: source.objectId }
    : source?.dependencyId ? { dependencyId: source.dependencyId }
      : source?.path ? { path: source.path } : null;
  if (!projectId || !identity) return;
  void api(`/api/projects/${encodeURIComponent(projectId)}/recommendation-usage`, {
    method: 'POST',
    body: JSON.stringify({
      ...identity, kind, sessionId: RECOMMENDATION_SESSION_ID,
      documentPath: Object.hasOwn(context, 'documentPath') ? context.documentPath : state.editor.document?.path,
    }),
  }).catch(() => { /* Ranking history must never interrupt the requested action. */ });
}
