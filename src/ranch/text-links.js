// What a text file points at: Lasso share links someone sent (a mail item from
// a connected app, a note, a README) and other files it names by file name.
// Both come from the file's own words; nothing is guessed from its contents.

// A share page is /d/<token> on whatever host made it: this Mac, or another
// Lasso behind its SHARE_BASE_URL. Lasso's tokens are exactly 32 URL-safe
// characters (24 random bytes), which keeps Google Docs and Drive addresses,
// whose /d/ ids are longer or shorter, out.
const SHARE_URL = /\bhttps?:\/\/[^\s<>()"'`\]]+?\/d\/([A-Za-z0-9_-]{32})(?=$|[/?#\s<>()"'`\],.;:!])/g;

// A file name as text writes it: no spaces, a name, a dot and a short
// extension. Paths and Markdown links ("see [plan](Drawings/Plan-A.pdf)") keep
// only their last part.
const FILE_NAME = /[^\s"'`<>()[\]{}|*?:;,\\]+\.[A-Za-z][A-Za-z0-9]{1,4}(?![A-Za-z0-9])/g;

/** Mentions past this are ignored; a file listing every other file says little. */
export const MAX_MENTIONS = 64;

/**
 * @param {string} text
 * @returns {{ url: string, token: string }[]} each distinct link once, in order
 */
export function shareLinksIn(text) {
  const seen = new Set();
  const links = [];
  for (const match of String(text ?? '').matchAll(SHARE_URL)) {
    const url = match[0].replace(/[.,;:!?]+$/, '');
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    links.push({ url, token: match[1] });
  }
  return links;
}

/**
 * @param {string} text
 * @returns {string[]} lower-case file names the text mentions, each once
 */
export function fileNamesIn(text) {
  const names = new Set();
  for (const match of String(text ?? '').matchAll(FILE_NAME)) {
    if (/^https?:/i.test(match[0]) || match[0].includes('@')) continue;
    let name = match[0].replace(/[.,;:!?]+$/, '').split('/').pop();
    try { name = decodeURIComponent(name); } catch { /* keep it as written */ }
    if (name.length < 5) continue;
    names.add(name.toLowerCase());
    if (names.size >= MAX_MENTIONS) break;
  }
  return [...names];
}
