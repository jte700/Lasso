// Opening a document and drawing it into the editor.
import { shortcut, state, elements } from './state.js?v=1';
import { escapeHtml, toast } from './utilities.js?v=1';
import { api } from './api.js?v=1';
import { syncOfflineEditor } from './workspace-projects.js?v=1';
import { setWorkspaceView, shell, refreshShell } from './workspace-shell.js?v=1';
import {
  focusEditorBlock, bindEditorSurface, editorHistorySnapshot, markEditorDirty, focusDocumentEnd,
  handleEditorShortcuts, formatActiveBlock, runEditorCommand,
} from './editor-surface.js?v=1';
import { clearPrediction, endSourceContext } from './editor-predictions.js?v=1';
import { saveDocument } from './editor-save.js?v=1';
import { bindLinkedClaimNode } from './linked-claims.js?v=1';
import { openManualPickerFromSelection, hideDependencyPicker } from './dependency-picker.js?v=1';
import { focusDependency, openActiveDependencySharing } from './dependency-inspector.js?v=1';

export function resetEditorProjectState() {
  state.editor.navigationRevision += 1;
  hideDependencyPicker();
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

export async function openManuscriptWorkspace(preferredPath = null, options = {}) {
  const projectId = options.projectId ?? state.project?.id;
  if (!projectId || state.project?.id !== projectId) return;
  const navigationRevision = ++state.editor.navigationRevision;
  setWorkspaceView('editor');
  const column = document.querySelector('.files-column');
  if (column) column.innerHTML = '<div class="column-header"><div><span class="eyebrow">Project files</span><h2>Documents</h2></div><span class="editor-live-pill">Sources</span></div><div class="manuscript-browser" id="manuscript-browser"><p class="browser-loading">Finding editable documents…</p></div>';
  try {
    const { documents } = await api(`/api/projects/${projectId}/documents`);
    if (state.project?.id !== projectId || navigationRevision !== state.editor.navigationRevision
      || (options.switchRevision != null && options.switchRevision !== state.projectSwitchRevision)) return;
    state.editor.documents = documents;
    renderManuscriptBrowser();
    const currentPath = state.editor.document?.projectId === projectId ? state.editor.document.path : null;
    const target = preferredPath ?? currentPath ?? documents[0]?.path;
    if (target) await openDocument(target, projectId);
    else elements['detail-column'].innerHTML = '<div class="detail-placeholder"><h2>No editable document found</h2><p>Add a document to the selected project, then checkpoint the project.</p></div>';
  } catch (error) {
    if (state.project?.id !== projectId || navigationRevision !== state.editor.navigationRevision) return;
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

export async function openDocument(filePath, requestedProjectId = state.project?.id) {
  if (!requestedProjectId || state.project?.id !== requestedProjectId) return;
  const navigationRevision = ++state.editor.navigationRevision;
  const isCurrent = () => navigationRevision === state.editor.navigationRevision && state.project?.id === requestedProjectId;
  if (state.editor.document && (state.editor.dirty || state.editor.pendingLinks.length || state.editor.savePromise)) {
    await saveDocument();
    if (!isCurrent()) return;
    if (state.editor.dirty || state.editor.pendingLinks.length) {
      toast('Finish saving the current document before opening another document.', 'error');
      return;
    }
  }
  shell.activeTab = `doc:${filePath}`;
  setWorkspaceView('editor');
  refreshShell();
  hideDependencyPicker();
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
    if (!isCurrent()) return;
    const refreshedProject = (await api(`/api/projects/${requestedProjectId}`)).project;
    if (!isCurrent()) return;
    state.editor.document = { ...prepareDocumentForEditor(document), projectId: requestedProjectId };
    state.editor.documents = state.editor.documents.map((item) => item.path === document.path
      ? { ...item, ...document.audit.summary }
      : item);
    state.editor.dirty = false;
    state.project = refreshedProject;
    renderManuscriptBrowser();
    renderDocumentEditor();
  } catch (error) {
    if (!isCurrent()) return;
    toast(error.message, 'error');
    // Never leave the "Opening…" placeholder behind: return to the document
    // that was open, or say why nothing could be opened.
    if (state.editor.document) {
      shell.activeTab = `doc:${state.editor.document.path}`;
      refreshShell();
      renderDocumentEditor();
    } else {
      elements['detail-column'].innerHTML = `<div class="detail-placeholder"><p>${escapeHtml(error.message)}</p></div>`;
    }
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
    ? `<div class="edit-layer-note"><strong>${escapeHtml(fileLabel)} original preserved</strong><span>You are editing a versioned Lasso text layer. The source file is never overwritten.</span></div>` : '';
  const documentOptions = state.editor.documents.map((document) => `<option value="${escapeHtml(document.path)}" ${document.path === documentState.path ? 'selected' : ''}>${escapeHtml(document.path.split('/').pop())}</option>`).join('');
  elements['detail-column'].innerHTML = `<div class="document-editor-view">
    <header class="editor-header">
      <div class="editor-title-group">
        <div class="editor-history-buttons"><button data-editor-command="undo" title="Undo">↶</button><button data-editor-command="redo" title="Redo">↷</button></div>
        <div class="editor-document-title"><select id="editor-document-switcher" aria-label="Current document">${documentOptions}</select><small>Version ${documentState.version} · ${escapeHtml(fileLabel)}</small></div>
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
    <div class="t-editor-status" aria-hidden="true"><span><kbd>${shortcut('Z')}</kbd> Undo</span><span><kbd>${shortcut('L', true)}</kbd> Link source</span><span><kbd>Tab</kbd> Accept suggestion</span><span><kbd>Esc</kbd> Dismiss</span></div>
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
  syncOfflineEditor();
}

export function renderEditableBlock(block, blockIndex, dependencies) {
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

export function renderBlockDependencyContent(blockText, blockIndex, dependencies) {
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

export function settleAcceptedDependencyReveal() {
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
