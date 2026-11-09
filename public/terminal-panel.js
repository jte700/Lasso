// The source library with its terminal prompt, wired to the workspace, and the source evidence dialog.
import { createSourceDialog } from './source-dialog.js?v=1';
import { createSourceWorkbench } from './source-workbench.js?v=6';
import { desktop, state } from './state.js?v=1';
import { toast } from './utilities.js?v=1';
import { api, recordRecommendationUsage } from './api.js?v=1';
import { workspaceVersion, projectIsOffline, selectProject } from './workspace-projects.js?v=1';
import { setWorkspaceView } from './workspace-shell.js?v=1';
import { showPreview } from './snapshot-preview.js?v=1';
import { openDocument } from './editor-document.js?v=1';
import { focusDependency } from './dependency-inspector.js?v=1';

export const openSourceDialog = createSourceDialog({ api, getActor: () => state.identity, onStatus: message => toast(message) });

export const terminalInput = document.getElementById('terminal-input');

// The terminal and the editor are two views of one dependency graph, so the
// shell opens documents through the same path the sidebar does.
export const dependencyShell = createSourceWorkbench({
  input: terminalInput,
  api,
  getProjectId: () => state.project?.id ?? null,
  getIsOffline: projectIsOffline,
  getProjectVersion: workspaceVersion,
  getWorkspaceId: () => workspaceVersion(),
  getDocumentProjectId: () => state.editor.document?.projectId ?? null,
  getDocumentPath: () => state.editor.document?.path ?? null,
  getContext: () => state.editor.activeBlock?.textContent ?? '',
  getActor: () => state.identity,
  onRecommendationUsage: recordRecommendationUsage,
  onShare: desktop?.isWindows ? object => openSourceDialog({ sourceId: object.id, versionId: object.versionId, projectId: object.projectId ?? state.project.id, openSharing: true }) : null,
  onOpenSource: (object, context) => {
    if (object.snapshotId) { setWorkspaceView('source'); showPreview(object.snapshotId, object.path, object.anchor, object, context); }
  },
  onStatus: (message) => toast(message),
  onSession: (session) => {
    const review = session ? (session.stale ?? 0) + (session.failures ?? 0) : 0;
    const sourceCount = document.getElementById('rail-source-count');
    const changeCount = document.getElementById('rail-change-count');
    const reviewCount = document.getElementById('rail-review-count');
    if (sourceCount) sourceCount.textContent = String(session?.files ?? 0);
    if (changeCount) changeCount.textContent = session?.changes ? String(session.changes) : '';
    if (reviewCount) reviewCount.textContent = review ? String(review) : '';
  },
  onOpenDocument: async (documentPath, reference) => {
    const target = documentPath ?? reference?.documentPath;
    if (!target) return;
    try {
      const projectId = reference?.projectId ?? state.project?.id;
      if (projectId !== state.project?.id && !await selectProject(projectId, false)) return;
      await openDocument(target, projectId);
      if (reference?.dependencyId) focusDependency(reference.dependencyId);
    } catch (error) { toast(error.message, 'error'); }
  },
});
