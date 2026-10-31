import { createRemovableDrives } from './removable-drives.js?v=1';
import { createCommandPalette } from './palette.js';
import { createDirectorySidebar, createTabBar, createSpatialWorkbench } from './shell.js?v=5';
import { dismissLassoOverlays } from './escape-dismissal.js';
import { desktop, shortcut, state, elements, identityId, setIdentity } from './state.js?v=1';
import { toast, openDialog } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import {
  loadProjects, toggleDirectory, projectIsOffline, hasUnsavedEditorChanges, refreshDriveProjects,
  selectProject, refreshProject,
} from './workspace-projects.js?v=1';
import { shell, showSession, selectShellTab } from './workspace-shell.js?v=1';
import { openSourceDialog, terminalInput, dependencyShell } from './terminal-panel.js?v=1';
import { openManuscriptWorkspace, openDocument } from './editor-document.js?v=1';
import { clearPrediction } from './editor-predictions.js?v=1';
import { saveDocument } from './editor-save.js?v=1';
import { hideDependencyPicker } from './dependency-picker.js?v=1';
import { openActiveDependencySharing } from './dependency-inspector.js?v=1';
import { loadSharedDependency } from './shared-source.js?v=1';
import { currentTheme, applyTheme, showShortcuts } from './platform-settings.js?v=1';

elements['import-button'].addEventListener('click', () => openDialog(elements['import-dialog']));
elements['identity-button'].addEventListener('click', () => {
  const form = elements['identity-form'];
  form.elements.displayName.value = state.identity.displayName;
  form.elements.actorType.value = state.identity.actorType;
  openDialog(elements['identity-dialog']);
});
elements['project-select'].addEventListener('change', async (event) => {
  const projectId = event.target.value;
  if (!projectId) return;
  try { await selectProject(projectId); }
  catch (error) {
    if (state.project?.id) elements['project-select'].value = state.project.id;
    toast(error.message, 'error');
  }
});
elements['editor-nav'].addEventListener('click', () => openManuscriptWorkspace());
elements['ribbon-editor'].addEventListener('click', () => state.project && openManuscriptWorkspace());
document.getElementById('global-share-button').addEventListener('click', () => {
  if (state.view === 'editor') openActiveDependencySharing();
  else toast('Open a document and select a linked source to share its evidence.');
});
document.querySelectorAll('[data-library-view]').forEach((button) => button.addEventListener('click', () => {
  if (!state.project) {
    openDialog(elements['import-dialog']);
    return;
  }
  const view = button.dataset.libraryView;
  if (view === 'documents') openManuscriptWorkspace();
  else if (view === 'sources') {
    openManuscriptWorkspace().then(() => document.getElementById('audit-button')?.click());
  } else toast(`${button.textContent.trim()} will use the same project library in a future workspace view.`);
}));
document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close-dialog]');
  if (close) close.closest('dialog')?.close();
});
window.addEventListener('beforeunload', (event) => {
  if (!state.editor.dirty && !state.editor.pendingLinks.length && !state.editor.savePromise) return;
  event.preventDefault();
  event.returnValue = '';
});

elements['import-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.classList.add('loading'); submit.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const rootPaths = values.rootPaths.split(/\r?\n/).map(path => path.trim()).filter(Boolean);
    if (!rootPaths.length) throw new Error('Enter at least one absolute directory path.');
    await api('/api/workspace/directories', {
      method: 'POST', body: JSON.stringify({ rootPaths, actor: state.identity }),
    });
    elements['import-dialog'].close(); form.reset();
    const workspace = await api('/api/workspace');
    const added = workspace.directories.find(directory => rootPaths.includes(directory.rootPath));
    toast(`${rootPaths.length} ${rootPaths.length === 1 ? 'directory' : 'directories'} included in workspace`);
    await loadProjects(added?.id);
  } catch (error) { form.querySelector('[data-dialog-error]').textContent = error.message; }
  finally { submit.classList.remove('loading'); submit.disabled = false; }
});

elements['identity-form'].addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  const identity = { id: identityId(values.displayName, values.actorType), displayName: values.displayName.trim(), actorType: values.actorType };
  setIdentity(identity);
  elements['identity-dialog'].close();
  if (state.project) await selectProject(state.project.id);
  toast(`Working as ${identity.displayName}`);
});

