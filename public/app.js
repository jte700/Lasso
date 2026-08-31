import { caretPointForTextLengths, contextualCompletionCase } from './editor-acceptance.js';
import { createCommandPalette } from './palette.js';
import { createDirectorySidebar, createTabBar, createSidebarResize, createSpatialWorkbench, renderSession, shortenPath } from './shell.js?v=3';
import { createDependencyShell } from './dependency-shell.js?v=4';
import { renderAssistBox } from './assist-box.js?v=2';

const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;
// The interface build, taken from this module's own cache-busting query. Shown
// in the terminal banner so "which build am I running?" is answerable on sight.
const UI_BUILD = new URL(import.meta.url).searchParams.get('v') ?? 'dev';

const state = {
  projects: [],
  project: null,
  preview: null,
  identity: loadIdentity(),
  proposedExecution: null,
  pollTimer: null,
  statusTimer: null,
  projectSwitchRevision: 0,
  view: 'timeline',
  editor: {
    documents: [], document: null, dirty: false, prediction: null, predictionIndex: 0,
    predictionTimer: null, predictionController: null,
    activeBlock: null, manualClaim: null, pickerMode: 'link',
    revealDependencyId: null, revealTimer: null,
    pendingLinks: [], autosaveTimer: null, savePromise: null, editRevision: 0,
    undoStack: [], redoStack: [], restoringHistory: false, lastHistoryAt: 0, lastHistoryType: null,
    activeDependencyId: null, sourcePeekTimer: null, sourcePeekRequest: 0,
  },
};

const elements = Object.fromEntries([
  'project-select', 'project-name', 'project-path', 'detail-column', 'import-button', 'identity-button', 'avatar-initials', 'import-dialog',
  'import-form', 'identity-dialog', 'identity-form', 'toast-region',
  'editor-nav', 'ribbon-editor',
  'window-project-name', 'status-message', 'status-project', 'status-version', 'status-files', 'status-identity',
].map((id) => [id, document.getElementById(id)]));

function loadIdentity() {
  try {
    return JSON.parse(localStorage.getItem('colab.identity')) ?? defaultIdentity();
  } catch { return defaultIdentity(); }
}

function defaultIdentity() {
  return { id: 'human-self:maya-chen', displayName: 'Maya Chen', actorType: 'HUMAN_SELF' };
}

function identityId(name, type) {
  return `${type.toLowerCase()}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function api(url, options = {}) {
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

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  elements['toast-region'].append(node);
  setTimeout(() => node.remove(), 4200);
  if (elements['status-message']) {
    clearTimeout(state.statusTimer);
    elements['status-message'].textContent = message;
    state.statusTimer = setTimeout(() => { elements['status-message'].textContent = 'Ready'; }, 4200);
  }
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function setIdentity(identity) {
  state.identity = identity;
  localStorage.setItem('colab.identity', JSON.stringify(identity));
  elements['avatar-initials'].textContent = initials(identity.displayName);
  const sidebarName = document.getElementById('sidebar-identity-name');
  const sidebarRole = document.getElementById('sidebar-identity-role');
  if (sidebarName) sidebarName.textContent = identity.displayName;
  if (sidebarRole) sidebarRole.textContent = identity.actorType === 'HUMAN_COLLABORATOR' ? 'Collaborator' : 'Local workspace';
  if (elements['status-identity']) elements['status-identity'].textContent = identity.displayName;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function loadProjects(preferredId = null) {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  elements['project-select'].innerHTML = '<option value="">No project selected</option>' + projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)} · V${project.currentVersion}</option>`).join('');
  const saved = preferredId ?? localStorage.getItem('colab.projectId');
  const project = projects.find((candidate) => candidate.id === saved) ?? projects[0] ?? null;
  if (project) await selectProject(project.id, true);
  else renderEmpty();
}

async function selectProject(projectId, reconcile = true) {
  const switchRevision = ++state.projectSwitchRevision;
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
  localStorage.setItem('colab.projectId', projectId);
  elements['project-select'].value = projectId;
  if (reopenEditor) {
    elements['detail-column'].innerHTML = `<div class="detail-placeholder"><p>Opening ${escapeHtml(nextProject.name)} documents…</p></div>`;
  }
  if (reconcile) {
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
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => refreshProject(true), 5000);
  // Load the document list so tabs and the palette are populated, then rest on
  // the session view unless the user already had a document open.
  try {
    const { documents } = await api(`/api/projects/${projectId}/documents`);
    if (state.project?.id === projectId) state.editor.documents = documents;
  } catch { /* the session view says when nothing is indexed */ }
  if (reopenEditor) await openManuscriptWorkspace(null, { projectId, switchRevision });
  else showSession();
  return true;
}

async function refreshProject(silent = false, requestedProjectId = state.project?.id) {
  if (!requestedProjectId) return;
  try {
    const [projectResponse, projectsResponse] = await Promise.all([
      api(`/api/projects/${requestedProjectId}`),
      api('/api/projects'),
    ]);
    if (state.project?.id !== requestedProjectId) return;
    state.project = projectResponse.project;
    state.projects = projectsResponse.projects;
    renderProjectContext();
  } catch (error) {
    if (!silent) toast(error.message, 'error');
  }
}

function renderProjectContext() {
  if (!state.project) return;
  const current = state.projects.find((project) => project.id === state.project.id) ?? state.project;
  elements['project-name'].textContent = current.name;
  elements['project-path'].textContent = current.rootPath;
  elements['project-path'].title = current.rootPath;
  document.title = `${current.name} — CoLab Dry`;
  refreshShell();
  // Tell the macOS app which project system-wide suggestions should use.
  window.webkit?.messageHandlers?.colab?.postMessage({ activeProjectId: current.id });
  elements['window-project-name'].textContent = current.name;
  elements['status-project'].textContent = current.name;
  elements['status-version'].textContent = `Version ${current.currentVersion}`;
  elements['status-files'].textContent = `${current.fileCount ?? state.project.fileCount ?? 0} files`;
  const selectedOption = elements['project-select'].querySelector(`option[value="${current.id}"]`);
  if (selectedOption) selectedOption.textContent = `${current.name} · V${current.currentVersion}`;
}

function renderEmpty() {
  state.project = null;
  elements['project-name'].textContent = 'Scientific timeline';
  elements['project-path'].textContent = 'Choose a local directory to begin.';
  refreshShell();
  elements['editor-nav'].disabled = true;
  elements['ribbon-editor'].disabled = true;
  elements['window-project-name'].textContent = 'Scientific workspace';
  elements['status-project'].textContent = 'No project';
  elements['status-version'].textContent = 'No version';
  elements['status-files'].textContent = '0 files';
}

async function showPreview(snapshotId, path, returnEventId = null, focusAnchor = null) {
  try {
    const { preview } = await api(`/api/snapshots/${snapshotId}/preview?path=${encodeURIComponent(path)}`);
    state.preview = preview;
    state.selection = null;
    renderPreview(preview, returnEventId, focusAnchor);
  } catch (error) { toast(error.message, 'error'); }
}

function renderPreview(preview, returnEventId, focusAnchor = null) {
  elements['detail-column'].innerHTML = `<div class="preview-view">
    <header class="preview-header">
      <div class="preview-title"><strong>${escapeHtml(preview.path)}</strong><span>Version ${preview.version} · ${escapeHtml(preview.fileType)}</span></div>
      <div class="preview-actions">${returnEventId ? `<button class="secondary-button" id="back-to-event">Back to event</button>` : ''}<button class="primary-button" id="request-info" disabled>Request information</button></div>
    </header>
    <div class="preview-body"><p class="selection-hint">Select a sentence, line, cell, or value below. The selection is anchored to Version ${preview.version}.</p>${previewContent(preview)}<div id="rfi-result"></div></div>
  </div>`;
  elements['detail-column'].scrollTop = 0;
  if (returnEventId) document.getElementById('back-to-event').addEventListener('click', () => showEvent(returnEventId));
  document.getElementById('request-info').addEventListener('click', requestInformation);
  bindSelections();
  if (focusAnchor) focusPreviewAnchor(focusAnchor);
}

