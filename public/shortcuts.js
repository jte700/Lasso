// Keyboard shortcuts for Settings, read from shortcuts.json. The Mac app's
// Settings reads the same file, so both platforms list the same actions, each
// with its own keys. An entry without keys for a platform is not shown there.

const escapeText = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The sections and shortcuts that exist on `platform`, in their listed order.
 * Malformed entries are skipped rather than shown half-filled.
 * @param {unknown} catalog The parsed shortcuts.json.
 * @param {'macos' | 'windows'} platform
 * @returns {{ title: string, note: string | null, shortcuts: { action: string, keys: string }[] }[]}
 */
export function shortcutSections(catalog, platform) {
  const sections = Array.isArray(catalog?.sections) ? catalog.sections : [];
  return sections
    .filter((section) => isText(section?.title) && Array.isArray(section.shortcuts))
    .map((section) => ({
      title: section.title,
      note: isText(section.note) ? section.note : null,
      shortcuts: section.shortcuts
        .filter((entry) => isText(entry?.action) && isText(entry[platform]))
        .map((entry) => ({ action: entry.action, keys: entry[platform] })),
    }))
    .filter((section) => section.shortcuts.length > 0);
}

/** @param {ReturnType<typeof shortcutSections>} sections */
export function shortcutListMarkup(sections) {
  return sections.map((section) => `<section class="shortcut-group">
    <h4>${escapeText(section.title)}</h4>
    ${section.note ? `<p class="shortcut-note">${escapeText(section.note)}</p>` : ''}
    <dl>${section.shortcuts.map((shortcut) => `<div class="shortcut-row"><dt>${escapeText(shortcut.action)}</dt><dd><kbd>${escapeText(shortcut.keys)}</kbd></dd></div>`).join('')}</dl>
  </section>`).join('');
}
