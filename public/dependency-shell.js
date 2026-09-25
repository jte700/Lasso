// The terminal view over the dependency graph.
//
// It renders the structured results the command layer returns — it does not
// format them on the server and print strings here, and it does not decide
// what a command means. Its whole job is the interaction: a transcript,
// keyboard navigation through results, inline completion, a source preview for
// whatever is highlighted, and the single-key actions a result offers.

const HISTORY_KEY = 'lasso.terminal.history';
const HISTORY_LIMIT = 200;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function loadHistory() {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? localStorage.getItem('colab.terminal.history'));
    return Array.isArray(stored) ? stored.slice(-HISTORY_LIMIT) : [];
  } catch { return []; }
}

function saveHistory(history) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT))); } catch { /* transcript only */ }
}

// ── block rendering ─────────────────────────────────────────────────────────

function renderRow(row) {
  const meta = row.meta ? `<span class="dsh-meta">${escapeHtml(row.meta)}</span>` : '';
  return `<div class="dsh-row t-${escapeHtml(row.tone ?? 'normal')}"><span>${escapeHtml(row.text)}</span>${meta}</div>`;
}

function renderBlock(block) {
  switch (block.kind) {
    case 'blank': return '<div class="dsh-blank"></div>';
    case 'text': return `<div class="dsh-line t-${escapeHtml(block.tone)}">${escapeHtml(block.text)}</div>`;
    case 'fields': return `<dl class="dsh-fields">${block.rows.map((row) => `
      <div class="t-${escapeHtml(row.tone)}"><dt>${escapeHtml(row.label)}</dt><dd>${escapeHtml(row.value)}</dd></div>`).join('')}</dl>`;
    case 'group': return `<div class="dsh-group">
      <div class="dsh-group-head"><span>${escapeHtml(block.label)}</span>${block.note ? `<span class="dsh-meta">${escapeHtml(block.note)}</span>` : ''}</div>
      ${block.rows.map(renderRow).join('')}
    </div>`;
    case 'table': return `<div class="dsh-table-wrap"><table class="dsh-table">
      <thead><tr>${block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
      <tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>`;
    default: return '';
  }
}

function renderResultItem(item, index, selected) {
  return `<button type="button" tabindex="-1" class="dsh-result ${selected ? 'selected' : ''} t-${escapeHtml(item.tone)}"
      data-result="${index}" aria-current="${selected}">
    <span class="dsh-index">${index + 1}</span>
    <span class="dsh-body">
      <span class="dsh-title">${escapeHtml(item.title)}${item.badge ? `<i class="dsh-badge">${escapeHtml(item.badge)}</i>` : ''}</span>
      ${item.lines.map((line) => `<span class="dsh-sub">${escapeHtml(line)}</span>`).join('')}
    </span>
    ${item.value == null ? '' : `<span class="dsh-value" title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</span>`}
  </button>`;
}

function renderActions(actions) {
  if (!actions?.length) return '';
  return `<div class="dsh-actions">${actions
    .map((action) => `<span><kbd>${escapeHtml(action.key)}</kbd>${escapeHtml(action.label)}</span>`)
    .join('')}</div>`;
}

function renderEntry(entry, index, state) {
  const { result } = entry;
  const active = index === state.activeEntryIndex;
  const headline = result.headline
    ? `<div class="dsh-headline ${result.ok ? '' : 'failed'}">${escapeHtml(result.headline)}</div>` : '';
  const subhead = result.subhead ? `<div class="dsh-subhead">${escapeHtml(result.subhead)}</div>` : '';
  const results = result.results.length
    ? `<div class="dsh-results" data-entry="${index}">${result.results
      .map((item, position) => renderResultItem(item, position, active && position === state.selected)).join('')}</div>`
    : '';
  const hints = result.hints?.length
    ? `<div class="dsh-hints">${result.hints.map((hint) => `<span>${escapeHtml(hint)}</span>`).join('')}</div>` : '';

  return `<section class="dsh-entry ${active ? 'active' : ''}">
    <div class="dsh-echo"><i>〉</i><span>${escapeHtml(entry.input)}</span></div>
    ${headline}${subhead}
    ${result.blocks.map(renderBlock).join('')}
    ${results}
    ${active ? renderPreview(state.preview) : ''}
    ${active && result.results.length ? renderActions(result.actions) : ''}
    ${hints}
  </section>`;
}