/// Everything the workspace can do, as one flat list for the palette.
function paletteCommands() {
  const commands = [];

  for (const document_ of state.editor.documents ?? []) {
    const name = document_.path.split('/').pop();
    commands.push({
      title: `open ${name}`,
      hint: document_.path,
      run: () => openDocument(document_.path),
    });
  }

  for (const project of state.projects ?? []) {
    if (project.id !== state.project?.id && project.available !== false) commands.push({
      title: `switch to ${project.name}`,
      hint: `documents · V${project.currentVersion}${project.active ? '' : ' · directory paused'}${project.availability === 'offline' ? ' · Offline (cached)' : ''}`,
      run: () => selectProject(project.id),
    });
    if (project.available !== false) commands.push({
      title: `${project.active ? 'pause' : 'include'} ${project.name}`,
      hint: 'workspace sources and suggestions',
      run: () => toggleDirectory(project.id, !project.active),
    });
  }

  commands.push(
    { title: 'add work directories', hint: 'include local folders in the workspace', run: () => openDialog(elements['import-dialog']) },
    { title: 'change identity', hint: `currently ${state.identity.displayName}`, run: () => {
      const form = elements['identity-form'];
      form.elements.displayName.value = state.identity.displayName;
      form.elements.actorType.value = state.identity.actorType;
      openDialog(elements['identity-dialog']);
    } },
    ...(!projectIsOffline() ? [{ title: 'reload sources', hint: 'refresh the current project', run: () => refreshProject() }] : []),
  );

  if (state.editor.document && !projectIsOffline()) {
    commands.push({ title: 'save document now', hint: state.editor.document.path, run: () => saveDocument() });
  }
  return commands;
}

setIdentity(state.identity);

shell.sidebar = createDirectorySidebar({
  host: document.getElementById('directory-list'),
  onSelect: (id) => selectProject(id).catch((error) => toast(error.message, 'error')),
  onToggle: toggleDirectory,
});
shell.tabs = createTabBar({
  host: document.getElementById('tab-scroll'),
  onSelect: selectShellTab,
});
document.getElementById('sidebar-add').addEventListener('click', () => openDialog(elements['import-dialog']));

const spatialWorkbench = createSpatialWorkbench({
  projectTrigger: document.getElementById('project-pill'),
  projectPopover: document.getElementById('project-popover'),
  workspaceButton: document.getElementById('workspace-nav'),
  onWorkspace: async () => { if (await showSession()) await dependencyShell.run('index status'); },
});
document.querySelectorAll('[data-workspace-query]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!state.project) { openDialog(elements['import-dialog']); return; }
    if (!await showSession()) return;
    document.querySelectorAll('.rail-item').forEach((item) => item.classList.remove('active'));
    button.closest('.rail-item')?.classList.add('active');
    dependencyShell.run(button.dataset.workspaceQuery);
  });
});
document.getElementById('tab-add').addEventListener('click', () => openDialog(elements['import-dialog']));

const commandPalette = createCommandPalette({
  getCommands: paletteCommands,
  onStatus: (message) => toast(message, 'error'),
});
window.dismissLassoOverlays = () => dismissLassoOverlays({
  document, palette: commandPalette, closeProjectPicker: () => spatialWorkbench.closeProjectPicker(),
  cancelPending: () => {
    clearPrediction();
    hideDependencyPicker();
    clearTimeout(state.editor.sourcePeekTimer);
    state.editor.sourcePeekTimer = null;
    state.editor.sourcePeekRequest += 1;
    state.editor.inspectorRequest += 1;
    state.editor.viewerRequest += 1;
    state.editor.sharingRequest += 1;
    state.editor.activeDependencyId = null;
  },
});
// A native overlay can consume Escape's keydown while the workspace browser
// still has focus. Keyup also dismisses browser overlays, idempotently.
window.addEventListener('keyup', (event) => {
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    window.dismissLassoOverlays();
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    window.dismissLassoOverlays();
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    event.preventDefault();
    shell.tabs?.activate(Number(event.key) - 1);
    return;
  }
  // ⌘K, and ⌘⇧P for hosts where the browser claims ⌘K first.
  if (modifier && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'p'))) {
    event.preventDefault();
    if (!event.shiftKey) { event.stopImmediatePropagation(); terminalInput.focus(); terminalInput.select(); }
    else commandPalette.toggle();
  }
}, true);

