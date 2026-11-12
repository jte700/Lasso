// Which slides of a .pptx changed between two versions, from each part's
// checksum, size and stored bytes, without inflating any slide, so an edit to
// one slide re-reads only that slide (as workbook-parts.js does for sheets).
// The deck's outline and passages are still made from every slide; what is
// carried is each unchanged slide's reading.

import { relationships, relationshipsPart, relationshipTarget, slideParts } from './presentation-extraction.js';
import { partStamp, zipBytes } from './zip-archive.js';

const PRESENTATION_PART = 'ppt/presentation.xml';
// Parts every slide is read with: the slide list and its relationships.
const SHARED_PARTS = [PRESENTATION_PART, 'ppt/_rels/presentation.xml.rels'];
// ...and the layouts, masters and theme slides are drawn on.
const SHARED_FOLDERS = ['ppt/slideLayouts/', 'ppt/slideMasters/', 'ppt/theme/'];
// The parts a slide links to that its reading includes: its charts and SmartArt words.
const READ_LINKS = /\/(?:chart|diagramData)$/;
const MAX_RELS_BYTES = 1_000_000;

/**
 * Each slide of a deck (an opened zip) in slide-list order, { part,
 * signature }, where the signature changes exactly when anything the slide
 * is read with changes: its own part, its relationships and the charts and
 * SmartArt they link, or a part every slide reads. Null for anything that is
 * not a readable deck, or one without slides.
 */
export function slideSignatures(zip) {
  if (!zip?.has?.(PRESENTATION_PART)) return null;
  const slides = slideParts(zip);
  if (!slides.length) return null;
  const sharedNames = [...SHARED_PARTS, ...[...zip.keys()].filter((name) => SHARED_FOLDERS.some((folder) => name.startsWith(folder))).sort()];
  const shared = sharedNames.map((name) => partStamp(zip, name)).join('|');
  return slides.map(({ part }) => {
    const relsName = relationshipsPart(part);
    const rels = zipBytes(zip.get(relsName), MAX_RELS_BYTES)?.toString('utf8') ?? '';
    const linked = relationships(rels).filter((relation) => !relation.external && READ_LINKS.test(relation.type))
      .map((relation) => relationshipTarget(part, relation.target));
    const own = [part, relsName, ...[...new Set(linked)].sort()].map((name) => partStamp(zip, name)).join('|');
    return { part, signature: `${own}|${shared}` };
  });
}

/**
 * A slide cache for readPresentation over `store` (get and set by key), whose
 * keys start with `prefix`, such as the file's identity and path.
 */
export function deckSlideCache(store, prefix = '') {
  return {
    signatures: (zip) => new Map((slideSignatures(zip) ?? []).map(({ part, signature }) => [part, signature])),
    get: (signature) => store.get(`${prefix}${signature}`),
    set: (signature, reading) => store.set(`${prefix}${signature}`, reading),
  };
}