function focusPreviewAnchor(anchor) {
  const candidates = [...document.querySelectorAll('.selectable[data-anchor]')];
  const node = candidates.find((candidate) => {
    const item = JSON.parse(candidate.dataset.anchor);
    return item.kind === anchor.kind
      && (anchor.line == null || item.line === anchor.line)
      && (anchor.cellId == null || item.cellId === anchor.cellId)
      && (anchor.path == null || item.path === anchor.path)
      && (anchor.rowKey == null || item.rowKey === anchor.rowKey)
      && (anchor.column == null || item.column === anchor.column);
  });
  if (!node) return;
  node.classList.add('selected-anchor');
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function previewContent(preview) {
  if (preview.kind === 'blocks') return preview.items.map((item) => `<div class="preview-block ${item.blockType} selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.text)}</div>`).join('');
  if (preview.kind === 'lines') return `<div class="code-preview">${preview.items.map((item) => `<div class="code-line"><span class="number">${item.label}</span><span class="selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.text) || ' '}</span></div>`).join('')}</div>`;
  if (preview.kind === 'table') return `<div style="overflow:auto"><table class="data-preview"><thead><tr>${preview.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${preview.rows.map((row) => `<tr>${row.cells.map((cell) => `<td class="selectable" data-anchor='${escapeHtml(JSON.stringify(cell.anchor))}'>${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  if (preview.kind === 'json') return `<div class="json-preview">${preview.items.map((item) => `<span class="json-path">${escapeHtml(item.path)}</span><span class="json-value selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.value)}</span>`).join('')}</div>`;
  if (preview.kind === 'notebook') return preview.cells.map((cell) => `<div class="notebook-cell"><div class="cell-label">${escapeHtml(cell.type)} · ${escapeHtml(cell.id)}</div><div class="cell-source selectable" data-anchor='${escapeHtml(JSON.stringify(cell.anchor))}'>${escapeHtml(cell.source)}</div></div>`).join('');
  return `<div class="binary-preview"><p>${escapeHtml(preview.message)}</p><span>${preview.size.toLocaleString()} bytes</span><span class="binary-hash">SHA-256 ${preview.contentHash}</span></div>`;
}

function textOffset(root, target, offset) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(target, offset);
  return range.toString().length;
}

function setWorkspaceView(view) {
  state.view = view;
  const window_ = document.getElementById('app-window');
  window_?.classList.toggle('view-editor', view === 'editor');
  window_?.classList.toggle('view-session', view === 'session');
  elements['editor-nav'].classList.toggle('active', view === 'editor');
  elements['ribbon-editor'].classList.toggle('active', view === 'editor');
  document.getElementById('workspace-nav')?.classList.toggle('active', view === 'session');
}

function resetEditorProjectState() {
  clearPrediction();
  clearTimeout(state.editor.autosaveTimer);
  clearTimeout(state.editor.revealTimer);
  clearTimeout(state.editor.sourcePeekTimer);
  state.editor.predictionController?.abort();
  state.editor.documents = [];
  state.editor.document = null;
  state.editor.dirty = false;
  state.editor.prediction = null;
  state.editor.activeBlock = null;
  state.editor.manualClaim = null;
  state.editor.revealDependencyId = null;
  state.editor.revealTimer = null;
  state.editor.pendingLinks = [];
  state.editor.autosaveTimer = null;
  state.editor.editRevision = 0;
  state.editor.undoStack = [];
  state.editor.redoStack = [];
  state.editor.activeDependencyId = null;
  state.editor.sourcePeekRequest += 1;
  document.getElementById('dependency-inspector')?.setAttribute('hidden', '');
  document.getElementById('source-peek')?.setAttribute('hidden', '');
}

async function openManuscriptWorkspace(preferredPath = null, options = {}) {
  const projectId = options.projectId ?? state.project?.id;
  if (!projectId || state.project?.id !== projectId) return;
  setWorkspaceView('editor');
  const column = document.querySelector('.files-column');
  column.innerHTML = '<div class="column-header"><div><span class="eyebrow">Project files</span><h2>Documents</h2></div><span class="editor-live-pill">Sources</span></div><div class="manuscript-browser" id="manuscript-browser"><p class="browser-loading">Finding editable documents…</p></div>';
  try {
    const { documents } = await api(`/api/projects/${projectId}/documents`);
    if (state.project?.id !== projectId
      || (options.switchRevision != null && options.switchRevision !== state.projectSwitchRevision)) return;
    state.editor.documents = documents;
    renderManuscriptBrowser();
    const currentPath = state.editor.document?.projectId === projectId ? state.editor.document.path : null;
    const target = preferredPath ?? currentPath ?? documents[0]?.path;
    if (target) await openDocument(target, projectId);
    else elements['detail-column'].innerHTML = '<div class="detail-placeholder"><h2>No editable document found</h2><p>Add a document to the selected project, then checkpoint the project.</p></div>';
  } catch (error) {
    if (state.project?.id !== projectId) return;
    toast(error.message, 'error');
    const browser = document.getElementById('manuscript-browser');
    if (browser) browser.innerHTML = `<p class="browser-loading">${escapeHtml(error.message)}</p>`;
  }
}

function renderManuscriptBrowser() {
  const target = document.getElementById('manuscript-browser');
  if (!target) return;
  target.innerHTML = state.editor.documents.length ? state.editor.documents.map((document) => {
    const typeLabel = document.fileType === 'document' ? 'DOCX' : String(document.fileType ?? 'text').toUpperCase();
    const layerLabel = document.editingMode === 'TEXT_LAYER' ? ' · editable text layer' : '';
    return `<button class="manuscript-file ${state.editor.document?.path === document.path ? 'active' : ''}" data-document-path="${escapeHtml(document.path)}"><span class="file-icon" data-file-type="${escapeHtml(typeLabel)}"></span><span><strong>${escapeHtml(document.path.split('/').pop())}</strong><small>${escapeHtml(typeLabel)}${layerLabel} · ${escapeHtml(document.path)}</small></span><i>${document.stale || document.needsReview || document.broken ? '!' : document.linked}</i></button>`;
  }).join('') : '<p class="browser-loading">No editable documents are tracked.</p>';
  target.querySelectorAll('[data-document-path]').forEach((button) => button.addEventListener('click', () => openDocument(button.dataset.documentPath)));
  if (state.editor.document?.audit) {
    const audit = state.editor.document.audit;
    target.insertAdjacentHTML('beforeend', `<section class="audit-card"><span class="eyebrow">Provenance audit</span><strong>${audit.summary.detected} factual claims detected</strong><div class="audit-grid"><span><b>${audit.summary.linked}</b> linked</span><span class="warn"><b>${audit.summary.stale}</b> stale</span><span><b>${audit.summary.needsReview}</b> review</span><span><b>${audit.summary.unlinked}</b> unlinked</span></div><div class="audit-claims">${audit.dependencies.map((dependency) => `<button data-audit-dependency="${dependency.id}"><i class="status-dot ${dependency.status.toLowerCase()}"></i><span>${escapeHtml(dependency.spanText)}</span></button>`).join('')}</div></section>`);
    target.querySelectorAll('[data-audit-dependency]').forEach((button) => button.addEventListener('click', () => focusDependency(button.dataset.auditDependency)));
  }
}

async function openDocument(filePath, requestedProjectId = state.project?.id) {
  if (!requestedProjectId || state.project?.id !== requestedProjectId) return;
  shell.activeTab = `doc:${filePath}`;
  refreshShell();
  clearPrediction();
  clearTimeout(state.editor.autosaveTimer);
  state.editor.autosaveTimer = null;
  state.editor.pendingLinks = [];
  state.editor.editRevision = 0;
  state.editor.undoStack = [];
  state.editor.redoStack = [];
  state.editor.lastHistoryAt = 0;
  state.editor.lastHistoryType = null;
  elements['detail-column'].innerHTML = '<div class="detail-placeholder"><p>Opening manuscript…</p></div>';
  try {
    const { document } = await api(`/api/projects/${requestedProjectId}/documents?path=${encodeURIComponent(filePath)}`);
    if (state.project?.id !== requestedProjectId) return;
    state.editor.document = { ...prepareDocumentForEditor(document), projectId: requestedProjectId };
    state.editor.documents = state.editor.documents.map((item) => item.path === document.path
      ? { ...item, ...document.audit.summary }
      : item);
    state.editor.dirty = false;
    const refreshedProject = (await api(`/api/projects/${requestedProjectId}`)).project;
    if (state.project?.id !== requestedProjectId) return;
    state.project = refreshedProject;
    renderManuscriptBrowser();
    renderDocumentEditor();
  } catch (error) {
    if (state.project?.id === requestedProjectId) toast(error.message, 'error');
  }
}

function editorBlockModel(block) {
  const raw = String(block.text ?? '');
  if (block.type === 'heading') {
    const prefix = raw.match(/^(#{1,6})\s+/);
    return {
      ...block,
      text: prefix ? raw.slice(prefix[0].length) : raw,
      headingLevel: prefix?.[1].length ?? 2,
      storedPrefixLength: prefix?.[0].length ?? 0,
    };
  }
  if (block.type === 'list') {
    const lines = raw.split('\n');
    const markers = lines.map((line) => line.match(/^\s*(?:[-*+] |\d+\. )/)?.[0] ?? '- ');
    return {
      ...block,
      text: lines.map((line, index) => line.slice(markers[index].length)).join('\n'),
      listStyle: markers.some((marker) => /\d+\./.test(marker)) ? 'ordered' : 'unordered',
      storedListMarkers: markers,
    };
  }
  if (block.type === 'code') {
    const lines = raw.split('\n');
    const opener = /^(?:```|~~~)/.test(lines[0] ?? '') ? lines.shift() : '```';
    if (lines.length && /^(?:```|~~~)/.test(lines.at(-1))) lines.pop();
    return { ...block, text: lines.join('\n'), codeFence: opener };
  }
  return { ...block, text: raw };
}

function storedOffsetToEditor(model, offset) {
  if (model.type === 'heading') return Math.max(0, offset - (model.storedPrefixLength ?? 0));
  if (model.type === 'code') return Math.max(0, offset - String(model.codeFence ?? '```').length - 1);
  if (model.type !== 'list') return offset;
  const visibleLines = model.text.split('\n');
  const markers = model.storedListMarkers ?? visibleLines.map(() => '- ');
  let storedCursor = 0;
  let editorCursor = 0;
  for (let index = 0; index < visibleLines.length; index += 1) {
    const lineLength = visibleLines[index].length;
    const markerLength = markers[index].length;
    const contentStart = storedCursor + markerLength;
    const storedEnd = contentStart + lineLength;
    if (offset <= storedEnd) return editorCursor + Math.max(0, offset - contentStart);
    storedCursor = storedEnd + 1;
    editorCursor += lineLength + 1;
  }
  return model.text.length;
}

function prepareDocumentForEditor(documentState) {
  const blocks = documentState.blocks.map(editorBlockModel);
  const dependencies = documentState.dependencies.map((dependency) => {
    const model = blocks[dependency.anchor.blockIndex];
    if (!model) return dependency;
    return {
      ...dependency,
      anchor: {
        ...dependency.anchor,
        start: storedOffsetToEditor(model, dependency.anchor.start),
        end: storedOffsetToEditor(model, dependency.anchor.end),
      },
    };
  });
  return { ...documentState, blocks, dependencies };
}

function renderDocumentEditor() {
  const documentState = state.editor.document;
  if (!documentState) return;
  const fileLabel = documentState.fileType === 'document' ? 'DOCX' : String(documentState.fileType ?? 'text').toUpperCase();
  const editLayerNote = documentState.originalPreserved
    ? `<div class="edit-layer-note"><strong>${escapeHtml(fileLabel)} original preserved</strong><span>You are editing a versioned CoLab text layer. The source file is never overwritten.</span></div>` : '';
  const documentOptions = state.editor.documents.map((document) => `<option value="${escapeHtml(document.path)}" ${document.path === documentState.path ? 'selected' : ''}>${escapeHtml(document.path.split('/').pop())}</option>`).join('');
  elements['detail-column'].innerHTML = `<div class="document-editor-view">
    <header class="editor-header">
      <div class="editor-title-group">
        <div class="editor-history-buttons"><button data-editor-command="undo" title="Undo">↶</button><button data-editor-command="redo" title="Redo">↷</button></div>
        <div class="editor-document-title"><select id="editor-document-switcher" aria-label="Current document">${documentOptions}</select><small>Version ${documentState.version} · ${escapeHtml(fileLabel)} · source-backed editing</small></div>
      </div>
      <div class="editor-header-actions"><span id="editor-save-state">Saved</span><button id="audit-button">Sources</button><button id="save-document" disabled>Save now</button><button class="editor-share-button" id="editor-share-button">Share <span>⌄</span></button></div>
    </header>
    <div class="t-cap" aria-hidden="true"><span>├</span><span class="t-hfill"></span><span>┤</span></div>
    <div class="editor-toolbar" role="toolbar" aria-label="Document formatting">
      <select class="toolbar-select" id="block-format" aria-label="Paragraph style"><option value="paragraph">Body</option><option value="heading">Heading</option><option value="list">Bullets</option><option value="numbered">Numbering</option></select>
      <span></span><select class="font-select" id="editor-font" aria-label="Font"><option value="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif">SF Pro</option><option value="Arial, sans-serif">Arial</option><option value="Georgia, serif">Georgia</option></select><select class="size-select" id="editor-font-size" aria-label="Font size"><option value="2">10</option><option value="3" selected>11</option><option value="4">14</option><option value="5">18</option></select>
      <span></span><button data-editor-command="bold" title="Bold">B</button><button data-editor-command="italic" title="Italic">I</button><button data-editor-command="underline" title="Underline">U</button>
      <span></span><button data-format="list" title="Bulleted list">☷</button><button data-format="numbered" title="Numbered list">☰</button><button id="manual-dependency" title="Link a project source">⌁ Link source</button><button id="end-source-context" title="Stop using the current source for subsequent suggestions">End source</button>
      <span class="editor-rule" id="editor-assist-status">Predictive dependencies on</span>
    </div>
    <div class="t-cap" aria-hidden="true"><span>├</span><span class="t-hfill"></span><span>┤</span></div>
    <div class="editor-workspace">
      <div class="editor-scroll">${editLayerNote}<article class="manuscript-page" id="manuscript-page" aria-label="Document editor"><div class="document-body" id="document-body" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true" aria-label="Edit ${escapeHtml(documentState.path)}">${documentState.blocks.length ? documentState.blocks.map((block, index) => renderEditableBlock(block, index, documentState.dependencies)).join('') : renderEditableBlock({ type: 'paragraph', text: '' }, 0, [])}</div><div class="document-end-space" id="document-end-space" aria-hidden="true"></div><div id="dependency-completion" hidden></div><div id="dependency-picker" hidden></div></article></div>
      <i class="t-v t-v-inspector" aria-hidden="true"></i>
      <aside id="dependency-inspector" class="dependency-inspector" hidden aria-label="Source inspector"></aside>
      <aside id="source-peek" class="source-peek" hidden aria-label="Source preview"></aside>
    </div>
    <div class="t-editor-status" aria-hidden="true"><b>EDIT</b><span>[⌘Z] undo · [⌘⇧L] link source · [Tab] accept suggestion · [Esc] dismiss</span></div>
  </div>`;
  elements['detail-column'].scrollTop = 0;
  bindEditorSurface();
  state.editor.activeBlock = document.querySelector('.manuscript-block');
  // The document is what the user just opened, so it takes the caret. Left in
  // the terminal prompt, Tab would move focus instead of accepting a
  // suggestion, and typing would go to the wrong surface entirely.
  if (state.editor.activeBlock) focusEditorBlock(state.editor.activeBlock);
  state.editor.undoStack = [editorHistorySnapshot()];
  state.editor.redoStack = [];
  document.querySelectorAll('.linked-claim').forEach(bindLinkedClaimNode);
  settleAcceptedDependencyReveal();
  document.getElementById('save-document').addEventListener('click', () => saveDocument());
  document.getElementById('editor-share-button').addEventListener('click', openActiveDependencySharing);
  document.getElementById('editor-document-switcher').addEventListener('change', (event) => openDocument(event.target.value));
  document.getElementById('block-format').addEventListener('change', (event) => {
    formatActiveBlock(event.target.value);
    event.target.value = 'paragraph';
  });
  document.getElementById('editor-font').addEventListener('change', (event) => {
    document.execCommand('fontName', false, event.target.value);
    markEditorDirty();
  });
  document.getElementById('editor-font-size').addEventListener('change', (event) => {
    document.execCommand('fontSize', false, event.target.value);
    markEditorDirty();
  });
  document.getElementById('document-end-space').addEventListener('click', focusDocumentEnd);
  document.getElementById('manual-dependency').addEventListener('click', openManualPickerFromSelection);
  document.getElementById('end-source-context').addEventListener('mousedown', (event) => {
    event.preventDefault(); endSourceContext();
  });
  document.getElementById('audit-button').addEventListener('click', () => renderManuscriptBrowser());
  document.querySelectorAll('[data-format]').forEach((button) => button.addEventListener('click', () => formatActiveBlock(button.dataset.format)));
  document.querySelectorAll('[data-editor-command]').forEach((button) => button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    runEditorCommand(button.dataset.editorCommand);
  }));
  document.getElementById('manuscript-page').addEventListener('keydown', handleEditorShortcuts);
}

function renderEditableBlock(block, blockIndex, dependencies) {
  const content = renderBlockDependencyContent(block.text, blockIndex, dependencies);
  const attributes = [
    `data-block-index="${blockIndex}"`,
    `data-block-type="${escapeHtml(block.type)}"`,
    block.headingLevel ? `data-heading-level="${block.headingLevel}"` : '',
    block.listStyle ? `data-list-style="${escapeHtml(block.listStyle)}"` : '',
    block.codeFence ? `data-code-fence="${escapeHtml(block.codeFence)}"` : '',
  ].filter(Boolean).join(' ');
  return `<div class="manuscript-block ${block.type}" ${attributes}>${content || '<br>'}</div>`;
}

function renderBlockDependencyContent(blockText, blockIndex, dependencies) {
  const linked = dependencies
    // A claim the document no longer holds keeps its last known anchor so it
    // can be reviewed, but it is not drawn: those offsets now point at
    // somebody else's sentence.
    .filter((dependency) => !dependency.statusDetails?.anchorIssue)
    .filter((dependency) => dependency.anchor.blockIndex === blockIndex)
    .sort((a, b) => a.anchor.start - b.anchor.start);
  let cursor = 0;
  let content = '';
  for (const dependency of linked) {
    if (dependency.anchor.start < cursor || dependency.anchor.end > blockText.length) continue;
    content += escapeHtml(blockText.slice(cursor, dependency.anchor.start));
    const linkedText = blockText.slice(dependency.anchor.start, dependency.anchor.end);
    const reveal = dependency.id === state.editor.revealDependencyId;
    const pending = dependency.pending === true;
    const status = pending ? 'pending' : dependency.status.toLowerCase();
    const identity = pending ? `data-pending-link-id="${dependency.id}"` : `data-dependency-id="${dependency.id}"`;
    const title = pending ? `Source selected · saves automatically within five minutes`
      : dependency.status === 'LINKED' ? 'Linked source' : dependency.status.replaceAll('_', ' ');
    content += `<span class="linked-claim ${status}${reveal ? ' just-linked' : ''}" ${identity} title="${escapeHtml(title)}">${renderLinkedClaimText(linkedText, reveal)}</span>`;
    cursor = dependency.anchor.end;
  }
  content += escapeHtml(blockText.slice(cursor));
  return content;
}

function renderLinkedClaimText(value, reveal) {
  if (!reveal) return escapeHtml(value);
  let wordIndex = 0;
  return String(value).split(/(\s+)/).map((part) => {
    if (!part || /^\s+$/.test(part)) return escapeHtml(part);
    const delay = wordIndex * 55;
    wordIndex += 1;
    return `<span class="dependency-stream-word" style="--stream-delay:${delay}ms">${escapeHtml(part)}</span>`;
  }).join('');
}

function settleAcceptedDependencyReveal() {
  clearTimeout(state.editor.revealTimer);
  const node = state.editor.revealDependencyId
    ? document.querySelector(`.linked-claim[data-dependency-id="${CSS.escape(state.editor.revealDependencyId)}"], .linked-claim[data-pending-link-id="${CSS.escape(state.editor.revealDependencyId)}"]`)
    : null;
  if (!node) {
    state.editor.revealDependencyId = null;
    return;
  }
  const wordCount = node.querySelectorAll('.dependency-stream-word').length;
  const duration = Math.min(1600, Math.max(420, wordCount * 55 + 420));
  state.editor.revealTimer = setTimeout(() => {
    if (node.isConnected) {
      const text = node.textContent;
      node.replaceChildren(document.createTextNode(text));
      node.classList.remove('just-linked');
    }
    state.editor.revealDependencyId = null;
    state.editor.revealTimer = null;
  }, duration);
}

function spreadsheetColumnLabel(index) {
  if (!Number.isInteger(index) || index < 0) return '';
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function dependencyReferencesRow(dependency) {
  const source = dependency?.source ?? {};
  const anchor = source.anchor ?? {};
  if (source.objectType === 'DATASET_ROW' || anchor.kind === 'table-row') return true;
  if (anchor.kind !== 'table-cell' || !anchor.rowKey) return false;
  const comparable = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const linkedText = comparable(dependency?.spanText);
  return Boolean(linkedText && linkedText === comparable(anchor.rowKey)
    && linkedText !== comparable(source.valueText));
}

function dependencySourceForDisplay(dependency) {
  const source = dependency?.source ?? {};
  if (!dependencyReferencesRow(dependency)) return source;
  const anchor = source.anchor ?? {};
  const rowKey = String(anchor.rowKey ?? source.metadata?.row ?? dependency.spanText ?? '').trim();
  return {
    ...source,
    label: rowKey || source.label,
    objectType: 'DATASET_ROW',
    valueText: null,
    anchor: { kind: 'table-row', rowKey, rowIndex: anchor.rowIndex, sheet: anchor.sheet },
    metadata: { ...source.metadata, row: rowKey, column: null, referenceKind: 'ROW' },
  };
}

function dependencySourcePresentation(dependency) {
  const source = dependencySourceForDisplay(dependency);
  const anchor = source.anchor ?? {};
  const fileName = String(source.path ?? source.label ?? 'Project source').split('/').pop();
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const tabular = ['xls', 'xlsx', 'csv', 'tsv'].includes(extension)
    || ['table-cell', 'table-row', 'table-column'].includes(anchor.kind);
  const coordinate = Number.isInteger(anchor.columnIndex) && Number.isInteger(anchor.rowIndex)
    ? `${spreadsheetColumnLabel(anchor.columnIndex)}${anchor.rowIndex}` : '';
  const scope = [anchor.sheet, coordinate || anchor.rowKey || anchor.column].filter(Boolean).join('!');
  const context = [anchor.sheet, anchor.rowKey, anchor.column].filter(Boolean).join('  ›  ')
    || source.metadata?.title || source.metadata?.subject || source.label;
  return {
    fileName,
    typeLabel: tabular ? 'XLS' : extension === 'pdf' ? 'PDF' : extension === 'docx' ? 'DOC' : extension.slice(0, 3).toUpperCase() || 'SRC',
    typeClass: tabular ? 'sheet' : extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'doc' : 'source',
    sourceLine: scope ? `${fileName} → ${scope}` : fileName,
    context,
  };
}

function dependencyDisplayValue(dependency) {
  const raw = String(dependencySourceForDisplay(dependency).valueText ?? '').trim();
  const claim = String(dependency.spanText ?? '').trim();
  if (!raw || !claim) return raw;
  const comparableNumber = (value) => {
    const percent = /%/.test(value);
    const numeric = Number(String(value).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(numeric) ? (percent ? numeric / 100 : numeric) : null;
  };
  const sourceNumber = comparableNumber(raw);
  const claimNumber = comparableNumber(claim);
  if (sourceNumber != null && claimNumber != null) {
    const directMatch = Math.abs(sourceNumber - claimNumber) <= Math.max(1e-9, Math.abs(sourceNumber) * 1e-8);
    const percentMatch = Math.abs(sourceNumber - claimNumber * 100) <= Math.max(1e-9, Math.abs(sourceNumber) * 1e-8)
      || Math.abs(sourceNumber * 100 - claimNumber) <= Math.max(1e-9, Math.abs(claimNumber) * 1e-8);
    if (directMatch || percentMatch) return claim;
  }
  return raw;
}

function scheduleSourcePeekClose(delay = 160) {
  clearTimeout(state.editor.sourcePeekTimer);
  state.editor.sourcePeekTimer = setTimeout(() => {
    const peek = document.getElementById('source-peek');
    if (peek) { peek.hidden = true; peek.replaceChildren(); }
  }, delay);
}

async function showSourcePeek(dependencyId, sourceNode) {
  const peek = document.getElementById('source-peek');
  const host = document.querySelector('.editor-workspace');
  if (!peek || !host || !sourceNode?.isConnected) return;
  const request = ++state.editor.sourcePeekRequest;
  try {
    const { dependency } = await api(`/api/dependencies/${dependencyId}`);
    if (request !== state.editor.sourcePeekRequest || !sourceNode.isConnected) return;
    const presentation = dependencySourcePresentation(dependency);
    const displayValue = dependencyDisplayValue(dependency);
    const displaySource = dependencySourceForDisplay(dependency);
    peek.innerHTML = `<header><span class="source-peek-icon">${escapeHtml(presentation.typeLabel)}</span><span><strong>Source preview</strong><small>${escapeHtml(presentation.sourceLine)}</small></span><button aria-label="Close source preview">×</button></header>
      <div class="source-peek-body">${displayValue ? `<div class="source-peek-row value"><small>Value</small><strong>${escapeHtml(displayValue)}</strong></div>` : ''}<div class="source-peek-row"><small>Source</small><strong>${escapeHtml(displaySource.label)}</strong></div><div class="source-peek-row"><small>Updated</small><strong>${escapeHtml(formatDateTime(dependency.createdAt))} by ${escapeHtml(dependency.linkedBy?.displayName ?? dependency.createdBy.displayName)}</strong></div></div>
      <button class="source-peek-open">Open source inspector <span>↗</span></button>`;
    const sourceRect = sourceNode.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = Math.max(12, Math.min(sourceRect.left - hostRect.left, host.clientWidth - 322));
    const below = sourceRect.bottom - hostRect.top + 10;
    const top = below + 300 < host.clientHeight ? below : Math.max(12, sourceRect.top - hostRect.top - 300);
    peek.style.left = `${left}px`;
    peek.style.top = `${top}px`;
    peek.hidden = false;
    peek.addEventListener('pointerenter', () => clearTimeout(state.editor.sourcePeekTimer));
    peek.addEventListener('pointerleave', () => scheduleSourcePeekClose());
    peek.querySelector('header button').addEventListener('click', () => scheduleSourcePeekClose(0));
    peek.querySelector('.source-peek-open').addEventListener('click', () => {
      scheduleSourcePeekClose(0);
      showDependencyInspector(dependencyId, sourceNode);
    });
  } catch {
    if (peek) peek.hidden = true;
  }
}

function bindLinkedClaimNode(node) {
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    if (node.dataset.pendingLinkId) {
      editorAssistStatus('Source selected · autosave pending');
      return;
    }
    if (node.dataset.dependencyId) {
      scheduleSourcePeekClose(0);
      showDependencyInspector(node.dataset.dependencyId, node);
    }
  });
  if (node.dataset.dependencyId) {
    node.addEventListener('pointerenter', () => {
      clearTimeout(state.editor.sourcePeekTimer);
      state.editor.sourcePeekTimer = setTimeout(() => showSourcePeek(node.dataset.dependencyId, node), 320);
    });
    node.addEventListener('pointerleave', () => scheduleSourcePeekClose());
  }
}

function resolveDependencyAnchor(dependency, blockText, blockIndex) {
  if (dependency.anchor.blockIndex !== blockIndex) return dependency.anchor;
  const expected = dependency.spanText;
  if (blockText.slice(dependency.anchor.start, dependency.anchor.end) === expected) return dependency.anchor;
  const matches = [];
  let offset = blockText.indexOf(expected);
  while (offset >= 0) {
    matches.push(offset);
    offset = blockText.indexOf(expected, offset + Math.max(1, expected.length));
  }
  if (matches.length !== 1) return null;
  return { ...dependency.anchor, start: matches[0], end: matches[0] + expected.length };
}

function editorDependenciesForBlock(block) {
  const blockIndex = Number(block.dataset.blockIndex);
  const blockText = block.textContent;
  return [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks]
    .map((dependency) => {
      const anchor = resolveDependencyAnchor(dependency, blockText, blockIndex);
      if (!anchor) return null;
      if (dependency.pending) dependency.anchor = anchor;
      return { ...dependency, anchor };
    }).filter(Boolean);
}

function renderLocalDependencies(block, focusPosition = null) {
  if (!block?.isConnected) return;
  const text = block.textContent;
  const blockIndex = Number(block.dataset.blockIndex);
  block.innerHTML = renderBlockDependencyContent(text, blockIndex, editorDependenciesForBlock(block)) || '<br>';
  block.querySelectorAll('.linked-claim').forEach(bindLinkedClaimNode);
  if (Number.isInteger(focusPosition)) focusEditorBlock(block, focusPosition);
  else if (focusPosition === true) focusEditorBlock(block);
  settleAcceptedDependencyReveal();
}

function pendingDependenciesForPrediction() {
  return state.editor.pendingLinks.map((dependency) => {
    const block = document.querySelector(`.manuscript-block[data-block-index="${dependency.anchor.blockIndex}"]`);
    const anchor = block ? resolveDependencyAnchor(dependency, block.textContent, dependency.anchor.blockIndex) : null;
    if (!anchor) return null;
    dependency.anchor = anchor;
    return {
      id: dependency.id,
      blockIndex: anchor.blockIndex,
      start: anchor.start,
      end: anchor.end,
      sourceObjectId: dependency.source.id,
      sourceSnapshotId: dependency.source.snapshotId,
    };
  }).filter(Boolean);
}

function editorBlockFromSelection(target = null) {
  const direct = target?.closest?.('.manuscript-block');
  if (direct) return direct;
  const selection = window.getSelection();
  const focusElement = selection?.focusNode?.nodeType === Node.ELEMENT_NODE
    ? selection.focusNode : selection?.focusNode?.parentElement;
  return focusElement?.closest?.('.manuscript-block') ?? state.editor.activeBlock;
}

function focusEditorBlock(block, offset = null) {
  const surface = document.getElementById('document-body');
  if (!surface || !block) return;
  surface.focus({ preventScroll: true });
  if (offset == null) placeCaretAtEnd(block);
  else placeCaretAtOffset(block, offset);
  state.editor.activeBlock = block;
}

function bindEditorSurface() {
  const surface = document.getElementById('document-body');
  if (!surface) return;
  const rememberActiveBlock = (event) => {
    const block = editorBlockFromSelection(event.target);
    if (block?.isConnected) state.editor.activeBlock = block;
  };
  surface.addEventListener('focusin', rememberActiveBlock);
  surface.addEventListener('pointerup', rememberActiveBlock);
  surface.addEventListener('keyup', rememberActiveBlock);
  surface.addEventListener('beforeinput', (event) => {
    if (!state.editor.restoringHistory) recordEditorHistory(event.inputType ?? 'input');
  });
  surface.addEventListener('input', (event) => {
    const block = editorBlockFromSelection(event.target);
    if (!block?.isConnected) return;
    state.editor.activeBlock = block;
    repairLinkedClaimBoundaries(block);
    markEditorDirty();
    clearPrediction();
    clearTimeout(state.editor.predictionTimer);
    state.editor.predictionTimer = setTimeout(() => predictForBlock(block), 45);
  });
}

/**
 * Keeps a claim's highlight to the claim.
 *
 * Typing immediately after a linked claim is merged into it by the browser,
 * however the caret was placed — the span is inline, and that is what inline
 * editing does. Rather than fight the caret, the extra characters are lifted
 * back out into a sibling text node, which leaves the document text untouched
 * and the highlight exactly as wide as what was linked.
 */
function repairLinkedClaimBoundaries(block) {
  const known = new Map([...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks]
    .map((dependency) => [dependency.id, dependency.spanText]));
  for (const claim of block.querySelectorAll('.linked-claim')) {
    const id = claim.dataset.dependencyId ?? claim.dataset.pendingLinkId;
    const expected = known.get(id);
    const text = claim.textContent;
    // Only the append case is repaired. Editing the claim itself is a real
    // change to the writing, and belongs to review rather than to this.
    if (!expected || text === expected || !text.startsWith(expected) || text.length <= expected.length) continue;
    const overflow = text.slice(expected.length);
    claim.textContent = expected;
    const tail = document.createTextNode(overflow);
    claim.after(tail);
    const range = document.createRange();
    range.setStart(tail, tail.textContent.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function editorHistorySnapshot() {
  const active = editorBlockFromSelection() ?? state.editor.activeBlock;
  return {
    blocks: [...document.querySelectorAll('.manuscript-block')].map((block) => ({
      type: block.dataset.blockType ?? 'paragraph',
      text: block.textContent,
      headingLevel: block.dataset.headingLevel,
      listStyle: block.dataset.listStyle,
      codeFence: block.dataset.codeFence,
    })),
    activeIndex: active ? Number(active.dataset.blockIndex) : 0,
    caret: active ? caretOffsetWithin(active) : 0,
    dependencyAnchors: Object.fromEntries((state.editor.document?.dependencies ?? []).map((dependency) => [dependency.id, { ...dependency.anchor }])),
    pendingLinks: structuredClone(state.editor.pendingLinks),
  };
}

function recordEditorHistory(inputType = 'edit', force = false) {
  if (state.editor.restoringHistory || !document.getElementById('document-body')) return;
  const timestamp = Date.now();
  const coalescible = /^(?:insertText|deleteContentBackward|deleteContentForward)$/.test(inputType);
  const coalesced = !force && coalescible && state.editor.lastHistoryType === inputType
    && timestamp - state.editor.lastHistoryAt < 750;
  if (!coalesced) {
    const snapshot = editorHistorySnapshot();
    const historyKey = (value) => JSON.stringify({
      blocks: value.blocks,
      dependencyAnchors: value.dependencyAnchors,
      pendingLinks: value.pendingLinks.map((dependency) => ({
        id: dependency.id, anchor: dependency.anchor, spanText: dependency.spanText,
      })),
    });
    if (!state.editor.undoStack.length || historyKey(state.editor.undoStack.at(-1)) !== historyKey(snapshot)) {
      state.editor.undoStack.push(snapshot);
    }
    if (state.editor.undoStack.length > 50) state.editor.undoStack.shift();
    state.editor.redoStack = [];
  }
  state.editor.lastHistoryAt = timestamp;
  state.editor.lastHistoryType = force ? null : inputType;
}

function restoreEditorHistory(snapshot) {
  if (!snapshot) return;
  const surface = document.getElementById('document-body');
  if (!surface) return;
  state.editor.restoringHistory = true;
  clearPrediction();
  for (const dependency of state.editor.document?.dependencies ?? []) {
    if (snapshot.dependencyAnchors[dependency.id]) dependency.anchor = { ...snapshot.dependencyAnchors[dependency.id] };
  }
  state.editor.pendingLinks = structuredClone(snapshot.pendingLinks);
  const dependencies = [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks];
  surface.innerHTML = snapshot.blocks.map((block, index) => renderEditableBlock(block, index, dependencies)).join('');
  surface.querySelectorAll('.linked-claim').forEach(bindLinkedClaimNode);
  const active = surface.querySelector(`.manuscript-block[data-block-index="${Math.min(snapshot.activeIndex, snapshot.blocks.length - 1)}"]`)
    ?? surface.querySelector('.manuscript-block');
  if (active) focusEditorBlock(active, Math.min(snapshot.caret, active.textContent.length));
  state.editor.restoringHistory = false;
  state.editor.lastHistoryType = null;
  markEditorDirty();
}

function undoEditor() {
  const snapshot = state.editor.undoStack.pop();
  if (!snapshot) return;
  state.editor.redoStack.push(editorHistorySnapshot());
  restoreEditorHistory(snapshot);
}

function redoEditor() {
  const snapshot = state.editor.redoStack.pop();
  if (!snapshot) return;
  state.editor.undoStack.push(editorHistorySnapshot());
  restoreEditorHistory(snapshot);
}

function markEditorDirty() {
  state.editor.dirty = true;
  state.editor.editRevision += 1;
  const save = document.getElementById('save-document');
  if (save) save.disabled = false;
  const status = document.getElementById('editor-save-state');
  if (status) status.textContent = 'Autosave pending';
  scheduleEditorAutosave();
}

function scheduleEditorAutosave() {
  if (state.editor.autosaveTimer || state.editor.savePromise) return;
  state.editor.autosaveTimer = setTimeout(() => {
    state.editor.autosaveTimer = null;
    saveDocument({ automatic: true });
  }, AUTOSAVE_INTERVAL_MS);
}

function markPendingDependency() {
  const save = document.getElementById('save-document');
  if (save) save.disabled = false;
  const status = document.getElementById('editor-save-state');
  if (status) status.textContent = 'Source selected · autosave pending';
  scheduleEditorAutosave();
}

function caretOffsetWithin(block) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !block.contains(selection.focusNode)) return block.textContent.length;
  return textOffset(block, selection.focusNode, selection.focusOffset);
}

async function predictForBlock(block) {
  if (!block?.isConnected || !block.textContent.trim()) return;
  const requestedText = block.textContent;
  const controller = new AbortController();
  state.editor.predictionController?.abort();
  state.editor.predictionController = controller;
  try {
    const cursor = caretOffsetWithin(block);
    const blocks = [...document.querySelectorAll('.manuscript-block')];
    const blockIndex = Number(block.dataset.blockIndex);
    const section = blocks.slice(0, blockIndex + 1).reverse()
      .find((item) => item.dataset.blockType === 'heading')?.textContent ?? '';
    const { prediction } = await api(`/api/projects/${state.project.id}/dependencies/predict`, {
      method: 'POST', body: JSON.stringify({
        text: requestedText,
        context: blocks.slice(Math.max(0, blockIndex - 1), blockIndex + 2).map((item) => item.textContent).join(' '),
        cursor,
        blockIndex,
        section,
        documentPath: state.editor.document.path,
        sourceScopeBoundary: Number.isInteger(Number(block.dataset.sourceScopeBoundary))
          ? Number(block.dataset.sourceScopeBoundary) : undefined,
        pendingDependencies: pendingDependenciesForPrediction(),
      }), signal: controller.signal,
    });
    if (controller.signal.aborted || state.editor.predictionController !== controller
      || !block.isConnected || block.textContent !== requestedText) return;
    if (prediction.sourceCompletions?.length && prediction.sourceContext?.source) {
      const findings = prediction.sourceCompletions.map((finding) => ({ ...finding, block, requestedText }));
      const first = findings[0];
      state.editor.prediction = {
        mode: 'SOURCE_FINDINGS',
        completion: { kind: 'SOURCE_FINDING', block, requestedText },
        findings,
        sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start: first.claimStart, end: first.claimEnd, type: 'SOURCE_FINDING',
          text: requestedText.slice(first.claimStart, first.claimEnd),
          candidates: findings.map((finding) => finding.dependencyCandidate),
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.workspaceCompletions?.length) {
      const workspaceSuggestions = prediction.workspaceCompletions
        .map((suggestion) => ({ ...suggestion, block, requestedText }));
      const first = workspaceSuggestions[0];
      state.editor.prediction = {
        mode: 'WORKSPACE_SUGGESTIONS',
        completion: { kind: 'WORKSPACE', block, requestedText },
        workspaceSuggestions,
        workspaceHeading: prediction.workspaceHeading,
        sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start: first.claimStart, end: first.claimEnd, type: 'WORKSPACE',
          text: requestedText.slice(first.claimStart, first.claimEnd),
          candidates: workspaceSuggestions.map((suggestion) => suggestion.dependencyCandidate),
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.completion?.insertText && prediction.completion.dependencyCandidate) {
      const completion = { ...prediction.completion, kind: 'SENTENCE', block, requestedText };
      const start = completion.claimStart;
      state.editor.prediction = {
        mode: 'COMPLETE_AND_LINK', completion, blockIndex, blockType: block.dataset.blockType, block,
        claim: {
          start, end: requestedText.length, type: 'PROJECT_SENTENCE',
          text: `${requestedText.slice(start)}${completion.insertText}`,
          candidates: [completion.dependencyCandidate],
        },
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    const claim = prediction.claims.find((candidate) => candidate.candidates.length);
    if (claim) {
      const completesCitation = claim.type === 'LITERATURE' && claim.partial
        && claim.candidates.some((candidate) => candidate.citationText);
      const completesStudyVariable = claim.type === 'STUDY_VARIABLE' && claim.partial
        && claim.candidates.some((candidate) => candidate.completionText);
      const completesReferenceComponent = ['TABLE_REFERENCE', 'FIGURE'].includes(claim.type) && claim.partial
        && claim.candidates.some((candidate) => candidate.componentText);
      state.editor.prediction = {
        mode: completesCitation || completesStudyVariable || completesReferenceComponent ? 'COMPLETE_AND_LINK' : 'LINK',
        completion: completesCitation
          ? { kind: 'CITATION', block, requestedText }
          : completesStudyVariable ? { kind: 'STUDY_VARIABLE', block, requestedText }
            : completesReferenceComponent ? { kind: 'REFERENCE_COMPONENT', block, requestedText } : null,
        claim, sourceContext: prediction.sourceContext,
        blockIndex, blockType: block.dataset.blockType, block,
      };
      state.editor.predictionIndex = 0;
      showPredictionCompletion();
      return;
    }
    if (prediction.notice) editorAssistStatus(prediction.notice);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, 'error');
  } finally {
    if (state.editor.predictionController === controller) state.editor.predictionController = null;
  }
}

function editorAssistStatus(message = 'Predictive dependencies on') {
  const status = document.getElementById('editor-assist-status');
  if (status) status.textContent = message;
}

function placeCaretAtEnd(node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  // A block that ends in a linked claim would otherwise keep growing it.
  const last = node.lastChild;
  if (last?.nodeType === Node.ELEMENT_NODE && last.classList?.contains('linked-claim')) {
    range.setStartAfter(last);
    range.collapse(true);
  }
  selection.addRange(range);
}

function predictionEdit(prediction, candidate, selectedIndex = 0) {
  const completion = prediction?.completion;
  if (!completion) return null;
  if (completion.kind === 'SOURCE_FINDING' || completion.kind === 'WORKSPACE') {
    const suggestion = completion.kind === 'SOURCE_FINDING'
      ? prediction.findings?.[selectedIndex] : prediction.workspaceSuggestions?.[selectedIndex];
    if (!suggestion?.replacementText) return null;
    const start = suggestion.claimStart;
    const end = suggestion.claimEnd;
    const typed = completion.requestedText.slice(start, end);
    const before = completion.requestedText.slice(0, start);
    const joiner = start === end && before && !/\s$/.test(before) ? ' ' : '';
    const labelCompletion = ['Column', 'Row', 'Variable'].includes(suggestion.category);
    const replacement = contextualCompletionCase(
      suggestion.replacementText,
      typed,
      before,
      labelCompletion ? 'label' : 'phrase',
    );
    const sharesPrefix = replacement.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase());
    const blockText = `${before}${joiner}${replacement}${completion.requestedText.slice(end)}`;
    const claimStart = start + joiner.length;
    return {
      blockText,
      claimStart,
      claimEnd: claimStart + replacement.length,
      claimText: replacement,
      ghostText: end === completion.requestedText.length && sharesPrefix
        ? `${joiner}${replacement.slice(typed.length)}` : '',
    };
  }
  if (['CITATION', 'STUDY_VARIABLE', 'REFERENCE_COMPONENT'].includes(completion.kind)) {
    const typed = completion.requestedText.slice(prediction.claim.start, prediction.claim.end);
    const before = completion.requestedText.slice(0, prediction.claim.start);
    const rawReplacement = completion.kind === 'CITATION' ? candidate?.citationText
      : completion.kind === 'REFERENCE_COMPONENT' ? candidate?.componentText : candidate?.completionText;
    const replacement = contextualCompletionCase(
      rawReplacement,
      typed,
      before,
      ['CITATION', 'REFERENCE_COMPONENT'].includes(completion.kind) ? 'proper-name' : 'label',
    );
    if (!replacement) return null;
    const sharesPrefix = replacement.toLocaleLowerCase().startsWith(typed.toLocaleLowerCase());
    const blockText = `${completion.requestedText.slice(0, prediction.claim.start)}${replacement}${completion.requestedText.slice(prediction.claim.end)}`;
    return {
      blockText,
      claimStart: prediction.claim.start,
      claimEnd: prediction.claim.start + replacement.length,
      claimText: replacement,
      ghostText: prediction.claim.end === completion.requestedText.length && sharesPrefix
        ? replacement.slice(typed.length) : '',
    };
  }
  const insertText = contextualCompletionCase(
    completion.insertText,
    '',
    completion.requestedText,
    'phrase',
  );
  const blockText = `${completion.requestedText}${insertText}`;
  return {
    blockText,
    claimStart: prediction.claim.start,
    claimEnd: blockText.length,
    claimText: blockText.slice(prediction.claim.start),
    ghostText: insertText,
  };
}

function showPredictionCompletion() {
  const prediction = state.editor.prediction;
  const overlay = document.getElementById('dependency-completion');
  if (!prediction || !overlay) return;
  const candidates = prediction.claim.candidates;
  const selectedIndex = Math.min(state.editor.predictionIndex, candidates.length - 1);
  const selectedCandidate = candidates[selectedIndex];
  const edit = predictionEdit(prediction, selectedCandidate, selectedIndex);
  const block = prediction.block;
  block.classList.add('has-prediction');
  if (edit?.ghostText) {
    block.dataset.completion = edit.ghostText;
    block.classList.add('has-text-completion');
  } else {
    block.classList.remove('has-text-completion');
    delete block.dataset.completion;
  }
  highlightPredictedSpan(block, prediction.claim.start, prediction.claim.end);
  overlay.hidden = false;
  overlay.className = 'dependency-completion';
  positionCompletion(overlay, block, prediction.claim.start, prediction.claim.end);
  const findingMode = prediction.mode === 'SOURCE_FINDINGS';
  const workspaceMode = prediction.mode === 'WORKSPACE_SUGGESTIONS';
  const linkedSourceMode = prediction.sourceContext?.kind === 'LINKED_SOURCE';
  const scopedWorkspace = workspaceMode && prediction.sourceContext?.kind === 'PROJECT_OBJECT';
  const rowWorkspace = scopedWorkspace && prediction.workspaceSuggestions?.some((suggestion) => suggestion.category === 'Row');
  const columnWorkspace = scopedWorkspace && prediction.workspaceSuggestions?.some((suggestion) => suggestion.category === 'Column');
  const completing = (prediction.mode === 'COMPLETE_AND_LINK' || findingMode || workspaceMode) && Boolean(edit);
  const heading = findingMode
    ? `findings · ${prediction.sourceContext.source.label}`
    : linkedSourceMode ? `components · ${prediction.sourceContext.source.label}`
    : workspaceMode ? 'project' : 'dependency';

  // The three prediction modes carry different objects; the box shows one
  // shape, so each is reduced to the same three columns the native overlay
  // draws: what would be inserted, its value, and the file it came from.
  const rows = findingMode
    ? prediction.findings.map((finding) => ({
      label: finding.replacementText,
      detail: 'finding',
      path: prediction.sourceContext.source.path,
    }))
    : workspaceMode
      ? prediction.workspaceSuggestions.map((suggestion) => ({
        label: suggestion.replacementText,
        detail: suggestion.dependencyCandidate?.valueText ?? suggestion.category ?? '',
        path: suggestion.dependencyCandidate?.path ?? '',
      }))
      : candidates.map((candidate) => ({
        label: candidate.label,
        detail: candidate.displayValue ?? candidate.valueText ?? candidate.objectType ?? '',
        path: candidate.path,
      }));

  const canPick = !(completing || prediction.sourceContext?.exclusive);
  if (canPick) {
    rows.push({
      label: 'More sources',
      detail: `${candidates.length}`,
      path: '',
      attributes: 'id="choose-dependency"',
    });
  }

  const scoped = findingMode || linkedSourceMode || scopedWorkspace;
  const hints = [
    'Tab accept',
    scoped ? '⌘⏎ end source' : null,
    rows.length > 1 ? '↑↓ select' : null,
    'Esc close',
  ].filter(Boolean).join('   ');

  overlay.innerHTML = renderAssistBox({ title: heading, rows, selected: selectedIndex, hints });
  overlay.querySelectorAll('[data-completion-index]').forEach((button) => button.addEventListener('mousedown', (event) => {
    event.preventDefault();
    state.editor.predictionIndex = Number(button.dataset.completionIndex);
    acceptPrediction();
  }));
  document.getElementById('choose-dependency')?.addEventListener('mousedown', (event) => {
    event.preventDefault(); openPredictionPicker();
  });
  document.getElementById('end-source-scope')?.addEventListener('mousedown', (event) => {
    event.preventDefault(); endSourceContext();
  });
  overlay.querySelector('.ab-row.selected')?.scrollIntoView({ block: 'nearest' });
  const sourceName = (prediction.completion?.source?.path ?? selectedCandidate.path)?.split('/').pop();
  editorAssistStatus(findingMode
    ? `Suggestions locked to ${prediction.sourceContext.source.label}`
    : linkedSourceMode
    ? `Components locked to ${prediction.sourceContext.source.label}`
    : rowWorkspace
    ? `Rows matching ${prediction.sourceContext.variable}`
    : columnWorkspace
    ? `Columns from ${prediction.sourceContext.source.path}`
    : scopedWorkspace
    ? `Values locked to ${prediction.sourceContext.variable}`
    : workspaceMode
    ? 'Suggestions from project data and files'
    : completing
    ? `Tab completes and links${sourceName ? ` · ${sourceName}` : ''}`
    : 'Tab links the suggested source');
}

function formatObjectLocation(object) {
  if (!object?.path) return '';
  const start = object.anchor?.lineStart ?? object.anchor?.line ?? object.metadata?.lineStart;
  const end = object.anchor?.lineEnd ?? object.metadata?.lineEnd;
  return `${object.relation ? `${object.relation.replaceAll('_', ' ').toLowerCase()} · ` : ''}${object.path}${start ? `:${start}${end && end !== start ? `-${end}` : ''}` : ''}`;
}

function rangeForTextSpan(block, start, end) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let node; let offset = 0; let startNode; let endNode; let startOffset = 0; let endOffset = 0;
  while ((node = walker.nextNode())) {
    const next = offset + node.textContent.length;
    if (!startNode && start >= offset && start <= next) { startNode = node; startOffset = start - offset; }
    if (end >= offset && end <= next) { endNode = node; endOffset = end - offset; break; }
    offset = next;
  }
  if (!startNode || !endNode) return null;
  const range = new Range(); range.setStart(startNode, startOffset); range.setEnd(endNode, endOffset);
  return range;
}

function positionCompletion(overlay, block, start, end) {
  const page = document.getElementById('manuscript-page');
  const range = rangeForTextSpan(block, start, end);
  const pageRect = page?.getBoundingClientRect();
  const textRect = range?.getBoundingClientRect();
  if (!pageRect || !textRect) {
    overlay.style.top = `${block.offsetTop + block.offsetHeight + 5}px`;
    overlay.style.left = '72px';
    return;
  }
  overlay.style.top = `${Math.max(8, textRect.bottom - pageRect.top + 7)}px`;
  overlay.style.left = `${Math.max(12, Math.min(textRect.left - pageRect.left, page.clientWidth - 440))}px`;
}

function clearPrediction() {
  clearTimeout(state.editor.predictionTimer);
  state.editor.predictionController?.abort();
  state.editor.predictionController = null;
  const block = state.editor.prediction?.block;
  block?.classList.remove('has-prediction', 'has-text-completion');
  if (block) delete block.dataset.completion;
  globalThis.CSS?.highlights?.delete('predicted-dependency');
  state.editor.prediction = null;
  editorAssistStatus();
  const overlay = document.getElementById('dependency-completion');
  if (overlay) { overlay.hidden = true; overlay.replaceChildren(); }
}

function endSourceContext() {
  const selection = window.getSelection();
  const selectedBlock = selection?.focusNode?.parentElement?.closest?.('.manuscript-block')
    ?? selection?.focusNode?.closest?.('.manuscript-block');
  const block = selectedBlock ?? state.editor.activeBlock ?? state.editor.prediction?.block;
  if (!block?.isConnected) {
    editorAssistStatus('Place the caret in the document to end a source');
    return;
  }
  const boundary = caretOffsetWithin(block);
  block.dataset.sourceScopeBoundary = String(boundary);
  clearPrediction();
  editorAssistStatus('Source context ended · new suggestions use the project workspace');
}

function highlightPredictedSpan(block, start, end) {
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  const range = rangeForTextSpan(block, start, end);
  if (!range) return;
  CSS.highlights.set('predicted-dependency', new Highlight(range));
}

function openPredictionPicker() {
  const prediction = state.editor.prediction;
  if (!prediction || prediction.mode === 'COMPLETE_AND_LINK') return;
  showDependencyPicker({
    ...prediction.claim,
    blockIndex: prediction.blockIndex,
    blockType: prediction.blockType,
    searchText: prediction.block.textContent,
  }, 'link');
}

async function acceptPrediction() {
  const prediction = state.editor.prediction;
  if (!prediction) return;
  const candidate = prediction.claim.candidates[state.editor.predictionIndex];
  let claim = { ...prediction.claim, blockIndex: prediction.blockIndex, blockType: prediction.blockType };
  const edit = predictionEdit(prediction, candidate, state.editor.predictionIndex);
  const editsAcceptedText = ['COMPLETE_AND_LINK', 'SOURCE_FINDINGS', 'WORKSPACE_SUGGESTIONS'].includes(prediction.mode) && Boolean(edit);
  if (editsAcceptedText) {
    const { block, completion } = prediction;
    if (!block?.isConnected || block.textContent !== completion.requestedText) {
      clearPrediction();
      return;
    }
    recordEditorHistory('prediction', true);
    claim = { ...claim, start: edit.claimStart, end: edit.claimEnd, text: edit.claimText };
    clearPrediction();
    block.textContent = edit.blockText;
    focusEditorBlock(block, edit.claimEnd);
    markEditorDirty();
  } else {
    clearPrediction();
  }
  await linkCandidate(claim, candidate, 'AUTOCOMPLETE', null, {
    revealAcceptedText: true,
    caretOffset: editsAcceptedText ? edit.claimEnd : null,
  });
}

function storedTextForEditorBlock(block) {
  const text = block.textContent.replace(/\u00a0/g, ' ');
  if (block.dataset.blockType === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.dataset.headingLevel) || 2));
    return `${'#'.repeat(level)} ${text}`;
  }
  if (block.dataset.blockType === 'list') {
    const ordered = block.dataset.listStyle === 'ordered';
    return text.split('\n').map((line, index) => `${ordered ? `${index + 1}. ` : '- '}${line}`).join('\n');
  }
  if (block.dataset.blockType === 'code') {
    const fence = block.dataset.codeFence || '```';
    return `${fence}\n${text}\n${fence.startsWith('~~~') ? '~~~' : '```'}`;
  }
  return text;
}

function serializeManuscript() {
  const blocks = [...document.querySelectorAll('.manuscript-block')];
  let content = '';
  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const separator = index && previous?.dataset.blockType === 'list' && block.dataset.blockType === 'list' ? '\n' : index ? '\n\n' : '';
    content += `${separator}${storedTextForEditorBlock(block)}`;
  });
  return `${content.replace(/\n{3,}/g, '\n\n')}\n`;
}

