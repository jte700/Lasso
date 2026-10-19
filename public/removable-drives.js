const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const driveUrl = id => `/api/drives/${encodeURIComponent(id)}`;

// Selecting a parent includes its descendants; send each directory only once.
export function compactDrivePaths(paths) {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return sorted.filter((path, index) => !sorted.slice(0, index).some(parent => parent === '.' || path.startsWith(`${parent}/`)));
}

export function createRemovableDrives({ api, getActor, onProjectsChanged, beforeRemove, onStatus }) {
  const trigger = document.getElementById('removable-drives-button');
  const badge = trigger.querySelector('[data-drive-count]');
  const notification = document.createElement('aside');
  notification.className = 'drive-notification';
  notification.hidden = true;
  notification.setAttribute('aria-label', 'External drive notification');
  document.body.append(notification);
  const dialog = document.createElement('dialog');
  dialog.className = 'modal utility-dialog drive-dialog';
  dialog.setAttribute('aria-labelledby', 'drive-dialog-title');
  dialog.innerHTML = `<header class="dialog-heading"><div><span class="eyebrow">Available working directories</span><h2 id="drive-dialog-title">External drives</h2></div><button class="dialog-close toolbar-icon" type="button" data-drive-close aria-label="Close external drives">×</button></header><div data-drive-content></div><p class="dialog-error" data-drive-error role="alert"></p>`;
  document.body.append(dialog);
  const content = dialog.querySelector('[data-drive-content]');
  const error = dialog.querySelector('[data-drive-error]');
  let drives = [], signature = null, selectedId = null, browsing = false, folderPath = '.', folders = [], folderError = '', folderLoading = false;
  let selectedPaths = new Set(), confirmingRemoval = false, busy = false, timer = null, fetching = null, folderRevision = 0;
  const current = () => drives.find(drive => drive.id === selectedId);
  const showError = message => { error.textContent = message ?? ''; };

  function updateNotice() {
    const pending = drives.filter(drive => drive.pendingAction);
    badge.hidden = !pending.length;
    badge.textContent = String(pending.length);
    trigger.classList.toggle('has-pending-drive', pending.length > 0);
    trigger.setAttribute('aria-label', pending.length ? `External drives: ${pending.length} awaiting a decision` : 'External drives');
    notification.hidden = !pending.length;
    if (!pending.length) { notification.replaceChildren(); return; }
    const drive = pending[0];
    const message = drive.pendingAction === 'disconnected'
      ? `${drive.name} was disconnected. Keep or remove its saved index?`
      : `${drive.name} is connected. Index the drive or choose folders?`;
    notification.innerHTML = `<div role="status"><strong>${escape(message)}</strong>${pending.length > 1 ? `<small>${pending.length} drives need a decision</small>` : ''}</div><button type="button" class="secondary-button" data-review-drives>Review</button>`;
    notification.querySelector('[data-review-drives]').addEventListener('click', () => open(drive.id));
  }

  function render() {
    if (!dialog.open) return;
    const drive = current();
    content.innerHTML = `<nav class="drive-list" aria-label="External drives">${drives.map(item => `<button type="button" data-drive-id="${escape(item.id)}" aria-pressed="${item.id === selectedId}"><span>${escape(item.name)}</span><small>${item.connected ? 'Connected' : 'Offline'}${item.pendingAction ? ' · Needs a decision' : ''}</small></button>`).join('')}</nav>${drive ? renderDrive(drive) : '<p class="drive-empty">Connect an external storage drive to choose which files Lasso can index.</p>'}`;
    if (busy) content.querySelectorAll('button,input').forEach(element => { element.disabled = true; });
    content.querySelectorAll('[data-drive-id]').forEach(button => button.addEventListener('click', () => {
      selectedId = button.dataset.driveId; resetBrowser(); showError(); render();
    }));
    content.querySelector('[data-index-whole]')?.addEventListener('click', () => index(['.']));
    content.querySelector('[data-choose-folders]')?.addEventListener('click', () => { browsing = true; loadFolders('.'); });
    content.querySelector('[data-index-folders]')?.addEventListener('click', () => index(compactDrivePaths([...selectedPaths])));
    content.querySelector('[data-dismiss-drive]')?.addEventListener('click', () => decide('dismiss'));
    content.querySelector('[data-keep-drive]')?.addEventListener('click', () => decide('keep'));
    content.querySelector('[data-remove-drive]')?.addEventListener('click', () => { confirmingRemoval = true; render(); content.querySelector('[data-cancel-remove]')?.focus(); });
    content.querySelector('[data-cancel-remove]')?.addEventListener('click', () => { confirmingRemoval = false; render(); });
    content.querySelector('[data-confirm-remove]')?.addEventListener('click', () => decide('remove'));
    content.querySelectorAll('[data-open-folder]').forEach(button => button.addEventListener('click', () => loadFolders(button.dataset.openFolder)));
    content.querySelectorAll('[data-select-folder]').forEach(input => input.addEventListener('change', () => {
      const path = input.dataset.selectFolder;
      if (input.checked) selectedPaths.add(path); else selectedPaths.delete(path);
      selectedPaths = new Set(compactDrivePaths([...selectedPaths]));
      render();
      [...content.querySelectorAll('[data-select-folder]')].find(item => item.dataset.selectFolder === path)?.focus();
    }));
    content.querySelectorAll('[data-unselect-folder]').forEach(button => button.addEventListener('click', () => { selectedPaths.delete(button.dataset.unselectFolder); render(); }));
    content.querySelector('[data-back-drive]')?.addEventListener('click', () => { resetBrowser(); render(); });
  }

  function renderDrive(drive) {
    const count = drive.projects?.length ?? 0;
    const description = drive.connected
      ? 'Choose what to index. Lasso reads these files and keeps searchable copies and version history on this computer.'
      : 'The drive is offline. Saved copies remain searchable, but saving and reindexing require reconnecting this drive.';
    let actions;
    if (confirmingRemoval) {
      actions = `<section class="drive-remove-confirm" aria-label="Confirm removal"><h3>Remove saved drive data?</h3><p>This removes ${count} ${count === 1 ? 'workspace' : 'workspaces'}, their indexes, cached file copies, and version history from Lasso on this computer. This cannot be undone. Original files on the drive are untouched.</p><div class="dialog-actions"><button class="secondary-button" data-cancel-remove type="button">Cancel</button><button class="primary-button drive-danger" data-confirm-remove type="button">Remove saved data</button></div></section>`;
    } else if (!drive.connected) {
      actions = `<p class="drive-retention">Keep saved data to search and review it while the drive is disconnected, or remove it from this computer.</p><div class="drive-actions"><button class="primary-button" data-keep-drive type="button">Keep saved index</button><button class="secondary-button" data-remove-drive type="button">Remove saved data…</button></div>`;
    } else if (browsing) {
      const parent = folderPath.includes('/') ? folderPath.slice(0, folderPath.lastIndexOf('/')) : '.';
      const chosen = compactDrivePaths([...selectedPaths]);
      actions = `<section class="drive-folder-picker" aria-label="Choose folders to index"><div class="drive-breadcrumb"><button class="secondary-button" type="button" data-back-drive>Back</button><strong>${escape(folderPath === '.' ? drive.name : folderPath)}</strong>${folderPath !== '.' ? `<button class="secondary-button" type="button" data-open-folder="${escape(parent)}">Up one level</button>` : ''}</div><p class="drive-help">Select folders with the checkboxes. Open a folder to choose subfolders. Selected folders include everything inside them.</p><div class="drive-folders" aria-busy="${folderLoading}">${folderLoading ? '<p>Reading folders…</p>' : folderError ? `<p role="alert">${escape(folderError)}</p>` : folders.length ? folders.map(folder => {
        const covered = chosen.some(path => folder.path.startsWith(`${path}/`));
        return `<div class="drive-folder-row"><label><input type="checkbox" data-select-folder="${escape(folder.path)}" ${selectedPaths.has(folder.path) || covered ? 'checked' : ''} ${covered ? 'disabled' : ''}><span>${escape(folder.name)}</span></label><button type="button" class="secondary-button" data-open-folder="${escape(folder.path)}" aria-label="Open folder ${escape(folder.name)}">Open</button></div>`;
      }).join('') : '<p>No subfolders in this folder.</p>'}</div><div class="drive-selection" aria-live="polite"><strong>${chosen.length} ${chosen.length === 1 ? 'folder' : 'folders'} selected</strong>${chosen.map(path => `<button type="button" data-unselect-folder="${escape(path)}" aria-label="Remove ${escape(path)} from selection">${escape(path)} <span aria-hidden="true">×</span></button>`).join('')}</div><div class="dialog-actions"><button class="primary-button" type="button" data-index-folders ${!chosen.length || folderLoading ? 'disabled' : ''}>Index selected folders</button></div></section>`;
    } else {
      actions = `<div class="drive-actions"><button class="primary-button" data-index-whole type="button">Index entire drive</button><button class="secondary-button" data-choose-folders type="button">Choose folders…</button>${drive.pendingAction === 'connected' ? '<button class="secondary-button" data-dismiss-drive type="button">Not now</button>' : ''}</div>`;
    }
    return `<section class="drive-detail"><div class="drive-detail-heading"><h3>${escape(drive.name)}</h3><span class="drive-availability ${drive.connected ? '' : 'offline'}">${drive.connected ? 'Connected' : 'Offline'}</span></div><p class="drive-root">${escape(drive.rootPath)}</p><p>${description}</p>${count ? `<p class="drive-project-count">${count} indexed ${count === 1 ? 'workspace' : 'workspaces'}: ${drive.projects.map(project => escape(project.name)).join(', ')}</p>` : ''}${busy ? '<p role="status" class="drive-busy">Working… Keep the drive connected until indexing finishes.</p>' : ''}${actions}</section>`;
  }

  function resetBrowser() { browsing = false; folderPath = '.'; folders = []; selectedPaths.clear(); folderError = ''; folderLoading = false; confirmingRemoval = false; folderRevision += 1; }
  async function loadFolders(path) {
    const drive = current();
    if (!drive?.connected) return;
    const revision = ++folderRevision;
    folderLoading = true; folderPath = path; folderError = ''; render();
    try {
      const result = await api(`${driveUrl(drive.id)}/folders?${new URLSearchParams({ path })}`);
      if (revision !== folderRevision || current()?.id !== drive.id || !current()?.connected) return;
      folders = result.folders; folderPath = result.path;
    } catch (failure) { if (revision === folderRevision) { folders = []; folderError = failure.message; } }
    finally { if (revision === folderRevision) { folderLoading = false; render(); } }
  }
  async function index(paths) {
    const drive = current();
    if (busy || !drive?.connected || !paths.length) return;
    busy = true; showError(); render();
    try {
      const result = await api(`${driveUrl(drive.id)}/index`, { method: 'POST', body: JSON.stringify({ paths, actor: getActor() }) });
      resetBrowser();
      await refresh(false);
      await onProjectsChanged?.({ preferredId: result.projects?.[0]?.id });
      onStatus?.(`${drive.name} is available in your workspaces.`);
    } catch (failure) { showError(failure.message); }
    finally { busy = false; render(); }
  }
  async function decide(action) {
    const drive = current();
    if (busy || !drive) return;
    busy = true; showError(); render();
    try {
      if (action === 'remove' && await beforeRemove?.(drive) === false) {
        showError('This drive has unsaved changes open. Reconnect it and save before removing its saved data.');
        return;
      }
      const result = await api(`${driveUrl(drive.id)}/decision`, { method: 'POST', body: JSON.stringify({ action }) });
      resetBrowser();
      await refresh(false);
      await onProjectsChanged?.({ removedProjectIds: result.removedProjectIds ?? [] });
      onStatus?.(action === 'keep' ? 'Saved copies and history are available offline.' : action === 'remove' ? 'Saved drive data removed. Original drive files are untouched.' : 'Drive indexing skipped for now.');
    } catch (failure) { showError(failure.message); }
    finally { busy = false; render(); }
  }
  async function refresh(notify = true) {
    if (fetching) { await fetching; return; }
    fetching = (async () => {
      const result = await api('/api/drives');
      trigger.hidden = !result.supported;
      if (!result.supported) { notification.hidden = true; return; }
      drives = result.drives ?? [];
      const next = JSON.stringify(drives.map(drive => [drive.id, drive.name, drive.connected, drive.pendingAction, drive.rootPath, drive.projects?.map(project => [project.id, project.availability])]));
      if (next === signature) return;
      const changed = signature !== null;
      signature = next;
      if (!current()) { selectedId = drives.find(drive => drive.pendingAction)?.id ?? drives[0]?.id ?? null; resetBrowser(); }
      if (!current()?.connected) resetBrowser();
      updateNotice(); render();
      if (changed && notify) await onProjectsChanged?.({});
    })();
    try { await fetching; } finally { fetching = null; }
  }
  async function open(id = null) {
    showError();
    try { await refresh(); } catch (failure) { showError(failure.message); }
    selectedId = drives.some(drive => drive.id === id) ? id : drives.find(drive => drive.pendingAction)?.id ?? selectedId ?? drives[0]?.id;
    resetBrowser();
    if (!dialog.open) dialog.showModal();
    trigger.setAttribute('aria-expanded', 'true'); render();
  }
  trigger.addEventListener('click', () => open());
  dialog.querySelector('[data-drive-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus(); });
  window.addEventListener('lasso-open-drives', () => open());
  window.addEventListener('lasso-drives-changed', () => { void refresh().catch(() => {}); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh().catch(() => {}); });
  return {
    start() { void refresh().catch(() => {}); timer = setInterval(() => { if (!document.hidden) void refresh().catch(() => {}); }, 2000); },
    stop() { clearInterval(timer); },
    refresh,
    open,
  };
}
