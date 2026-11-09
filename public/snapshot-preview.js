// The preview of one indexed file at the version a source came from.
import { renderModelPlan, bindModelPlans } from './model-preview.js?v=3';
import { state, elements } from './state.js?v=1';
import { escapeHtml, toast } from './utilities.js?v=1';
import { api, recordRecommendationUsage } from './api.js?v=1';

export async function showPreview(snapshotId, path, focusAnchor = null, source = null, context = null) {
  const usageContext = context ?? { projectId: state.project?.id, documentPath: state.editor.document?.path };
  const requestedProjectId = state.project?.id;
  const navigationRevision = ++state.editor.navigationRevision;
  const isCurrent = () => requestedProjectId === state.project?.id && navigationRevision === state.editor.navigationRevision;
  try {
    const parameters = new URLSearchParams({ path });
    if (focusAnchor?.elementId) parameters.set('elementId', focusAnchor.elementId);
    if (focusAnchor?.featureId) parameters.set('featureId', focusAnchor.featureId);
    const { preview } = await api(`/api/snapshots/${snapshotId}/preview?${parameters}`);
    if (!isCurrent()) return;
    state.preview = { ...preview, projectId: source?.projectId ?? usageContext.projectId };
    state.selection = null;
    renderPreview(preview, focusAnchor);
    recordRecommendationUsage(source?.id ? { objectId: source.id, projectId: source.projectId } : { path, projectId: source?.projectId }, 'open', usageContext);
  } catch (error) { if (isCurrent()) toast(error.message, 'error'); }
}

function renderPreview(preview, focusAnchor = null) {
  elements['detail-column'].innerHTML = `<div class="preview-view">
    <header class="preview-header">
      <div class="preview-title"><strong>${escapeHtml(preview.path)}</strong><span>Version ${preview.version} · ${escapeHtml(preview.fileType)}</span></div>
      <div class="preview-actions"><button class="primary-button" id="request-info" disabled>Request information</button></div>
    </header>
    <div class="preview-body"><p class="selection-hint">${preview.kind === 'model-plan' ? (preview.selected ? 'The indexed element is highlighted in the preserved model. Drag to pan, or show its surrounding context.' : 'Plan overview of the preserved model. Drag to pan or use the zoom controls.') : preview.kind === 'pdf' ? `Read the preserved PDF below, or expand its text to select evidence from Version ${preview.version}.` : `Select a sentence, line, cell, or value below. The selection is anchored to Version ${preview.version}.`}</p>${previewContent(preview, focusAnchor)}<div id="rfi-result"></div></div>
  </div>`;
  elements['detail-column'].scrollTop = 0;
  document.getElementById('request-info').addEventListener('click', requestInformation);
  bindSelections();
  bindModelPlans(elements['detail-column']);
  if (focusAnchor && preview.kind !== 'pdf') focusPreviewAnchor(focusAnchor);
}