function editorOffsetToStored(block, offset) {
  if (block.dataset.blockType === 'heading') {
    const level = Math.min(6, Math.max(1, Number(block.dataset.headingLevel) || 2));
    return offset + level + 1;
  }
  if (block.dataset.blockType === 'code') return offset + (block.dataset.codeFence || '```').length + 1;
  if (block.dataset.blockType !== 'list') return offset;
  const before = block.textContent.slice(0, offset);
  const lines = before.split('\n');
  const ordered = block.dataset.listStyle === 'ordered';
  return offset + lines.reduce((total, _line, index) => total + (ordered ? String(index + 1).length + 2 : 2), 0);
}

function pendingLinkPayload(dependency) {
  const block = document.querySelector(`.manuscript-block[data-block-index="${dependency.anchor.blockIndex}"]`);
  if (!block) return null;
  const anchor = resolveDependencyAnchor(dependency, block.textContent, dependency.anchor.blockIndex);
  if (!anchor) return null;
  dependency.anchor = anchor;
  const storedAnchor = {
    ...anchor,
    start: editorOffsetToStored(block, anchor.start),
    end: editorOffsetToStored(block, anchor.end),
  };
  return {
    localId: dependency.id,
    documentPath: state.editor.document.path,
    anchor: createClaimAnchor({ ...storedAnchor, blockType: block.dataset.blockType }, storedTextForEditorBlock(block)),
    spanText: dependency.spanText,
    sourceObjectId: dependency.source.id,
    sourceSnapshotId: dependency.source.snapshotId,
    selectionMethod: dependency.selectionMethod,
    confidence: dependency.confidence,
  };
}

