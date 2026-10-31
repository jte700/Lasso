// The workspace's directories: loading them, switching the open project and keeping the page in step with changes.
import { createVisibilityRefresh } from './visibility-refresh.js';
import { desktop, state, elements } from './state.js?v=1';
import { escapeHtml, toast } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import { refreshShell, showSession } from './workspace-shell.js?v=1';
import { dependencyShell } from './terminal-panel.js?v=1';
import { resetEditorProjectState, openManuscriptWorkspace } from './editor-document.js?v=1';
import { scheduleEditorAutosave } from './editor-surface.js?v=1';
import { clearPrediction } from './editor-predictions.js?v=1';
import { saveDocument } from './editor-save.js?v=1';

let nativeWindowVisible = window.__lassoWindowVisible !== false;
const projectRefresh = createVisibilityRefresh({
  visible: !document.hidden && nativeWindowVisible,
  load: (projectId, signal) => Promise.all([
    projectId === 'workspace' ? Promise.resolve(null) : api(`/api/projects/${projectId}`, { signal }),
    api('/api/workspace', { signal }),
  ]),
  apply: ([projectResponse, workspace], projectId) => {
    if ((state.project?.id ?? 'workspace') !== projectId) return;
    const changed = applyWorkspace(workspace);
    const projectChanged = projectResponse && JSON.stringify(state.project) !== JSON.stringify(projectResponse.project);
    if (projectResponse) state.project = projectResponse.project;
    if (changed || projectChanged) {
      if (state.project) renderProjectContext();
      else {
        const first = state.projects.find(project => project.available !== false);
        if (first) void selectProject(first.id, false).catch(error => toast(error.message, 'error'));
        else renderEmpty();
      }
    }
    if (changed) {
      clearPrediction();
      dependencyShell.reset();
      if (state.view === 'session' && state.project) void dependencyShell.refresh();
    }
  },
  onError: error => toast(error.message, 'error'),
});
function updateWindowVisibility() {
  const visible = !document.hidden && nativeWindowVisible;
  projectRefresh.setVisible(visible);
  if (!visible) clearPrediction();
}
document.addEventListener('visibilitychange', updateWindowVisibility);
window.addEventListener('lasso-window-visibility', event => {
  nativeWindowVisible = event.detail?.visible !== false;
  updateWindowVisibility();
});
window.addEventListener('pagehide', () => projectRefresh.setVisible(false));
window.addEventListener('pageshow', updateWindowVisibility);

export async function loadProjects(preferredId = null) {
  applyWorkspace(await api('/api/workspace'));
  const projects = state.projects.filter(project => project.available !== false);
  const saved = preferredId ?? localStorage.getItem('lasso.projectId') ?? localStorage.getItem('colab.projectId');
  const project = projects.find((candidate) => candidate.id === saved) ?? projects.find(candidate => candidate.active) ?? projects[0] ?? null;
  if (project) await selectProject(project.id, true);
  else renderEmpty();
}

export function workspaceVersion() {
  return `${state.workspace.revision}:${state.projects.filter(project => project.active && project.available !== false)
    .map(project => `${project.id}:${project.currentSnapshotId}`).join(',')}`;
}

export function applyWorkspace(workspace) {
  if (Number.isFinite(workspace.revision) && Number.isFinite(state.workspace.revision)
    && workspace.revision < state.workspace.revision) return false;
  const changed = JSON.stringify(state.workspace) !== JSON.stringify(workspace);
  state.workspace = workspace;
  state.projects = workspace.directories ?? [];
  elements['project-select'].innerHTML = '<option value="">No directory selected</option>' + state.projects
    .map(project => `<option value="${escapeHtml(project.id)}" ${project.available === false ? 'disabled' : ''}>${escapeHtml(project.name)} · V${project.currentVersion}${project.active ? '' : ' · Paused'}${project.availability === 'offline' ? ' · Offline (cached)' : ''}</option>`).join('');
  if (state.project) elements['project-select'].value = state.project.id;
  return changed;
}

