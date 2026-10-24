// Files that are one thing in several forms: a part's STEP model, its PDF
// drawing and its cost sheet, or a report and its exported copy. They share a
// distinctive name, so The Ranch connects them even before anyone links them.

// Names too common to say two files belong together.
const GENERIC_STEMS = new Set([
  'readme', 'index', 'notes', 'note', 'data', 'draft', 'final', 'copy', 'untitled', 'document', 'sheet',
  'book', 'report', 'summary', 'image', 'scan', 'file', 'new', 'test', 'temp', 'main', 'export', 'output',
  'input', 'template', 'backup', 'archive', 'list', 'table', 'figure', 'page', 'drawing', 'model', 'part',
]);

/** A group larger than this is a naming convention, not one thing. */
export const MAX_GROUP_SIZE = 6;
const MIN_STEM_LENGTH = 4;

/**
 * "Bracket-Rev2.STEP" → "bracket", "Site Plan (1).pdf" → "site plan".
 * @param {string} fileName
 * @returns {string}
 */
export function nameStem(fileName) {
  const base = String(fileName ?? '').split('/').pop();
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
    .replace(/\s*\(\d+\)$/, '')
    .replace(/[\s_-]+(?:copy|final|draft|export(?:ed)?)$/, '')
    .replace(/[\s_-]*(?:rev|v|version)[\s_-]?[a-z0-9]{1,3}$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * @template {{ key: string, name: string }} File
 * @param {File[]} files
 * @returns {string[][]} keys of files that share a distinctive stem, two or more per group
 */
export function nameGroups(files) {
  const byStem = new Map();
  for (const file of files) {
    const stem = nameStem(file.name);
    if (stem.length < MIN_STEM_LENGTH || GENERIC_STEMS.has(stem) || /^\d+$/.test(stem.replaceAll(' ', ''))) continue;
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(file.key);
  }
  return [...byStem.values()].filter((keys) => keys.length >= 2 && keys.length <= MAX_GROUP_SIZE);
}