function updateEditorVersion(snapshot) {
  if (!snapshot) return;
  state.project = {
    ...state.project,
    currentSnapshotId: snapshot.id ?? state.project.currentSnapshotId,
    currentVersion: snapshot.version ?? state.project.currentVersion,
  };
  state.editor.document.snapshotId = snapshot.id ?? state.editor.document.snapshotId;
  state.editor.document.version = snapshot.version ?? state.editor.document.version;
  const version = document.querySelector('.editor-header .eyebrow');
  if (version) version.textContent = `Version ${state.editor.document.version}`;
}

async function saveDocument(options = {}) {
  if (state.editor.savePromise) return state.editor.savePromise;
  if (!state.editor.document || (!state.editor.dirty && !state.editor.pendingLinks.length)) return state.editor.document;
  clearTimeout(state.editor.autosaveTimer);
  state.editor.autosaveTimer = null;
  const automatic = options.automatic === true;
  const button = document.getElementById('save-document');
  const saveState = document.getElementById('editor-save-state');
  const revisionAtStart = state.editor.editRevision;
  const contentAtStart = serializeManuscript();
  const contentWasDirty = state.editor.dirty;
  const pendingAtStart = state.editor.pendingLinks.map(pendingLinkPayload).filter(Boolean);
  const pendingIds = new Set(pendingAtStart.map((link) => link.localId));
  if (saveState) saveState.textContent = automatic ? 'Autosaving…' : 'Saving…';
  button?.classList.add('loading');

  state.editor.savePromise = (async () => {
    try {
      if (contentWasDirty) {
        const result = await api(`/api/projects/${state.project.id}/documents/save`, {
          method: 'POST', body: JSON.stringify({
            path: state.editor.document.path,
            content: contentAtStart,
            baseSnapshotId: state.editor.document.snapshotId,
            actor: state.identity,
          }),
        });
        state.project = result.project;
        state.editor.document.content = contentAtStart;
        state.editor.document.snapshotId = result.project.currentSnapshotId;
        state.editor.document.version = result.project.currentVersion;
      } else {
        const { project } = await api(`/api/projects/${state.project.id}`);
        state.project = project;
        state.editor.document.snapshotId = project.currentSnapshotId;
        state.editor.document.version = project.currentVersion;
      }

      if (pendingAtStart.length) {
        const linked = await api(`/api/projects/${state.project.id}/dependencies/batch`, {
          method: 'POST', body: JSON.stringify({
            links: pendingAtStart.map(({ localId, ...link }) => link),
            expectedSnapshotId: state.project.currentSnapshotId,
            actor: state.identity,
          }),
        });
        updateEditorVersion(linked.snapshot);
        linked.dependencies.forEach((dependency, index) => {
          const pending = pendingAtStart[index];
          state.editor.document.dependencies.push(dependency);
          const node = document.querySelector(`[data-pending-link-id="${CSS.escape(pending.localId)}"]`);
          if (node) {
            node.classList.remove('pending');
            delete node.dataset.pendingLinkId;
            node.dataset.dependencyId = dependency.id;
            node.title = 'Linked source';
          }
        });
        state.editor.pendingLinks = state.editor.pendingLinks.filter((dependency) => !pendingIds.has(dependency.id));
      }

      const changedDuringSave = state.editor.editRevision !== revisionAtStart || serializeManuscript() !== contentAtStart;
      state.editor.dirty = changedDuringSave;
      const stillPending = state.editor.pendingLinks.length > 0;
      if (button) button.disabled = !changedDuringSave && !stillPending;
      if (saveState) {
        saveState.textContent = changedDuringSave || stillPending
          ? 'Autosave pending'
          : automatic ? `Autosaved ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date())}` : 'Saved';
      }
      if (!automatic) toast(pendingAtStart.length ? 'Manuscript and sources saved' : 'Manuscript saved');
      return state.editor.document;
    } catch (error) {
      if (saveState) saveState.textContent = 'Autosave could not complete';
      toast(error.message, 'error');
      return state.editor.document;
    } finally {
      button?.classList.remove('loading');
      state.editor.savePromise = null;
      if (state.editor.dirty || state.editor.pendingLinks.length) scheduleEditorAutosave();
    }
  })();
  return state.editor.savePromise;
}