// ── source preview ──────────────────────────────────────────────────────────

function renderPreview(preview) {
  if (!preview) return '';
  const head = `<div class="dsh-preview-head">
    <strong>${escapeHtml(preview.fileName ?? '')}</strong>
    <span>${escapeHtml(preview.locator ?? preview.path ?? '')}</span>
  </div>`;

  if (preview.kind === 'table') {
    const body = preview.rows.map((row) => `<tr class="${row.highlighted ? 'hit' : ''}">
      <td class="dsh-gutter">${row.rowNumber}</td>
      ${row.cells.slice(0, 8).map((cell, column) => `<td class="${column === preview.highlightColumn ? 'hit-cell' : ''}">${escapeHtml(cell)}</td>`).join('')}
    </tr>`).join('');
    return `<aside class="dsh-preview">${head}<div class="dsh-table-wrap"><table class="dsh-table"><tbody>${body}</tbody></table></div></aside>`;
  }
  if (preview.kind === 'text') {
    return `<aside class="dsh-preview">${head}<pre class="dsh-preview-code">${preview.lines
      .map((line) => `<span class="${line.highlighted ? 'hit' : ''}"><i>${String(line.lineNumber).padStart(4)}</i>${escapeHtml(line.text)}</span>`)
      .join('\n')}</pre></aside>`;
  }
  if (preview.kind === 'unavailable') {
    return `<aside class="dsh-preview">${head}<div class="dsh-line t-dim">${escapeHtml(preview.reason)}</div></aside>`;
  }
  return `<aside class="dsh-preview">${head}<div class="dsh-line">${escapeHtml(preview.value ?? preview.objectType ?? '')}</div></aside>`;
}

// ── the shell ───────────────────────────────────────────────────────────────

