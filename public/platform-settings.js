// Windows settings: the chosen theme and the list of keyboard shortcuts.
import { shortcutSections, shortcutListMarkup } from './shortcuts.js';
import { desktop } from './state.js?v=1';
import { api } from './api.js?v=1';

// Windows keeps a chosen theme in its settings; macOS follows the system.
export function currentTheme() {
  try { return localStorage.getItem('lasso.theme') ?? localStorage.getItem('colab.theme') ?? 'system'; } catch { return 'system'; }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'carbon' : 'alabaster') : theme;
  try { localStorage.setItem('lasso.theme', theme); } catch { /* presentation only */ }
  desktop?.postMessage({ action: 'appearance', dark: document.documentElement.dataset.theme !== 'alabaster' });
}

// Settings lists the shortcuts from the file the Mac app's Settings reads too.
let shortcutsShown = false;
export async function showShortcuts(list) {
  if (!list || shortcutsShown) return;
  try {
    const sections = shortcutSections(await api('/shortcuts.json'), desktop?.name ?? 'macos');
    if (!sections.length) throw new Error('The shortcut list is empty.');
    list.innerHTML = shortcutListMarkup(sections);
    shortcutsShown = true;
  } catch {
    list.textContent = 'Keyboard shortcuts could not be loaded. Close Settings and open it again to try again.';
  }
}
