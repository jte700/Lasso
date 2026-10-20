// Application shell: directory navigation, document tabs, and the empty workspace.
//
// Each piece is a small factory over existing DOM rather than a framework
// component, but the boundaries are the same: the shell knows nothing about
// provenance, and the workspace knows nothing about how it is framed.

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

/// `/Users/x/Documents/research` → `~/Documents/research`
export function shortenPath(path) {
  if (!path) return '';
  return path.replace(/^\/Users\/[^/]+/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
}

// ── DirectorySidebar ────────────────────────────────────────────────────────

/**
 * Directories the user has granted the application access to. Selecting one
 * changes the document context. Checkboxes independently select directories
 * that contribute to the shared source library and writing suggestions.
 */
export function createDirectorySidebar({ host, onSelect, onToggle }) {
  let directories = [];
  let activeId = null;

  function render() {
    host.innerHTML = directories.map((directory) => {
      const selected = directory.id === activeId;
      // A disconnected drive keeps its cached index browsable and searchable.
      const offline = directory.availability === 'offline';
      const status = offline ? 'offline' : directory.active ? 'active' : 'available';
      const meta = offline ? `${directory.driveName || 'External drive'} · Offline`
        : [directory.available === false ? 'Unavailable' : directory.active ? 'Included' : 'Paused', directory.gitBranch || shortenPath(directory.path)].filter(Boolean).join(' · ');
      return `<div style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" data-toggle-directory="${escapeHtml(directory.id)}" ${directory.active ? 'checked' : ''}
          ${directory.available === false ? 'disabled' : ''} aria-label="Include ${escapeHtml(directory.name)} in workspace"
          title="${escapeHtml(directory.error || 'Include this directory in suggestions and search')}" style="accent-color:var(--u-green);flex:none;margin-left:6px">
        <button class="directory-row ${selected ? 'selected' : ''}" type="button" aria-pressed="${selected}"
                data-directory="${escapeHtml(directory.id)}" ${directory.available === false ? 'disabled' : ''}>
        <span class="dir-dot ${status}" aria-hidden="true"></span>
        <span class="dir-name">${escapeHtml(directory.name)}${directory.availability === 'offline' ? ' <small class="drive-offline-label">Cached</small>' : ''}</span>
        <span class="dir-meta">${escapeHtml(meta)}</span>
      </button></div>`;
    }).join('') || '<p class="add-directory" style="cursor:default">no directories yet</p>';

    host.querySelectorAll('[data-directory]').forEach((row) => {
      row.addEventListener('click', () => onSelect?.(row.dataset.directory));
    });
    host.querySelectorAll('[data-toggle-directory]').forEach((checkbox) => {
      checkbox.addEventListener('change', () => onToggle?.(checkbox.dataset.toggleDirectory, checkbox.checked));
    });
  }

  return {
    set(list, selectedId) {
      directories = list ?? [];
      activeId = selectedId ?? null;
      render();
    },
    setActive(id) { activeId = id; render(); },
  };
}

// ── TabBar ──────────────────────────────────────────────────────────────────

/** Open documents, plus the session tab, as a dense strip. */
export function createTabBar({ host, onSelect }) {
  let tabs = [];
  let activeId = null;

  function render() {
    host.innerHTML = tabs.map((tab, index) => `
      <button class="tab ${tab.id === activeId ? 'active' : ''}" data-tab="${escapeHtml(tab.id)}"
              title="${escapeHtml(tab.title)}">
        ${tab.glyph ? `<span class="tab-glyph" aria-hidden="true">${escapeHtml(tab.glyph)}</span>` : ''}
        <span class="tab-label">${escapeHtml(tab.title)}</span>
        ${index < 9 ? `<span class="tab-key" aria-hidden="true">${window.lassoPlatform?.shortcut(String(index + 1)) ?? `⌘${index + 1}`}</span>` : ''}
      </button>`).join('');
    host.querySelectorAll('[data-tab]').forEach((button) => {
      button.addEventListener('click', () => onSelect?.(button.dataset.tab));
    });
  }

  return {
    set(list, selectedId) {
      tabs = list ?? [];
      activeId = selectedId ?? null;
      render();
    },
    activate(index) {
      const tab = tabs[index];
      if (tab) onSelect?.(tab.id);
    },
    get count() { return tabs.length; },
  };
}

// ── Empty workbench ────────────────────────────────────────────────────────

export function renderSession({ project, identity, warnings = [] }) {
  if (project) return '';
  return `<section class="empty-workbench">
    <span class="empty-project-icon" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M7 13h13l4 5h17v22H7Z"/><path d="M24 24v10m-5-5h10"/></svg></span>
    <p class="empty-eyebrow">Your sources, always within reach</p>
    <h1>Start with a project.</h1>
    <p class="empty-copy">Index a local directory once. Lasso will make its documents,
      datasets, figures, values, and citations available while you write anywhere.</p>
    <div class="empty-flow">
      <div><i>1</i><span><strong>Choose a project</strong><small>Choose a folder with your documents and data.</small></span></div>
      <div><i>2</i><span><strong>Let Lasso build the index</strong><small>Your files stay in place and remain local.</small></span></div>
      <div><i>3</i><span><strong>Write without searching</strong><small>Accept source-backed suggestions with Tab.</small></span></div>
    </div>
    <button class="primary-button empty-add-project" id="empty-add-project" type="button">Add a project…</button>
    <div class="empty-user"><span>${escapeHtml((identity?.displayName ?? 'Local user').slice(0, 2).toUpperCase())}</span><p>Ready for ${escapeHtml(identity?.displayName ?? 'the local user')}</p></div>
    ${warnings.map((warning) => `<div class="empty-warning">${escapeHtml(warning)}</div>`).join('')}
  </section>`;
}

// ── Spatial Workbench ──────────────────────────────────────────────────────

/**
 * The native-style shell keeps project navigation transient. The current
 * project lives in a context capsule; opening it reveals a popover rather than
 * permanently reducing the writing surface. The detached dock changes modes.
 */
export function createSpatialWorkbench({
  projectTrigger,
  projectPopover,
  workspaceButton,
  onWorkspace,
}) {
  const setProjectPopover = (open) => {
    projectPopover.hidden = !open;
    projectTrigger.setAttribute('aria-expanded', String(open));
  };

  projectTrigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setProjectPopover(projectPopover.hidden);
  });

  projectPopover.addEventListener('click', (event) => {
    if (event.target.closest('[data-directory]')) setProjectPopover(false);
  });

  document.addEventListener('pointerdown', (event) => {
    if (projectPopover.hidden) return;
    if (projectPopover.contains(event.target) || projectTrigger.contains(event.target)) return;
    setProjectPopover(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || projectPopover.hidden) return;
    event.preventDefault();
    setProjectPopover(false);
    projectTrigger.focus();
  });

  workspaceButton.addEventListener('click', () => onWorkspace?.());

  return {
    closeProjectPicker() { setProjectPopover(false); },
  };
}
