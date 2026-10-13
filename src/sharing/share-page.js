// Server-rendered pages for externally shared sources. Kept deliberately plain:
// recipients are outside the workspace and only need the provenance and the file.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]
  ));
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(new Date(value));
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --accent:#007aff; --green:#248a3d; --red:#d70015;
    --text:rgba(24,24,27,.96); --text2:rgba(60,60,67,.72); --text3:rgba(60,60,67,.5);
    --line:rgba(60,60,67,.16); --surface:rgba(255,255,255,.78); --paper:#fff; --canvas:#eef0f4;
    font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;
  }
  @media(prefers-color-scheme:dark){:root{--accent:#0a84ff;--green:#32d74b;--red:#ff453a;
    --text:rgba(255,255,255,.92);--text2:rgba(235,235,245,.66);--text3:rgba(235,235,245,.42);
    --line:rgba(255,255,255,.14);--surface:rgba(48,48,53,.72);--paper:#242427;--canvas:#171719}}
  *{box-sizing:border-box} body{margin:0;padding:46px 24px;background:var(--canvas);color:var(--text);
    font:13px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;
    -webkit-font-smoothing:antialiased} main{max-width:720px;margin:0 auto}
  h1{margin:4px 0 0;color:var(--text);font-size:24px;line-height:1.2;letter-spacing:-.025em}
  .kicker{margin:0;color:var(--text3);font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
  .frame{margin-top:20px;padding:20px 22px;border:1px solid var(--line);border-radius:16px;background:var(--paper);
    box-shadow:0 16px 46px rgba(24,28,38,.12),0 2px 8px rgba(24,28,38,.06)}
  dl{display:grid;grid-template-columns:100px minmax(0,1fr);gap:8px 15px;margin:0 0 18px}
  dt{color:var(--text3);font-size:11px}dd{margin:0;color:var(--text);overflow-wrap:anywhere}
  dd.value{color:var(--green);font-size:19px;font-weight:700}
  .actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}
  a.action{display:inline-flex;min-height:32px;align-items:center;padding:0 11px;border:1px solid var(--line);border-radius:8px;
    background:var(--surface);color:var(--accent);font-weight:600;text-decoration:none}
  a.action:hover{background:color-mix(in srgb,var(--accent) 10%,var(--surface))}
  table{width:100%;margin-top:16px;border-collapse:separate;border-spacing:0;overflow:hidden;border:1px solid var(--line);
    border-radius:10px;font-size:11px}th,td{padding:7px 9px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
  th:last-child,td:last-child{border-right:0}tr:last-child td{border-bottom:0}th{color:var(--text3);font-weight:650}
  td.cited{background:color-mix(in srgb,var(--accent) 13%,var(--paper));box-shadow:inset 0 0 0 2px var(--accent);font-weight:700}
  .notice{margin-top:20px;color:var(--text3);font-size:11px}.unavailable{color:var(--red)}
  .privacy-preview{display:flex;flex-wrap:wrap;gap:5px;margin-top:16px;padding:13px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
  .privacy-block{padding:3px 5px;border-radius:5px;background:var(--paper);font-size:11px}.redaction{display:inline-block;min-width:42px;border-radius:4px;background:rgba(120,120,128,.2);color:var(--text3);text-align:center;user-select:none}
  .redaction.blur{filter:blur(1.7px);letter-spacing:2px}.redaction.blank{color:transparent;background:rgba(120,120,128,.12)}
  td.redacted-cell{background:rgba(120,120,128,.1)!important;box-shadow:none!important}
  .full-document{margin-top:16px}.full-document h2{margin:18px 0 7px;font-size:13px}.full-document .document-table{display:block;max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}.full-document .document-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0}.full-document .document-table tr:first-child td{position:sticky;top:0;background:var(--paper);font-weight:650}.full-document .document-text{display:grid;gap:7px}.full-document .document-block{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);line-height:1.5}
  body.inspector{padding:20px;background:transparent}.inspector main{max-width:none}.inspector h1{font-size:17px}
  .inspector .frame{margin-top:14px;padding:15px;border:1px solid var(--line);border-radius:13px;background:color-mix(in srgb,var(--surface) 60%,transparent);box-shadow:none}
  .inspector dl{grid-template-columns:78px minmax(0,1fr);gap:7px 10px}.inspector .notice{margin:14px 2px 4px}
  body.inspector-spatial{padding:0;overflow:hidden;background:transparent}.inspector-spatial main{width:100%;height:100vh;max-width:none}
  .inspector-shell{display:grid;grid-template-rows:52px minmax(0,1fr) 45px;height:100vh;color:var(--text)}
  .inspector-topbar{display:flex;align-items:center;justify-content:space-between;padding:0 10px;border-bottom:1px solid var(--line);-webkit-app-region:drag}
  .inspector-title{display:flex;min-width:0;align-items:center;gap:9px}.inspector-title>span:last-child{display:grid;min-width:0}.inspector-title small{color:var(--text3);font-size:8px}.inspector-title strong{overflow:hidden;margin-top:1px;font-size:10.5px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}
  .source-type{display:grid;width:31px;height:31px;flex:0 0 auto;place-items:center;border-radius:7px;background:#b54843;color:#fff;font-size:7px;font-weight:800}
  .inspector-window-actions{display:flex;gap:3px;-webkit-app-region:no-drag}.inspector-window-actions button{display:grid;width:27px;height:27px;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--text3);font-size:14px}.inspector-window-actions button:hover{background:var(--surface);color:var(--text)}
  .inspector-body{min-height:0;overflow:auto;padding:11px}
  .source-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:1px 1px 10px}.source-summary>span{display:grid;min-width:0}.source-summary strong{font-size:13px;font-weight:650}.source-summary small{margin-top:2px;color:var(--text3);font-size:8.5px}.source-summary b{padding:3px 6px;border-radius:6px;background:var(--surface);color:var(--text3);font-size:7.5px;font-weight:600;white-space:nowrap}
  .inspector-value{display:grid;margin:0 0 10px;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}.inspector-value small{color:var(--text3);font-size:8px}.inspector-value strong{margin-top:1px;color:var(--green);font-size:18px}
  .inspector-details{display:grid!important;grid-template-columns:1fr!important;gap:0!important;margin:0 0 10px!important;padding:6px 10px!important;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--surface) 45%,transparent)}.inspector-details>div{display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;padding:4px 0}.inspector-details dt{font-size:8px}.inspector-details dd{font-size:8.5px;overflow-wrap:anywhere}
  .inspector-preview{margin:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--surface) 45%,transparent)}.preview-heading{display:flex;justify-content:space-between;padding:8px 9px;border-bottom:1px solid var(--line)}.preview-heading span{font-size:9px;font-weight:650}.preview-heading small{color:var(--text3);font-size:7.5px}.preview-scroll{max-height:190px;overflow:auto}.inspector-preview table{margin:0;border:0;border-radius:0;font-size:8.5px}.inspector-preview th,.inspector-preview td{padding:6px 7px}.text-preview p{margin:0;padding:10px;color:var(--text2);font-size:8.5px;line-height:1.45}
  .inspector-toolbar{display:flex;align-items:center;gap:4px;padding:0 8px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 50%,transparent)}.inspector-toolbar button{display:flex;height:27px;align-items:center;gap:5px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--text2);font-size:8.5px}.inspector-toolbar button:hover{background:var(--surface);color:var(--text)}.inspector-toolbar button.destructive:hover{color:var(--red)}.inspector-toolbar button span{font-size:11px}