function createClaimAnchor(claim, textOverride = null) {
  const block = document.querySelector(`.manuscript-block[data-block-index="${claim.blockIndex}"]`);
  const text = textOverride ?? block?.textContent ?? '';
  return {
    kind: 'manuscript-span', blockIndex: claim.blockIndex, blockType: claim.blockType,
    start: claim.start, end: claim.end,
    prefix: text.slice(Math.max(0, claim.start - 32), claim.start),
    suffix: text.slice(claim.end, Math.min(text.length, claim.end + 32)),
  };
}

async function linkCandidate(claim, candidate, selectionMethod, dependencyToChange = null, options = {}) {
  try {
    if (dependencyToChange) {
      const project = (await api(`/api/projects/${state.project.id}`)).project;
      const result = await api(`/api/dependencies/${dependencyToChange.id}/revise`, {
        method: 'POST', body: JSON.stringify({
          sourceObjectId: candidate.id,
          sourceSnapshotId: candidate.snapshotId,
          confidence: candidate.score ?? null,
          expectedSnapshotId: project.currentSnapshotId,
          actor: state.identity,
        }),
      });
      updateEditorVersion(result.snapshot);
      state.editor.document.dependencies = state.editor.document.dependencies
        .map((dependency) => dependency.id === dependencyToChange.id ? result.dependency : dependency);
      toast('Linked source changed');
      hideDependencyPicker();
      return;
    }

    const localId = `pending:${crypto.randomUUID()}`;
    const dependency = {
      id: localId,
      pending: true,
      anchor: createClaimAnchor(claim),
      spanText: claim.text,
      source: candidate,
      selectionMethod,
      confidence: candidate.score ?? null,
      status: 'PENDING',
    };
    state.editor.pendingLinks.push(dependency);
    const revealAcceptedText = options.revealAcceptedText !== false;
    state.editor.revealDependencyId = revealAcceptedText ? localId : null;
    const block = document.querySelector(`.manuscript-block[data-block-index="${claim.blockIndex}"]`);
    const focusPosition = Number.isInteger(options.caretOffset)
      ? options.caretOffset : revealAcceptedText;
    renderLocalDependencies(block, focusPosition);
    markPendingDependency();
    editorAssistStatus(`Source selected · autosaves within five minutes`);
    hideDependencyPicker();
  } catch (error) { toast(error.message, 'error'); }
}

function editorDependencyRecords() {
  return [...(state.editor.document?.dependencies ?? []), ...state.editor.pendingLinks];
}

function reindexEditorBlocks() {
  document.querySelectorAll('.manuscript-block').forEach((block, index) => {
    block.dataset.blockIndex = String(index);
  });
}

function createEditorBlockElement(type = 'paragraph', text = '', options = {}) {
  const block = document.createElement('div');
  block.className = `manuscript-block ${type}`;
  block.dataset.blockType = type;
  if (type === 'heading') block.dataset.headingLevel = String(options.headingLevel ?? 2);
  if (type === 'list') block.dataset.listStyle = options.listStyle ?? 'unordered';
  if (type === 'code') block.dataset.codeFence = options.codeFence ?? '```';
  block.textContent = text;
  if (!text) block.innerHTML = '<br>';
  return block;
}

/**
 * Moves a caret that landed at the very end of a linked claim to just after
 * it. Left inside, the next character typed would be swallowed by the claim
 * and the highlight would creep across text that is not part of it.
 */
function caretOutsideLinkedClaim(range) {
  const node = range.startContainer;
  if (node?.nodeType !== Node.TEXT_NODE) return range;
  const claim = node.parentElement?.closest?.('.linked-claim');
  if (!claim) return range;
  if (range.startOffset !== node.textContent.length) return range;
  // Only the last text node in the claim sits on its trailing boundary.
  const walker = document.createTreeWalker(claim, NodeFilter.SHOW_TEXT);
  let last = null;
  let current;
  while ((current = walker.nextNode())) last = current;
  if (node !== last) return range;
  const outside = document.createRange();
  outside.setStartAfter(claim);
  outside.collapse(true);
  return outside;
}

