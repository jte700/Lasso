// The shape every command returns.
//
// Commands produce data, never formatted text: the terminal view decides how
// to draw a field list or a result set, and the same result can be rendered by
// a test, the web view, or a future client without reparsing prose.

export function result(command, { headline = null, subhead = null, blocks = [], results = [], actions = [], hints = [], data = null } = {}) {
  return {
    ok: true,
    command,
    headline,
    subhead,
    blocks,
    results,
    actions,
    hints,
    data,
  };
}

export function failure(command, message, { hints = [], blocks = [], results = [] } = {}) {
  return { ok: false, command, headline: message, subhead: null, blocks, results, actions: [], hints, data: null };
}

export const text = (value, tone = 'normal') => ({ kind: 'text', text: String(value ?? ''), tone });
export const dim = (value) => text(value, 'dim');
export const warn = (value) => text(value, 'warn');
export const blank = () => ({ kind: 'blank' });

/** A label/value column pair, as `trace` uses. */
export const fields = (rows) => ({
  kind: 'fields',
  rows: rows.filter(Boolean).map(([label, value, tone = 'normal']) => ({ label, value: value == null ? '—' : String(value), tone })),
});

/** A labelled group of indented rows, as `impact` uses for documents. */
export const group = (label, rows, note = null) => ({
  kind: 'group',
  label,
  note,
  rows: rows.map((row) => (typeof row === 'string' ? { text: row } : row)),
});

export const table = (columns, rows) => ({ kind: 'table', columns, rows });

/** Selectable results. `lines` are display rows under the title. */
export function resultItem({ title, lines = [], value = null, ref, badge = null, tone = 'normal', actions = [] }) {
  return { title, lines: lines.filter((line) => line != null && line !== ''), value, ref, badge, tone, actions };
}

export const ACTION = {
  inspect: { key: 'Enter', label: 'inspect' },
  update: { key: 'u', label: 'update affected' },
  updateOne: { key: 'u', label: 'update' },
  keep: { key: 'k', label: 'keep current' },
  showSource: { key: 's', label: 'show source' },
  inspectDependency: { key: 'i', label: 'inspect dependency' },
  inspectSource: { key: 'i', label: 'inspect source' },
  revoke: { key: 'r', label: 'revoke' },
  open: { key: 'o', label: 'open' },
  copyLink: { key: 'c', label: 'copy link' },
  retry: { key: 'r', label: 'retry' },
  impact: { key: 'a', label: 'impact' },
};
