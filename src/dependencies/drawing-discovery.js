// Discovery names are derived at read time, so older immutable drawing rows
// remain usable without rewriting their source labels or versioned metadata.
const words = value => String(value ?? '').normalize('NFKC')
  .replace(/([a-z\d])([A-Z])/g, '$1 $2').toLocaleLowerCase('en-US')
  .match(/[\p{L}\p{N}]+/gu) ?? [];
const normalized = value => words(value).join(' ');
const humanStem = filename => filename.replace(/\.[^.]+$/, '').replace(/([a-z\d])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
const genericTitle = value => !value || /^(?:\d+|(?:ifc|cad|bim)?\s*model|drawing(?:\s*[·:-]?\s*page\s*\d+)?)$/i.test(value.trim());
const ambiguousSingleAlias = new Set(['floor', 'plan', 'building', 'model', 'architectural', 'civil', 'engineering', 'cad', 'bim']);

/** Human-facing names and conservative aliases for a whole indexed drawing. */
export function drawingDiscovery(object) {
  if (object?.objectType !== 'DRAWING') return null;
  const metadata = object.metadata ?? {};
  const filename = String(object.path ?? '').replaceAll('\\', '/').split('/').pop() ?? '';
  const stem = humanStem(filename);
  const explicitTitle = [object.label, metadata.title].find(value => typeof value === 'string' && !genericTitle(value));
  const title = explicitTitle && explicitTitle !== filename ? explicitTitle.trim() : '';
  const label = stem && title && normalized(stem) !== normalized(title) ? `${stem} · ${title}`
    : stem || title || 'Drawing';
  const format = String(metadata.format ?? filename.split('.').pop() ?? '').toUpperCase();
  const aliases = ['drawing'];
  const unavailable = ['unsupported', 'failed', 'error'].includes(String(metadata.extractionStatus ?? '').toLowerCase());
  const excerpt = String(metadata.textExcerpt ?? '').slice(0, 20_000);
  // A suffix alone cannot certify a parsed building model. Legacy IFC rows
  // carry a measurement count and/or a parser summary, rather than room names.
  const ifcEvidence = metadata.format?.toUpperCase?.() === 'IFC' && !unavailable
    && (Number(metadata.annotationCount) > 0
      || /\bIFCSPACE\b|\bIFCBUILDING(?:STOREY)?\b/i.test(excerpt)
      || metadata.extraction === 'ifc-properties' && /\bIFC(?:2X3|4(?:X\d+)?)[^\n]*\b\d+\s+entities\b/i.test(excerpt));
  if (format === 'IFC' && ifcEvidence) aliases.push('floor plan', 'floorplan', 'architectural drawing', 'building model', 'BIM model', 'IFC model');
  else if (format === 'DXF' && !unavailable) aliases.push('CAD drawing', 'CAD plan');
  else if (format === 'LANDXML' && !unavailable) aliases.push('civil drawing', 'civil engineering plan', 'civil model', 'LandXML model');
  return { label, aliases, filename, format,
    searchText: [...new Set([label, filename, stem, explicitTitle, ...aliases].filter(Boolean))].join(' ') };
}

function phraseMatch(candidate, query) {
  const source = words(candidate);
  if (!source.length || !query.length) return null;
  // Every query term must match in order. Only the last term may be unfinished;
  // extra prose cannot fall back to one matching word such as "plan".
  let position = 0;
  for (let index = 0; index < query.length; index++) {
    const term = query[index], last = index === query.length - 1;
    const found = source.findIndex((word, at) => at >= position
      && (word === term || last && term.length >= (query.length > 1 ? 2 : 3) && word.startsWith(term)));
    if (found < 0) return null;
    position = found + 1;
  }
  return normalized(candidate) === query.join(' ') ? 'exact' : 'prefix';
}

/** Return null, or a suggestion {label, score}, without changing the source. */
export function drawingReferenceMatch(object, query) {
  const discovery = drawingDiscovery(object);
  if (!discovery) return null;
  const terms = words(query);
  if (!terms.length || terms.length > 12 || terms.join('').length < 3) return null;
  const metadata = object.metadata ?? {};
  const names = [...new Set([discovery.filename, humanStem(discovery.filename),
    object.label, metadata.title].filter(value => value && !genericTitle(String(value))))];
  for (const name of names) {
    const match = phraseMatch(name, terms);
    if (match) return { label: discovery.label, score: match === 'exact' ? .98 : .93, matchedBy: 'filename-or-title' };
  }
  if (terms.length === 1 && ambiguousSingleAlias.has(terms[0])) return null;
  for (const alias of discovery.aliases) {
    const aliasWords = words(alias);
    // "floor" is not an abbreviation of floorplan; require the distinguishing
    // letter. Other multiword aliases also need at least two typed terms.
    if (terms.length === 1 && (aliasWords.length > 1 || alias === 'floorplan' && terms[0].length < 6)) continue;
    const candidates = [alias, ...names.flatMap(name => [`${name} ${alias}`, `${alias} ${name}`])];
    for (const candidate of candidates) {
      const match = phraseMatch(candidate, terms);
      if (match) return { label: discovery.label, score: match === 'exact' ? .94 : .89, matchedBy: 'drawing-alias' };
    }
  }
  return null;
}