export function createDependencyShell({ host = null, input, api, getProjectId, getDocumentPath, getActor, onRecommendationUsage, onOpenDocument, onStatus, onSession, build = 'dev' }) {
  let hostNode = host;
  const state = {
    transcript: [],
    history: loadHistory(),
    historyIndex: null,
    draft: '',
    selected: -1,
    activeEntryIndex: -1,
    completion: null,
    completionIndex: 0,
    // Set once the user picks a row themselves, so Enter takes their choice
    // instead of running a half-typed line.
    completionNavigated: false,
    preview: null,
    previewToken: 0,
    session: null,
    busy: false,
    // Set while the user is stepping through results, so a redraw does not
    // yank the view away from a command they just ran.
    followSelection: false,
  };

  const activeResult = () => state.transcript[state.activeEntryIndex]?.result ?? null;
  const selectedItem = () => activeResult()?.results?.[state.selected] ?? null;

  function bannerHtml() {
    const session = state.session;
    if (!session) return '';
    const reviewCount = (session.changes ?? 0) + (session.stale ?? 0)
      + (session.conflicts ?? 0) + (session.failures ?? 0);
    return `<section class="workspace-overview">
      <header class="overview-heading">
        <div><small>Workspace state · Version ${session.version}</small>
          <h2>Sources and provenance</h2>
          <p>Indexed project objects available to document editing and system-wide IntelliSense.</p></div>
        <span class="health-pill"><i></i>${reviewCount ? `${reviewCount} item${reviewCount === 1 ? '' : 's'} to review` : 'Index up to date'}</span>
      </header>
      <div class="object-grid">
        <button class="object-card" type="button" data-session-action="index status"><span class="object-card-icon"><svg viewBox="0 0 20 20"><path d="M3.5 5.5h13v9h-13Z"/><path d="M6 8h8M6 11h5"/></svg></span><span><strong>${session.files.toLocaleString()}</strong><small>Indexed sources</small></span></button>
        <button class="object-card" type="button" data-session-action="changes"><span class="object-card-icon"><svg viewBox="0 0 20 20"><path d="M6 6.5h8v7H6Z"/><path d="M3.5 4v8M16.5 8v8"/></svg></span><span><strong>${session.dependencies.toLocaleString()}</strong><small>Dependencies</small></span></button>
        <button class="object-card" type="button" data-session-action="changes"><span class="object-card-icon"><svg viewBox="0 0 20 20"><path d="M4 10a6 6 0 1 0 2-4.5M4 4v4h4"/></svg></span><span><strong>${session.changes.toLocaleString()}</strong><small>Recent changes</small></span></button>
        <button class="object-card" type="button" data-session-action="conflicts"><span class="object-card-icon"><svg viewBox="0 0 20 20"><path d="M10 3.5 16.5 15H3.5Z"/><path d="M10 7v4M10 13.5v.1"/></svg></span><span><strong>${reviewCount.toLocaleString()}</strong><small>Needs review</small></span></button>
      </div>
      <section class="utility-section">
        <header><strong>Workspace health</strong><span>${session.directories} local project${session.directories === 1 ? '' : 's'}</span></header>
        <div class="state-list">
          <div class="state-row"><span class="state-icon">✓</span><span><strong>Source index available</strong><small>${session.files.toLocaleString()} documents, tables, figures, and values</small></span><b>Current</b></div>
          <div class="state-row"><span class="state-icon">✓</span><span><strong>Dependency map active</strong><small>Linked evidence stays traceable while documents change</small></span><b>${session.dependencies.toLocaleString()} links</b></div>
          <div class="state-row"><span class="state-icon ${reviewCount ? 'warning' : ''}">${reviewCount ? '!' : '✓'}</span><span><strong>${reviewCount ? 'Human review required' : 'No unresolved provenance issues'}</strong><small>${session.stale ?? 0} stale · ${session.conflicts ?? 0} ambiguous · ${session.failures ?? 0} indexing issues</small></span><b>${reviewCount || 'Clear'}</b></div>
        </div>
      </section>
    </section>`;
  }
  function render() {
    if (!hostNode?.isConnected) return;
    hostNode.innerHTML = `${bannerHtml()}
      ${state.transcript.map((entry, index) => renderEntry(entry, index, state)).join('')}
      ${state.busy ? '<div class="dsh-line t-dim">…</div>' : ''}`;
    hostNode.querySelectorAll('[data-result]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeEntryIndex = Number(button.closest('[data-entry]').dataset.entry);
        select(Number(button.dataset.result));
      });
      button.addEventListener('dblclick', () => inspectSelected());
    });
    hostNode.querySelectorAll('[data-session-action]').forEach((button) => {
      button.addEventListener('click', () => run(button.dataset.sessionAction));
    });
    // The shell is drawn inside the workspace's scroller, not its own.
    if (state.followSelection) {
      hostNode.querySelector('.dsh-result.selected')?.scrollIntoView({ block: 'nearest' });
    }
  }

  const COMPLETION_HEADINGS = {
    command: 'command',
    subcommand: 'subcommand',
    flag: 'flag',
    argument: 'dependency',
  };

  /** Compact source and command suggestions anchored to the toolbar query field. */
  function renderCompletion() {
    const box = document.getElementById('dsh-completion');
    if (!box) return;
    const suggestions = state.completion?.suggestions ?? [];
    if (!suggestions.length) {
      box.innerHTML = '';
      box.hidden = true;
      return;
    }
    const heading = state.completion.heading ?? COMPLETION_HEADINGS[state.completion.position] ?? 'suggestion';
    const related = suggestions.some((suggestion) => suggestion.kind === 'related');
    box.hidden = false;
    box.innerHTML = `
      <div class="query-suggestion-head"><span>${escapeHtml(heading)}</span><span>${suggestions.length} result${suggestions.length === 1 ? '' : 's'}</span></div>
      <div class="dsh-completion-list" role="listbox" aria-label="Suggestions">
        ${suggestions.map((suggestion, index) => `
          <button type="button" tabindex="-1" class="dsh-completion-row ${index === state.completionIndex ? 'selected' : ''}"
                  role="option" aria-selected="${index === state.completionIndex}" data-completion="${index}">
            <span class="dsh-completion-value">${escapeHtml(suggestion.value)}</span>
            <span class="dsh-completion-preview">${escapeHtml(suggestion.preview ?? '')}</span>
            <span class="dsh-completion-detail" title="${escapeHtml(suggestion.detail ?? '')}">${escapeHtml(suggestion.ranking?.reason ?? suggestion.detail ?? '')}</span>
          </button>`).join('')}
      </div>
      <div class="query-suggestion-foot">
        <span><kbd>Tab</kbd> Insert</span>
        ${suggestions.length > 1 ? '<span><kbd>↑</kbd><kbd>↓</kbd> Select</span>' : ''}
        <span><kbd>Esc</kbd> Close</span>
        ${related ? '<span>Related project sources</span>' : ''}
      </div>`;

    box.querySelectorAll('[data-completion]').forEach((row) => {
      // mousedown, so the prompt never loses focus to the click.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        state.completionIndex = Number(row.dataset.completion);
        applyCompletion();
      });
    });
    box.querySelector('.dsh-completion-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function closeCompletion() {
    state.completion = null;
    state.completionIndex = 0;
    state.completionNavigated = false;
    renderCompletion();
  }

  function moveCompletion(direction) {
    const suggestions = state.completion?.suggestions ?? [];
    if (!suggestions.length) return false;
    state.completionIndex = (state.completionIndex + direction + suggestions.length) % suggestions.length;
    state.completionNavigated = true;
    renderCompletion();
    return true;
  }

  async function refreshCompletion() {
    const projectId = getProjectId();
    const value = input.value;
    if (!projectId || !value.trim()) {
      closeCompletion();
      return;
    }
    try {
      const parameters = new URLSearchParams({ input: value });
      const documentPath = getDocumentPath?.();
      if (documentPath) parameters.set('documentPath', documentPath);
      const body = await api(`/api/projects/${encodeURIComponent(projectId)}/terminal/complete?${parameters}`);
      // A response for a line the user has already moved past is discarded.
      if (input.value !== value || getProjectId() !== projectId) return;
      state.completion = {
        ...body.completion,
        suggestions: (body.completion?.suggestions ?? []).slice(0, 5),
        projectId, documentPath,
      };
      state.completionIndex = 0;
      state.completionNavigated = false;
    } catch { state.completion = null; }
    renderCompletion();
  }

  function applyCompletion() {
    const suggestion = state.completion?.suggestions?.[state.completionIndex];
    if (!suggestion) return false;
    if (state.completion.projectId !== getProjectId()) {
      closeCompletion();
      return false;
    }
    const fragment = state.completion.fragment ?? '';
    const value = input.value;
    const base = fragment ? value.slice(0, value.length - fragment.length) : value;
    const spacer = fragment || /\s$/.test(value) || !value ? '' : ' ';
    // A name containing a space has to be quoted to survive the parser.
    const literal = /\s/.test(suggestion.value) ? `"${suggestion.value}"` : suggestion.value;
    input.value = `${base}${spacer}${literal} `;
    input.setSelectionRange(input.value.length, input.value.length);
    if (suggestion.objectId || suggestion.dependencyId || suggestion.path) {
      onRecommendationUsage?.(suggestion, 'accept', {
        projectId: state.completion.projectId, documentPath: state.completion.documentPath,
      });
    }
    // Accepting closes the box, the way a shell does. Typing reopens it, and so
    // does another Tab.
    closeCompletion();
    return true;
  }

  async function refreshPreview() {
    const item = selectedItem();
    const projectId = getProjectId();
    const token = (state.previewToken += 1);
    if (!item?.ref || !projectId) {
      state.preview = null;
      return;
    }
    try {
      const body = await api(`/api/projects/${encodeURIComponent(projectId)}/terminal/preview`, {
        method: 'POST',
        body: JSON.stringify({ ref: item.ref }),
      });
      if (token !== state.previewToken) return;
      state.preview = body.preview;
    } catch { state.preview = null; }
    render();
  }

  function select(index) {
    const results = activeResult()?.results ?? [];
    if (!results.length) { state.selected = -1; state.preview = null; render(); return; }
    state.selected = Math.max(0, Math.min(results.length - 1, index));
    state.followSelection = true;
    render();
    refreshPreview();
  }

  function clearSelection() {
    state.selected = -1;
    state.preview = null;
    render();
  }

  async function run(line, { echo = true } = {}) {
    const value = String(line ?? '').trim();
    if (!value) return null;
    const projectId = getProjectId();
    if (!projectId) {
      onStatus?.('Select a directory before running a command.');
      return null;
    }
    state.busy = true;
    state.followSelection = false;
    render();
    let result;
    try {
      const body = await api(`/api/projects/${encodeURIComponent(projectId)}/terminal`, {
        method: 'POST',
        body: JSON.stringify({ input: value, actor: getActor?.() ?? null, documentPath: getDocumentPath?.() }),
      });
      result = body.result;
    } catch (error) {
      result = { ok: false, command: '', headline: error.message, blocks: [], results: [], actions: [], hints: [] };
    }
    state.busy = false;

    if (result.clear) {
      state.transcript = [];
      state.activeEntryIndex = -1;
      state.selected = -1;
      state.preview = null;
      render();
      return result;
    }

    if (echo) {
      state.transcript.push({ input: value, result });
      state.activeEntryIndex = state.transcript.length - 1;
      state.selected = result.results.length ? 0 : -1;
      state.preview = null;
    }
    render();
    // The newest entry is what the user just asked for, so it leads the view.
    const scroller = hostNode?.closest('.terminal-scroll');
    const entry = [...(hostNode?.querySelectorAll('.dsh-entry') ?? [])].at(-1);
    if (scroller && entry) scroller.scrollTop = entry.offsetTop - scroller.offsetTop - 8;
    if (state.selected >= 0) refreshPreview();
    // A command that writes leaves the session counters stale.
    if (['update', 'index', 'alias', 'unalias', 'rules', 'shares'].includes(result.command)) refreshSession();
    return result;
  }

  function remember(value) {
    if (state.history.at(-1) !== value) {
      state.history.push(value);
      saveHistory(state.history);
    }
    state.historyIndex = null;
    state.draft = '';
  }

  // ── actions on the selected result ────────────────────────────────────────

  async function inspectSource(ref, command) {
    const context = { projectId: getProjectId(), documentPath: getDocumentPath?.() };
    const result = await run(command);
    if (result?.ok && (ref.objectId || ref.dependencyId || ref.path)) {
      onRecommendationUsage?.(ref, 'open', context);
    }
  }

  function inspectSelected() {
    const item = selectedItem();
    if (!item?.ref) return;
    const { ref } = item;
    switch (ref.kind) {
      // A reference lives in a document, so inspecting it opens the document
      // at the claim rather than printing more terminal output.
      case 'dependency': onOpenDocument?.(item.title.includes('/') ? item.title : null, ref); break;
      case 'object': inspectSource(ref, `impact ${ref.name}`); break;
      case 'objectVersion': inspectSource(ref, `history ${ref.name}`); break;
      case 'conflict': run(`conflicts ${ref.name}`); break;
      case 'share': window.open(ref.url, '_blank', 'noopener'); break;
      case 'indexFailure': run(`index retry ${ref.path}`); break;
      case 'alias': run('aliases'); break;
      case 'rule': run(`rules ${ref.enabled ? 'disable' : 'enable'} ${ref.name}`); break;
      default: break;
    }
  }

  function actOnSelected(key) {
    const item = selectedItem();
    if (!item?.ref) return false;
    const { ref } = item;
    const available = new Set((item.actions ?? []).map((action) => action.key));
    if (!available.has(key)) return false;
    switch (key) {
      case 'u':
        if (ref.name) run(`update ${ref.name} --apply`);
        return true;
      case 'k':
        if (ref.name) run(`update ${ref.name} --keep`);
        return true;
      case 's':
      case 'i':
        if (ref.name) inspectSource(ref, `trace ${ref.name}`);
        return true;
      case 'a':
        if (ref.name) run(`impact ${ref.name}`);
        return true;
      case 'r':
        if (ref.kind === 'share') run(`revoke ${ref.token}`);
        else if (ref.kind === 'indexFailure') run(`index retry ${ref.path}`);
        return true;
      case 'o':
        if (ref.url) window.open(ref.url, '_blank', 'noopener');
        return true;
      case 'c':
        if (ref.url) {
          navigator.clipboard?.writeText(new URL(ref.url, window.location.origin).toString());
          onStatus?.('Share link copied.');
        }
        return true;
      default: return false;
    }
  }

  // ── keyboard ──────────────────────────────────────────────────────────────

  function onKeyDown(event) {
    const empty = !input.value.length;
    const completing = (state.completion?.suggestions?.length ?? 0) > 0;
    // Arrow keys have three homes, in this order: the completion box while it
    // is open, then the current result set while one is selected, then the
    // command history. Esc steps back out of each in turn.
    const navigating = empty && state.selected >= 0 && (activeResult()?.results?.length ?? 0) > 0;

    if (event.key === 'Tab') {
      event.preventDefault();
      if (completing) applyCompletion();
      else refreshCompletion();
      return;
    }
    if (event.key === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      state.transcript = [];
      state.activeEntryIndex = -1;
      closeCompletion();
      clearSelection();
      return;
    }
    if (event.key === 'Escape') {
      if (completing) { closeCompletion(); return; }
      if (state.preview || state.selected >= 0) { clearSelection(); return; }
      input.value = '';
      return;
    }
    if (event.key === '?' && empty) {
      event.preventDefault();
      run('help');
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (completing) {
        event.preventDefault();
        moveCompletion(direction);
        return;
      }
      if (navigating) {
        event.preventDefault();
        select(state.selected + direction);
        return;
      }
      event.preventDefault();
      const { history } = state;
      if (!history.length) return;
      if (state.historyIndex === null) {
        if (direction > 0) return;
        state.draft = input.value;
        state.historyIndex = history.length - 1;
      } else {
        state.historyIndex += direction;
      }
      if (state.historyIndex >= history.length) {
        state.historyIndex = null;
        input.value = state.draft;
      } else {
        state.historyIndex = Math.max(0, state.historyIndex);
        input.value = history[state.historyIndex];
      }
      input.setSelectionRange(input.value.length, input.value.length);
        return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      // Having chosen a row in the completion box, Enter takes it — running a
      // half-typed line at that point is never what was meant.
      if (completing && state.completionNavigated) { applyCompletion(); return; }
      if (navigating) { inspectSelected(); return; }
      const value = input.value.trim();
      if (!value) return;
      input.value = '';
      input.closest('.terminal-input')?.classList.remove('has-text');
      closeCompletion();
      remember(value);
      run(value);
      return;
    }
    if (navigating && !completing && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (actOnSelected(event.key.toLowerCase())) event.preventDefault();
    }
  }

  async function refreshSession() {
    const projectId = getProjectId();
    if (!projectId) { state.session = null; onSession?.(null); render(); return; }
    try {
      const body = await api(`/api/projects/${encodeURIComponent(projectId)}/terminal/session`);
      state.session = body.session;
    } catch { state.session = null; }
    onSession?.(state.session);
    render();
  }

  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('input', () => {
    input.closest('.terminal-input')?.classList.toggle('has-text', input.value.length > 0);
    state.historyIndex = null;
    if (state.selected >= 0) clearSelection();
    refreshCompletion();
  });

  return {
    setHost(node) { hostNode = node; },
    mount() { render(); },
    refresh: refreshSession,
    run,
    reset() {
      closeCompletion();
      state.transcript = [];
      state.activeEntryIndex = -1;
      state.selected = -1;
      state.preview = null;
      state.session = null;
    },
    focus() { input.focus(); },
    get state() { return state; },
  };
}
