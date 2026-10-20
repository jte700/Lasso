import { HttpError } from '../history/errors.js';

/**
 * A share link's optional expiry. An unreadable date used to surface as an
 * unexpected server error, and a past date silently created a dead link.
 *
 * @param {unknown} value
 * @param {Date} [reference]
 * @returns {string | null} ISO timestamp, or null for a link that does not expire
 */
export function shareExpiry(value, reference = new Date()) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Choose a valid expiry date for this link.');
  if (date <= reference) throw new HttpError(400, 'Choose an expiry date in the future.');
  return date.toISOString();
}