export async function toggleDirectory(projectId, active) {
  try {
    await api(`/api/workspace/directories/${encodeURIComponent(projectId)}`, {
      method: 'POST', body: JSON.stringify({ active, actor: state.identity }),
    });
    applyWorkspace(await api('/api/workspace'));
    clearPrediction();
    dependencyShell.reset();
    renderProjectContext();
    if (state.view === 'session') await dependencyShell.refresh();
    toast(active ? 'Directory included in workspace' : 'Directory paused');
  } catch (error) { refreshShell(); toast(error.message, 'error'); }
}

export function projectIsOffline() {
  return (state.projects.find(project => project.id === state.project?.id) ?? state.project)?.availability === 'offline';
}

export function hasUnsavedEditorChanges() {
  return Boolean(state.editor.dirty || state.editor.pendingLinks.length || state.editor.savePromise);
}

export function syncOfflineEditor() {
  const offline = projectIsOffline();
  const sourceStatus = document.querySelector('.wb-status > span:last-child');
  if (sourceStatus) sourceStatus.textContent = `${offline ? 'Offline · saved copies' : 'Local workspace'}${state.project?.currentVersion ? ` · Version ${state.project.currentVersion}` : ''}`;
  const body = document.getElementById('document-body');
  if (body) {
    body.contentEditable = String(!offline);
    body.setAttribute('aria-readonly', String(offline));
  }
  document.querySelectorAll('.editor-toolbar button,.editor-toolbar select,.editor-history-buttons button,[data-retry]').forEach(button => { button.disabled = offline; });
  const save = document.getElementById('save-document');
  if (save) save.disabled = offline || !hasUnsavedEditorChanges();
  const status = document.getElementById('editor-save-state');
  if (offline) {
    clearTimeout(state.editor.autosaveTimer);
    state.editor.autosaveTimer = null;
    clearPrediction();
    if (status) status.textContent = hasUnsavedEditorChanges() ? 'Offline · reconnect to save your changes' : 'Offline · saved copy';
  } else if (status?.textContent.startsWith('Offline')) {
    status.textContent = hasUnsavedEditorChanges() ? 'Autosave pending' : 'Saved';
    if (hasUnsavedEditorChanges()) scheduleEditorAutosave();
  }
}

// Device changes update metadata without reopening a document or replacing its
// unsaved contents. A new index becomes active only when it is safe to switch.
export async function refreshDriveProjects({ preferredId = null, removedProjectIds = [] } = {}) {
  applyWorkspace(await api('/api/workspace'));
  const projects = state.projects;
  if (removedProjectIds.includes(state.project?.id)) {
    ++state.projectSwitchRevision;
    clearInterval(state.pollTimer);
    resetEditorProjectState();
    dependencyShell.reset();
    state.project = null;
    localStorage.removeItem('lasso.projectId');
    localStorage.removeItem('colab.projectId');
    renderEmpty();
  }
  const current = projects.find(project => project.id === state.project?.id);
  if (current) state.project = { ...state.project, ...current };
  if (preferredId && preferredId !== state.project?.id && !hasUnsavedEditorChanges()) {
    await selectProject(preferredId);
  } else if (!state.project && projects.length) {
    await selectProject(projects[0].id);
  } else if (state.project) {
    renderProjectContext();
  } else {
    refreshShell();
  }
}