function placeCaretAtOffset(node, offset) {
  const requestedOffset = Math.max(0, Math.min(Number(offset) || 0, node.textContent.length));
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  let textNode;
  while ((textNode = walker.nextNode())) textNodes.push(textNode);
  const point = caretPointForTextLengths(textNodes.map((item) => item.textContent.length), requestedOffset);
  if (point.atEnd) return placeCaretAtEnd(node);
  const target = textNodes[point.nodeIndex];
  const range = document.createRange();
  range.setStart(target, point.offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(caretOutsideLinkedClaim(range));
}

function splitEditorBlock(block) {
  const index = Number(block.dataset.blockIndex);
  const offset = caretOffsetWithin(block);
  const text = block.textContent;
  const crossesDependency = editorDependencyRecords().some((dependency) => dependency.anchor.blockIndex === index
    && dependency.anchor.start < offset && dependency.anchor.end > offset);
  if (crossesDependency) {
    toast('Move the caret outside the linked phrase before splitting this paragraph', 'error');
    return;
  }
  recordEditorHistory('paragraph', true);
  for (const dependency of editorDependencyRecords()) {
    if (dependency.anchor.blockIndex > index) dependency.anchor.blockIndex += 1;
    else if (dependency.anchor.blockIndex === index && dependency.anchor.start >= offset) {
      dependency.anchor.blockIndex += 1;
      dependency.anchor.start -= offset;
      dependency.anchor.end -= offset;
    }
  }
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  block.textContent = before;
  const nextType = block.dataset.blockType === 'list' ? 'list' : 'paragraph';
  const next = createEditorBlockElement(nextType, after, { listStyle: block.dataset.listStyle });
  block.after(next);
  reindexEditorBlocks();
  renderLocalDependencies(block);
  renderLocalDependencies(next);
  focusEditorBlock(next, 0);
  markEditorDirty();
}

function mergeEditorBlockWithPrevious(block) {
  const previous = block.previousElementSibling?.classList.contains('manuscript-block') ? block.previousElementSibling : null;
  if (!previous) return false;
  recordEditorHistory('paragraph', true);
  const index = Number(block.dataset.blockIndex);
  const previousLength = previous.textContent.length;
  for (const dependency of editorDependencyRecords()) {
    if (dependency.anchor.blockIndex === index) {
      dependency.anchor.blockIndex -= 1;
      dependency.anchor.start += previousLength;
      dependency.anchor.end += previousLength;
    } else if (dependency.anchor.blockIndex > index) dependency.anchor.blockIndex -= 1;
  }
  previous.textContent = `${previous.textContent}${block.textContent}`;
  block.remove();
  reindexEditorBlocks();
  renderLocalDependencies(previous);
  focusEditorBlock(previous, previousLength);
  markEditorDirty();
  return true;
}

function focusDocumentEnd() {
  let last = document.querySelector('.manuscript-block:last-of-type');
  if (!last || last.textContent.trim()) {
    last = createEditorBlockElement();
    document.getElementById('document-body').append(last);
    reindexEditorBlocks();
  }
  focusEditorBlock(last);
}

function handleEditorShortcuts(event) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redoEditor(); else undoEditor();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
    event.preventDefault(); openManualPickerFromSelection(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === '.') {
    event.preventDefault(); openManualPickerFromSelection(); return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); saveDocument(); return;
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key === 'Enter') {
    event.preventDefault(); endSourceContext(); return;
  }
  if (state.editor.prediction && (event.key === 'Tab' || (event.altKey && event.key === 'Enter'))) {
    event.preventDefault(); acceptPrediction();
    return;
  }
  if (state.editor.prediction && event.key === 'ArrowDown') {
    event.preventDefault();
    state.editor.predictionIndex = (state.editor.predictionIndex + 1) % state.editor.prediction.claim.candidates.length;
    showPredictionCompletion();
    return;
  }
  if (state.editor.prediction && event.key === 'ArrowUp') {
    event.preventDefault();
    const completionCount = state.editor.prediction.claim.candidates.length;
    state.editor.predictionIndex = (state.editor.predictionIndex - 1 + completionCount) % completionCount;
    showPredictionCompletion();
    return;
  }
  if (state.editor.prediction && event.key === 'Escape') { event.preventDefault(); clearPrediction(); return; }
  const block = editorBlockFromSelection(event.target);
  if (!block || event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    clearPrediction();
    if (block.dataset.blockType === 'code') {
      document.execCommand('insertText', false, '\n');
      markEditorDirty();
    } else splitEditorBlock(block);
    return;
  }
  if (event.key === 'Backspace' && window.getSelection()?.isCollapsed && caretOffsetWithin(block) === 0) {
    if (block.previousElementSibling?.classList.contains('manuscript-block')) {
      event.preventDefault();
      clearPrediction();
      mergeEditorBlockWithPrevious(block);
    }
  }
  if (event.key === 'Delete' && window.getSelection()?.isCollapsed
    && caretOffsetWithin(block) === block.textContent.length) {
    const next = block.nextElementSibling?.classList.contains('manuscript-block') ? block.nextElementSibling : null;
    if (next) {
      event.preventDefault();
      clearPrediction();
      mergeEditorBlockWithPrevious(next);
    }
  }
}

function selectedClaim() {
  const selection = window.getSelection();
  const block = selection?.focusNode?.parentElement?.closest?.('.manuscript-block')
    ?? selection?.focusNode?.closest?.('.manuscript-block') ?? state.editor.activeBlock;
  if (!block) return null;
  const text = block.textContent;
  let start = 0; let end = text.length;
  if (selection && !selection.isCollapsed && block.contains(selection.anchorNode) && block.contains(selection.focusNode)) {
    start = textOffset(block, selection.anchorNode, selection.anchorOffset);
    end = textOffset(block, selection.focusNode, selection.focusOffset);
    if (start > end) [start, end] = [end, start];
  } else {
    const claims = state.editor.prediction?.claim ? [state.editor.prediction.claim] : [];
    if (claims.length) ({ start, end } = claims[0]);
  }
  return {
    start, end, text: text.slice(start, end), searchText: text, type: 'MANUAL', value: null,
    blockIndex: Number(block.dataset.blockIndex), blockType: block.dataset.blockType,
  };
}

function openManualPickerFromSelection() {
  const claim = selectedClaim();
  if (!claim?.text.trim()) { toast('Select a manuscript phrase first', 'error'); return; }
  showDependencyPicker(claim, 'link');
}

async function showDependencyPicker(claim, mode = 'link', dependency = null) {
  clearPrediction();
  state.editor.manualClaim = claim;
  state.editor.pickerMode = mode;
  const picker = document.getElementById('dependency-picker');
  if (!picker) return;
  const inspector = document.getElementById('dependency-inspector');
  if (inspector) inspector.hidden = true;
  picker.hidden = false;
  picker.className = 'dependency-picker';
  picker.innerHTML = `<header><div><span class="eyebrow">Select dependency</span><strong>${mode === 'change' ? 'Change linked source' : `“${escapeHtml(claim.text.slice(0, 70))}”`}</strong></div><button id="close-picker" aria-label="Close dependency picker">×</button></header><label><span class="sr-only">Search project</span><input id="dependency-search" placeholder="Search sources, figures, datasets, and code"></label><div class="picker-results" id="picker-results"><p>Searching the current project…</p></div>`;
  document.getElementById('close-picker').addEventListener('click', hideDependencyPicker);
  const input = document.getElementById('dependency-search');
  input.value = wordTokensForSearch(dependency
    ? `${dependency.source.label} ${dependency.source.valueText ?? ''}`
    : claim.searchText ?? claim.text);
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => loadPickerResults(input.value, dependency), 220); });
  await loadPickerResults(input.value, dependency);
  input.focus();
}

function wordTokensForSearch(value) {
  return (String(value).match(/[A-Za-z][A-Za-z0-9-]{2,}/g) ?? []).slice(0, 4).join(' ');
}

async function loadPickerResults(query, dependency = null) {
  const target = document.getElementById('picker-results');
  if (!target) return;
  const { objects } = await api(`/api/projects/${state.project.id}/dependency-objects?query=${encodeURIComponent(query)}`);
  target.innerHTML = objects.length ? objects.map((object) => `<button class="picker-result" data-object-id="${object.id}" data-object-snapshot="${object.snapshotId}"><i class="object-type">${escapeHtml(object.objectType)}</i><span><strong>${escapeHtml(object.label)} ${object.valueText ? `<b>${escapeHtml(object.valueText)}</b>` : ''}</strong><small>${escapeHtml(object.path)}</small></span></button>`).join('') : '<div class="no-candidate"><strong>No matching project dependency found.</strong><span>CoLab will not invent a source.</span></div>';
  target.querySelectorAll('[data-object-id]').forEach((button) => button.addEventListener('click', () => {
    const object = objects.find((candidate) => candidate.id === button.dataset.objectId && candidate.snapshotId === button.dataset.objectSnapshot);
    linkCandidate(state.editor.manualClaim, object, 'MANUAL', dependency);
  }));
}

function hideDependencyPicker() {
  const picker = document.getElementById('dependency-picker');
  if (picker) { picker.hidden = true; picker.replaceChildren(); }
}

async function showDependencyInspector(dependencyId, sourceNode = null) {
  const { dependency } = await api(`/api/dependencies/${dependencyId}`);
  const inspector = document.getElementById('dependency-inspector');
  if (!inspector) return;
  state.editor.activeDependencyId = dependencyId;
  inspector.hidden = false;
  inspector.className = 'dependency-inspector';
  inspector.style.top = '24px';
  inspector.style.left = 'auto';
  inspector.style.right = '24px';
  const warning = ['STALE', 'BROKEN', 'NEEDS_REVIEW'].includes(dependency.status)
    ? `<div class="dependency-warning"><strong>${dependency.status.replaceAll('_', ' ')}</strong>${dependency.status === 'STALE' ? `<span>Manuscript: ${escapeHtml(dependency.source.valueText ?? dependency.spanText)} · Current source: ${escapeHtml(dependency.statusDetails.currentSourceValue ?? 'changed')}</span>` : `<span>${escapeHtml(dependency.statusDetails.anchorIssue ?? dependency.statusDetails.sourceIssue ?? 'Human review is required.')}</span>`}</div>` : '';
  const origin = dependency.source.origin;
  const presentation = dependencySourcePresentation(dependency);
  const displayValue = dependencyDisplayValue(dependency);
  const displaySource = dependencySourceForDisplay(dependency);
  const figureSource = displaySource.objectType === 'FIGURE';
  const referenceCount = (state.editor.document?.dependencies ?? [])
    .filter((item) => item.source.id === dependency.source.id).length || 1;
  const anchor = displaySource.anchor ?? {};
  const coordinate = Number.isInteger(anchor.columnIndex) && Number.isInteger(anchor.rowIndex)
    ? `${spreadsheetColumnLabel(anchor.columnIndex)}${anchor.rowIndex}` : '';
  const location = [anchor.sheet, coordinate || anchor.rowKey || anchor.column].filter(Boolean).join('!');

  const actions = [
    { key: 'o', label: 'open', id: 'open-dependency-source' },
    { key: 's', label: 'share', id: 'share-dependency' },
    { key: 'c', label: 'change', id: 'change-dependency' },
    { key: 'r', label: 'request', id: 'dependency-rfi' },
    origin?.path ? { key: 'g', label: 'origin', id: 'open-dependency-origin' } : null,
    dependency.status === 'STALE' ? { key: 'k', label: 'keep', id: 'keep-historical' } : null,
    { key: 'x', label: 'remove', id: 'remove-dependency' },
  ].filter(Boolean);

  const sourceType = (displaySource.path.split('.').pop() || displaySource.objectType || 'SRC').toUpperCase().slice(0, 4);
  const sourceName = displaySource.path.split('/').pop() || displaySource.label;
  inspector.innerHTML = `<section class="native-source-inspector" tabindex="-1">
    <header class="inspector-drag">
      <div><span class="inspector-app-icon">${escapeHtml(sourceType)}</span><span><small>Source Inspector</small><strong>${escapeHtml(sourceName)}</strong></span></div>
      <button class="inspector-close" id="close-inspector" aria-label="Close source inspector">×</button>
    </header>
    ${warning}
    <div class="inspector-source-summary">
      <span class="source-kind-icon">${escapeHtml(sourceType)}</span>
      <span><strong>${escapeHtml(presentation.sourceLine)}</strong><small>${escapeHtml(displaySource.path)}</small></span>
      <span class="source-status ${dependency.status.toLowerCase()}">${escapeHtml(dependency.status.replaceAll('_', ' ').toLowerCase())}</span>
    </div>
    ${displayValue && !figureSource ? `<div class="inspector-primary-value"><small>Cited value</small><strong>${escapeHtml(displayValue)}</strong></div>` : ''}
    <dl class="inspector-metadata">
      ${location ? `<div><dt>Location</dt><dd>${escapeHtml(location)}</dd></div>` : ''}
      <div><dt>Linked</dt><dd>${escapeHtml(formatDateTime(dependency.createdAt))} by ${escapeHtml(dependency.linkedBy?.displayName ?? dependency.createdBy.displayName)}</dd></div>
      <div><dt>References</dt><dd>${referenceCount} in this document</dd></div>
      ${origin?.path ? `<div><dt>Produced by</dt><dd>${escapeHtml(formatObjectLocation(origin))}</dd></div>` : ''}
    </dl>
    <section class="inspector-evidence">
      <header><span><strong>Cited source preview</strong><small>Exact evidence and nearby context</small></span><button id="open-dependency-source" type="button">Open source</button></header>
      <div id="dependency-source-preview"><div class="inspector-preview-loading"><span></span>Loading indexed context…</div></div>
    </section>
    <footer class="inspector-actions">
      <button id="share-dependency" type="button"><kbd>S</kbd>Share</button>
      <button id="change-dependency" type="button"><kbd>C</kbd>Change</button>
      <button id="dependency-rfi" type="button"><kbd>R</kbd>Trace</button>
      ${origin?.path ? '<button id="open-dependency-origin" type="button"><kbd>G</kbd>Origin</button>' : ''}
      ${dependency.status === 'STALE' ? '<button id="keep-historical" type="button"><kbd>K</kbd>Keep</button>' : ''}
      <button id="remove-dependency" class="destructive" type="button"><kbd>X</kbd>Remove</button>
    </footer>
  </section>
  <div id="inspector-rfi"></div><div id="dependency-sharing"></div>`;

  inspector.querySelector('.native-source-inspector')?.focus({ preventScroll: true });
  inspector.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { document.getElementById('close-inspector')?.click(); return; }
    const match = actions.find((action) => action.key === event.key.toLowerCase());
    if (match) { event.preventDefault(); document.getElementById(match.id)?.click(); }
  });

  bindDraggableInspector(inspector);
  const close = () => {
    inspector.hidden = true;
    state.editor.activeDependencyId = null;
  };
  document.getElementById('close-inspector')?.addEventListener('click', close);
  inspector.querySelector('.inspector-drag')?.addEventListener('dblclick', close);
  document.getElementById('dependency-rfi')?.addEventListener('click', () => requestDependencyRfi(dependency));
  document.getElementById('open-dependency-source')?.addEventListener('click', () => openDependencySourceViewer(dependency));
  document.getElementById('share-dependency')?.addEventListener('click', async () => {
    await openDependencySharing(dependency, true);
    document.getElementById('dependency-sharing')?.scrollIntoView({ block: 'nearest' });
  });
  document.getElementById('open-dependency-origin')?.addEventListener('click', () => showPreview(origin.snapshotId, origin.path, null, origin.anchor));
  document.getElementById('change-dependency')?.addEventListener('click', () => showDependencyPicker({ ...dependency.anchor, text: dependency.spanText }, 'change', dependency));
  document.getElementById('remove-dependency')?.addEventListener('click', () => reviseDependency(dependency, { action: 'REMOVE' }));
  document.getElementById('keep-historical')?.addEventListener('click', () => reviseDependency(dependency, { action: 'KEEP_HISTORICAL' }));
  await loadDependencySourcePreview(dependency);
}


