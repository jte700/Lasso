import path from 'node:path';

const MARKDOWN = new Set(['.md', '.mdx', '.qmd', '.rmd', '.rst']);
const TEXT = new Set(['.txt', '.tex', '.bib', '.ris', '.enw', '.nbib', '.log']);
const CODE = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.r', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.kt', '.kts', '.sh', '.zsh', '.fish', '.sql',
  '.html', '.css', '.scss', '.vue', '.svelte', '.toml', '.ini', '.env',
]);
const TABLE = new Set(['.csv', '.tsv']);
const SPREADSHEET = new Set(['.xlsx', '.xls', '.ods']);
const JSON_TYPES = new Set(['.json', '.geojson']);
const YAML = new Set(['.yaml', '.yml']);
const NOTEBOOK = new Set(['.ipynb']);
const DOCUMENT = new Set(['.docx']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tif', '.tiff', '.svg']);
const PDF = new Set(['.pdf']);
const DRAWING = new Set(['.ifc', '.dxf', '.dwg', '.rvt', '.dgn', '.landxml', '.step', '.stp',
  // Native CAD formats are retained with export guidance rather than parsed.
  '.sldprt', '.sldasm', '.ipt', '.iam', '.f3d', '.catpart', '.catproduct', '.x_t', '.x_b', '.igs', '.iges', '.3dm']);

export function detectFileType(filePath) {
  const name = path.basename(filePath).toLowerCase();
  const extension = path.extname(name);
  if (NOTEBOOK.has(extension)) return 'notebook';
  if (MARKDOWN.has(extension)) return 'markdown';
  if (TABLE.has(extension)) return 'table';
  if (SPREADSHEET.has(extension)) return 'spreadsheet';
  if (JSON_TYPES.has(extension)) return 'json';
  if (YAML.has(extension)) return 'yaml';
  if (CODE.has(extension) || name === 'dockerfile' || name === 'makefile') return 'code';
  if (TEXT.has(extension)) return 'text';
  if (DOCUMENT.has(extension)) return 'document';
  if (IMAGE.has(extension)) return 'image';
  if (PDF.has(extension)) return 'pdf';
  if (DRAWING.has(extension)) return 'drawing';
  if (extension === '.xml') return 'xml';
  return 'binary';
}

export function isTextualType(type) {
  return new Set(['notebook', 'markdown', 'table', 'json', 'yaml', 'code', 'text']).has(type);
}

// Files that appear while another app works and vanish again: Office owner
// files (~$Budget.xlsx), LibreOffice locks, partial downloads, and system
// metadata such as AppleDouble (._) files on external drives. Tracking them
// recorded "Added" and "Removed" history each time a document was opened.
const UNTRACKED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'Icon\r']);
const UNTRACKED_PREFIXES = ['.~', '~$', '._'];
const UNTRACKED_EXTENSIONS = new Set(['.tmp', '.crdownload', '.part', '.download']);

export function isTrackedFile(filePath) {
  const base = path.basename(filePath);
  if (UNTRACKED_NAMES.has(base) || UNTRACKED_PREFIXES.some((prefix) => base.startsWith(prefix))) return false;
  return !UNTRACKED_EXTENSIONS.has(path.extname(base).toLowerCase());
}
