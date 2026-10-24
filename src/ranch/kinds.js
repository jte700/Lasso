import path from 'node:path';

// What kind of source a file is, as The Ranch groups and previews it. The Mac
// app picks the viewer from this: 3D models turn, drawings pan and zoom, and
// everything else scrolls in Quick Look.
const KINDS = [
  ['spreadsheet', ['.xlsx', '.xls', '.xlsm', '.ods', '.numbers', '.csv', '.tsv', '.gsheet']],
  ['pdf', ['.pdf']],
  ['document', ['.docx', '.doc', '.pages', '.rtf', '.odt', '.gdoc']],
  ['presentation', ['.pptx', '.ppt', '.key', '.odp', '.gslides']],
  ['model', ['.step', '.stp', '.iges', '.igs', '.stl', '.obj', '.3mf', '.ply', '.usdz', '.usd', '.dae', '.f3d', '.f3z',
    '.sldprt', '.sldasm', '.ipt', '.iam', '.catpart', '.catproduct', '.x_t', '.x_b', '.3dm']],
  ['drawing', ['.dxf', '.dwg', '.ifc', '.rvt', '.dgn', '.landxml']],
  ['image', ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.heic', '.svg']],
  ['text', ['.md', '.mdx', '.txt', '.rst', '.tex', '.log']],
];
const BY_EXTENSION = new Map(KINDS.flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind])));
const BY_FILE_TYPE = { code: 'code', json: 'code', yaml: 'code', notebook: 'code', xml: 'code', markdown: 'text', text: 'text' };

/**
 * @param {string} filePath
 * @param {string} [fileType] the type the history scanner recorded
 * @returns {string}
 */
export function sourceKind(filePath, fileType) {
  return BY_EXTENSION.get(path.extname(String(filePath ?? '')).toLowerCase()) ?? BY_FILE_TYPE[fileType] ?? 'other';
}

/** Text files small enough to read for links and file names. */
export const SCANNED_TEXT_TYPES = new Set(['markdown', 'text', 'code', 'json', 'yaml', 'xml']);
export const MAX_SCANNED_BYTES = 1024 * 1024;
