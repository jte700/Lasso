import crypto from 'node:crypto';

// The apps Lasso can connect to, and how their items are written into the
// folder Lasso indexes for each connection. Every item becomes one Markdown
// file, so mail, events and pages are searched and cited like any document.

/**
 * `auth` is how a connection is made:
 *  - oauth: the user signs in on the provider's own page in their browser,
 *    which redirects back to this computer (RFC 8252). It needs the client
 *    ID of an app registration, built in or entered once in the Connect app.
 *  - token: the user pastes a secret the provider issued to them.
 *  - url: the user pastes a published calendar address.
 *  - native: the Mac app reads the items and hands them to the server.
 */
export const PROVIDERS = Object.freeze({
  outlook: {
    id: 'outlook', name: 'Outlook', vendor: 'Microsoft', brings: 'Mail and calendar',
    description: 'Messages and events from Outlook.com, Hotmail or Microsoft 365, read through Microsoft Graph.',
    auth: 'oauth', oauthApp: 'microsoft', symbol: 'envelope',
    parts: [
      { id: 'mail', label: 'Mail', detail: 'Messages in your Inbox, Sent and other folders' },
      { id: 'calendar', label: 'Calendar', detail: 'Events in your Outlook calendars' },
    ],
  },
  'google-calendar': {
    id: 'google-calendar', name: 'Google Calendar', vendor: 'Google', brings: 'Events',
    description: 'Events from every Google calendar you can see, read through the Google Calendar API.',
    auth: 'oauth', oauthApp: 'google', symbol: 'calendar',
    parts: [{ id: 'calendar', label: 'Calendar', detail: 'Events in the calendars in your list' }],
  },
  'apple-calendar': {
    id: 'apple-calendar', name: 'Calendar', vendor: 'Apple', brings: 'Calendars on this Mac',
    description: 'Events from the Calendar app, including iCloud, Exchange and Google accounts added to this Mac.',
    auth: 'native', platform: 'darwin', symbol: 'calendar',
    parts: [{ id: 'calendar', label: 'Calendar', detail: 'Events in the calendars you choose' }],
  },
  notion: {
    id: 'notion', name: 'Notion', vendor: 'Notion', brings: 'Pages and databases',
    description: 'Pages and database entries you share with a Notion integration, read through the Notion API.',
    auth: 'token', symbol: 'doc.text',
    parts: [{ id: 'pages', label: 'Pages', detail: 'Pages and database entries shared with the integration' }],
  },
  ics: {
    id: 'ics', name: 'Calendar Feed', vendor: 'iCal link', brings: 'A published calendar',
    description: 'Any calendar published as an iCal (.ics) address, such as an Outlook published calendar or a Google secret address.',
    auth: 'url', symbol: 'calendar.badge.plus',
    parts: [{ id: 'calendar', label: 'Calendar', detail: 'Events in the published calendar' }],
  },
});

// How far back and ahead a connection reads unless the user chooses otherwise.
export const DEFAULT_RANGE = Object.freeze({ pastDays: 30, futureDays: 90 });
export const RANGE_LIMITS = Object.freeze({ pastDays: [0, 365], futureDays: [0, 365] });
// One connection never mirrors more items than this; the newest are kept.
export const ITEM_LIMIT = 2_000;

export function provider(id) {
  const entry = PROVIDERS[id];
  if (!entry) return null;
  return entry;
}

const clamp = (value, [low, high], fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(high, Math.max(low, Math.round(number))) : fallback;
};

/** The settings a connection keeps, with anything unknown or out of range dropped. */
export function normalizeSettings(providerId, input = {}) {
  const entry = provider(providerId);
  const known = new Set(entry?.parts.map((part) => part.id) ?? []);
  const parts = Array.isArray(input.parts) ? input.parts.filter((part) => known.has(part)) : [...known];
  const settings = {
    parts: parts.length ? [...new Set(parts)] : [...known],
    pastDays: clamp(input.pastDays, RANGE_LIMITS.pastDays, DEFAULT_RANGE.pastDays),
    futureDays: clamp(input.futureDays, RANGE_LIMITS.futureDays, DEFAULT_RANGE.futureDays),
  };
  if (Array.isArray(input.calendars)) {
    settings.calendars = input.calendars.filter((id) => typeof id === 'string' && id).slice(0, 200);
  }
  if (typeof input.label === 'string' && input.label.trim()) settings.label = input.label.trim().slice(0, 80);
  return settings;
}

// ---------- Markdown ----------

// How items are written. A new version rewrites every connection's files once.
export const RENDER_VERSION = 2;

// Dates and times read as this Mac writes them; the app passes its settings.
const LOCALE = (() => {
  const requested = String(process.env.LASSO_LOCALE ?? '').replace(/@.*$/, '').replace(/_/g, '-');
  try { return requested ? Intl.getCanonicalLocales(requested)[0] : undefined; } catch { return undefined; }
})();
const HOUR_CYCLE = ['h11', 'h12', 'h23', 'h24'].includes(process.env.LASSO_HOUR_CYCLE) ? process.env.LASSO_HOUR_CYCLE : undefined;

