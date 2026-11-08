const MAX_SENTENCES = 12_000;
const MAX_SENTENCE_LENGTH = 420;

const CONCEPT_GROUPS = [
  ['result', 'results', 'finding', 'findings', 'observation', 'observations'],
  ['show', 'shows', 'showed', 'shown', 'indicate', 'indicates', 'indicated', 'suggest', 'suggests', 'suggested', 'demonstrate', 'demonstrates', 'demonstrated', 'reveal', 'reveals', 'revealed'],
  ['increase', 'increases', 'increased', 'increasing', 'higher', 'elevated', 'rise', 'rises', 'rose'],
  ['decrease', 'decreases', 'decreased', 'decreasing', 'lower', 'reduced', 'reduction', 'decline', 'declined'],
  ['associate', 'associated', 'association', 'correlate', 'correlated', 'correlation', 'relationship', 'relationships'],
  ['participant', 'participants', 'patient', 'patients', 'sample', 'samples', 'cohort', 'cohorts', 'subject', 'subjects'],
  ['analyze', 'analyzed', 'analysis', 'analyses', 'evaluate', 'evaluated', 'evaluation'],
  ['measure', 'measured', 'measurement', 'measurements', 'quantify', 'quantified', 'quantification'],
  ['use', 'uses', 'used', 'using', 'employ', 'employed', 'apply', 'applied'],
  ['significant', 'significantly', 'significance'],
];

const CONCEPTS = new Map();
for (const group of CONCEPT_GROUPS) for (const word of group) CONCEPTS.set(word, group[0]);
const SEMANTIC_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from', 'has', 'have', 'in', 'is',
  'it', 'of', 'on', 'or', 'that', 'the', 'these', 'this', 'to', 'was', 'were', 'with', 'we', 'our',
]);

function stem(word) {
  let value = word.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9-]/g, '');
  if (CONCEPTS.has(value)) return CONCEPTS.get(value);
  if (value.length > 6 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 5 && value.endsWith('ied')) value = `${value.slice(0, -3)}y`;
  else if (value.length > 5 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 5 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('s')) value = value.slice(0, -1);
  return CONCEPTS.get(value) ?? value;
}

function tokens(value) {
  return [...String(value ?? '').matchAll(/[A-Za-z][A-Za-z0-9'’-]*/g)].map((match) => ({
    raw: match[0], key: stem(match[0]), start: match.index, end: match.index + match[0].length,
  }));
}

