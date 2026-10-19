import path from 'node:path';

// Formats a browser displays without running script. Anything else from a
// work directory, such as HTML or SVG, is downloaded instead of opened, so it
// can never run with the local API's origin.
const PASSIVE_INLINE_TYPES = Object.freeze({
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
});

/**
 * @param {string} filePath
 * @returns {string | null} the content type to show it inline, or null when it must be downloaded
 */
export function passiveInlineType(filePath) {
  return PASSIVE_INLINE_TYPES[path.extname(String(filePath)).toLowerCase()] ?? null;
}
