// Author names in document metadata, and the labels derived from them.

const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le',
  'ter', 'ten', 'bin', 'ibn', 'al', 'dos', 'das', 'y']);
const ORGANIZATION_AUTHOR = /\b(?:inc|ltd|llc|llp|plc|corp|corporation|company|group|team|university|institute|department|council|association|society|committee|agency|ministry|foundation|laboratory)\b/i;

// Document metadata often names an organisation or tool ("Lasso fictional
// test fixtures") rather than a person; such authors have no family name.
export function isPersonalName(value) {
  const name = String(value ?? '').replace(/[{}]/g, '').trim();
  if (!name || /[\d@]/.test(name) || ORGANIZATION_AUTHOR.test(name)) return false;
  const words = (name.includes(',') ? name.split(',')[0] : name).split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4
    && words.every((word) => NAME_PARTICLES.has(word.toLowerCase()) || /^\p{Lu}/u.test(word));
}

export function firstAuthorFamily(author = '') {
  const first = String(author).split(/\s+(?:and|&)\s+|\s*;\s*/i)[0].trim();
  if (!first || !isPersonalName(first)) return '';
  if (first.includes(',')) return first.split(',')[0].trim().replace(/[{}]/g, '');
  return first.split(/\s+/).at(-1).replace(/[{}]/g, '');
}

// Earlier indexes labelled documents with the last word of any author field.
// Their stored versions are immutable, so the title is shown in its place.
export function correctedDocumentLabel(objectType, label, metadata) {
  if (!['PAPER', 'DOCUMENT'].includes(objectType) || !metadata?.author || !metadata.title) return label;
  const first = String(metadata.author).split(/\s+(?:and|&)\s+|\s*;\s*/i)[0].trim();
  if (isPersonalName(first)) return label;
  const legacy = (first.includes(',') ? first.split(',')[0] : first.split(/\s+/).at(-1) ?? '').replace(/[{}]/g, '').trim();
  return legacy && (label === legacy || label.startsWith(`${legacy} et al.`) || label.startsWith(`${legacy},`))
    ? metadata.title : label;
}
