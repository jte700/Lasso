// The full-size viewer for the file behind a linked source, and the cited preview in the inspector.
import { renderModelPlan, bindModelPlans } from './model-preview.js?v=3';
import { state } from './state.js?v=1';
import { escapeHtml } from './utilities.js?v=1';
import { api, recordRecommendationUsage } from './api.js?v=1';

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
    state.editor.viewerRequest += 1;
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
  // A large table arrives as the rows around the cited one, starting at `firstRow`.
  const firstRow = viewer.firstRow ?? 0;
  const rows = viewer.rows.map((row, rowIndex) => `<tr class="${rowIndex === viewer.selectedRow ? 'indexed-row' : ''}"><th class="source-viewer-row-number">${firstRow + rowIndex + 1}</th>${row.map((value, columnIndex) => `<td ${rowIndex === viewer.selectedRow && (columnIndex === viewer.selectedColumn || (viewer.selectedColumn < 0 && columnIndex === 0)) ? 'id="source-viewer-cited-location"' : ''} class="${rowIndex === viewer.selectedRow && columnIndex === viewer.selectedColumn ? 'indexed-cell' : ''}">${escapeHtml(value)}</td>`).join('')}</tr>`).join('');
  return `${sheets}<div class="source-viewer-table-scroll"><table class="source-viewer-table">${header}<tbody>${rows}</tbody></table></div>${viewer.truncated ? `<p class="source-viewer-truncated">${firstRow
    ? `Showing rows ${(firstRow + 1).toLocaleString()} to ${(firstRow + viewer.rows.length).toLocaleString()} of ${viewer.totalRows.toLocaleString()}.`
    : `Showing the first ${viewer.rows.length.toLocaleString()} of ${viewer.totalRows.toLocaleString()} indexed rows.`}</p>` : ''}`;
}

function renderDependencySourceViewer(dialog, viewer) {
  const target = dialog.querySelector('#dependency-source-viewer-content');
  const page = Math.max(1, Number(viewer.pageNumber) || 1);
  const content = viewer.kind === 'model-plan' ? renderModelPlan(viewer)
    : viewer.kind === 'model-unavailable' ? `<div class="source-viewer-unavailable"><strong>Model geometry unavailable</strong><p>${escapeHtml(viewer.reason ?? 'No displayable geometry was found for this indexed element.')}</p></div>`
    : viewer.kind === 'pdf'
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
  bindModelPlans(target);
  target.querySelectorAll('[data-source-viewer-sheet]').forEach((button) => button.addEventListener('click', () => {
    openDependencySourceViewer(viewer.dependencyId, button.dataset.sourceViewerSheet);
  }));
  requestAnimationFrame(() => target.querySelector('#source-viewer-cited-location')?.scrollIntoView({ block: 'center', inline: 'center' }));
}

export async function openDependencySourceViewer(dependencyOrId, sheet = null) {
  const request = ++state.editor.viewerRequest;
  const dependencyId = typeof dependencyOrId === 'string' ? dependencyOrId : dependencyOrId.id;
  const usageContext = { projectId: state.project?.id, documentPath: state.editor.document?.path };
  const dialog = ensureDependencySourceViewer();
  const isCurrent = () => request === state.editor.viewerRequest && dialog.open && usageContext.projectId === state.project?.id;
  const target = dialog.querySelector('#dependency-source-viewer-content');
  target.innerHTML = '<div class="source-viewer-loading"><span></span><strong>Opening indexed source…</strong></div>';
  if (!dialog.open) dialog.showModal();
  try {
    const query = sheet ? `?sheet=${encodeURIComponent(sheet)}` : '';
    const { viewer } = await api(`/api/dependencies/${encodeURIComponent(dependencyId)}/viewer${query}`);
    if (!isCurrent()) return;
    renderDependencySourceViewer(dialog, viewer);
    if (!sheet) recordRecommendationUsage({ dependencyId }, 'open', usageContext);
  } catch (error) {
    if (!isCurrent()) return;
    target.innerHTML = `<div class="source-viewer-unavailable"><strong>Source viewer unavailable</strong><p>${escapeHtml(error.message)}</p><button id="close-dependency-source-viewer">Close</button></div>`;
    document.getElementById('close-dependency-source-viewer').addEventListener('click', () => dialog.close());
  }
}

export async function loadDependencySourcePreview(dependency) {
  const target = document.getElementById('dependency-source-preview');
  if (!target) return;
  try {
    const { preview } = await api(`/api/dependencies/${dependency.id}/preview?contextRadius=1`);
    if (!target.isConnected) return;
    target.innerHTML = renderCitedSourcePreview(preview);
    bindModelPlans(target);
    target.addEventListener('click', event => {
      if (event.target.closest('[data-model-plan]')) return;
      openDependencySourceViewer(dependency);
    });
  } catch (error) {
    target.innerHTML = `<div class="inspector-preview-error">${escapeHtml(error.message)}</div>`;
  }
}

function renderCitedSourcePreview(preview) {
  const content = preview.content ?? {};
  if (content.kind === 'model-plan') return `${renderModelPlan(content)}<button class="preview-open-affordance" type="button">Open model context <span>↗</span></button>`;
  if (content.kind === 'model-unavailable') return `<div class="inspector-preview-empty">${escapeHtml(content.reason ?? 'No displayable geometry was found for this indexed element.')}</div><button class="preview-open-affordance" type="button">Open source context <span>↗</span></button>`;
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