function bindDraggableInspector(inspector) {
  const handle = inspector.querySelector('.inspector-drag');
  const host = inspector.closest('.editor-workspace');
  if (!handle || !host) return;
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button, a, input, select, textarea')) return;
    const hostRect = host.getBoundingClientRect();
    const inspectorRect = inspector.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = inspectorRect.left - hostRect.left;
    const startTop = inspectorRect.top - hostRect.top;
    inspector.style.left = `${startLeft}px`;
    inspector.style.top = `${startTop}px`;
    inspector.style.right = 'auto';
    inspector.classList.add('dragging');
    const move = (moveEvent) => {
      const maxLeft = Math.max(8, host.clientWidth - inspector.offsetWidth - 8);
      const maxTop = Math.max(8, host.clientHeight - Math.min(inspector.offsetHeight, 64) - 8);
      const nextLeft = Math.min(maxLeft, Math.max(8, startLeft + moveEvent.clientX - startX));
      const nextTop = Math.min(maxTop, Math.max(8, startTop + moveEvent.clientY - startY));
      inspector.style.left = `${nextLeft}px`;
      inspector.style.top = `${nextTop}px`;
    };
    const stop = () => {
      inspector.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    event.preventDefault();
  });
}

function ensureDependencySourceViewer() {
  let dialog = document.getElementById('dependency-source-viewer');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'dependency-source-viewer';
  dialog.className = 'dependency-source-viewer';
  dialog.setAttribute('aria-label', 'Indexed source viewer');
  dialog.innerHTML = '<div id="dependency-source-viewer-content"></div>';
  document.body.append(dialog);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.querySelector('iframe')?.setAttribute('src', 'about:blank');
  });
  return dialog;
}

function sourceViewerDocumentContent(viewer) {
  const text = String(viewer.text ?? '');
  const start = Number(viewer.selectedStart);
  const length = String(viewer.selectedText ?? '').length;
  if (start < 0 || !length || start + length > text.length) return `<pre class="source-viewer-document-text">${escapeHtml(text)}</pre>`;
  return `<pre class="source-viewer-document-text">${escapeHtml(text.slice(0, start))}<mark id="source-viewer-cited-location">${escapeHtml(text.slice(start, start + length))}</mark>${escapeHtml(text.slice(start + length))}</pre>`;
}

function sourceViewerTableContent(viewer) {
  const sheets = viewer.sheets?.length > 1
    ? `<nav class="source-viewer-sheet-tabs" aria-label="Workbook sheets">${viewer.sheets.map((sheet) => `<button class="${sheet === viewer.sheet ? 'active' : ''}" data-source-viewer-sheet="${escapeHtml(sheet)}">${escapeHtml(sheet)}</button>`).join('')}</nav>` : '';
  const header = `<thead><tr><th class="source-viewer-row-number" aria-label="Row number"></th>${viewer.headers.map((value, columnIndex) => `<th class="${columnIndex === viewer.selectedColumn ? 'indexed-column' : ''}">${escapeHtml(value)}</th>`).join('')}</tr></thead>`;
  const rows = viewer.rows.map((row, rowIndex) => `<tr class="${rowIndex === viewer.selectedRow ? 'indexed-row' : ''}"><th class="source-viewer-row-number">${rowIndex + 1}</th>${row.map((value, columnIndex) => `<td ${rowIndex === viewer.selectedRow && (columnIndex === viewer.selectedColumn || (viewer.selectedColumn < 0 && columnIndex === 0)) ? 'id="source-viewer-cited-location"' : ''} class="${rowIndex === viewer.selectedRow && columnIndex === viewer.selectedColumn ? 'indexed-cell' : ''}">${escapeHtml(value)}</td>`).join('')}</tr>`).join('');
  return `${sheets}<div class="source-viewer-table-scroll"><table class="source-viewer-table">${header}<tbody>${rows}</tbody></table></div>${viewer.truncated ? `<p class="source-viewer-truncated">Showing the first ${viewer.rows.length.toLocaleString()} of ${viewer.totalRows.toLocaleString()} indexed rows.</p>` : ''}`;
}

function renderDependencySourceViewer(dialog, viewer) {
  const target = dialog.querySelector('#dependency-source-viewer-content');
  const page = Math.max(1, Number(viewer.pageNumber) || 1);
  const content = viewer.kind === 'pdf'
    ? `<iframe class="source-viewer-pdf" src="${escapeHtml(`${viewer.fileUrl}#page=${page}&zoom=page-width`)}" title="${escapeHtml(viewer.path)}"></iframe>`
    : viewer.kind === 'table' ? sourceViewerTableContent(viewer)
      : viewer.kind === 'image' ? `<div class="source-viewer-image"><img id="source-viewer-cited-location" src="${escapeHtml(viewer.fileUrl)}" alt="${escapeHtml(viewer.source.label)}"></div>`
        : viewer.kind === 'document' ? sourceViewerDocumentContent(viewer)
          : `<div class="source-viewer-unavailable"><strong>This file cannot be displayed inline.</strong><p>The preserved source version can still be opened in its native application.</p></div>`;
  target.innerHTML = `<div class="source-viewer-shell">
    <header class="source-viewer-header"><div><span class="source-viewer-file-type">${escapeHtml(String(viewer.fileType).toUpperCase())}</span><span><strong>${escapeHtml(viewer.path.split('/').pop())}</strong><small>${escapeHtml(viewer.path)}${viewer.version ? ` · Version ${viewer.version}` : ''}</small></span></div><div><a href="${escapeHtml(viewer.fileUrl)}" target="_blank" rel="noopener">Open separately ↗</a><button id="close-dependency-source-viewer" aria-label="Close source viewer">×</button></div></header>
    <div class="source-viewer-location"><span>Indexed location</span><strong>${escapeHtml(viewer.locationLabel || viewer.source.label)}</strong><small>You can scroll through the rest of this preserved source. This private viewer does not change sharing permissions.</small></div>
    <main class="source-viewer-content source-viewer-${escapeHtml(viewer.kind)}">${content}</main>
  </div>`;
  document.getElementById('close-dependency-source-viewer').addEventListener('click', () => dialog.close());
  target.querySelectorAll('[data-source-viewer-sheet]').forEach((button) => button.addEventListener('click', () => {
    openDependencySourceViewer(viewer.dependencyId, button.dataset.sourceViewerSheet);
  }));
  requestAnimationFrame(() => target.querySelector('#source-viewer-cited-location')?.scrollIntoView({ block: 'center', inline: 'center' }));
}

async function openDependencySourceViewer(dependencyOrId, sheet = null) {
  const dependencyId = typeof dependencyOrId === 'string' ? dependencyOrId : dependencyOrId.id;
  const dialog = ensureDependencySourceViewer();
  const target = dialog.querySelector('#dependency-source-viewer-content');
  target.innerHTML = '<div class="source-viewer-loading"><span></span><strong>Opening indexed source…</strong></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const query = sheet ? `?sheet=${encodeURIComponent(sheet)}` : '';
    const { viewer } = await api(`/api/dependencies/${encodeURIComponent(dependencyId)}/viewer${query}`);
    if (!dialog.open) return;
    renderDependencySourceViewer(dialog, viewer);
  } catch (error) {
    target.innerHTML = `<div class="source-viewer-unavailable"><strong>Source viewer unavailable</strong><p>${escapeHtml(error.message)}</p><button id="close-dependency-source-viewer">Close</button></div>`;
    document.getElementById('close-dependency-source-viewer').addEventListener('click', () => dialog.close());
  }
}

async function loadDependencySourcePreview(dependency) {
  const target = document.getElementById('dependency-source-preview');
  if (!target) return;
  try {
    const { preview } = await api(`/api/dependencies/${dependency.id}/preview?contextRadius=1`);
    if (!target.isConnected) return;
    target.innerHTML = renderCitedSourcePreview(preview);
    target.addEventListener('click', () => openDependencySourceViewer(dependency), { once: true });
  } catch (error) {
    target.innerHTML = `<div class="inspector-preview-error">${escapeHtml(error.message)}</div>`;
  }
}

function renderCitedSourcePreview(preview) {
  const content = preview.content ?? {};
  if (['table', 'table-context'].includes(content.kind)) {
    const headers = content.headers ?? [];
    const rows = content.rows ?? [];
    if (!headers.length && !rows.length) return '<div class="inspector-preview-empty">No table rows were extractable.</div>';
    return `<div class="native-table-preview"><table>
      ${headers.length ? `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>` : ''}
      <tbody>${rows.slice(0, 8).map((row) => {
        const cells = row.cells ?? row;
        return `<tr class="${row.highlighted || row.cited ? 'cited' : ''}">${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`;
      }).join('')}</tbody>
    </table></div><button class="preview-open-affordance" type="button">Open workbook context <span>↗</span></button>`;
  }
  if (content.kind === 'pdf-figure') {
    return `<div class="native-figure-preview">
      <div class="figure-preview-meta"><strong>${escapeHtml(content.label ?? 'Figure')}</strong><span>PDF · Page ${escapeHtml(content.pageNumber ?? '—')}</span></div>
      <img src="${escapeHtml(content.imageUrl)}" alt="${escapeHtml(content.label ?? 'Cited figure')}">
      ${content.caption ? `<p>${escapeHtml(content.caption)}</p>` : ''}
    </div><button class="preview-open-affordance" type="button">Open cited page <span>↗</span></button>`;
  }
  const text = content.text || preview.source?.valueText || 'No extractable preview is available for this source type.';
  return `<div class="native-text-preview"><p>${escapeHtml(text)}</p></div><button class="preview-open-affordance" type="button">Open source context <span>↗</span></button>`;
}


const SHARE_CHOICES = {
  CONTEXT: {
    label: 'Cited context', badge: 'Recommended',
    description: 'Share the cited cell or passage with labels and nearby context. The rest of the source stays private.',
  },
  PRIVATE: {
    label: 'Keep source private', badge: 'No access',
    description: 'Revoke active source links. Recipients can read the document claim but cannot open its evidence.',
  },
  FULL: {
    label: 'Full source', badge: 'Broad access',
    description: 'Let link recipients inspect the complete indexed source version. Use only when the full file is appropriate to disclose.',
  },
};

async function openDependencySharing(dependency, alternativesOpen = false) {
  const target = document.getElementById('dependency-sharing');
  if (!target) return;
  target.innerHTML = '<div class="share-loading">Loading source access…</div>';
  try {
    const { sharing } = await api(`/api/dependencies/${dependency.id}/share`);
    renderDependencySharing(dependency, sharing, 'CONTEXT', alternativesOpen);
  } catch (error) {
    target.innerHTML = `<div class="share-error">${escapeHtml(error.message)}</div>`;
  }
}

function shareExpiryValue(value) {
  if (value === 'never') return null;
  const days = Number(value) || 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function absoluteShareUrl(grant) {
  return new URL(grant.url, window.location.origin).href;
}

function renderShareGrant(grant) {
  const expires = grant.expiresAt ? `Expires ${formatDateTime(grant.expiresAt)}` : 'No expiration';
  return `<div class="share-grant"><div><strong>${grant.scope === 'CONTEXT' ? 'Cited context' : 'Full source'}</strong><span>${escapeHtml(grant.recipientLabel || 'Anyone with this link')} · ${escapeHtml(expires)}</span></div><div><a href="${escapeHtml(absoluteShareUrl(grant))}" target="_blank" rel="noopener">Preview</a><button data-copy-share="${escapeHtml(grant.token)}">Copy</button><button data-revoke-share="${escapeHtml(grant.token)}">Revoke</button></div></div>`;
}

function renderDependencySharing(dependency, sharing, selectedScope = 'CONTEXT', alternativesOpen = false) {
  const target = document.getElementById('dependency-sharing');
  if (!target) return;
  const selected = SHARE_CHOICES[selectedScope];
  const alternatives = Object.entries(SHARE_CHOICES).filter(([scope]) => scope !== selectedScope);
  target.innerHTML = `<section class="share-card">
    <header><div><span class="share-shield" aria-hidden="true">◇</span><span><strong>Source access</strong><small>Choose what a document recipient may open</small></span></div><button id="close-sharing" aria-label="Close source access">×</button></header>
    <button class="share-choice selected" data-current-share-scope="${selectedScope}"><span><b>${escapeHtml(selected.label)}</b><small>${escapeHtml(selected.description)}</small></span><em>${escapeHtml(selected.badge)}</em></button>
    <button class="share-alternatives-toggle" id="share-alternatives-toggle" aria-expanded="${alternativesOpen}"><span>${alternativesOpen ? 'Hide' : 'Show'} other access options</span><i>${alternativesOpen ? '⌃' : '⌄'}</i></button>
    <div class="share-alternatives" ${alternativesOpen ? '' : 'hidden'}>${alternatives.map(([scope, choice]) => `<button class="share-choice" data-share-scope="${scope}"><span><b>${escapeHtml(choice.label)}</b><small>${escapeHtml(choice.description)}</small></span><em>${escapeHtml(choice.badge)}</em></button>`).join('')}</div>
    ${selectedScope === 'PRIVATE' ? '' : `<div class="share-fields"><label>Recipient or group <input id="share-recipient" placeholder="Optional — e.g. Review team"></label><label>Link expires <select id="share-expiry"><option value="7">In 7 days</option><option value="30">In 30 days</option><option value="never">Never</option></select></label></div>`}
    <div class="share-privacy-note"><strong>${selectedScope === 'FULL' ? 'Full-source disclosure' : selectedScope === 'PRIVATE' ? 'Private by default' : 'Minimum necessary context'}</strong><span>${selectedScope === 'FULL' ? 'This can reveal unrelated rows or passages in the indexed source.' : selectedScope === 'PRIVATE' ? 'No source content is available through a recipient link.' : 'Only the cited evidence and enough surrounding context to interpret it are disclosed.'}</span></div>
    <button class="share-primary" id="apply-share-scope">${selectedScope === 'PRIVATE' ? 'Revoke source access' : `Create ${selectedScope === 'CONTEXT' ? 'context' : 'full-source'} link`}</button>
    ${sharing.grants.length ? `<div class="share-grants"><span class="eyebrow">Active links</span>${sharing.grants.map(renderShareGrant).join('')}</div>` : '<p class="no-share-grants">No active source links. The dependency is private.</p>'}
  </section>`;
  document.getElementById('close-sharing').addEventListener('click', () => { target.replaceChildren(); });
  document.getElementById('share-alternatives-toggle').addEventListener('click', () => renderDependencySharing(dependency, sharing, selectedScope, !alternativesOpen));
  target.querySelectorAll('[data-share-scope]').forEach((button) => button.addEventListener('click', () => renderDependencySharing(dependency, sharing, button.dataset.shareScope, false)));
  document.getElementById('apply-share-scope').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const { sharing: updated } = await api(`/api/dependencies/${dependency.id}/share`, {
        method: 'POST', body: JSON.stringify({
          scope: selectedScope,
          recipientLabel: document.getElementById('share-recipient')?.value ?? '',
          contextRadius: 1,
          expiresAt: shareExpiryValue(document.getElementById('share-expiry')?.value),
          actor: state.identity,
        }),
      });
      renderDependencySharing(dependency, updated, selectedScope, false);
      toast(selectedScope === 'PRIVATE' ? 'Source access revoked' : `${selected.label} link created`);
    } catch (error) { toast(error.message, 'error'); button.disabled = false; }
  });
  target.querySelectorAll('[data-copy-share]').forEach((button) => button.addEventListener('click', async () => {
    const grant = sharing.grants.find((item) => item.token === button.dataset.copyShare);
    if (!grant) return;
    try {
      await navigator.clipboard.writeText(absoluteShareUrl(grant));
      toast('Source link copied');
    } catch { toast('Could not copy the link automatically', 'error'); }
  }));
  target.querySelectorAll('[data-revoke-share]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/dependency-shares/${encodeURIComponent(button.dataset.revokeShare)}`, { method: 'DELETE' });
      const { sharing: updated } = await api(`/api/dependencies/${dependency.id}/share`);
      renderDependencySharing(dependency, updated, selectedScope, alternativesOpen);
      toast('Source link revoked');
    } catch (error) { toast(error.message, 'error'); }
  }));
}