// The Mac app reports mounted drives to the server; the workspace shows them
// wherever it opens. Without that report the drive controls stay hidden.
const removableDrives = !desktop?.isWindows ? createRemovableDrives({
  api,
  getActor: () => state.identity,
  onProjectsChanged: refreshDriveProjects,
  beforeRemove: drive => {
    if (drive.projects?.some(project => project.id === state.project?.id) && hasUnsavedEditorChanges()) {
      toast('This drive has unsaved changes open. Reconnect it and save before removing its saved data.', 'error');
      return false;
    }
    return true;
  },
  onStatus: message => toast(message),
}) : null;

const launchParams = new URLSearchParams(window.location.search);
// Desktop hosts supply their own window chrome.
if (launchParams.get('app') === '1') document.documentElement.classList.add('native-app');
const sharedDependencyToken = launchParams.get('share');
if (sharedDependencyToken) loadSharedDependency(sharedDependencyToken);
else {
  loadProjects()
    .then(() => {
      removableDrives?.start();
      if (launchParams.get('drives') === 'open') window.dispatchEvent(new CustomEvent('lasso-open-drives'));
      if (launchParams.get('view') === 'documents' && state.project) return openManuscriptWorkspace();
      const view = launchParams.get('view');
      if (['changes', 'attention'].includes(view) && state.project) {
        return showSession().then(opened => opened && dependencyShell.run(view === 'changes' ? 'changes' : 'stale'));
      }
      return null;
    })
    .catch((error) => toast(error.message, 'error'));
}

// The native shell owns permissions and the actual running state.
const writingAssist = document.getElementById('writing-assist-toggle');
if (writingAssist && desktop?.isNative) {
  writingAssist.hidden = false;
  window.addEventListener('lasso-assist-state', event => {
    writingAssist.setAttribute('aria-checked', String(Boolean(event.detail?.enabled)));
    writingAssist.disabled = false;
  });
  writingAssist.addEventListener('click', () => {
    if (!state.project) { openDialog(elements['import-dialog']); return; }
    writingAssist.disabled = true;
    desktop.postMessage({action:'toggleSuggestions'});
  });
  desktop.postMessage({action:'suggestionState'});
}

// Windows shell affordances use the same workspace, settings, and save paths.
const folderButton = document.getElementById('choose-folder');
if (folderButton && desktop?.canChooseFolder) {
  folderButton.hidden = false;
  folderButton.addEventListener('click', () => {
    folderButton.disabled = true;
    desktop.postMessage({ action: 'chooseFolder' });
  });
  window.addEventListener('lasso-folder-selected', event => {
    folderButton.disabled = false;
    if (!event.detail.path) return;
    // Each chosen folder is added as one more line of the directory list.
    const input = elements['import-form'].elements.rootPaths;
    const lines = input.value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (!lines.includes(event.detail.path)) input.value = [...lines, event.detail.path].join('\n');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  });
}
window.addEventListener('lasso-host-error', event => {
  if (folderButton) folderButton.disabled = false;
  if (writingAssist) writingAssist.disabled = false;
  toast(event.detail.message, 'error');
});

if (desktop?.isWindows) {
  document.getElementById('search-shortcut').textContent = shortcut('K');
  elements['import-form'].elements.rootPaths.placeholder = 'C:\\Users\\you\\Documents\\Research\nC:\\Users\\you\\Documents\\Finance';
  document.getElementById('writing-assist-help').textContent = desktop.isNative
    ? 'Enable writing suggestions, then type in an editor that supports Windows UI Automation. Tab accepts and links a source, Ctrl+Enter inserts plain text, ↑ and ↓ select, and Esc dismisses. Password fields are excluded.'
    : 'Open Lasso for Windows to enable suggestions in supported desktop editors. Your project library and writing workspace are also available here.';
  const settings = document.getElementById('settings-dialog');
  const theme = document.getElementById('windows-theme');
  document.getElementById('windows-settings').addEventListener('click', () => {
    const current = currentTheme();
    theme.value = current === 'system' || current === 'alabaster' ? current : 'carbon';
    settings.showModal();
    showShortcuts(document.getElementById('settings-shortcuts'));
  });
  theme.addEventListener('change', () => applyTheme(theme.value));
}

window.addEventListener('lasso-open-source', event => openSourceDialog(event.detail));
