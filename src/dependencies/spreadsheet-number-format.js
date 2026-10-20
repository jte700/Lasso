// Excel stores dates and percentages as plain numbers and keeps how they look
// in a separate number format. Without that format a date reads 45352 and
// 15.3% reads 0.153: not what the writer sees, and not what Lasso may insert.
// Dates are written as ISO 8601 so they read the same in every locale.

const DATE_FORMAT = 'yyyy-mm-dd';
const BUILT_IN_FORMATS = new Map([
  [1, '0'], [2, '0.00'], [3, '#,##0'], [4, '#,##0.00'], [11, '0.00E+00'], [12, '# ?/?'], [13, '# ??/??'],
  [37, '#,##0 ;(#,##0)'], [38, '#,##0 ;[Red](#,##0)'], [39, '#,##0.00;(#,##0.00)'],
  [40, '#,##0.00;[Red](#,##0.00)'], [48, '##0.0E+0'], [49, '@'],
  [9, '0%'], [10, '0.00%'],
  [14, DATE_FORMAT], [15, 'd-mmm-yy'], [16, 'd-mmm'], [17, 'mmm-yy'],
  [18, 'h:mm AM/PM'], [19, 'h:mm:ss AM/PM'], [20, 'h:mm'], [21, 'h:mm:ss'], [22, 'yyyy-mm-dd h:mm'],
  [45, 'mm:ss'], [46, '[h]:mm:ss'], [47, 'mm:ss.0'],
  // East Asian built-in date formats.
  ...[27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58].map((id) => [id, DATE_FORMAT]),
]);

const UNIX_EPOCH_SERIAL = 25569;          // 1970-01-01 in Excel's 1900 date system
const DATE_1904_OFFSET = 1462;            // days between the 1900 and 1904 systems
const FIRST_SERIAL_AFTER_LEAP_BUG = 60;   // Excel counts a 29 February 1900 that never existed
const MS_PER_DAY = 86_400_000;

/** @param {number} id @returns {string | null} */
export function builtInNumberFormat(id) {
  return BUILT_IN_FORMATS.get(id) ?? null;
}

/** The first section of a format with literals, padding, colours and currency tags removed. */
function formatTokens(formatCode) {
  return String(formatCode).split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/[_*]./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
}

const pad = (value) => String(value).padStart(2, '0');

function formatDate(value, tokens, hasDate, hasTime, date1904) {
  if (value < 0) return null;
  let serial = value + (date1904 ? DATE_1904_OFFSET : 0);
  if (!date1904 && serial < FIRST_SERIAL_AFTER_LEAP_BUG) serial += 1;
  const seconds = Math.round((serial - UNIX_EPOCH_SERIAL) * (MS_PER_DAY / 1000));
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return null;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
    + (/s/i.test(tokens) ? `:${pad(date.getUTCSeconds())}` : '');
  if (hasDate && hasTime) return `${day} ${clock}`;
  return hasDate ? day : clock;
}

/**
 * @param {string} raw the cell's stored number
 * @param {string | null} formatCode the cell's number format
 * @param {{ date1904?: boolean }} [workbook]
 * @returns {string | null} the value as the format shows it, or null to keep the stored number
 */