function cleanLine(value) {
  return String(value ?? '')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// A sentence is offered once it has this much to it. A slide's title or
// bullet is complete in a few words, so a deck's sources ask for less.
const SENTENCE_LIMITS = Object.freeze({ minLength: 18, minWords: 4 });

function sourceSentences(text, { minLength, minWords } = SENTENCE_LIMITS) {
  const withoutCode = String(text ?? '').replace(/```[\s\S]*?```/g, '\n');
  const lines = withoutCode.split(/\n+/).map(cleanLine).filter(Boolean);
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const output = [];
  for (const line of lines) {
    for (const part of segmenter.segment(line)) {
      const sentence = cleanLine(part.segment);
      const wordCount = tokens(sentence).length;
      if (sentence.length >= minLength && sentence.length <= MAX_SENTENCE_LENGTH && wordCount >= minWords
        && !/^(?:https?:\/\/|www\.)/i.test(sentence)) output.push(sentence);
    }
  }
  return output;
}

/** `source.limits` may lower how much a sentence needs to be offered, as a deck's do. */
export function buildSentenceCorpus(sources) {
  const corpus = [];
  const seen = new Set();
  for (const source of sources) {
    for (const sentence of sourceSentences(source.text, source.limits ?? SENTENCE_LIMITS)) {
      // Bibliography entries are independently citable even in one file.
      const sourceKey = source.dependencyCandidate?.objectType === 'REFERENCE'
        ? source.dependencyCandidate.id : source.path;
      const fingerprint = `${sourceKey}\u0000${sentence.toLowerCase().replace(/\W+/g, ' ').trim()}`;
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      corpus.push({
        sentence,
        path: source.path,
        snapshotId: source.snapshotId,
        dependencyCandidate: source.dependencyCandidate ?? null,
        tokens: tokens(sentence),
        ...(source.limits ? { compact: true } : {}),
      });
      if (corpus.length >= MAX_SENTENCES) return corpus;
    }
  }
  return corpus;
}

function trailingSentence(text, cursor) {
  const before = String(text ?? '').slice(0, cursor);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  return before.slice(boundary + 1).replace(/^\s+/, '');
}

function trailingSentenceStart(text, cursor) {
  const before = String(text ?? '').slice(0, cursor);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  const remainder = before.slice(boundary + 1);
  return boundary + 1 + (remainder.match(/^\s+/)?.[0].length ?? 0);
}

export function sourceFindingFragment(text, cursor, sourceEnd = 0) {
  const before = String(text ?? '').slice(0, cursor);
  const scoped = before.slice(Math.max(0, sourceEnd));
  const attributedCue = /\b(?:the\s+)?(?:authors?|researchers?|investigators?|study|paper|article|they)\s+(?:found|reported|observed|showed|demonstrated|identified|concluded|noted|revealed)(?:\s+that)?\s*([^.!?]*)$/i;
  // The accepted citation anchor is itself the grammatical subject in sentences
  // such as "Mohammad et al. (2021) found that ...". Because `scoped` starts
  // exactly after that anchor, a leading reporting verb is unambiguously tied to
  // the linked paper and does not need a second "the authors" subject.
  const citationCue = /^\s*[,;:]?\s*(?:found|reported|observed|showed|demonstrated|identified|concluded|noted|revealed)(?:\s+that)?\s*([^.!?]*)$/i;
  const cue = scoped.match(attributedCue) ?? (sourceEnd > 0 ? scoped.match(citationCue) : null);
  if (!cue) return null;
  const raw = cue[1] ?? '';
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  return {
    text: raw.trim(),
    start: cursor - raw.length + leading,
    end: cursor,
  };
}

function findingClause(sentence) {
  let value = String(sentence ?? '').trim()
    .replace(/([A-Za-z])\s+-\s+([a-z])/g, '$1$2')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')');
  value = value.replace(/^(?:moreover|interestingly|further|finally|collectively),\s+/i, '');
  value = value.replace(/^(?:we|researchers?|investigators?|the\s+(?:authors?|study|analysis|results?))\s+(?:found|reported|observed|showed|demonstrated|identified|concluded|noted|revealed)(?:\s+that)?\s+/i, '');
  value = value
    .replace(/\bshowed (?:a )?significant differences? between\b/i, 'differed significantly between')
    .replace(/\bmetabolites that were different\b/i, 'metabolites that differed')
    .replace(/^placental stress marker,\s*([^,]+)\s+showed correlation with\b/i, '$1, a placental stress marker, correlated with')
    .replace(/\b(\d+) of these were found in lower concentrations\b/i, '$1 were present at lower concentrations');
  if (/^[A-Z][a-z]/.test(value)) value = `${value[0].toLowerCase()}${value.slice(1)}`;
  return value;
}

// Accepted findings may be grammatical clauses rather than literal source
// substrings. Resolve them with the same deterministic transformation, using
// only text from the pinned source version instead of a client-supplied quote.
export function originalFindingSentence(text, finding) {
  const expected = cleanLine(finding).toLowerCase();
  if (!expected) return null;
  return sourceSentences(text).find(sentence => findingClause(sentence).toLowerCase() === expected) ?? null;
}

function findingQuality(sentence, clause) {
  const raw = String(sentence ?? '').trim();
  const value = String(clause ?? '').trim();
  if (!value || tokens(value).length < 5) return 0;
  // PDF comparison tables commonly flatten their Method and Result columns into
  // one line. Those rows are evidence, but they are not prose suitable for
  // insertion after "found that"; prefer the article's narrative statement.
  if (/^(?:un)?targeted\b/i.test(raw)
    || /^study\s+\d+\s*:/i.test(raw)
    || /^\(?\d{4}\)?\s+(?:C\/S|N\s*=)/i.test(raw)) return 0;
  if (/(?:\bFig\.|\bTable\s+\d*)$/i.test(value)) return 0;
  return 1;
}

export function findingSignal(sentence) {
  const signals = String(sentence ?? '').match(/\b(?:found|show\w*|observ\w*|demonstrat\w*|reveal\w*|indicat\w*|suggest\w*|associat\w*|correlat\w*|increas\w*|decreas\w*|higher|lower|elevat\w*|reduc\w*|significant\w*|majority|compared|risk|effect|difference|levels?|fold|odds|ratio)\b/gi)?.length ?? 0;
  if (!signals) return 0;
  return Math.min(1, signals * 0.32 + (/\d/.test(sentence) ? 0.22 : 0) + (tokens(sentence).length >= 8 ? 0.12 : 0));
}