export async function selectProject(projectId, reconcile = true) {
  const switchRevision = ++state.projectSwitchRevision;
  state.editor.navigationRevision += 1;
  const previousProjectId = state.project?.id ?? null;
  const switchingProjects = Boolean(previousProjectId && previousProjectId !== projectId);
  const reopenEditor = state.view === 'editor';
  if (switchingProjects && (state.editor.dirty || state.editor.pendingLinks.length || state.editor.savePromise)) {
    await saveDocument();
    if (switchRevision !== state.projectSwitchRevision) return false;
    if (state.editor.dirty || state.editor.pendingLinks.length) {
      elements['project-select'].value = previousProjectId;
      toast('Finish saving the current document before switching projects.', 'error');
      return false;
    }
  }
  const listedProject = state.projects.find((project) => project.id === projectId);
  if (listedProject?.available === false) throw new Error('This directory is unavailable. Restore it before opening its documents.');
  const nextProject = listedProject ?? (await api(`/api/projects/${projectId}`)).project;
  if (switchRevision !== state.projectSwitchRevision) return false;
  if (switchingProjects) {
    resetEditorProjectState();
    // The transcript belongs to the workspace it was run against.
    dependencyShell.reset();
  }
  state.project = nextProject;
  state.preview = null;
  state.selection = null;
  localStorage.setItem('lasso.projectId', projectId);
  elements['project-select'].value = projectId;
  if (reopenEditor) {
    elements['detail-column'].innerHTML = `<div class="detail-placeholder"><p>Opening ${escapeHtml(nextProject.name)} documents…</p></div>`;
  }
  if (reconcile && listedProject?.active) {
    try {
      const result = await api(`/api/projects/${projectId}/open`, {
        method: 'POST', body: JSON.stringify({ actor: state.identity }),
      });
      if (switchRevision !== state.projectSwitchRevision || state.project?.id !== projectId) return false;
      state.project = { ...state.project, ...result.project };
      if (result.capture.changed) toast(`Captured Version ${result.capture.snapshot.version}`);
    } catch (error) { toast(error.message, 'error'); }
  }
  if (switchRevision !== state.projectSwitchRevision || state.project?.id !== projectId) return false;
  await refreshProject(false, projectId);
  if (switchRevision !== state.projectSwitchRevision || state.project?.id !== projectId) return false;
  renderProjectContext();
  elements['editor-nav'].disabled = false;
  elements['ribbon-editor'].disabled = false;
  // Load the document list so tabs and the palette are populated, then rest on
  // the session view unless the user already had a document open.
  try {
    const { documents } = await api(`/api/projects/${projectId}/documents`);
    if (state.project?.id === projectId) state.editor.documents = documents;
  } catch { /* the session view says when nothing is indexed */ }
  if (reopenEditor) await openManuscriptWorkspace(null, { projectId, switchRevision });
  else await showSession();
  return true;
}

export async function refreshProject(silent = false, requestedProjectId = state.project?.id) {
  if (!requestedProjectId || state.project?.id !== requestedProjectId) return;
  projectRefresh.setProject(requestedProjectId);
  await projectRefresh.refresh({ silent });
}

export function renderProjectContext() {
  if (!state.project) return;
  const current = state.projects.find((project) => project.id === state.project.id) ?? state.project;
  elements['project-name'].textContent = current.name;
  elements['project-path'].textContent = `${current.rootPath}${current.availability === 'offline' ? ' · Offline — browsing saved copies' : ''}`;
  elements['project-path'].title = current.rootPath;
  document.title = `${current.name} · Lasso`;
  refreshShell();
  // The Windows companion scopes its suggestions to the selected directory;
  // the Mac app reads the workspace's active directories instead.
  if (desktop?.isWindows) desktop.postMessage({ activeProjectId: current.id });
  elements['status-version'].textContent = `Version ${current.currentVersion}`;
  const active = state.projects.filter(project => project.active && project.available !== false);
  elements['status-project'].textContent = `${active.length} ${active.length === 1 ? 'directory' : 'directories'} active`;
  elements['status-files'].textContent = `${active.reduce((count, project) => count + (project.fileCount ?? 0), 0)} files`;
  const selectedOption = elements['project-select'].querySelector(`option[value="${current.id}"]`);
  if (selectedOption) selectedOption.textContent = `${current.name} · V${current.currentVersion}${current.availability === 'offline' ? ' · Offline (cached)' : ''}`;
  syncOfflineEditor();
}

function renderEmpty() {
  state.project = null;
  projectRefresh.setProject('workspace');
  if (desktop?.isWindows) desktop.postMessage({ activeProjectId: null });
  elements['project-name'].textContent = 'Welcome to Lasso';
  showSession();
  elements['project-path'].textContent = 'Choose a local directory to begin.';
  refreshShell();
  elements['editor-nav'].disabled = true;
  elements['ribbon-editor'].disabled = true;
  elements['window-project-name'].textContent = 'Choose a project';
  elements['status-project'].textContent = 'No project';
  elements['status-version'].textContent = 'No version';
  elements['status-files'].textContent = '0 files';
}
