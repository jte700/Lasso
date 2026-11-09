// The frame around the workspace: which view is showing, the directory list, the tabs and the source library.
import { renderSession } from './shell.js?v=5';
import { desktop, state, elements } from './state.js?v=1';
import { toast, openDialog } from './utilities.js?v=1';
import { dependencyShell } from './terminal-panel.js?v=1';
import { openDocument } from './editor-document.js?v=1';
import { saveDocument } from './editor-save.js?v=1';
import { hideDependencyPicker } from './dependency-picker.js?v=1';

export function setWorkspaceView(view) {
  if (view !== 'editor') state.editor.navigationRevision += 1;
  state.view = view;
  if (desktop?.isWindows && view !== 'session') {
    document.querySelectorAll('.rail-navigation .rail-item').forEach(button => { button.classList.remove('active'); button.removeAttribute('aria-current'); });
  }
  const window_ = document.getElementById('app-window');
  window_?.classList.toggle('view-editor', view === 'editor');
  window_?.classList.toggle('view-session', view === 'session');
  elements['editor-nav'].classList.toggle('active', view === 'editor');
  elements['ribbon-editor'].classList.toggle('active', view === 'editor');
  document.getElementById('workspace-nav')?.classList.toggle('active', view === 'session');
}

export const shell = {
  sidebar: null,
  tabs: null,
  activeTab: 'session',
};

/// Projects are the directories the user has granted access to.
function directoriesFromProjects() {
  return state.projects.map((project) => ({
    id: project.id,
    name: project.name,
    path: project.rootPath,
    active: project.active,
    available: project.available,
    error: project.error,
    availability: project.availability,
    driveName: project.driveName,
  }));
}

function tabsForWorkspace() {
  const tabs = [];
  for (const document_ of state.editor.documents ?? []) {
    tabs.push({ id: `doc:${document_.path}`, title: document_.path.split('/').pop(), glyph: '' });
  }
  return tabs;
}

export function refreshShell() {
  shell.sidebar?.set(directoriesFromProjects(), state.project?.id ?? null);
  shell.tabs?.set(tabsForWorkspace(), shell.activeTab);
  const chrome = document.getElementById('window-project-name');
  if (chrome) {
    const active = state.projects.filter(project => project.active && project.available !== false).length;
    chrome.textContent = active ? `${active} work ${active === 1 ? 'directory' : 'directories'}` : 'Choose work directories';
  }
}

/// Return to the structured workspace overview.
export async function showSession() {
  const navigationRevision = ++state.editor.navigationRevision;
  const projectId = state.project?.id;
  const switchRevision = state.projectSwitchRevision;
  if (state.editor.document && (state.editor.dirty || state.editor.pendingLinks.length || state.editor.savePromise)) {
    await saveDocument();
    if (state.project?.id !== projectId || state.projectSwitchRevision !== switchRevision || navigationRevision !== state.editor.navigationRevision) return false;
    if (state.editor.dirty || state.editor.pendingLinks.length) {
      toast('Finish saving the current document before opening the source library.', 'error');
      return false;
    }
  }
  shell.activeTab = 'session';
  hideDependencyPicker();
  state.editor.document = null;
  setWorkspaceView('session');
  if (!state.project) {
    // First-run workspace.
    elements['detail-column'].innerHTML = renderSession({
      project: null,
      documents: [],
      identity: state.identity,
      warnings: [],
    });
    document.getElementById('empty-add-project')?.addEventListener('click', () => openDialog(elements['import-dialog']));
    refreshShell();
    return true;
  }
  elements['detail-column'].innerHTML = '<div class="dsh" id="dependency-shell"></div>';
  dependencyShell.setHost(document.getElementById('dependency-shell'));
  dependencyShell.mount();
  dependencyShell.refresh();
  // The prompt is this view's primary surface, so it takes focus with it.

  refreshShell();
  return true;
}

export function selectShellTab(id) {
  if (id === 'session') { showSession(); return; }
  if (id.startsWith('doc:')) {
    shell.activeTab = id;
    openDocument(id.slice(4));
  }
}