`;

function page(title, body, bodyClass = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body class="${escapeHtml(bodyClass)}"><main>${body}</main></body></html>`;
}

/// Distinct wording per state, with no hint that other tokens exist.
export function renderUnavailable(status) {
  const message = {
    REVOKED: 'This dependency link has been revoked.',
    EXPIRED: 'This dependency link has expired.',
    SOURCE_MISSING: 'The source for this dependency is no longer available.',
    SCOPE_RESTRICTED: 'This link does not permit downloading the original document.',
  }[status] ?? 'This dependency link is invalid or no longer available.';
  return page('Dependency unavailable',
    `<h1>Lasso</h1><p class="unavailable">${escapeHtml(message)}</p>`);
}

function shareScopeName(scope) {
  return {
    DOCUMENT: 'Entire document',
    INDEXED: 'Indexed part only',
    REDACTED: 'Complete document with redactions',
  }[scope] ?? 'Indexed part only';
}

function previewTextBlocks(value) {
  const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
  const blocks = [];
  for (let index = 0; index < words.length; index += 7) {
    blocks.push(words.slice(index, index + 7).join(' '));
  }
  return blocks;
}

function findRedaction(redactions, kind, coordinates) {
  return redactions.find((entry) => entry.kind === kind
    && Object.entries(coordinates).every(([key, value]) => (
      key === 'sheet' ? (entry[key] ?? 0) === value : entry[key] === value
    )));
}

