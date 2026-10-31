// The page's shared state: the saved identity, the open project and editor, and the elements the workbench reads.
export const desktop = window.lassoPlatform;

export const shortcut = (key, shift = false) => desktop?.shortcut(key, shift) ?? `${shift ? '⇧' : ''}⌘${key}`;

export const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;
export const RECOMMENDATION_SESSION_ID = crypto.randomUUID();
export const AUTOMATIC_SUGGESTION_LIMIT = 5;

export const state = {
  projects: [],
  workspace: { directories: [], activeProjectIds: [], revision: null },
  project: null,
  preview: null,
  identity: loadIdentity(),
  statusTimer: null,
  projectSwitchRevision: 0,
  view: 'timeline',
  editor: {
    documents: [], document: null, dirty: false, prediction: null, predictionIndex: 0,
    predictionTimer: null, predictionController: null,
    activeBlock: null, manualClaim: null, pickerMode: 'link',
    revealDependencyId: null, revealTimer: null,
    pendingLinks: [], autosaveTimer: null, savePromise: null, editRevision: 0,
    undoStack: [], redoStack: [], restoringHistory: false, lastHistoryAt: 0, lastHistoryType: null,
    activeDependencyId: null, sourcePeekTimer: null, sourcePeekRequest: 0,
    navigationRevision: 0, pickerTimer: null, pickerController: null,
    inspectorRequest: 0, viewerRequest: 0, sharingRequest: 0,
  },
};

export const elements = Object.fromEntries([
  'project-select', 'project-name', 'project-path', 'detail-column', 'import-button', 'identity-button', 'avatar-initials', 'import-dialog',
  'import-form', 'identity-dialog', 'identity-form', 'toast-region',
  'editor-nav', 'ribbon-editor',
  'window-project-name', 'status-message', 'status-project', 'status-version', 'status-files', 'status-identity',
].map((id) => [id, document.getElementById(id)]));

function loadIdentity() {
  try {
    const saved = JSON.parse(localStorage.getItem('lasso.identity') ?? localStorage.getItem('colab.identity'));
    // Earlier builds silently saved a fictional demo identity on first load.
    if (saved?.id === 'human-self:maya-chen' && saved.displayName === 'Maya Chen') return defaultIdentity();
    return saved ?? defaultIdentity();
  } catch { return defaultIdentity(); }
}

function defaultIdentity() {
  return { id: 'human-self:local-user', displayName: 'Local user', actorType: 'HUMAN_SELF' };
}

export function identityId(name, type) {
  return `${type.toLowerCase()}:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
}

function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

export function setIdentity(identity) {
  state.identity = identity;
  localStorage.setItem('lasso.identity', JSON.stringify(identity));
  elements['avatar-initials'].textContent = initials(identity.displayName);
  const sidebarName = document.getElementById('sidebar-identity-name');
  const sidebarRole = document.getElementById('sidebar-identity-role');
  if (sidebarName) sidebarName.textContent = identity.displayName;
  if (sidebarRole) sidebarRole.textContent = identity.actorType === 'HUMAN_COLLABORATOR' ? 'Collaborator' : 'Local workspace';
  if (elements['status-identity']) elements['status-identity'].textContent = identity.displayName;
}
