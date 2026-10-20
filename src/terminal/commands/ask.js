// ask — questions answered only from indexed sources.
//
// This is a query parser, not a language model. Each supported question maps
// to one graph query, and every answer prints the source it came from. When no
// indexed source supports an answer, the terminal says so; it never composes
// one.

import { parseSince } from '../parser.js';
import { answerDrawingQuestion } from '../drawing-queries.js';
import { isPassage } from '../graph.js';
import { blank, dim, fields, group, result, text } from '../result.js';
import { formatMoment, plural } from './shared.js';

const OUT_OF_SCOPE = 'This terminal queries and operates on indexed Lasso sources.';

// Things people ask an assistant, which this is not.
const GENERATIVE = /\b(write|draft|compose|rewrite|summari[sz]e|translate|explain how to|generate|invent|brainstorm|tell me a|poem|joke|story|email|essay|code for)\b/i;

const INTENTS = [
  { kind: 'SOURCE_OF', pattern: /^(?:which|what)\s+(?:source|file|workbook|spreadsheet|document|sheet)\s+(?:contains|holds|has|produced|produces|gives?|provides?)\s+(?:the\s+|our\s+|my\s+|current\s+|latest\s+)*(.+?)\??$/i },
  { kind: 'SOURCE_OF', pattern: /^where\s+(?:did|does)\s+(?:the\s+|our\s+|my\s+)?(.+?)\s+come\s+from\??$/i },
  { kind: 'PREVIOUS_VALUE', pattern: /^what\s+was\s+(?:the\s+|our\s+|my\s+)?(.+?)\s+(?:value\s+)?(?:before|prior to)\s+(?:the\s+)?(?:latest|last|most recent)\s*(?:update|change)?\??$/i },
  { kind: 'PREVIOUS_VALUE', pattern: /^what\s+was\s+the\s+previous\s+(?:value\s+of\s+)?(.+?)\??$/i },
  { kind: 'UPDATED_WHEN', pattern: /^when\s+was\s+(?:the\s+|our\s+|my\s+)?(.+?)\s+(?:last\s+)?(?:updated|changed|modified)\??$/i },
  { kind: 'DEPENDENTS', pattern: /^(?:what|which|who)\s+(?:documents?\s+)?(?:depends?\s+on|references?|uses?|cites?)\s+(?:the\s+|our\s+|my\s+)?(.+?)\??$/i },
  { kind: 'DEPENDENTS', pattern: /^where\s+is\s+(?:the\s+|our\s+|my\s+)?(.+?)\s+(?:being\s+)?used\??$/i },
  { kind: 'CHANGES', pattern: /^what\s+(?:has\s+)?changed(?:\s+(?:since|in the last)\s+(.+?))?\??$/i },
  { kind: 'STALE', pattern: /^(?:what|which)\s+(?:is|are)?\s*(?:out of date|stale|outdated)\??$/i },
  { kind: 'VALUE_OF', pattern: /^(?:what\s+is|what'?s|what\s+are)\s+(?:the\s+|our\s+|my\s+)?(?:current\s+|latest\s+)?(.+?)\??$/i },
  { kind: 'VALUE_OF', pattern: /^(?:the\s+)?(?:current|latest)\s+(.+?)\??$/i },
];

// Words a question wraps a dependency name in, which are not part of the name.
const TRAILING_NOISE = /\s*\b(value|values|figure|number|amount|assumption|assumptions|total|now|today|currently|in the workbook|in our sources|from our sources)\b\s*$/i;

function cleanSubject(raw) {
  let subject = String(raw ?? '').trim().replace(/^["'`]|["'`]$/g, '');
  let previous = null;
  while (previous !== subject) {
    previous = subject;
    subject = subject.replace(TRAILING_NOISE, '').trim();
  }
  return subject;
}

function classify(question) {
  const text_ = String(question ?? '').trim().replace(/\s+/g, ' ');
  for (const intent of INTENTS) {
    const match = text_.match(intent.pattern);
    if (match) return { kind: intent.kind, subject: cleanSubject(match[1]), argument: match[2] ?? match[1] ?? null };
  }
  return null;
}

function cannotVerify(question, reason, hints = []) {
  return result('ask', {
    headline: 'Not answerable from indexed sources',
    blocks: [text(reason, 'warn'), blank(), dim(`Asked: ${question}`)],
    hints,
    data: { answered: false, reason },
  });
}

/** Resolves the subject of a question, or explains why it could not. */
function subjectOf(context, subject, kind = null) {
  if (!subject) return { error: 'The question does not name a dependency or source.' };
  const resolution = context.graph.resolve(context.projectId, subject);
  if (resolution.status === 'RESOLVED') return { object: resolution.object };
  if (resolution.status === 'AMBIGUOUS') {
    return {
      error: `${subject} names ${resolution.candidates.length} different indexed sources, so there is no single answer.`,
      hints: [`\`conflicts ${resolution.candidates[0].name}\` compares them.`, 'An alias pins one for good.'],
    };
  }
  // A question may describe a value rather than name it. One clearly best
  // search hit is accepted; a tie is not.
  let matches = context.graph.search(context.projectId, subject, { limit: 12, maxPerFile: 4 });
  // A whole document is not the value of anything. Its passages may be.
  if (kind === 'VALUE_OF') {
    matches = matches.filter(({ object }) => !['PAPER', 'DOCUMENT'].includes(object.objectType) || isPassage(object));
  }
  const passages = quotablePassages(matches);
  if (matches.length === 1 || (matches.length > 1 && matches[0].score - matches[1].score >= 0.2)) {
    return { object: matches[0].object, inferred: true, passages };
  }
  if (matches.length > 1) {
    return {
      error: `Several indexed sources match "${subject}" equally well, so no single source supports an answer.`,
      hints: [`\`find ${subject}\` lists them.`],
      passages,
    };
  }
  return { error: `Nothing indexed in this workspace matches "${subject}".`, hints: [`\`find ${subject}\` searches more broadly.`] };
}

// Words that shape a question but never identify what it is about.
const QUESTION_WORDS = new Set(['what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'many', 'much',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have', 'had', 'can', 'could', 'should', 'would',
  'will', 'the', 'a', 'an', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'from', 'with', 'as', 'and', 'or', 'there', 'this',
  'that', 'it', 'its', 'our', 'my', 'we', 'any', 'currently', 'current', 'latest',
  // Timing verbs frame a question; sources phrase them many ways.
  'due', 'end', 'ends', 'start', 'starts', 'begin', 'begins', 'happen', 'occur']);

/**
 * Passages that mention every word of the subject, at most three. A paragraph
 * is dropped when a sentence inside it is already quoted.
 */
function quotablePassages(matches) {
  const chosen = [];
  for (const match of matches) {
    // Every term must appear: whole words, or a longer word they begin.
    if (!isPassage(match.object) || match.score < 0.5) continue;
    const text = String(match.object.valueText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const overlaps = chosen.some(({ object, normalized }) => object.path === match.object.path
      && (normalized.includes(text) || text.includes(normalized)));
    if (!overlaps) chosen.push({ ...match, normalized: text });
    if (chosen.length === 3) break;
  }
  return chosen;
}

/** Quotes the passages that mention the subject. Nothing is composed or inferred. */
function passageAnswer(context, question, passages) {
  return result('ask', {
    headline: passages.length === 1 ? 'Found in an indexed passage' : `Found in ${passages.length} indexed passages`,
    blocks: [
      ...passages.flatMap(({ object }) => {
        const traced = context.graph.trace(context.projectId, object);
        return [text(`“${object.valueText}”`), dim(`  ${traced.path}${traced.locator ? `  ${traced.locator}` : ''}`), blank()];
      }),
      dim('Quoted from the indexed sources. Lasso does not compose an answer.'),
    ],
    hints: ['`find` lists every passage that mentions it.'],
    data: { answered: true, passages: passages.map(({ object }) => object.objectKey), question },
  });
}

function provenanceBlock(context, object, extra = []) {
  const traced = context.graph.trace(context.projectId, object);
  return [
    blank(),
    text('Source'),
    dim(`  ${traced.path}`),
    traced.locator ? dim(`  ${traced.locator}`) : null,
    blank(),
    text('Updated'),
    dim(`  ${formatMoment(traced.updatedAt) ?? 'not recorded'}`),
    ...extra,
  ].filter(Boolean);
}

export function askCommand(context, command) {
  const question = command.rest.trim();
  if (!question) {
    return result('ask', {
      headline: 'ask queries the indexed workspace',
      blocks: [
        dim('Questions it answers:'),
        dim('  which source contains our latest depreciation assumption?'),
        dim('  what was our office supplies value before the latest update?'),
        dim('  when was q3-revenue last updated?'),
        dim('  what depends on depreciation-direct?'),
        dim('  what changed since yesterday?'),
        dim('  what is the square footage of Office 101?'),
        dim('  what is the slope of storm pipe P1?'),
      ],
      data: { answered: false },
    });
  }

  if (GENERATIVE.test(question)) {
    return result('ask', {
      headline: OUT_OF_SCOPE,
      blocks: [dim('It answers questions about indexed sources and the dependencies drawn from them. Writing belongs in the document editor.')],
      data: { answered: false, reason: 'OUT_OF_SCOPE' },
    });
  }

  const drawingAnswer = answerDrawingQuestion(context, question);
  if (drawingAnswer) return drawingAnswer;

  const intent = classify(question);
  if (!intent) {
    // Questions outside the supported forms can still be answered by quoting
    // passages that contain all of their content words.
    const subject = question.toLowerCase().match(/[a-z0-9][a-z0-9'’-]*/g)?.filter((word) => !QUESTION_WORDS.has(word)).join(' ') ?? '';
    const passages = subject ? quotablePassages(context.graph.search(context.projectId, subject, { limit: 12, maxPerFile: 4 })) : [];
    if (passages.length) return passageAnswer(context, question, passages);
    return cannotVerify(question, 'That question does not map to anything this terminal can look up.', [
      'Supported: which source contains X · what was X before the latest update · when was X last updated · what depends on X · what changed since <time>',
    ]);
  }

  if (intent.kind === 'CHANGES') {
    const since = intent.argument ? parseSince(intent.argument) : null;
    const changes = context.graph.valueChanges(context.projectId, { since, limit: 25 });
    if (!changes.length) {
      return result('ask', {
        headline: since ? 'Nothing changed in that window' : 'No recorded value changes',
        blocks: [dim('Every indexed value matches the value recorded at the previous version.')],
        data: { answered: true, changes: [] },
      });
    }
    return result('ask', {
      headline: `${plural(changes.length, 'dependency value', 'dependency values')} changed`,
      blocks: changes.map((change) => group(change.name, [
        { text: `${change.previousValue ?? '—'} → ${change.currentValue ?? '—'}` },
        { text: `${change.path}${change.locator ? `  ${change.locator}` : ''}`, tone: 'dim' },
        { text: formatMoment(change.changedAt), tone: 'dim' },
      ])),
      hints: ['`changes` gives the same answer with the references affected.'],
      data: { answered: true, changes },
    });
  }

  if (intent.kind === 'STALE') {
    const entries = context.graph.staleDependencies(context.projectId);
    if (!entries.length) {
      return result('ask', {
        headline: 'Nothing is out of date',
        blocks: [dim('Every linked reference matches the value at its recorded source location.')],
        data: { answered: true, stale: [] },
      });
    }
    return result('ask', {
      headline: `${plural(entries.length, 'dependency', 'dependencies')} out of date`,
      blocks: entries.map((entry) => group(entry.name, [
        { text: `document ${entry.documentValue ?? '—'}  ·  source ${entry.sourceValue ?? '—'}` },
        { text: `${entry.path}${entry.locator ? `  ${entry.locator}` : ''}`, tone: 'dim' },
      ])),
      hints: ['`stale` gives the same answer with the affected references.'],
      data: { answered: true, stale: entries },
    });
  }

  const found = subjectOf(context, intent.subject, intent.kind);
  const quotable = ['VALUE_OF', 'SOURCE_OF'].includes(intent.kind) && found.passages?.length
    && (found.error || (found.inferred && isPassage(found.object)));
  if (quotable) return passageAnswer(context, question, found.passages);
  if (found.error) return cannotVerify(question, found.error, found.hints ?? []);
  const { object } = found;

  switch (intent.kind) {
    case 'SOURCE_OF':
    case 'VALUE_OF': {
      if (intent.kind === 'VALUE_OF' && found.inferred && ['drawing-annotation', 'cad-property'].includes(object.anchor?.kind)) {
        return cannotVerify(question, 'That question does not identify a supported drawing measurement. Ask for an explicit area, length, perimeter, diameter, slope, or elevation.');
      }
      if (object.valueText == null && intent.kind === 'VALUE_OF') {
        return cannotVerify(question, `${object.name} is indexed at ${object.path}, but no value is recorded for it.`);
      }
      return result('ask', {
        headline: intent.kind === 'SOURCE_OF'
          ? `${intent.subject}: ${object.valueText ?? object.label}`
          : `${object.name}: ${object.valueText}`,
        blocks: [
          found.inferred ? dim(`Matched the indexed dependency ${object.name}.`) : null,
          ...provenanceBlock(context, object),
        ].filter(Boolean),
        hints: [`\`trace ${object.name}\` shows every reference to it.`],
        data: { answered: true, object: object.objectKey },
      });
    }

    case 'PREVIOUS_VALUE': {
      const versions = context.graph.history(context.projectId, object.id);
      const distinct = [];
      for (const version of versions) {
        if (!distinct.length || distinct.at(-1).value !== version.value) distinct.push(version);
      }
      if (distinct.length < 2) {
        return cannotVerify(question,
          `${object.name} has only one recorded value (${object.valueText ?? '—'}). No earlier value is indexed.`,
          [`\`history ${object.name}\` lists what is recorded.`]);
      }
      const [current, previous] = distinct;
      return result('ask', {
        headline: `Previous value: ${previous.value ?? '—'}`,
        blocks: [
          blank(),
          fields([
            ['current value', current.value],
            ['changed', formatMoment(current.recordedAt)],
          ]),
          blank(),
          text('Source history'),
          dim(`  ${previous.path}`),
          previous.locator ? dim(`  ${previous.locator}`) : null,
          dim(`  recorded ${formatMoment(previous.recordedAt)}`),
        ].filter(Boolean),
        hints: [`\`history ${object.name}\` lists every recorded value.`],
        data: { answered: true, previous, current },
      });
    }

    case 'UPDATED_WHEN': {
      const traced = context.graph.trace(context.projectId, object);
      if (!traced.updatedAt) {
        return cannotVerify(question, `No modification time is recorded for ${traced.path}.`);
      }
      return result('ask', {
        headline: `${object.name} was last updated ${formatMoment(traced.updatedAt)}`,
        blocks: [
          blank(),
          fields([
            ['value', traced.value],
            ['source', traced.path],
            traced.locator ? ['location', traced.locator] : null,
            ['indexed', formatMoment(traced.indexedAt)],
          ]),
        ],
        data: { answered: true, updatedAt: traced.updatedAt },
      });
    }

    case 'DEPENDENTS': {
      const documents = context.graph.referencesByDocument(context.projectId, object.id);
      const shares = context.graph.sharesForObject(context.projectId, object.id).filter((share) => share.status === 'active');
      if (!documents.length && !shares.length) {
        return result('ask', {
          headline: `Nothing references ${object.name}`,
          blocks: provenanceBlock(context, object),
          data: { answered: true, documents: [] },
        });
      }
      return result('ask', {
        headline: `${plural(documents.reduce((sum, document) => sum + document.references.length, 0), 'reference')} in ${plural(documents.length, 'document')}`,
        blocks: [
          ...documents.map((document) => group(document.documentPath, document.references.map((reference) => ({
            text: `"${reference.spanText}"`,
            tone: reference.status === 'LINKED' ? 'dim' : 'warn',
          })))),
          ...(shares.length ? [blank(), text(`${plural(shares.length, 'active shared link')}`)] : []),
          ...provenanceBlock(context, object),
        ],
        hints: [`\`impact ${object.name}\` shows the same graph with update actions.`],
        data: { answered: true, documents, shares },
      });
    }

    default:
      return cannotVerify(question, 'That question is understood but not implemented.');
  }
}

export { OUT_OF_SCOPE };
