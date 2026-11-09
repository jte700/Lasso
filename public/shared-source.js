// The page a recipient sees when they open a shared source link.
import { escapeHtml, formatDateTime } from './utilities.js?v=1';
import { api } from './api.js?v=1';

function renderSharedTable(content) {
  const headers = content.headers ?? [];
  const rows = content.rows ?? [];
  return `<div class="shared-table-wrap"><table class="shared-table"><thead><tr>${headers.map((header, columnIndex) => `<th class="${columnIndex === content.selectedColumn ? 'cited-column' : ''}">${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr class="${rowIndex === content.selectedRow ? 'cited-row' : ''}">${row.map((cell, columnIndex) => `<td class="${rowIndex === content.selectedRow && columnIndex === content.selectedColumn ? 'cited-cell' : ''}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// A recipient sees only the shared source, never the owner's workspace.
function sharedViewRoot() {
  let root = document.querySelector('.shared-dependency-page');
  if (!root) {
    root = document.createElement('div');
    root.className = 'shared-dependency-page';
    document.body.replaceChildren(root);
  }
  return root;
}

function renderSharedDependency(shared) {
  const shell = sharedViewRoot();
  const contextOnly = shared.access.scope === 'CONTEXT';
  const content = ['table', 'table-context'].includes(shared.content.kind)
    ? renderSharedTable(shared.content)
    : `<div class="shared-text"><p>${escapeHtml(shared.content.text)}</p></div>`;
  shell.innerHTML = `<header class="shared-topbar"><a class="brand" href="/"><span class="brand-mark">L</span><span>Lasso</span></a><span class="shared-access-badge">${contextOnly ? 'Cited context' : 'Full source'} access</span></header>
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

export async function loadSharedDependency(token) {
  try {
    const { shared } = await api(`/api/shared-dependencies/${encodeURIComponent(token)}`);
    renderSharedDependency(shared);
  } catch (error) {
    const shell = sharedViewRoot();
    shell.innerHTML = `<main class="shared-source-view"><section class="shared-source-card shared-unavailable"><span class="brand-mark">L</span><h1>Source link unavailable</h1><p>${escapeHtml(error.message)}</p><a href="/">Return to Lasso</a></section></main>`;
  }
}
