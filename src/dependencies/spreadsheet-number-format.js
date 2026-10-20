// Excel stores dates and percentages as plain numbers and keeps how they look
// in a separate number format. Without that format a date reads 45352 and
// 15.3% reads 0.153: not what the writer sees, and not what Lasso may insert.
// Dates are written as ISO 8601 so they read the same in every locale.

const DATE_FORMAT = 'yyyy-mm-dd';
const BUILT_IN_FORMATS = new Map([
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