function maskedValue(value, redaction) {
  if (!redaction) return escapeHtml(value);
  const effect = redaction.effect === 'BLANK' ? 'blank' : 'blur';
  const placeholder = effect === 'blank' ? '&nbsp;' : '••••••';
  return `<span class="redaction ${effect}" aria-label="Redacted">${placeholder}</span>`;
}

function renderFullDocument(document, redactions) {
  if (document?.kind === 'table' && document.sheets?.length) {
    return `<div class="full-document">${document.sheets.map((sheet, sheetIndex) => (
      `<section><h2>${escapeHtml(sheet.name || `Sheet ${sheetIndex + 1}`)}</h2>
       <div class="document-table"><table><tbody>${sheet.rows.map((row, rowIndex) => (
         `<tr>${row.map((cell, column) => {
           const mask = findRedaction(redactions, 'CELL', { sheet: sheetIndex, row: rowIndex, column });
           return `<td class="${mask ? 'redacted-cell' : ''}">${maskedValue(cell, mask)}</td>`;
         }).join('')}</tr>`)).join('')}</tbody></table></div></section>`
    )).join('')}</div>`;
  }
  if (document?.kind === 'text' && document.blocks?.length) {
    return `<div class="full-document document-text">${document.blocks.map((block, index) => {
      const mask = findRedaction(redactions, 'BLOCK', { block: index });
      return `<div class="document-block">${maskedValue(block, mask)}</div>`;
    }).join('')}</div>`;
  }
  return '<div class="privacy-preview">A complete preview could not be rendered for this file type.</div>';
}

export function renderSharePage(resolved, token, preview, document = null) {
  const { source, share } = resolved;
  const scope = share.accessScope ?? 'DOCUMENT';
  const redacted = scope === 'REDACTED';
  const redactions = redacted ? (share.redactions ?? []) : [];
  // Indexed labels can repeat a masked row key or document heading.
  const title = redacted ? source.filename : source.label;
  const spreadsheet = ['DATASET_ROW', 'DATASET_CELL', 'TABLE_CELL', 'DATASET_COLUMN'].includes(source.objectType)
    || /\.(xlsx?|csv|tsv)$/i.test(source.filename);

  const rows = [];
  if (!redacted && source.valueText) {
    rows.push(['Value', `<dd class="value">${escapeHtml(source.valueText)}</dd>`]);
  }
  if (spreadsheet) {
    rows.push(['Workbook', `<dd>${escapeHtml(source.filename)}</dd>`]);
    const sheet = source.anchor?.sheet ?? source.metadata?.sheet;
    if (sheet && !redacted) rows.push(['Sheet', `<dd>${escapeHtml(sheet)}</dd>`]);
    if (!redacted) rows.push(['Cell', `<dd>${escapeHtml(source.location)}</dd>`]);
  } else {
    rows.push(['Source', `<dd>${escapeHtml(source.filename)}</dd>`]);
    if (!redacted) rows.push(['Location', `<dd>${escapeHtml(source.location)}</dd>`]);
  }
  if (!redacted) rows.push(['Context', `<dd>${escapeHtml(source.context)}</dd>`]);
  rows.push(['Access', `<dd>${escapeHtml(shareScopeName(scope))}</dd>`]);
  rows.push(['Version', `<dd>Version ${escapeHtml(source.snapshotVersion)}</dd>`]);
  rows.push(['Shared', `<dd>${escapeHtml(formatDate(share.createdAt))}</dd>`]);

  const table = !redacted && preview?.headers?.length
    ? `<table><thead><tr>${preview.headers.map((header, i) => `<th>${escapeHtml(header || `Column ${preview.columns?.[i] ?? i + 1}`)}</th>`).join('')}</tr></thead>
       <tbody>${preview.rows.map((row) => `<tr>${row.cells.map((cell) => (
         `<td class="${cell.cited ? 'cited' : ''}">${escapeHtml(cell.value)}</td>`)).join('')}</tr>`).join('')}</tbody></table>`
    : '';
  const documentPreview = redacted ? renderFullDocument(document, redactions) : '';

  const download = scope === 'DOCUMENT'
    ? `<div class="actions"><a class="action" href="/d/${encodeURIComponent(token)}/download">Download original</a></div>`
    : '';
  const notice = scope === 'DOCUMENT'
    ? 'This link contains the pinned original document.'
    : scope === 'INDEXED'
      ? 'This link exposes only the indexed source context. The original document cannot be downloaded.'
      : 'This link contains the complete document view with the marked areas removed. The original cannot be downloaded.';

  return page(`${title} · Lasso`, `
    <p class="kicker">Shared source</p>
    <h1>${escapeHtml(title)}</h1>
    <div class="frame">
      <dl>${rows.map(([term, definition]) => `<dt>${escapeHtml(term)}</dt>${definition}`).join('')}</dl>
      ${table}
      ${documentPreview}
      ${download}
    </div>
    <p class="notice">${escapeHtml(notice)} It stays at Version ${escapeHtml(source.snapshotVersion)},
    even if the workspace source changes later.</p>
  `);
}