export function formatSpreadsheetNumber(raw, formatCode, { date1904 = false } = {}) {
  const value = Number(raw);
  if (!formatCode || String(raw).trim() === '' || !Number.isFinite(value)) return null;
  const tokens = formatTokens(formatCode);
  // Elapsed durations such as [h]:mm can exceed a day; keep the stored number.
  if (/\[[hms]+\]/i.test(tokens)) return null;
  if (tokens.includes('%')) {
    const decimals = tokens.match(/\.([0#?]+)/)?.[1].length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  const hasTime = /[hs]/i.test(tokens);
  const hasDate = /[yd]/i.test(tokens) || (/m/i.test(tokens) && !hasTime);
  if (!hasDate && !hasTime) return null;
  return formatDate(value, tokens, hasDate, hasTime, date1904);
}

// Display formatting for previews. Indexed and inserted values keep the stored
// number (above); previews show what the sheet shows, such as $129,950 or
// (12,050), so a preview reads like the open file.

/** Excel's General format fits a number into this many characters. */
const GENERAL_WIDTH = 11;
const GENERAL_EXPONENT_DIGITS = 5;

/** Splits a format into its sections at semicolons outside quotes and escapes. */
function formatSections(formatCode) {
  const sections = [''];
  for (let index = 0, quoted = false; index < formatCode.length; index += 1) {
    const character = formatCode[index];
    if (character === '"') quoted = !quoted;
    if (!quoted && character === '\\') {
      sections[sections.length - 1] += character + (formatCode[index + 1] ?? '');
      index += 1;
    } else if (!quoted && character === ';') sections.push('');
    else sections[sections.length - 1] += character;
  }
  return sections;
}

/** Excel keeps 15 significant digits; larger magnitudes keep the stored text. */
const EXCEL_PRECISION_LIMIT = 1e15;
const GENERAL_SCIENTIFIC_BELOW = 1e-9;

/** Moves the decimal point by `places` through the exponent, so tiny and huge values stay exact. */
function shiftDecimal(value, places) {
  const [mantissa, exponent] = value.toExponential().split('e');
  return Number(`${mantissa}e${Number(exponent) + places}`);
}

/** Rounds half away from zero, as Excel does, without binary drift. */
function roundAway(value, decimals) {
  return Math.sign(value) * shiftDecimal(Math.round(shiftDecimal(Math.abs(value), decimals)), -decimals);
}

function generalNumber(value) {
  const magnitude = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  // Whole numbers such as account numbers and IDs keep every digit.
  if (Number.isInteger(magnitude) && magnitude < EXCEL_PRECISION_LIMIT) return sign + String(magnitude);
  const integerDigits = magnitude >= 1 ? Math.floor(Math.log10(magnitude)) + 1 : 1;
  if (integerDigits > GENERAL_WIDTH || (magnitude > 0 && magnitude < GENERAL_SCIENTIFIC_BELOW)) {
    const [mantissa, exponent] = magnitude.toExponential(GENERAL_EXPONENT_DIGITS).split('e');
    const digits = Math.abs(Number(exponent)).toString().padStart(2, '0');
    return `${sign}${mantissa.replace(/\.?0+$/, '')}E${Number(exponent) < 0 ? '-' : '+'}${digits}`;
  }
  const decimals = Math.max(0, GENERAL_WIDTH - integerDigits - 1);
  return sign + roundAway(magnitude, decimals).toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/**
 * Reads a section into literal text around one number pattern. Returns null
 * for layouts this reader does not reproduce (split digit groups, fractions).
 */
function sectionParts(section) {
  const parts = [];
  let percent = 0;
  const literal = (text) => parts.push({ text });
  for (let index = 0; index < section.length; index += 1) {
    const character = section[index];
    if (character === '"') {
      const end = section.indexOf('"', index + 1);
      literal(section.slice(index + 1, end < 0 ? undefined : end));
      index = end < 0 ? section.length : end;
    } else if (character === '\\') { literal(section[index + 1] ?? ''); index += 1; }
    else if (character === '_') { literal(' '); index += 1; }
    else if (character === '*') index += 1;
    else if (character === '[') {
      const end = section.indexOf(']', index);
      const tag = section.slice(index + 1, end < 0 ? undefined : end);
      if (tag.startsWith('$')) literal(tag.slice(1).split('-')[0]);
      index = end < 0 ? section.length : end;
    } else if (/[0#?.,]/.test(character)) {
      const match = section.slice(index).match(/^[0#?.,]+(?:[eE][+-][0#?]+)?/)[0];
      if (/[0#?]/.test(match)) parts.push({ pattern: match });
      else literal(match);
      index += match.length - 1;
    } else {
      if (character === '%') percent += 1;
      literal(character);
    }
  }
  return parts.filter((part) => part.pattern).length <= 1 ? { parts, percent } : null;
}

function scientificNumber(value, pattern) {
  const [mantissaPattern, exponentPattern] = pattern.split(/[eE]/);
  // Engineering notation (##0.0E+0) groups exponents by three; not reproduced here.
  if (mantissaPattern.split('.')[0].replace(/[^0#?]/g, '').length > 1) return null;
  const decimals = (mantissaPattern.split('.')[1] ?? '').replace(/[^0#?]/g, '').length;
  const [mantissa, exponent] = value.toExponential(decimals).split('e');
  const power = Number(exponent);
  const sign = power < 0 ? '-' : exponentPattern.startsWith('+') ? '+' : '';
  const digits = String(Math.abs(power)).padStart(exponentPattern.slice(1).replace(/[^0]/g, '').length, '0');
  return `${mantissa}E${sign}${digits}`;
}

function patternNumber(value, pattern) {
  if (/[eE]/.test(pattern)) return scientificNumber(value, pattern);
  const scaleCommas = pattern.match(/,+$/)?.[0].length ?? 0;
  const body = pattern.slice(0, pattern.length - scaleCommas);
  const [integerPattern, decimalPattern] = body.split('.');
  const decimals = (decimalPattern ?? '').replace(/[^0#?]/g, '').length;
  const minimumDecimals = (decimalPattern ?? '').replace(/[^0]/g, '').length;
  const scaled = roundAway(value / 1000 ** scaleCommas, decimals);
  let [integer, fraction = ''] = scaled.toFixed(decimals).split('.');
  while (fraction.length > minimumDecimals && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const minimumIntegers = integerPattern.replace(/[^0]/g, '').length;
  integer = integer === '0' && minimumIntegers === 0 ? '' : integer.padStart(minimumIntegers, '0');
  if (integerPattern.includes(',')) integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimalPattern === undefined ? integer : `${integer}.${fraction}`;
}

/**
 * @param {string} raw the cell's stored number
 * @param {string | null} formatCode the cell's number format; null is General
 * @returns {string | null} the number as the sheet displays it, or null when
 *   this format is a date, time, fraction, condition or text layout
 */
export function displaySpreadsheetNumber(raw, formatCode) {
  const value = Number(raw);
  if (String(raw ?? '').trim() === '' || !Number.isFinite(value)) return null;
  const sections = formatSections(String(formatCode ?? 'General'));
  if (sections.some((section) => /\[[<>=]/.test(section))) return null;
  const negativeSection = value < 0 && sections.length > 1;
  const section = (value < 0 ? sections[1] : value === 0 ? sections[2] : null) ?? sections[0];
  // Colour tags such as [Red] do not change the text of a General section.
  const untagged = section.replace(/\[[^\]]*\]/g, '');
  if (/^\s*general\s*$/i.test(untagged)) return negativeSection ? generalNumber(-value) : generalNumber(value);
  const tokens = formatTokens(section);
  if (/general/i.test(tokens) || /@/.test(section) || /[yYdDhHsS]|m/i.test(tokens.replace(/[eE][+-]/g, ''))
    || /[0#?]\s*\/\s*[0#?]/.test(tokens)) return null;
  const read = sectionParts(section);
  if (!read) return null;
  const magnitude = Math.abs(value) * 100 ** read.percent;
  const scientific = read.parts.some((part) => /[eE]/.test(part.pattern ?? ''));
  if (!scientific && magnitude >= EXCEL_PRECISION_LIMIT) return null;
  const pieces = read.parts.map((part) => part.pattern ? patternNumber(magnitude, part.pattern) : part.text);
  if (pieces.includes(null)) return null;
  const text = pieces.join('').trim();
  if (/NaN|Infinity/.test(text)) return null;
  const signed = value < 0 && !negativeSection && roundAway(magnitude, 10) !== 0;
  return signed ? `-${text}` : text;
}
