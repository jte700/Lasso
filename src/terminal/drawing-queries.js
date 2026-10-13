// Drawing answers are lookups of explicit, indexed annotations. They never
// infer dimensions from pixels, drawing scale, nearby text, or a similar name.
// Structured model properties and measured CAD geometry retain their basis.
import path from 'node:path';
import { dependencyName, sourceLocator } from './names.js';
import { ACTION, blank, dim, result, resultItem, text } from './result.js';

const METRICS = [
  ['area', '(?:(?:net|gross)\\s+)?(?:square\\s+(?:footage|feet|foot|metres?|meters?)|sq\\.?\\s*(?:ft|m)\\.?|ft(?:²|\\^2|2)|m(?:²|\\^2|2)|floor\\s+area|room\\s+area|area)'],
  ['diameter', '(?:pipe\\s+)?diameter'],
  ['length', '(?:pipe\\s+)?length'],
  ['perimeter', '(?:boundary\\s+)?perimeter'],
  ['slope', 'slope|gradient'],
  ['elevation', 'elevation|invert\\s+level'],
];
const KIND_ALIASES = { room_area: 'area', pipe_length: 'length', pipe_diameter: 'diameter' };
const VALUE_PREFIX = /^(?:what\s+(?:is|are)|what['’]?s|show(?:\s+me)?|give\s+me)\s+(?:the\s+)?/i;

function stripScope(subject) {
  const scope = { sheetNumber: null, pageNumber: null, file: null };
  let remaining = subject.trim().replace(/[?!.]+$/, '').trim();
  let previous;
  do {
    previous = remaining;
    remaining = remaining.replace(/\s+(?:on|in|from)\s+(?:the\s+)?sheet\s+([\w.-]+)$/i, (_, sheet) => {
      scope.sheetNumber = sheet;
      return '';
    }).replace(/\s+(?:on|in|from)\s+(?:the\s+)?page\s+(\d+)$/i, (_, page) => {
      scope.pageNumber = Number(page);
      return '';
    }).replace(/\s+(?:in|from)\s+["']?([^"']+\.(?:pdf|ifc|dxf|xml|landxml))["']?$/i, (_, file) => {
      scope.file = file.trim();
      return '';
    });
  } while (previous !== remaining);
  return { subject: remaining.replace(/^(?:the|our|my)\s+/i, '').replace(/^["'`]|["'`]$/g, '').trim(), ...scope };
}

/** Return null for questions handled by the terminal's existing intents. */
export function parseDrawingQuestion(question) {
  const scope = stripScope(String(question ?? '').trim().replace(/\s+/g, ' '));
  const raw = scope.subject;
  const areaQualifier = raw.match(/\b(net|gross)\s+(?:(?:floor\s+)?area\b|square\s+(?:footage|feet|foot|metres?|meters?)\b|sq\.?\s*(?:ft|m)\b|(?:ft|m)(?:²|\^2|2))/i);
  const areaType = areaQualifier?.[1].toLowerCase() ?? null;
  const requestedUnits = /\b(?:square (?:footage|feet|foot)|sq\.?\s*ft|ft(?:²|\^2|2))/i.test(raw) ? 'ft²'
    : /\b(?:square (?:meters?|metres?)|sq\.?\s*m|m(?:²|\^2|2))/i.test(raw) ? 'm²' : null;
  const body = raw.replace(VALUE_PREFIX, '');
  for (const [kind, expression] of METRICS) {
    const metric = `(?:${expression})`;
    const patterns = body !== raw ? [
      new RegExp(`^${metric}\\s+(?:of|for|in)\\s+(.+)$`, 'i'),
      new RegExp(`^(.+?)(?:['’]s)?\\s+${metric}$`, 'i'),
    ] : [];
    if (kind === 'area') {
      patterns.push(new RegExp(`^how\\s+(?:many|much)\\s+${metric}\\s+(?:is|are|does)\\s+(.+?)(?:\\s+(?:have|contain))?$`, 'i'));
    }
    for (const pattern of patterns) {
      const match = (body !== raw && patterns.indexOf(pattern) < 2 ? body : raw).match(pattern);
      if (match) return { ...scope, kind, subject: stripScope(match[1]).subject, areaType, requestedUnits };
    }
  }
  const long = raw.match(/^how\s+long\s+is\s+(.+)$/i);
  if (long) return { ...scope, kind: 'length', subject: stripScope(long[1]).subject };
  return null;
}

function tokens(value) {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function entityTerms(subject) {
  // "room" is often absent in the printed label, e.g. OFFICE 101. Actual
  // names and identifiers remain mandatory; 101 cannot match 1010.
  return tokens(subject).filter((term) => !['the', 'room', 'pipe'].includes(term));
}

function matchesEntity(object, subject) {
  const metadata = object.metadata ?? {};
  const anchor = object.anchor ?? {};
  const wanted = entityTerms(subject);
  if (!wanted.length) return false;
  const identity = new Set(tokens([
    object.label, anchor.label, anchor.identifier,
    metadata.roomName, metadata.roomNumber, metadata.entity, metadata.entityLabel,
    metadata.identifier, metadata.featureName, metadata.featureId, metadata.elementId, anchor.elementId,
  ].filter(Boolean).join(' ')));
  return wanted.every((term) => identity.has(term));
}

function matchesScope(object, query) {
  const metadata = object.metadata ?? {};
  const anchor = object.anchor ?? {};
  if (query.sheetNumber && String(anchor.sheetNumber ?? metadata.sheetNumber ?? '').toLowerCase() !== query.sheetNumber.toLowerCase()) return false;
  if (query.pageNumber && Number(anchor.pageNumber ?? metadata.pageNumber) !== query.pageNumber) return false;
  if (query.file) {
    const file = query.file.toLowerCase();
    const objectPath = String(object.path ?? '').toLowerCase();
    if (objectPath !== file && path.posix.basename(objectPath) !== file) return false;
  }
  return true;
}

function candidate(object) {
  return resultItem({
    title: object.name ?? dependencyName(object),
    value: object.valueText,
    lines: [object.path, sourceLocator(object)],
    ref: { kind: 'object', objectId: object.id, objectKey: object.objectKey, name: object.name ?? dependencyName(object), path: object.path },
    actions: [ACTION.inspect, ACTION.showSource],
  });
}

/** A grounded answer, an explicit refusal, or null for an unrelated question. */
export function answerDrawingQuestion(context, question) {
  const query = parseDrawingQuestion(question);
  if (!query) return null;
  // Keep existing named business/scientific values such as 'campaign length'.
  // The drawing vocabulary must not take over an already resolved source.
  const genericSubject = stripScope(String(question).trim()).subject.replace(VALUE_PREFIX, '').replace(/^(?:current|latest)\s+/i, '');
  const legacy = context.graph.resolve(context.projectId, genericSubject);
  if (legacy.status === 'RESOLVED' && !['drawing-annotation', 'cad-property'].includes(legacy.object.anchor?.kind)
    && legacy.object.objectType !== 'DRAWING_ANNOTATION' && !legacy.object.metadata?.drawing) return null;
  const objects = context.graph.namedObjects(context.projectId);
  const matches = objects.filter((object) => {
    const metadata = object.metadata ?? {};
    return (['drawing-annotation', 'cad-property'].includes(object.anchor?.kind) || object.objectType === 'DRAWING_ANNOTATION')
      && (KIND_ALIASES[metadata.kind] ?? metadata.kind) === query.kind
      // Space wall/ceiling/surface areas cannot answer a room floor-area question.
      && !(query.kind === 'area' && metadata.entityType === 'IFCSPACE' && metadata.kind !== 'room_area')
      && matchesEntity(object, query.subject) && matchesScope(object, query)
      && (!query.areaType || (metadata.entityType === 'IFCSPACE'
        ? String(metadata.propertyName ?? object.anchor?.propertyName ?? '').replace(/[^a-z]/gi, '').toLowerCase() === `${query.areaType}floorarea`
        : String(metadata.areaType ?? metadata.propertyName ?? object.anchor?.propertyName ?? object.label).toLowerCase().includes(query.areaType)));
  });
  const verified = matches.filter((object) => ['explicit', 'model-property', 'geometry'].includes(object.metadata?.measurementBasis)
    && typeof object.metadata.numericValue === 'number' && Number.isFinite(object.metadata.numericValue)
    && object.metadata.units && object.valueText != null && String(object.valueText).trim());
  if (!verified.length) {
    return result('ask', {
      headline: 'Not answerable from indexed drawings',
      blocks: [
        text(`No supported ${query.kind} measurement is indexed for "${query.subject}"${query.sheetNumber ? ` on sheet ${query.sheetNumber}` : ''}${query.pageNumber ? ` on page ${query.pageNumber}` : ''}.`, 'warn'),
        dim('Lasso requires a source annotation, a model property, or measured CAD geometry with declared units. It does not estimate from drawing scale.'),
      ],
      hints: ['`find` can locate the drawing and its indexed annotations.'],
      data: { answered: false, reason: 'NO_EXPLICIT_DRAWING_VALUE', query },
    });
  }
  if (verified.length !== 1 || matches.length !== 1) {
    return result('ask', {
      headline: 'Several drawing annotations match',
      blocks: [text(`${matches.length} annotations match ${query.subject}; no single source supports an answer.`, 'warn')],
      results: matches.map(candidate),
      hints: ['Add "on sheet A101", "on page 2", or "in plans.pdf" to identify the source.'],
      data: { answered: false, reason: 'AMBIGUOUS_DRAWING_VALUE', query, candidates: matches.map((object) => object.objectKey) },
    });
  }
  const object = verified[0];
  const locator = sourceLocator(object);
  const sourceUnits = String(object.metadata.units);
  const unitKind = /^(?:ft²|ft2|sq\.?\s*ft|square feet|square foot)$/i.test(sourceUnits) ? 'ft²'
    : /^(?:m²|m2|sq\.?\s*m|square metres?|square meters?)$/i.test(sourceUnits) ? 'm²' : null;
  let displayValue = object.valueText;
  let numericValue = object.metadata.numericValue;
  let units = sourceUnits;
  let conversion = null;
  if (query.requestedUnits && query.requestedUnits !== unitKind) {
    if (!unitKind) return result('ask', {
      headline: 'Requested units are not supported for this measurement',
      blocks: [dim(`The source records ${object.valueText}. Lasso cannot convert its units to ${query.requestedUnits}.`)],
      results: [candidate(object)],
      data: { answered: false, reason: 'UNSUPPORTED_DRAWING_UNITS', query },
    });
    numericValue = query.requestedUnits === 'ft²' ? numericValue / 0.09290304 : numericValue * 0.09290304;
    units = query.requestedUnits;
    displayValue = `${Number(numericValue.toFixed(4))} ${units}`;
    conversion = { sourceValue: object.valueText, sourceNumericValue: object.metadata.numericValue, sourceUnits,
      formula: query.requestedUnits === 'ft²' ? 'm² / 0.09290304' : 'ft² × 0.09290304', definition: '1 ft = 0.3048 m' };
  }
  return result('ask', {
    headline: `${object.label}: ${displayValue}`,
    blocks: [
      dim(`${object.metadata.measurementBasis === 'model-property' ? 'Structured model property' : object.metadata.measurementBasis === 'geometry' ? 'Measured CAD geometry' : 'Explicit annotation in the drawing'}; source value: ${object.valueText}.`),
      conversion ? dim(`Converted from ${object.valueText} using ${conversion.definition} (${conversion.formula}).`) : null,
      blank(), text('Source'), dim(`  ${object.path}`), dim(`  ${locator}`),
      object.metadata.rawText ? dim(`  Source text: ${object.metadata.rawText}`) : null,
    ].filter(Boolean),
    results: [candidate(object)],
    hints: [`\`trace ${object.name ?? dependencyName(object)}\` shows its source and references.`],
    data: { answered: true, object: object.objectKey, value: displayValue, numericValue, units, conversion, sourceValue: object.valueText, measurementBasis: object.metadata.measurementBasis, path: object.path, locator, query },
  });
}
