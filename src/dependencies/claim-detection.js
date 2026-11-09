// Finds the claims in a piece of writing (values, sample sizes, citations,
// partial references) that a source could back.

import { normalizedVariable } from './tabular.js';
import { wordTokens } from './text-similarity.js';
import { writingSourceContext } from './writing-context.js';

function partialReferenceIntent(source) {
  const nouns = '(paper|study|article|publication|reference|document|report|file|note|memo|proposal|manuscript|protocol|spreadsheet|workbook|presentation|slides?)';
  const query = "([A-Za-z0-9][A-Za-z0-9'’_.()+&/-]*(?:\\s+[A-Za-z0-9][A-Za-z0-9'’_.()+&/-]*){0,11}?)";
  const suffix = '(?:\\s+e(?:t(?:\\s+a(?:l\\.?)?)?)?)?[,]?\\s*$';
  const patterns = [
    { mode: 'title', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}(?:['’]s\\s+|\\s+)title\\s*(?:is|was|:|—|-)\\s*${query}${suffix}`, 'i') },
    { mode: 'title', pattern: new RegExp(`\\btitle\\s+of\\s+(?:the\\s+)?${nouns}\\s*(?:is|was|:|—|-)\\s*${query}${suffix}`, 'i') },
    { mode: 'title', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}\\s+(?:called|titled|named|entitled)\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(?:the\\s+)?${nouns}\\s+(?:written\\s+by|authored\\s+by|by)\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(?:the\\s+)?(paper|study|article|publication|reference)\\s+from\\s+${query}${suffix}`, 'i') },
    { mode: 'author', pattern: new RegExp(`\\b(according\\s+to)\\s+${query}${suffix}`, 'i'), kind: 'according to' },
    { mode: 'any', pattern: new RegExp(`\\b(?:(?:from|in|within|using|citing|referencing|based\\s+on)\\s+)?(?:the\\s+)?${nouns}\\s+${query}${suffix}`, 'i') },
  ];
  for (const definition of patterns) {
    const match = source.match(definition.pattern);
    if (!match) continue;
    const captured = match.slice(1).filter((value) => value != null);
    const rawQuery = captured.at(-1);
    if (!rawQuery || normalizedVariable(rawQuery).length < 2) continue;
    if (definition.mode === 'any' && /^(?:finds?|found|shows?|showed|observes?|observed|reports?|reported|reveals?|revealed|indicates?|indicated|includes?|included|demonstrates?|demonstrated|suggests?|suggested|contains?|contained)\b/i.test(rawQuery)) continue;
    const referenceKind = definition.kind ?? captured[0].toLowerCase();
    const start = match.index + match[0].lastIndexOf(rawQuery);
    return { query: rawQuery, start, referenceKind, referenceMode: definition.mode };
  }
  return null;
}

export function detectClaimSpans(text) {
  const source = String(text ?? '');
  const claims = [];
  const add = (start, end, type, value = null, details = {}) => {
    if (start < 0 || end <= start) return;
    const claim = { start, end, type, value, text: source.slice(start, end), ...details };
    if (!claims.some((item) => item.start === start && item.end === end && item.type === type)) claims.push(claim);
  };

  const quantity = /(?:\bp(?:-?value)?\s*[<=>]\s*0?\.\d+|\b(?:n\s*=\s*)?\d+(?:\.\d+)?\s*%\s*(?:CI)?|\bn\s*=\s*\d+|\b\d+\s+(?:patients?|samples?|participants?|subjects?)|\b\d+(?:\.\d+)?[- ]?fold(?:\s+change)?)/gi;
  for (const match of source.matchAll(quantity)) {
    let start = match.index;
    const prefix = source.slice(Math.max(0, start - 55), start);
    const phrase = prefix.match(/(?:decreased|reduced|increased|changed|lower|higher|included|excluded|p\s*(?:value)?)[^.!?;]{0,45}$/i);
    if (phrase) start -= phrase[0].length;
    add(start, match.index + match[0].length, /\bpatients?|samples?|participants?|subjects?|n\s*=/i.test(match[0]) ? 'SAMPLE_SIZE' : 'QUANTITATIVE', match[0]);
  }
  for (const match of source.matchAll(/\b(?:Figure|Fig\.?|Table)\s+[A-Za-z0-9.-]+/gi)) {
    add(match.index, match.index + match[0].length, /^Table/i.test(match[0]) ? 'TABLE_REFERENCE' : 'FIGURE', match[0]);
  }
  const partialComponent = source.match(/\b(Tab(?:l(?:e)?)?|Fig(?:u(?:r(?:e)?)?)?)(?:\s+([A-Za-z0-9.-]*))?\s*$/i);
  if (partialComponent && !claims.some((claim) => claim.start <= partialComponent.index && claim.end >= source.trimEnd().length)) {
    const table = /^tab/i.test(partialComponent[1]);
    add(partialComponent.index, source.trimEnd().length, table ? 'TABLE_REFERENCE' : 'FIGURE', partialComponent[0].trim(), {
      partial: true,
    });
  }
  for (const match of source.matchAll(/\b(?:mixed[- ]effects? model|random intercept|SCTransform|Cox model|linear regression|normalized? using [A-Za-z0-9_-]+)/gi)) add(match.index, match.index + match[0].length, 'METHOD', match[0]);
  let explicitReference = false;
  for (const match of source.matchAll(/\b[A-Z][A-Za-z'’-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’-]+)?\s+et al\.(?:,?\s*\(?(?:19|20)\d{2}[a-z]?\)?)?/g)) {
    explicitReference = true;
    add(match.index, match.index + match[0].length, 'LITERATURE', match[0]);
  }
  if (!explicitReference) {
    // A reference is named in the sentence being typed. Read across a full stop
    // or a blank line, "slide numbers or image references.\n\nCheck that the
    // invoice" asked for slides about invoices and numbers alike.
    const { sentenceStart } = writingSourceContext(source, source.length);
    const partialCitation = partialReferenceIntent(source.slice(sentenceStart));
    if (partialCitation) {
      explicitReference = true;
      const trailingComma = source.trimEnd().endsWith(',') ? 1 : 0;
      add(sentenceStart + partialCitation.start, source.length - trailingComma, 'LITERATURE', partialCitation.query, {
        partial: true,
        referenceKind: partialCitation.referenceKind,
        referenceMode: partialCitation.referenceMode,
      });
    }
  }
  if (!explicitReference && /\b(?:prior (?:work|studies)|studies have|reported|associated with)\b/i.test(source)) {
    add(0, source.length, 'LITERATURE', null);
  }
  const partialPercent = source.match(/\b(?:increased?|decreased?|reduced?|changed?|higher|lower)\s+(?:by\s+)?([+-]?\d+(?:\.\d*)?)\s*$/i);
  if (partialPercent) {
    add(partialPercent.index, source.length, 'QUANTITATIVE', `${partialPercent[1]}%`, { partial: true, unitHint: 'percent' });
  }
  const partialPValue = source.match(/\bp(?:-?value)?\s*[<=>]\s*(0?\.\d*)\s*$/i);
  if (partialPValue?.[1]) add(partialPValue.index, source.length, 'QUANTITATIVE', partialPValue[1], { partial: true, unitHint: 'p-value' });
  const studyNumber = /[+-]?\d[\d,]*(?:\.\d+)?(?:\s*(?:percent\b|µ?g|mg|kg|ng|pg|mm|cm|mL|dL|L|mmol\/L|µmol\/L|ng\/mL|years?|months?|days?|hours?))?/gi;
  for (const match of source.matchAll(studyNumber)) {
    const end = match.index + match[0].length;
    if (claims.some((claim) => claim.start < end && claim.end > match.index)) continue;
    const numericText = match[0].match(/[+-]?\d[\d,]*(?:\.\d+)?/)?.[0] ?? '';
    const numericValue = Number(numericText.replaceAll(',', ''));
    if (!Number.isFinite(numericValue) || (numericValue >= 1900 && numericValue <= 2099 && !match[0].includes('.'))) continue;
    const boundary = Math.max(source.lastIndexOf('.', match.index - 1), source.lastIndexOf('!', match.index - 1),
      source.lastIndexOf('?', match.index - 1), source.lastIndexOf(';', match.index - 1), source.lastIndexOf('\n', match.index - 1));
    const prefix = source.slice(boundary + 1, match.index);
    const relation = prefix.match(/([A-Za-z][A-Za-z0-9_()/ -]{1,80}?)\s+(?:was|were|is|are|averaged|measured|reached|equalled?|=)\s*$/i);
    if (!relation) continue;
    let variable = relation[1].trim()
      .replace(/^(?:in\s+(?:our|this)\s+study,?\s*)/i, '')
      .replace(/^(?:we\s+(?:found|observed|showed|identified|measured|detected|recorded|reported|estimated)(?:\s+that)?\s+)/i, '')
      .replace(/^(?:the|our)\s+/i, '')
      .replace(/^(?:adjusted\s+)?(?:mean|median|average)\s+(?:of\s+)?/i, '')
      .replace(/^(?:(?:odds|hazard)\s+ratio|coefficient|estimate|value)\s+(?:of|for)\s+/i, '');
    if (!variable || wordTokens(variable).length > 8) continue;
    const unit = match[0].slice(numericText.length).trim() || null;
    const start = boundary + 1 + relation.index;
    add(start, end, 'QUANTITATIVE', numericText, { variable, unit, studyResult: true });
  }
  for (const match of source.matchAll(/\b(?:[A-Z]{2,}\d*(?:-\d+)+|[A-Z]{2,}\d{1,3})\b/g)) {
    const sentenceStart = Math.max(source.lastIndexOf('.', match.index - 1), source.lastIndexOf('\n', match.index - 1)) + 1;
    const nextPeriod = source.indexOf('.', match.index);
    const nextLine = source.indexOf('\n', match.index);
    const sentenceEnd = Math.min(...[nextPeriod, nextLine, source.length].filter((index) => index >= 0));
    const alreadyRepresented = claims.some((claim) => claim.start < sentenceEnd && claim.end > sentenceStart
      && ['QUANTITATIVE', 'SAMPLE_SIZE', 'METHOD'].includes(claim.type));
    if (!alreadyRepresented && !claims.some((claim) => claim.start <= match.index && claim.end >= match.index + match[0].length)) {
      add(match.index, match.index + match[0].length, 'ENTITY', match[0]);
    }
  }
  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*(?:dataset|cohort)[A-Za-z0-9_-]*\b/gi)) {
    add(match.index, match.index + match[0].length, 'DATASET_REFERENCE', match[0]);
  }
  const partialEntity = source.match(/\b([A-Z]{2,}[A-Z0-9]*(?:-[A-Z0-9]*)?)$/);
  if (partialEntity && !claims.some((claim) => claim.start <= partialEntity.index && claim.end >= source.length)) {
    add(partialEntity.index, source.length, 'ENTITY', partialEntity[1], { partial: true });
  }
  return claims.sort((a, b) => a.start - b.start || a.end - b.end);
}
