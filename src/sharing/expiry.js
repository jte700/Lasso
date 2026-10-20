import { HttpError } from '../history/errors.js';

/** Every share link stops working this long after it is made. */
export const SHARE_LIFETIME_HOURS = 48;
const SHARE_LIFETIME_MS = SHARE_LIFETIME_HOURS * 60 * 60 * 1000;

/**
 * A share link's expiry. A link closes 48 hours after it is made, or sooner
 * when an earlier time is chosen. An unreadable date used to surface as an
 * unexpected server error, and a past date silently created a dead link.
 *
 * @param {unknown} value
 * @param {Date} [reference] when the link is made
 * @returns {string} ISO timestamp
 */
export function shareExpiry(value, reference = new Date()) {
  const latest = new Date(reference.getTime() + SHARE_LIFETIME_MS);
  if (value === undefined || value === null || value === '') return latest.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, 'Choose a valid expiry date for this link.');
  if (date <= reference) throw new HttpError(400, 'Choose an expiry date in the future.');
  if (date > latest) throw new HttpError(400, `Share links last at most ${SHARE_LIFETIME_HOURS} hours.`);
  return date.toISOString();
}
