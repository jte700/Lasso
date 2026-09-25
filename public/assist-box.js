// Shared completion and inspector primitives.
//
// These surfaces mirror the native AppKit overlay: a quiet glass card, clear
// hierarchy, source metadata, and keyboard hints. Keep the class names stable;
// the document editor and native source inspector both consume this module.

export const ASSIST = {
  innerWidth: 54,
  labelWidth: 22,
  detailWidth: 10,
};

export const sourceWidth = ASSIST.innerWidth - ASSIST.labelWidth - ASSIST.detailWidth - 5;

export function padCell(value, width) {
  const characters = [...String(value ?? '')];
  if (characters.length === width) return characters.join('');
  if (characters.length < width) return characters.join('') + ' '.repeat(width - characters.length);
  return `${characters.slice(0, Math.max(1, width - 1)).join('')}…`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

export function boxTop(title) {
  return `<div class="ab-head"><span class="ab-title">${escapeHtml(title)}</span></div>`;
}

export const boxDivider = () => '<div class="ab-divider" aria-hidden="true"></div>';
export const boxBottom = () => '<div class="ab-bottom" aria-hidden="true"></div>';

export function boxLine(body) {
  if (typeof body === 'string') {
    return `<div class="ab-line"><span class="ab-body">${escapeHtml(String(body).trimEnd())}</span></div>`;
  }
  const segments = body.map((part) => `<span class="ab-body ${part.tone ? `t-${part.tone}` : ''}">${escapeHtml(String(part.text ?? '').trimEnd())}</span>`).join('');
  return `<div class="ab-line">${segments}</div>`;
}

export function boxField(label, value) {
  return `<div class="ab-field"><span class="ab-field-label">${escapeHtml(label)}</span>`
    + `<span class="ab-field-value">${escapeHtml(value ?? '—')}</span></div>`;
}

export const assistText = (body) => boxLine(body);

export function assistRow(row, index, selected, attributes = '') {
  const source = String(row.path ?? '').split('/').pop() ?? '';
  const caption = [source, row.reason].filter(Boolean).join(' · ');
  return `<button type="button" tabindex="-1" class="ab-row ${selected ? 'selected' : ''}"
      role="option" aria-selected="${selected}" data-completion-index="${index}" ${attributes}>
    <span class="ab-label">${escapeHtml(row.label)}</span>
    <b class="ab-detail">${escapeHtml(row.detail ?? '')}</b>
    <span class="ab-source" title="${escapeHtml(caption)}">${escapeHtml(caption)}</span>
  </button>`;
}

export function renderAssistBox({ title = 'dependency', rows = [], selected = 0, hints = '', messageLines = null }) {
  if (messageLines) {
    return `<div class="ab">${boxTop(title)}<div class="ab-message">${messageLines
      .map((line) => `<p>${escapeHtml(line)}</p>`).join('')}</div>${boxBottom()}</div>`;
  }
  const body = rows.map((row, index) => assistRow(row, index, index === selected, row.attributes ?? '')).join('');
  return `<div class="ab">${boxTop(title)}<div class="ab-list" role="listbox">${body}</div>`
    + `${boxDivider()}<div class="ab-line ab-hints">${escapeHtml(hints)}</div>${boxBottom()}</div>`;
}