/**
 * The local source inspector: the same provenance the share page shows, sized
 * for a small panel beside the highlighted words. Local only — never published.
 */
export function renderInspectorPanel(resolved, reference, preview) {
  const { source } = resolved;
  const sourceType = source.filename.split('.').pop()?.toUpperCase().slice(0, 4) || 'SRC';
  const table = preview?.headers?.length
    ? `<div class="inspector-preview"><div class="preview-heading"><span>Evidence preview</span><small>Exact cited context</small></div>
       <div class="preview-scroll"><table><thead><tr>${preview.headers.map((header, i) => `<th>${escapeHtml(header || `Column ${preview.columns?.[i] ?? i + 1}`)}</th>`).join('')}</tr></thead>
       <tbody>${preview.rows.map((row) => `<tr>${row.cells.map((cell) => (
         `<td class="${cell.cited ? 'cited' : ''}">${escapeHtml(cell.value)}</td>`)).join('')}</tr>`).join('')}</tbody></table></div></div>`
    : `<div class="inspector-preview text-preview"><div class="preview-heading"><span>Evidence preview</span><small>Indexed source context</small></div>
       <p>${escapeHtml(source.context || source.location)}</p></div>`;

  return page(`${source.label} · source`, `
    <section class="inspector-shell">
      <header class="inspector-topbar">
        <div class="inspector-title"><span class="source-type">${escapeHtml(sourceType)}</span><span><small>Source Inspector</small><strong>${escapeHtml(source.filename)}</strong></span></div>
        <div class="inspector-window-actions"><button data-action="open" aria-label="Open source">↗</button><button data-action="close" aria-label="Close">×</button></div>
      </header>

      <div class="inspector-body">
        <div class="source-summary"><span><strong>${escapeHtml(source.label)}</strong><small>${escapeHtml(source.location)}</small></span><b>Version ${escapeHtml(source.snapshotVersion)}</b></div>
        ${source.valueText ? `<div class="inspector-value"><small>Cited value</small><strong>${escapeHtml(source.valueText)}</strong></div>` : ''}
        <dl class="inspector-details">
          <div><dt>Source</dt><dd>${escapeHtml(source.filename)}</dd></div>
          <div><dt>Location</dt><dd>${escapeHtml(source.location)}</dd></div>
          <div><dt>Context</dt><dd>${escapeHtml(source.context)}</dd></div>
        </dl>
        ${table}
      </div>

      <footer class="inspector-toolbar">
        <button data-action="open"><span>↗</span>Open source</button>
        <button data-action="share"><span>⌁</span>Share…</button>
        <button data-action="unlink" class="destructive"><span>×</span>Unlink</button>
      </footer>
    </section>
    <script>
      document.addEventListener('click', (event) => {
        const action = event.target.closest('[data-action]');
        if (!action) return;
        event.preventDefault();
        window.webkit?.messageHandlers?.inspector?.postMessage({
          action: action.dataset.action,
          referenceId: ${JSON.stringify(reference ?? null)},
        });
      });
    </script>
  `, 'inspector inspector-spatial');
}