function contentKeys(items) {
  return new Set(items.map((item) => item.key).filter((key) => key.length > 1 && !SEMANTIC_STOP_WORDS.has(key)));
}

function overlap(left, right) {
  const a = contentKeys(left);
  const b = contentKeys(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / Math.max(2, Math.min(a.size, b.size));
}

function bestSemanticContinuation(fragment, queryTokens, entry) {
  const candidateTokens = entry.tokens;
  const maximum = Math.min(6, queryTokens.length, candidateTokens.length);
  let best = null;
  for (let length = maximum; length >= 2 && !best; length -= 1) {
    const query = queryTokens.slice(-length);
    for (let start = 0; start + length <= candidateTokens.length; start += 1) {
      const candidate = candidateTokens.slice(start, start + length);
      const last = length - 1;
      const matches = candidate.every((token, index) => token.key === query[index].key
        || (index === last && query[index].raw.length >= 3
          && token.raw.toLowerCase().startsWith(query[index].raw.toLowerCase())));
      if (!matches) continue;
      const partialLastToken = candidate[last].raw.toLowerCase().startsWith(query[last].raw.toLowerCase())
        && candidate[last].raw.length > query[last].raw.length;
      const insertionStart = partialLastToken
        ? candidate[last].start + query[last].raw.length
        : candidate[last].end;
      const insertText = entry.sentence.slice(insertionStart);
      if (insertText.trim().length < 3) continue;
      const semanticOverlap = overlap(queryTokens, candidateTokens);
      // A slide's title or bullet too short to be a sentence elsewhere is
      // matched as far as it goes: from its first word, all of it is aligned.
      const short = entry.compact && candidateTokens.length < SENTENCE_LIMITS.minWords;
      const alignment = length / (short ? start + length : Math.min(6, Math.max(3, queryTokens.length)));
      best = { insertText, score: alignment * 0.62 + semanticOverlap * 0.33, matchedTokens: length };
      break;
    }
  }
  return best;
}

// Where each word appears, as sentence and word positions in corpus order, kept with the corpus.
const wordPlaces = new WeakMap();

/** Indexes a corpus's words for completion, once; Lasso does this before anyone types. */
export function indexSentenceCorpus(corpus) {
  let index = wordPlaces.get(corpus);
  if (!index) {
    index = new Map();
    corpus.forEach((entry, position) => entry.tokens.forEach((token, place) => {
      if (!index.has(token.key)) index.set(token.key, []);
      index.get(token.key).push(position, place);
    }));
    wordPlaces.set(corpus, index);
  }
  return index;
}

/**
 * The sentences, in corpus order, where the word before the last one typed is
 * followed by a word the last one is or begins. A sentence that begins with
 * what is typed has that pair, and so does any run of its last words.
 */
function sentencesContinuing(corpus, before, last) {
  const index = indexSentenceCorpus(corpus);
  const typed = last.raw.toLowerCase();
  const output = [];
  const places = index.get(before.key) ?? [];
  for (let at = 0; at < places.length; at += 2) {
    if (output.at(-1) === places[at]) continue;
    const next = corpus[places[at]].tokens[places[at + 1] + 1];
    if (next && (next.key === last.key || next.raw.toLowerCase().startsWith(typed))) output.push(places[at]);
  }
  return output;
}

/** `options.include` leaves sentences out without copying the corpus, so its index is kept. */
export function completeSentence(corpus, input, options = {}) {
  const text = String(input.text ?? '');
  const cursor = Number.isInteger(input.cursor) ? input.cursor : text.length;
  if (cursor !== text.length || /[.!?]\s*$/.test(text)) return null;
  const fragment = trailingSentence(text, cursor);
  const queryTokens = tokens(fragment);
  if (fragment.length < 8 || queryTokens.length < 2) return null;

  let best = null;
  const candidates = [];
  for (const position of sentencesContinuing(corpus, queryTokens.at(-2), queryTokens.at(-1))) {
    const entry = corpus[position];
    if (options.include && !options.include(entry)) continue;
    if (input.documentPath && entry.path === input.documentPath) continue;
    const lowerSentence = entry.sentence.toLowerCase();
    const lowerFragment = fragment.toLowerCase();
    let match = null;
    if (lowerSentence.startsWith(lowerFragment)) {
      const insertText = entry.sentence.slice(fragment.length);
      if (insertText.trim().length >= 3) match = { insertText, score: 0.99, matchedTokens: queryTokens.length, matchKind: 'PREFIX' };
    } else {
      match = bestSemanticContinuation(fragment, queryTokens, entry);
      if (match) match.matchKind = 'SEMANTIC_SEQUENCE';
    }
    if (!match || match.score < 0.54 || match.insertText.length > 260) continue;
    const candidate = {
      insertText: match.insertText,
      sourceSentence: entry.sentence,
      claimStart: trailingSentenceStart(text, cursor),
      completedText: `${fragment}${match.insertText}`,
      confidence: Number(Math.min(0.99, match.score).toFixed(3)),
      matchKind: match.matchKind,
      source: {
        path: entry.path,
        snapshotId: entry.snapshotId,
        objectId: entry.dependencyCandidate?.id ?? null,
        objectType: entry.dependencyCandidate?.objectType ?? null,
        label: entry.dependencyCandidate?.label ?? null,
      },
      dependencyCandidate: entry.dependencyCandidate
        ? { ...entry.dependencyCandidate, score: Number(Math.min(0.99, match.score).toFixed(3)), reasons: ['matching project sentence'] }
        : null,
      generated: false,
    };
    if (options.rank) candidates.push(candidate);
    if (!best || candidate.confidence > best.confidence
      || (candidate.confidence === best.confidence && candidate.insertText.length < best.insertText.length)
      || (candidate.confidence === best.confidence && candidate.insertText.length === best.insertText.length
        && candidate.source.path.localeCompare(best.source.path) < 0)) best = candidate;
  }
  if (options.rank) {
    candidates.sort((left, right) => right.confidence - left.confidence
      || left.insertText.length - right.insertText.length
      || left.source.path.localeCompare(right.source.path));
    return options.rank(candidates)[0] ?? null;
  }
  return best;
}

export function completeFromLinkedSource(corpus, input, source, options = {}) {
  const cursor = Number.isInteger(input.cursor) ? input.cursor : String(input.text ?? '').length;
  if (cursor !== String(input.text ?? '').length) return [];
  const fragment = sourceFindingFragment(input.text, cursor, options.sourceEnd ?? 0);
  if (!fragment) return [];
  const fragmentTokens = tokens(fragment.text);
  const title = String(source?.metadata?.title ?? source?.valueText ?? '').toLowerCase().trim();
  const seen = new Set();
  const findings = [];
  for (const [index, entry] of corpus.entries()) {
    if (entry.dependencyCandidate?.id !== source?.id) continue;
    if (entry.sentence.toLowerCase().trim() === title) continue;
    const clause = findingClause(entry.sentence);
    const fingerprint = clause.toLowerCase().replace(/\W+/g, ' ').trim();
    const quality = findingQuality(entry.sentence, clause);
    if (!fingerprint || seen.has(fingerprint) || !quality || findingSignal(entry.sentence) < 0.2) continue;
    seen.add(fingerprint);
    const lowerClause = clause.toLowerCase();
    const lowerFragment = fragment.text.toLowerCase();
    const semanticOverlap = fragmentTokens.length ? overlap(fragmentTokens, tokens(clause)) : 0;
    const prefix = lowerFragment && lowerClause.startsWith(lowerFragment) ? 1 : 0;
    const contains = lowerFragment && lowerClause.includes(lowerFragment) ? 1 : 0;
    const relevance = lowerFragment ? prefix * 0.72 + contains * 0.18 + semanticOverlap * 0.34 : findingSignal(entry.sentence);
    if (lowerFragment && relevance < 0.18) continue;
    const confidence = Number(Math.min(0.99, 0.48 + relevance * 0.48).toFixed(3));
    findings.push({
      id: `${source.id}:finding:${index}`,
      replacementText: clause,
      sourceSentence: entry.sentence,
      claimStart: fragment.start,
      claimEnd: fragment.end,
      confidence,
      dependencyCandidate: {
        ...source,
        score: confidence,
        reasons: ['continued from linked paper', 'finding extracted from that paper'],
      },
      generated: false,
    });
  }
  return findings.sort((left, right) => right.confidence - left.confidence
    || left.replacementText.length - right.replacementText.length
    || left.replacementText.localeCompare(right.replacementText)).slice(0, options.limit ?? 5);
}

export const completionInternals = {
  tokens, sourceSentences, stem, trailingSentence, trailingSentenceStart,
  sourceFindingFragment, findingClause, findingSignal, findingQuality,
};