const pad = (value) => String(value).padStart(2, '0');

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Tuesday, October 27", with the year when it is not this year's. */
export function dayText(value, now = new Date()) {
  const date = validDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(LOCALE, { weekday: 'long', month: 'long', day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
}

/** "1:00 PM" or "13:00", as this Mac shows times. */
export function timeText(value) {
  const date = validDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(LOCALE, { hour: 'numeric', minute: '2-digit',
    ...(HOUR_CYCLE ? { hourCycle: HOUR_CYCLE } : {}) }).format(date);
}

const sameDay = (left, right) => left.getFullYear() === right.getFullYear()
  && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();

/** An event's Date, Time and Ends fields. A whole day's end is the next midnight. */
function eventTimes(item) {
  const start = validDate(item.start);
  if (!start) return [];
  let end = validDate(item.end);
  if (item.allDay) {
    if (end && end > start && end.getHours() === 0 && end.getMinutes() === 0) end = new Date(end.getTime() - 1);
    return [['Date', end && !sameDay(start, end) ? `${dayText(start)} – ${dayText(end)}` : dayText(start)]];
  }
  return [
    ['Date', dayText(start)],
    ['Time', timeText(start)],
    ['Ends', end && end > start ? (sameDay(start, end) ? timeText(end) : `${dayText(end)}, ${timeText(end)}`) : ''],
  ];
}

function isoDay(value) {
  const date = validDate(value);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : 'undated';
}

/** A property holding an ISO date ("2026-10-27", or a range) reads as days. */
function readableProperty(value) {
  const text = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?(?: – \d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?)?$/.test(text)) return text;
  return text.split(' – ').map((part) => {
    // A bare date is that day wherever this Mac is, not UTC midnight.
    const date = /T/.test(part) ? new Date(part) : new Date(`${part}T00:00`);
    return /T/.test(part) ? `${dayText(date)}, ${timeText(date)}` : dayText(date);
  }).join(' – ');
}

/** One line of text, so a field cannot start a heading or list of its own. */
function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function block(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function person(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return inline(entry);
  const name = inline(entry.name), address = inline(entry.address ?? entry.email);
  return name && address && name !== address ? `${name} <${address}>` : name || address;
}

function fields(rows) {
  return rows.filter(([, value]) => value != null && String(value).trim())
    .map(([label, value]) => `- **${label}:** ${inline(value)}`).join('\n');
}

/** A file name that is safe on every file system and stays short. */
export function fileNameFor(item) {
  // A leading dot or tilde would read as a hidden or Office lock file.
  const title = inline(item.title || 'Untitled').replace(/[\\/:*?"<>|#\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[.~\s]+/, '').trim();
  const short = title.length > 72 ? `${title.slice(0, 71).trim()}…` : title;
  // Ids such as "…@google.com" share their ends, so the tag is a short hash.
  const tag = crypto.createHash('sha256').update(String(item.id ?? '')).digest('hex').slice(0, 6);
  const when = item.kind === 'page' ? '' : `${isoDay(item.kind === 'event' ? item.start : item.received)} `;
  return `${when}${short || 'Untitled'} (${tag}).md`;
}

const FOLDERS = { message: 'Mail', event: 'Calendar', page: 'Pages' };

/** Where the item lives inside the connection's folder. */
export function relativePathFor(item) {
  return `${FOLDERS[item.kind] ?? 'Items'}/${fileNameFor(item)}`;
}

export function renderItem(item, { providerName }) {
  const target = String(item.link ?? '').replace(/[()\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  const link = /^https?:\/\//i.test(target) ? `\n\n[Open in ${providerName}](${target})` : '';
  // The title, then labelled fields, so Lasso reads each item as a record:
  // linked by its title, "on" offers its date and "at" its time.
  if (item.kind === 'message') {
    const meta = fields([
      ['From', person(item.from)],
      ['To', (item.to ?? []).map(person).filter(Boolean).join(', ')],
      ['Cc', (item.cc ?? []).map(person).filter(Boolean).join(', ')],
      ['Date', dayText(item.received)],
      ['Time', timeText(item.received)],
      ['Folder', item.folder],
      ['Attachments', (item.attachments ?? []).map(inline).join(', ')],
    ]);
    return `# ${inline(item.title) || '(No subject)'}\n\n${meta}\n\n${block(item.body)}${link}\n`;
  }
  if (item.kind === 'event') {
    const meta = fields([
      ...eventTimes(item),
      ['Location', item.location],
      ['Organizer', person(item.organizer)],
      ['Attendees', (item.attendees ?? []).map(person).filter(Boolean).join(', ')],
      ['Calendar', item.calendar],
      ['Repeats', item.recurrence],
      ['Status', item.status],
    ]);
    return `# ${inline(item.title) || '(No title)'}\n\n${meta}\n\n${block(item.description)}${link}\n`;
  }
  const meta = fields([
    ['In', item.path],
    ...(item.properties ?? []).map(([label, value]) => [inline(label), readableProperty(value)]),
    ['Last edited', dayText(item.edited)],
  ]);
  return `# ${inline(item.title) || 'Untitled'}\n\n${meta}\n\n${block(item.body)}${link}\n`;
}