async function requestDependencyRfi(dependency) {
  const { rfi } = await api(`/api/projects/${state.project.id}/rfi`, {
    method: 'POST', body: JSON.stringify({ snapshotId: state.editor.document.snapshotId, path: state.editor.document.path, anchor: dependency.anchor }),
  });
  const target = document.getElementById('inspector-rfi');
  target.innerHTML = `<div class="inspector-lineage"><span class="eyebrow">Recorded lineage</span>${rfi.provenance.map((link) => `<div><i>${escapeHtml(link.relation)}</i><strong>${escapeHtml(link.to.path ?? link.metadata.label ?? 'Recorded object')}</strong>${link.to.version ? `<span>Version ${link.to.version}</span>` : ''}</div>`).join('') || `<p>${escapeHtml(rfi.message)}</p>`}</div>`;
}

async function reviseDependency(dependency, revision) {
  const project = (await api(`/api/projects/${state.project.id}`)).project;
  const result = await api(`/api/dependencies/${dependency.id}/revise`, {
    method: 'POST', body: JSON.stringify({ ...revision, expectedSnapshotId: project.currentSnapshotId, actor: state.identity }),
  });
  updateEditorVersion(result.snapshot);
  if (revision.action === 'REMOVE') {
    state.editor.document.dependencies = state.editor.document.dependencies.filter((item) => item.id !== dependency.id);
    const node = document.querySelector(`[data-dependency-id="${CSS.escape(dependency.id)}"]`);
    if (node) node.replaceWith(document.createTextNode(node.textContent));
  } else {
    state.editor.document.dependencies = state.editor.document.dependencies
      .map((item) => item.id === dependency.id ? result.dependency : item);
  }
  const inspector = document.getElementById('dependency-inspector');
  if (inspector) inspector.hidden = true;
  toast(revision.action === 'REMOVE' ? 'Dependency removed' : 'Dependency review recorded');
}

function focusDependency(dependencyId) {
  const node = document.querySelector(`[data-dependency-id="${dependencyId}"]`);
  node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (node) showDependencyInspector(dependencyId, node);
}

function formatActiveBlock(format) {
  const block = editorBlockFromSelection() ?? state.editor.activeBlock;
  if (!block) return;
  recordEditorHistory('format', true);
  if (format === 'heading') {
    block.dataset.blockType = 'heading';
    block.dataset.headingLevel = block.dataset.headingLevel || '2';
  } else if (format === 'list' || format === 'numbered') {
    block.dataset.blockType = 'list';
    block.dataset.listStyle = format === 'numbered' ? 'ordered' : 'unordered';
  } else block.dataset.blockType = 'paragraph';
  block.className = `manuscript-block ${block.dataset.blockType}`;
  markEditorDirty(); focusEditorBlock(block);
}

function runEditorCommand(command) {
  if (command === 'undo') undoEditor();
  else if (command === 'redo') redoEditor();
  else if (['bold', 'italic', 'underline'].includes(command)) {
    document.execCommand(command, false);
    markEditorDirty();
  }
}

async function openActiveDependencySharing() {
  const dependencyId = state.editor.activeDependencyId
    ?? state.editor.document?.dependencies?.[0]?.id;
  if (!dependencyId) {
    toast('Link a source before choosing source-sharing access.');
    return;
  }
  await showDependencyInspector(dependencyId);
  const button = document.getElementById('share-dependency');
  if (button) button.click();
}

function openDialog(dialog) {
  dialog.querySelectorAll('[data-dialog-error]').forEach((node) => { node.textContent = ''; });
  dialog.showModal();
}

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
    const result = await api('/api/projects/import', {
      method: 'POST', body: JSON.stringify({ ...values, actor: state.identity }),
    });
    elements['import-dialog'].close(); form.reset();
    toast(result.imported ? 'Version 1 created' : 'Project already registered');
    await loadProjects(result.project.id);
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

function renderSharedTable(content) {
  const headers = content.headers ?? [];
  const rows = content.rows ?? [];
  return `<div class="shared-table-wrap"><table class="shared-table"><thead><tr>${headers.map((header, columnIndex) => `<th class="${columnIndex === content.selectedColumn ? 'cited-column' : ''}">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr class="${rowIndex === content.selectedRow ? 'cited-row' : ''}">${row.map((cell, columnIndex) => `<td class="${rowIndex === content.selectedRow && columnIndex === content.selectedColumn ? 'cited-cell' : ''}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function renderSharedDependency(shared) {
  const shell = document.querySelector('.app-shell');
  const contextOnly = shared.access.scope === 'CONTEXT';
  const content = ['table', 'table-context'].includes(shared.content.kind)
    ? renderSharedTable(shared.content)
    : `<div class="shared-text"><p>${escapeHtml(shared.content.text)}</p></div>`;
  shell.innerHTML = `<header class="shared-topbar"><a class="brand" href="/"><span class="brand-mark">C</span><span>CoLab Dry</span></a><span class="shared-access-badge">${contextOnly ? 'Cited context' : 'Full source'} access</span></header>
    <main class="shared-source-view">
      <section class="shared-source-card">
        <div class="shared-source-heading"><span class="eyebrow">Verified project source</span><h1>${escapeHtml(shared.source.label)}</h1><p>${escapeHtml(shared.source.path)}</p></div>
        <div class="shared-claim"><span>Linked claim</span><blockquote>${escapeHtml(shared.claim)}</blockquote></div>
        <div class="shared-context-notice"><strong>${contextOnly ? 'Only the cited portion is shared' : 'The owner shared the full indexed source'}</strong><span>${contextOnly ? 'Nearby labels and rows or surrounding text are included so you can interpret the evidence without access to unrelated source content.' : 'This view may include information beyond the cited claim.'}</span></div>
        ${content}
        <dl class="shared-source-meta"><div><dt>Source version</dt><dd>${escapeHtml(shared.source.metadata.title || shared.source.path)}</dd></div>${shared.source.metadata.variable ? `<div><dt>Variable</dt><dd>${escapeHtml(shared.source.metadata.variable)}</dd></div>` : ''}${shared.source.metadata.row ? `<div><dt>Row</dt><dd>${escapeHtml(shared.source.metadata.row)}</dd></div>` : ''}${shared.access.expiresAt ? `<div><dt>Access expires</dt><dd>${escapeHtml(formatDateTime(shared.access.expiresAt))}</dd></div>` : ''}</dl>
      </section>
    </main>`;
  document.title = `${shared.source.label} · Shared source`;
}

async function loadSharedDependency(token) {
  try {
    const { shared } = await api(`/api/shared-dependencies/${encodeURIComponent(token)}`);
    renderSharedDependency(shared);
  } catch (error) {
    const shell = document.querySelector('.app-shell');
    shell.innerHTML = `<main class="shared-source-view"><section class="shared-source-card shared-unavailable"><span class="brand-mark">C</span><h1>Source link unavailable</h1><p>${escapeHtml(error.message)}</p><a href="/">Return to CoLab Dry</a></section></main>`;
  }
}


const THEMES = [
  { id: 'carbon', label: 'Carbon', hint: 'warm near-black · amber' },
  { id: 'slate', label: 'Slate', hint: 'cool grey · blue' },
  { id: 'palenight', label: 'Palenight', hint: 'indigo · violet' },
  { id: 'alabaster', label: 'Alabaster', hint: 'light · warm paper' },
];

function currentTheme() {
  try { return localStorage.getItem('colab.theme') || 'carbon'; } catch { return 'carbon'; }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('colab.theme', theme); } catch { /* presentation only */ }
}

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
    if (project.id === state.project?.id) continue;
    commands.push({
      title: `switch to ${project.name}`,
      hint: `project · V${project.currentVersion}`,
      run: () => selectProject(project.id),
    });
  }

  for (const theme of THEMES) {
    if (theme.id === currentTheme()) continue;
    commands.push({ title: `theme ${theme.label}`, hint: theme.hint, run: () => applyTheme(theme.id) });
  }

  commands.push(
    { title: 'index a project directory', hint: 'add a new local project', run: () => openDialog(elements['import-dialog']) },
    { title: 'change identity', hint: `currently ${state.identity.displayName}`, run: () => {
      const form = elements['identity-form'];
      form.elements.displayName.value = state.identity.displayName;
      form.elements.actorType.value = state.identity.actorType;
      openDialog(elements['identity-dialog']);
    } },
    { title: 'reload sources', hint: 'reindex the current project', run: () => refreshProject() },
  );

  if (state.editor.document) {
    commands.push({ title: 'save document now', hint: state.editor.document.path, run: () => saveDocument() });
  }
  return commands;
}

setIdentity(state.identity);

// ── Shell ───────────────────────────────────────────────────────────────────

const shell = {
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
    status: project.id === state.project?.id ? 'active' : 'available',
  }));
}

function tabsForWorkspace() {
  const tabs = [];
  for (const document_ of state.editor.documents ?? []) {
    tabs.push({ id: `doc:${document_.path}`, title: document_.path.split('/').pop(), glyph: '' });
  }
  return tabs;
}

function refreshShell() {
  shell.sidebar?.set(directoriesFromProjects(), state.project?.id ?? null);
  shell.tabs?.set(tabsForWorkspace(), shell.activeTab);
  const chrome = document.getElementById('window-project-name');
  if (chrome) chrome.textContent = state.project?.name ?? 'colab';
}

/// Return to the structured workspace overview.
function showSession() {
  shell.activeTab = 'session';
  state.editor.document = null;
  setWorkspaceView('session');
  if (!state.project) {
    // Nothing is indexed yet, so there is nothing to operate on.
    elements['detail-column'].innerHTML = renderSession({
      project: null,
      documents: [],
      identity: state.identity,
      warnings: ['no directory granted yet · use + add directory'],
    });
    refreshShell();
    return;
  }
  elements['detail-column'].innerHTML = '<div class="dsh" id="dependency-shell"></div>';
  dependencyShell.setHost(document.getElementById('dependency-shell'));
  dependencyShell.mount();
  dependencyShell.refresh();
  // The prompt is this view's primary surface, so it takes focus with it.
  if (shell.activeTab === 'session') dependencyShell.focus();
  refreshShell();
}

function selectShellTab(id) {
  if (id === 'session') { showSession(); return; }
  if (id.startsWith('doc:')) {
    shell.activeTab = id;
    openDocument(id.slice(4));
  }
}

applyTheme(currentTheme());
shell.sidebar = createDirectorySidebar({
  host: document.getElementById('directory-list'),
  onSelect: (id) => selectProject(id).catch((error) => toast(error.message, 'error')),
});
shell.tabs = createTabBar({
  host: document.getElementById('tab-scroll'),
  onSelect: selectShellTab,
});
createSidebarResize({
  handle: document.getElementById('resize-handle'),
  root: document.documentElement,
});
document.getElementById('sidebar-add').addEventListener('click', () => openDialog(elements['import-dialog']));
const terminalInput = document.getElementById('terminal-input');

// The terminal and the editor are two views of one dependency graph, so the
// shell opens documents through the same path the sidebar does.
const dependencyShell = createDependencyShell({
  input: terminalInput,
  api,
  getProjectId: () => state.project?.id ?? null,
  getActor: () => state.identity,
  build: UI_BUILD,
  onStatus: (message) => toast(message),
  onSession: (session) => {
    const review = session ? (session.changes ?? 0) + (session.stale ?? 0)
      + (session.conflicts ?? 0) + (session.failures ?? 0) : 0;
    const sourceCount = document.getElementById('rail-source-count');
    const changeCount = document.getElementById('rail-change-count');
    const reviewCount = document.getElementById('rail-review-count');
    if (sourceCount) sourceCount.textContent = String(session?.files ?? 0);
    if (changeCount) changeCount.textContent = String(session?.changes ?? 0);
    if (reviewCount) reviewCount.textContent = String(review);
  },
  onOpenDocument: (documentPath, reference) => {
    const target = documentPath ?? reference?.documentPath;
    if (!target) return;
    openDocument(target).then(() => {
      if (reference?.dependencyId) focusDependency(reference.dependencyId);
    }).catch((error) => toast(error.message, 'error'));
  },
});
createSpatialWorkbench({
  projectTrigger: document.getElementById('project-pill'),
  projectPopover: document.getElementById('project-popover'),
  workspaceButton: document.getElementById('workspace-nav'),
  onWorkspace: showSession,
});
document.querySelectorAll('[data-workspace-query]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!state.project) { openDialog(elements['import-dialog']); return; }
    showSession();
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
window.addEventListener('keydown', (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && !event.shiftKey && /^[1-9]$/.test(event.key)) {
    event.preventDefault();
    shell.tabs?.activate(Number(event.key) - 1);
    return;
  }
  // ⌘K, and ⌘⇧P for hosts where the browser claims ⌘K first.
  if (modifier && (event.key.toLowerCase() === 'k' || (event.shiftKey && event.key.toLowerCase() === 'p'))) {
    event.preventDefault();
    commandPalette.toggle();
  }
}, true);

const launchParams = new URLSearchParams(window.location.search);
// The macOS app supplies its own window chrome, so the simulated titlebar is dropped.
if (launchParams.get('app') === '1') document.documentElement.classList.add('native-app');
const sharedDependencyToken = launchParams.get('share');
if (sharedDependencyToken) loadSharedDependency(sharedDependencyToken);
else {
  loadProjects()
    .then(() => {
      if (launchParams.get('view') === 'documents' && state.project) return openManuscriptWorkspace();
      return null;
    })
    .catch((error) => toast(error.message, 'error'));
}
