// Values and measurements: parsing a written number with its unit, matching it
// to a stored value, and writing a stored value as it would be said.

import { canonicalRowReference } from './row-names.js';
import { humanVariable, normalizedVariable } from './tabular.js';

export function numericDescriptor(value) {
  const text = String(value ?? '').trim().toLowerCase().replaceAll(',', '');
  const match = text.match(/^(?:(p(?:-?value)?|n|fold[_ -]?change)\s*[<=>:]?\s*)?([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(%|percent)?(?:\s*ci|\s*[- ]?fold(?:\s+change)?)?$/i);
  if (!match) return null;
  return { number: Number(match[2]), percent: Boolean(match[3]), count: match[1] === 'n' };
}

const MEASUREMENT_UNITS = { mm: 'mm', cm: 'cm', m: 'm', km: 'km', 'µm': 'µm', mil: 'mil', in: 'in', ft: 'ft', yd: 'yd',
  'm²': 'm²', m2: 'm²', 'ft²': 'ft²', ft2: 'ft²', 'm³': 'm³', m3: 'm³', 'ft³': 'ft³', ft3: 'ft³', '°': '°', deg: '°' };

// Drawing and CAD values carry physical units. They match a written value only
// within the same unit; other values keep numericDescriptor's plain parsing.
export function measurementDescriptor(value) {
  const plain = numericDescriptor(value);
  if (plain) return { ...plain, unit: null };
  const match = String(value ?? '').trim().toLowerCase().replaceAll(',', '')
    .match(/^([+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*(mm|cm|km|µm|mil|m²|m2|m³|m3|m|in|ft²|ft2|ft³|ft3|ft|yd|°|deg)$/);
  return match ? { number: Number(match[1]), percent: false, count: false, unit: MEASUREMENT_UNITS[match[2]] } : null;
}

// What a number measures: a percent, a count ("n = 6") or a physical unit.
// Plain numbers say nothing, so they keep matching as before.
function quantityKind(number, writtenUnit = number.unit) {
  return number.percent ? '%' : number.count ? 'count' : writtenUnit;
}

// Claim values arrive without their unit; read one written right after the
// number. "in" is inches only when no word follows ("8 in diameter" is not).
// A percent written as a word ("6 percent") is a percent like "6%".
function claimUnit(claim) {
  const text = String(claim.text ?? '').toLowerCase(), value = String(claim.value ?? '').toLowerCase();
  const at = value ? text.lastIndexOf(value) : -1;
  const match = at < 0 ? null : text.slice(at + value.length)
    .match(/^\s*(mm|cm|km|µm|mil|m²|m2|m³|m3|m|in(?!\s*[a-z])|ft²|ft2|ft³|ft3|ft|yd|°|deg|percent)(?![a-z0-9²³])/);
  return match?.[1] === 'percent' ? '%' : match ? MEASUREMENT_UNITS[match[1]] : null;
}

export function valueMatch(claim, candidate, claimNumber = measurementDescriptor(claim.value),
  candidateNumber = measurementDescriptor(candidate.valueText)) {
  if (!claimNumber || !candidateNumber) return { score: 0, displayValue: null };
  // A value in one kind never matches another: 6% is not 0.06 m, nor n = 6.
  const writtenKind = quantityKind(claimNumber, claimNumber.unit ?? claimUnit(claim));
  const candidateKind = quantityKind(candidateNumber);
  if (writtenKind && candidateKind && writtenKind !== candidateKind) return { score: 0, displayValue: null };
  const direction = /\b(decreas|reduc|lower|declin|drop)/i.test(claim.text) ? -1
    : /\b(increas|rais|higher|grew|rise)/i.test(claim.text) ? 1 : 0;
  const expected = direction ? Math.abs(claimNumber.number) * direction : claimNumber.number;
  const candidateValues = [candidateNumber.number];
  if (candidateNumber.percent) candidateValues.push(candidateNumber.number / 100);
  if (claimNumber.percent) candidateValues.push(candidateNumber.number * 100);
  const signedPercent = claimNumber.percent
    ? `${direction > 0 ? '+' : direction < 0 ? '−' : ''}${Math.abs(claimNumber.number)}%`
    : null;
  if (candidateValues.some((number) => Math.abs(number - expected) < 1e-9)) {
    return { score: 1, displayValue: signedPercent };
  }
  if (claimNumber.percent && !candidateNumber.percent && direction) {
    const expectedFold = direction > 0
      ? 1 + Math.abs(claimNumber.number) / 100
      : 1 - Math.abs(claimNumber.number) / 100;
    if (Math.abs(candidateNumber.number - expectedFold) < 1e-9) {
      return { score: 1, displayValue: signedPercent };
    }
  }
  if (candidateValues.some((number) => Math.abs(Math.abs(number) - Math.abs(expected)) < 1e-9)) {
    return { score: 0.82, displayValue: signedPercent };
  }
  return { score: 0, displayValue: null };
}

export function missingMeasurement(value) {
  return /^(?:n\/?a|na|nd|not detected|<\s*(?:lod|loq)|below (?:the )?(?:lod|loq))$/i.test(String(value ?? '').trim());
}

export function contextualStoredValue(object, tail) {
  const raw = String(object.valueText ?? '').trim();
  if (!raw) return null;
  if (/^nd$/i.test(raw)) return 'not detected';
  if (/^<\s*lod$/i.test(raw)) return 'below the limit of detection';
  if (/^<\s*loq$/i.test(raw)) return 'below the limit of quantification';
  const field = humanVariable(object.metadata.column ?? object.metadata.metric ?? object.label);
  const numeric = numericDescriptor(raw);
  const direction = /\b(?:increas|higher|rais|rise|grew)/i.test(tail) ? 1
    : /\b(?:decreas|reduc|lower|declin|drop)/i.test(tail) ? -1 : 0;
  if (numeric && direction && /\bfold(?: change)?\b/.test(field)) {
    const percent = (numeric.number - 1) * 100;
    if ((direction > 0 && percent <= 0) || (direction < 0 && percent >= 0)) return null;
    const magnitude = Math.abs(percent);
    const formatted = Number.isInteger(magnitude) ? String(magnitude)
      : magnitude.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return `${formatted}%`;
  }
  // Units qualify amounts. A word such as a classification ("Income") takes none.
  const units = numeric ? String(object.metadata.units ?? '').trim() : '';
  return `${raw}${units && !raw.toLowerCase().endsWith(units.toLowerCase()) ? ` ${units}` : ''}`;
}

/** Whether a source was accepted as its own value ("100 mm", "485000 CAD",
 * "Income") rather than by a name that leads on to values. */
export function acceptedAsValue(dependency, text) {
  const { source, anchor } = dependency;
  if (['PAPER', 'REFERENCE'].includes(source.objectType)) return false;
  // A record's title names it; its fields are what come next.
  if (source.metadata?.recordFields?.length) return false;
  const accepted = normalizedVariable(String(text ?? '').slice(anchor.start, anchor.end));
  if (!accepted) return false;
  return [source.valueText, contextualStoredValue(source, String(text ?? '').slice(0, anchor.start))]
    .some((value) => value && normalizedVariable(value) === accepted);
}

export const comparableNumber = (value) => String(value ?? '').replace(/[\s,]/g, '').replace(/^[^\d.]+/, '');

/** The start of a number being typed at the end of the text ("was 48"), unless
 * that number completes a row reference ("control 4"). */
export function typedNumberPrefix(tail, requestedRows) {
  const typed = String(tail ?? '').match(/(?:^|\s)(\d[\d,]*(?:\.\d*)?)$/)?.[1];
  if (!typed) return '';
  const rowReference = String(tail).match(/\b[A-Za-z]{1,16}[\s_-]*\d+$/)?.[0];
  return rowReference && requestedRows.has(canonicalRowReference(rowReference)) ? '' : comparableNumber(typed);
}