function focusPreviewAnchor(anchor) {
  const candidates = [...document.querySelectorAll('.selectable[data-anchor]')];
  const node = candidates.find((candidate) => {
    const item = JSON.parse(candidate.dataset.anchor);
    return item.kind === anchor.kind
      && (anchor.identifier == null || item.identifier === anchor.identifier)
      && (anchor.elementId == null || item.elementId === anchor.elementId)
      && (anchor.propertyName == null || item.propertyName === anchor.propertyName)
      && (anchor.pageNumber == null || item.pageNumber === anchor.pageNumber)
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

/** Large files preview their start only; say so rather than look complete. */
function previewLimitNote(shown, total, unit) {
  if (!total || total <= shown) return '';
  return `<p class="source-viewer-truncated">Showing the first ${shown.toLocaleString()} of ${total.toLocaleString()} ${unit}. Open the file to see the rest.</p>`;
}

function previewContent(preview, focusAnchor = null) {
  if (preview.kind === 'model-plan') return renderModelPlan(preview);
  if (preview.kind === 'model-unavailable') return `<p class="selection-hint">${escapeHtml(preview.reason ?? 'No displayable geometry was found for this indexed element.')}</p>`;
  if (preview.kind === 'pdf') {
    const page = Math.max(1, Math.floor(Number(focusAnchor?.pageNumber ?? focusAnchor?.page ?? preview.pageNumber) || 1));
    const pages = (preview.pages ?? []).filter(item => item.text?.trim());
    return `<iframe class="source-viewer-pdf snapshot-pdf" src="${escapeHtml(`${preview.fileUrl}#page=${page}&zoom=page-width`)}" title="${escapeHtml(preview.path)}"></iframe>${(preview.warnings ?? []).map(warning => `<p class="selection-hint">${escapeHtml(warning)}</p>`).join('')}${pages.length ? `<details class="pdf-source-text"><summary>Selectable PDF text</summary>${pages.map(item => `<div class="notebook-cell"><div class="cell-label">Page ${escapeHtml(item.pageNumber)}</div><div class="cell-source selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.text)}</div></div>`).join('')}</details>` : ''}`;
  }
  if (preview.kind === 'drawing') return `${(preview.warnings ?? []).map(warning => `<p class="selection-hint">${escapeHtml(warning)}</p>`).join('')}<div class="json-preview">${preview.items.map(item => `<span class="json-path" title="${escapeHtml(item.location)}">${escapeHtml(item.path)}<small> · ${item.basis === 'geometry' ? 'Measured geometry' : 'Model property'}</small></span><span class="json-value selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.value)}</span>`).join('')}</div>`;
  if (preview.kind === 'blocks') return preview.items.map((item) => `<div class="preview-block ${item.blockType} selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.text)}</div>`).join('');
  if (preview.kind === 'lines') return `<div class="code-preview">${preview.items.map((item) => `<div class="code-line"><span class="number">${item.label}</span><span class="selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.text) || ' '}</span></div>`).join('')}</div>${previewLimitNote(preview.items.length, preview.totalItems, 'lines')}`;
  if (preview.kind === 'table') return `<div style="overflow:auto"><table class="data-preview"><thead><tr>${preview.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${preview.rows.map((row) => `<tr>${row.cells.map((cell) => `<td class="selectable" data-anchor='${escapeHtml(JSON.stringify(cell.anchor))}'>${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${previewLimitNote(preview.rows.length, preview.totalRows, 'rows')}`;
  if (preview.kind === 'json') return `<div class="json-preview">${preview.items.map((item) => `<span class="json-path">${escapeHtml(item.path)}</span><span class="json-value selectable" data-anchor='${escapeHtml(JSON.stringify(item.anchor))}'>${escapeHtml(item.value)}</span>`).join('')}</div>${previewLimitNote(preview.items.length, preview.totalItems, 'values')}`;
  if (preview.kind === 'notebook') return preview.cells.map((cell) => `<div class="notebook-cell"><div class="cell-label">${escapeHtml(cell.type)} · ${escapeHtml(cell.id)}</div><div class="cell-source selectable" data-anchor='${escapeHtml(JSON.stringify(cell.anchor))}'>${escapeHtml(cell.source)}</div></div>`).join('');
  return `<div class="binary-preview"><p>${escapeHtml(preview.message)}</p><span>${preview.size.toLocaleString()} bytes</span><span class="binary-hash">SHA-256 ${preview.contentHash}</span></div>`;
}

function bindSelections() {
  document.querySelectorAll('.selectable[data-anchor]').forEach(node => {
    node.addEventListener('click', () => {
      document.querySelectorAll('.selected-anchor').forEach(selected => selected.classList.remove('selected-anchor'));
      node.classList.add('selected-anchor');
      state.selection = JSON.parse(node.dataset.anchor);
      document.getElementById('request-info').disabled = false;
    });
  });
}

async function requestInformation() {
  const preview = state.preview;
  const anchor = state.selection;
  if (!preview || !anchor) return;
  const target = document.getElementById('rfi-result');
  try {
    const { rfi } = await api(`/api/projects/${encodeURIComponent(preview.projectId)}/rfi`, {
      method: 'POST', body: JSON.stringify({ snapshotId: preview.snapshotId, path: preview.path, anchor }),
    });
    if (!target.isConnected || state.preview !== preview) return;
    target.innerHTML = `<section class="source-lineage"><h3>Recorded source history</h3><p>${escapeHtml(rfi.message ?? 'The source has recorded provenance.')}</p>${rfi.history.map(item => `<p>Version ${item.version} · ${escapeHtml(String(item.value))}</p>`).join('')}${rfi.provenance.map(link => `<p>${escapeHtml(link.relation)} · ${escapeHtml(link.to.path ?? link.metadata?.label ?? 'Recorded source')}</p>`).join('')}</section>`;
  } catch (error) { toast(error.message, 'error'); }
}
