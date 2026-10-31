// The Source Inspector beside the editor, and the actions it offers on a linked source.
import { state } from './state.js?v=1';
import { escapeHtml, reportError, toast, formatDateTime } from './utilities.js?v=1';
import { api, recordRecommendationUsage } from './api.js?v=1';
import { showPreview } from './snapshot-preview.js?v=1';
import { updateEditorVersion } from './editor-save.js?v=1';
import {
  spreadsheetColumnLabel, dependencySourceForDisplay, dependencySourcePresentation,
  dependencyDisplayValue,
} from './linked-claims.js?v=1';
import { showDependencyPicker } from './dependency-picker.js?v=1';
import { openDependencySourceViewer, loadDependencySourcePreview } from './source-viewer.js?v=1';
import { openDependencySharing } from './dependency-sharing.js?v=1';

function formatObjectLocation(object) {
  if (!object?.path) return '';
  const start = object.anchor?.lineStart ?? object.anchor?.line ?? object.metadata?.lineStart;
  const end = object.anchor?.lineEnd ?? object.metadata?.lineEnd;
  return `${object.relation ? `${object.relation.replaceAll('_', ' ').toLowerCase()} · ` : ''}${object.path}${start ? `:${start}${end && end !== start ? `-${end}` : ''}` : ''}`;
}

export async function showDependencyInspector(dependencyId, sourceNode = null) {
  const request = ++state.editor.inspectorRequest;
  const documentAtStart = state.editor.document;
  const inspector = document.getElementById('dependency-inspector');
  if (!inspector) return;
  const usageContext = { projectId: state.project?.id, documentPath: state.editor.document?.path };
  const { dependency } = await api(`/api/dependencies/${dependencyId}`);
  if (request !== state.editor.inspectorRequest || state.editor.document !== documentAtStart || !inspector.isConnected) return;
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
      <header><span><strong>Cited source preview</strong><small>Exact evidence and nearby context</small></span><button id="open-dependency-source" type="button">Open file</button></header>
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

  recordRecommendationUsage({ dependencyId }, 'open', usageContext);

  inspector.querySelector('.native-source-inspector')?.focus({ preventScroll: true });
  inspector.onkeydown = (event) => {
    if (event.key === 'Escape') { document.getElementById('close-inspector')?.click(); return; }
    // Only bare letters are actions; ⌘C and ⌘X still copy and cut.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const match = actions.find((action) => action.key === event.key.toLowerCase());
    if (match) { event.preventDefault(); document.getElementById(match.id)?.click(); }
  };

  bindDraggableInspector(inspector);
  const close = () => {
    state.editor.inspectorRequest += 1;
    inspector.hidden = true;
    state.editor.activeDependencyId = null;
  };
  document.getElementById('close-inspector')?.addEventListener('click', close);
  inspector.querySelector('.inspector-drag')?.addEventListener('dblclick', close);
  document.getElementById('dependency-rfi')?.addEventListener('click', () => requestDependencyRfi(dependency).catch(reportError));
  document.getElementById('open-dependency-source')?.addEventListener('click', () => openDependencySourceViewer(dependency));
  document.getElementById('share-dependency')?.addEventListener('click', async () => {
    await openDependencySharing(dependency, true);
    document.getElementById('dependency-sharing')?.scrollIntoView({ block: 'nearest' });
  });
  document.getElementById('open-dependency-origin')?.addEventListener('click', () => showPreview(origin.snapshotId, origin.path, origin.anchor));
  document.getElementById('change-dependency')?.addEventListener('click', () => showDependencyPicker({ ...dependency.anchor, text: dependency.spanText }, 'change', dependency));
  document.getElementById('remove-dependency')?.addEventListener('click', () => reviseDependency(dependency, { action: 'REMOVE' }).catch(reportError));
  document.getElementById('keep-historical')?.addEventListener('click', () => reviseDependency(dependency, { action: 'KEEP_HISTORICAL' }).catch(reportError));
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

export function focusDependency(dependencyId) {
  const node = document.querySelector(`[data-dependency-id="${dependencyId}"]`);
  node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (node) showDependencyInspector(dependencyId, node).catch(reportError);
}

export async function openActiveDependencySharing() {
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
