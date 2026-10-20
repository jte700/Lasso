// How the complete view of a text source is divided into sections. Text
// redactions address those sections by index, so a share records the layout
// it was made with and keeps it even if the default layout later changes.

import path from 'node:path';
import { MARKDOWN_LAYOUT, isMarkdownPath } from './markdown.js';

/** XML reads line by line, so its complete view keeps one section per source line. */
export const LINE_LAYOUT = 'lines';
const LINE_LAYOUT_EXTENSIONS = new Set(['.xml', '.landxml']);

/** The structured section layout of a complete text document, or null for paragraph blocks. */
export function fullTextLayout(filePath) {
  if (isMarkdownPath(filePath)) return MARKDOWN_LAYOUT;
  return LINE_LAYOUT_EXTENSIONS.has(path.extname(String(filePath ?? '')).toLowerCase()) ? LINE_LAYOUT : null;
}
