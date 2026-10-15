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
  .privacy-block{padding:3px 5px;border-radius:5px;background:var(--paper);font-size:11px}
  .redaction{display:inline-flex;width:80px;max-width:100%;height:1.1em;vertical-align:middle;border-radius:2px;user-select:none}
  .redaction.blank{background:#000}
  .redaction.blur{align-items:center;gap:4px;filter:blur(3px);color:var(--text);opacity:.85}
  .redaction.blur>span{display:block;flex:0 0 13px;height:.75em;background:currentColor;border-radius:1px}
  .redaction.blur>span:nth-child(2){flex-basis:21px;height:.9em}.redaction.blur>span:nth-child(3){flex-basis:8px}.redaction.blur>span:nth-child(4){flex-basis:18px;height:.85em}
  td.redacted-cell{background:rgba(120,120,128,.1)!important;box-shadow:none!important}
  .full-document{margin-top:16px}.full-document h2{margin:18px 0 7px;font-size:13px}.full-document .document-table{display:block;max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:10px}.full-document .document-table table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0}.full-document .document-table tr:first-child td{position:sticky;top:0;background:var(--paper);font-weight:650}.full-document .document-text{display:grid;gap:7px}.full-document .document-block{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);line-height:1.5}
  body.inspector-spatial{padding:0;overflow:hidden;background:transparent}.inspector-spatial main{width:100%;height:100vh;max-width:none}
  .inspector-shell{--accent-ink:color-mix(in srgb,var(--accent) 65%,#000);display:grid;grid-template-rows:minmax(0,1fr) 42px;height:100vh;color:var(--text);font-size:12px}
  @media(prefers-color-scheme:dark){.inspector-shell{--accent-ink:color-mix(in srgb,var(--accent) 82%,#fff)}}
  .inspector-body{display:flex;min-height:0;flex-direction:column;padding:16px 16px 14px;gap:13px}
  .source-summary{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.source-summary strong{font-size:16px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
  .close-inspector{display:grid;width:23px;height:23px;flex:0 0 auto;place-items:center;border:0;border-radius:5px;background:transparent;color:var(--accent-ink);font-size:18px;line-height:1}.close-inspector:hover{background:color-mix(in srgb,var(--accent) 12%,transparent)}
  .inspector-details{display:grid;grid-template-columns:1fr;gap:7px;margin:0;padding:0}.inspector-details>div{display:grid;grid-template-columns:58px minmax(0,1fr);gap:9px}.inspector-details dt{font-size:11px}.inspector-details dd{font-size:11px;overflow-wrap:anywhere}.inspector-details .file-location{user-select:all}
  .inspector-preview{display:flex;flex:1;min-height:0;flex-direction:column;margin:0;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:var(--paper)}
  .preview-heading{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--surface)}.preview-heading span{font-size:11px;font-weight:650}.preview-heading small{color:var(--text3);font-size:10px;overflow-wrap:anywhere}
  .preview-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.inspector-preview table{width:max-content;min-width:100%;margin:0;border:0;border-radius:0;font-size:11px}.inspector-preview th,.inspector-preview td{height:27px;padding:5px 9px;white-space:pre}.inspector-preview thead th{position:sticky;top:0;z-index:2;text-align:center;background:var(--paper);color:var(--text3);font-size:10px;font-weight:500}.inspector-preview .row-number{position:sticky;left:0;z-index:1;min-width:31px;text-align:right;background:var(--paper);color:var(--text3);font-size:10px;font-weight:400;user-select:none}.inspector-preview thead .row-number{z-index:3}
  .source-lines{display:table;min-width:100%;margin:0;padding:8px 0;font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.source-line{display:table-row}.source-line.cited{background:color-mix(in srgb,var(--accent) 12%,var(--paper))}.line-number{display:table-cell;position:sticky;left:0;padding:0 10px;color:var(--text3);background:var(--paper);text-align:right;user-select:none}.line-content{display:table-cell;padding:0 10px;white-space:pre}.source-document-text{padding:16px;font:13px/1.7 Georgia,serif;white-space:pre-wrap;overflow-wrap:anywhere}.source-pdf{display:block;flex:1;width:100%;min-height:0;border:0;background:var(--paper)}.source-image{display:block;max-width:100%;height:auto;margin:auto}.preview-unavailable{padding:18px;color:var(--text2);font-size:12px;line-height:1.6}
  .inspector-toolbar{display:flex;align-items:center;gap:6px;padding:0 12px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 50%,transparent)}.inspector-toolbar button{display:flex;height:28px;align-items:center;gap:5px;padding:0 9px;border:1px solid color-mix(in srgb,var(--accent) 20%,transparent);border-radius:6px;background:color-mix(in srgb,var(--accent) 7%,transparent);color:var(--accent-ink);font:500 11px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}.inspector-toolbar button:hover{background:color-mix(in srgb,var(--accent) 16%,transparent)}.inspector-toolbar button span{font-size:13px}.inspector-toolbar kbd{padding:1px 4px;border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);border-radius:3px;color:var(--accent-ink);font:10px -apple-system,BlinkMacSystemFont,sans-serif}.inspector-toolbar .destructive{margin-left:auto}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

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
  // Only synthetic shapes reach the recipient. Blurring original text in CSS
  // would leave the private value recoverable from the page source.
  const placeholder = effect === 'blank' ? '' : '<span aria-hidden="true"></span>'.repeat(4);
  return `<span class="redaction ${effect}" role="img" aria-label="Redacted">${placeholder}</span>`;
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

/** The private source inspector uses original file content and local provenance. */
export function renderInspectorPanel(resolved, reference, preview) {
  const { source } = resolved;
  const position = preview?.location || source.location;
  let content = '<div class="preview-unavailable">This file cannot be displayed inline. Open the source to view it in its original application.</div>';
  let previewLabel = 'Source preview';
  if (preview?.kind === 'table') {
    content = `<div class="preview-scroll"><table aria-label="Source worksheet"><thead><tr><th class="row-number" aria-label="Row number"></th>${preview.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${preview.rows.map((row) => `<tr><th class="row-number" scope="row">${row.rowNumber}</th>${row.cells.filter((cell) => !cell.covered).map((cell) => `<td class="${cell.cited ? 'cited' : ''}" rowspan="${cell.rowSpan ?? 1}" colspan="${cell.colSpan ?? 1}">${escapeHtml(cell.value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } else if (preview?.kind === 'pdf') {
    content = `<iframe class="source-pdf" src="${escapeHtml(preview.fileUrl)}#page=${preview.page}&zoom=page-width" title="${escapeHtml(source.filename)}"></iframe>`;
  } else if (preview?.kind === 'image') {
    content = `<div class="preview-scroll"><img class="source-image" src="${escapeHtml(preview.fileUrl)}" alt="${escapeHtml(source.filename)}"></div>`;
  } else if (preview?.kind === 'text') {
    previewLabel = preview.extracted ? 'Document text' : 'Source preview';
    content = preview.extracted
      ? `<div class="preview-scroll source-document-text">${escapeHtml(preview.lines.map((line) => line.value).join('\n'))}</div>`
      : `<div class="preview-scroll"><div class="source-lines">${preview.lines.map((line) => `<div class="source-line ${line.cited ? 'cited' : ''}"><span class="line-number">${line.lineNumber}</span><span class="line-content">${escapeHtml(line.value) || '&nbsp;'}</span></div>`).join('')}</div></div>`;
  }
  const localPayload = JSON.stringify({ referenceId: reference ?? null, absolutePath: source.absolutePath ?? null }).replace(/</g, '\\u003c');
  return page(`${source.label} · source`, `
    <section class="inspector-shell" aria-label="Source inspector">
      <div class="inspector-body">
        <div class="source-summary"><strong>${escapeHtml(source.label)}</strong><button class="close-inspector" data-action="close" aria-label="Close source inspector">×</button></div>
        <dl class="inspector-details">
          <div><dt>Source</dt><dd>${escapeHtml(source.filename)}</dd></div>
          <div><dt>Location</dt><dd class="file-location">${escapeHtml(source.absolutePath || resolved.internal?.filePath || 'Unavailable')}</dd></div>
          ${position && position !== '—' ? `<div><dt>Selection</dt><dd>${escapeHtml(position)}</dd></div>` : ''}
        </dl>
        <div class="inspector-preview"><div class="preview-heading"><span>${previewLabel}</span>${preview?.sheet ? `<small>${escapeHtml(preview.sheet)}</small>` : ''}</div>${content}</div>
      </div>
      <footer class="inspector-toolbar">
        <button data-action="open"><span>↗</span>Open source</button>
        <button data-action="share">Share link <kbd>Tab</kbd></button>
        <button data-action="unlink" class="destructive"><span>×</span>Unlink</button>
      </footer>
    </section>
    <script>
      const sourceAccent = new URLSearchParams(window.location.search).get('accent');
      if (/^#[0-9a-f]{6}$/i.test(sourceAccent ?? '')) {
        document.documentElement.style.setProperty('--accent', sourceAccent);
      }
      const sendAction = (action) => window.webkit?.messageHandlers?.inspector?.postMessage({ action, ...${localPayload} });
      document.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        event.preventDefault();
        sendAction(button.dataset.action);
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); sendAction('close'); }
        if (event.key === 'Tab' && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault(); sendAction('share');
        }
      });
      requestAnimationFrame(() => document.querySelector('.cited')?.scrollIntoView({ block: 'center', inline: 'center' }));
    </script>
  `, 'inspector inspector-spatial');
}
