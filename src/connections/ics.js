// Reads the events of an iCalendar (.ics) feed, as published by Outlook,
// Google Calendar, iCloud and most other calendar apps.

// Outlook names zones the Windows way. These are the ones it publishes most.
const WINDOWS_ZONES = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'Atlantic Standard Time': 'America/Halifax', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'US Mountain Standard Time': 'America/Phoenix',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'Israel Standard Time': 'Asia/Jerusalem', 'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane', 'New Zealand Standard Time': 'Pacific/Auckland',
  'SA Pacific Standard Time': 'America/Bogota', 'E. South America Standard Time': 'America/Sao_Paulo',
  'Canada Central Standard Time': 'America/Regina', 'Newfoundland Standard Time': 'America/St_Johns',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Egypt Standard Time': 'Africa/Cairo', UTC: 'UTC',
};

/** Joins folded lines (RFC 5545 §3.1) and splits the feed into content lines. */
function unfold(text) {
  return String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter(Boolean);
}

function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, character) => (/n/i.test(character) ? '\n' : character));
}

/** "DTSTART;TZID=Europe/Berlin:20261021T091500" → name, params and value. */
export function parseLine(line) {
  let index = 0, inQuote = false;
  for (; index < line.length; index++) {
    const character = line[index];
    if (character === '"') inQuote = !inQuote;
    else if (character === ':' && !inQuote) break;
  }
  const head = line.slice(0, index), value = line.slice(index + 1);
  const [name, ...rawParams] = head.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const params = {};
  for (const param of rawParams) {
    const at = param.indexOf('=');
    if (at > 0) params[param.slice(0, at).toUpperCase()] = param.slice(at + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function offsetIn(timeZone, ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - ms;
}

/** A wall-clock time in a named zone, as an instant. Unknown zones read as local time. */
function zonedTime(fields, zoneName) {
  const [year, month, day, hour, minute, second] = fields;
  const timeZone = WINDOWS_ZONES[zoneName] ?? zoneName;
  try {
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    let instant = wall - offsetIn(timeZone, wall);
    // Near a daylight-saving change the first guess lands an hour out.
    const corrected = wall - offsetIn(timeZone, instant);
    if (corrected !== instant) instant = corrected;
    return new Date(instant);
  } catch {
    return new Date(year, month - 1, day, hour, minute, second);
  }
}

/** A DATE or DATE-TIME value, with whether it is a whole day. */
export function parseDate({ params, value }) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, utc] = match;
  const numbers = [y, mo, d, h ?? 0, mi ?? 0, s ?? 0].map(Number);
  if (params.VALUE === 'DATE' || h == null) return { date: new Date(numbers[0], numbers[1] - 1, numbers[2]), allDay: true };
  if (utc) return { date: new Date(Date.UTC(...[numbers[0], numbers[1] - 1, ...numbers.slice(2)])), allDay: false };
  if (params.TZID) return { date: zonedTime(numbers, params.TZID), allDay: false };
  return { date: new Date(numbers[0], numbers[1] - 1, numbers[2], numbers[3], numbers[4], numbers[5]), allDay: false };
}

const WEEKDAYS = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };
const UNITS = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

/** "Every 2 weeks on Mon, Wed until 1 Dec 2026" from an RRULE value. */
export function describeRule(value) {
  const rule = Object.fromEntries(String(value).split(';').map((part) => part.split('=')).filter(([key]) => key));
  const unit = UNITS[rule.FREQ];
  if (!unit) return 'Repeats';
  const interval = Number(rule.INTERVAL) > 1 ? Number(rule.INTERVAL) : 1;
  let text = interval > 1 ? `Every ${interval} ${unit}s` : `Every ${unit}`;
  const days = String(rule.BYDAY ?? '').split(',').map((day) => WEEKDAYS[day.slice(-2)]).filter(Boolean);
  if (days.length) text += ` on ${days.join(', ')}`;
  if (rule.UNTIL) {
    const until = parseDate({ params: {}, value: rule.UNTIL });
    if (until) text += ` until ${until.date.getDate()} ${until.date.toLocaleString('en-US', { month: 'short' })} ${until.date.getFullYear()}`;
  } else if (Number(rule.COUNT) > 0) text += `, ${Number(rule.COUNT)} times`;
  return text;
}

function untilOf(value) {
  const until = String(value).match(/(?:^|;)UNTIL=([0-9TZ]+)/)?.[1];
  return until ? parseDate({ params: {}, value: until })?.date ?? null : null;
}

function person({ params, value }) {
  const address = value.replace(/^mailto:/i, '');
  return { name: params.CN ? unescapeText(params.CN) : '', address };
}

/**
 * Events from the feed whose time falls in [from, to], plus repeating events
 * that are still repeating then. Each is listed once, with its pattern.
 */
export function parseCalendar(text, { from = null, to = null } = {}) {
  const lines = unfold(text);
  if (!lines.some((line) => /^BEGIN:VCALENDAR/i.test(line))) {
    throw new Error('That address did not return a calendar. Check that it is the iCal (.ics) link.');
  }
  let calendarName = null;
  const events = [];
  let current = null, depth = 0;
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry.name === 'BEGIN' && /^VEVENT$/i.test(entry.value)) { current = { attendees: [] }; depth = 0; continue; }
    if (!current) {
      if (entry.name === 'X-WR-CALNAME') calendarName = unescapeText(entry.value);
      continue;
    }
    // Alarms and other parts nested in an event have their own properties.
    if (entry.name === 'BEGIN') { depth++; continue; }
    if (entry.name === 'END' && depth > 0) { depth--; continue; }
    if (entry.name === 'END' && /^VEVENT$/i.test(entry.value)) { events.push(current); current = null; continue; }
    if (depth > 0) continue;
    switch (entry.name) {
      case 'UID': current.uid = entry.value; break;
      case 'SUMMARY': current.title = unescapeText(entry.value); break;
      case 'DESCRIPTION': current.description = unescapeText(entry.value); break;
      case 'LOCATION': current.location = unescapeText(entry.value); break;
      case 'STATUS': current.status = entry.value.charAt(0) + entry.value.slice(1).toLowerCase(); break;
      case 'URL': current.link = entry.value; break;
      case 'DTSTART': current.start = parseDate(entry); break;
      case 'DTEND': current.end = parseDate(entry); break;
      case 'RRULE': current.rule = entry.value; break;
      case 'RECURRENCE-ID': current.recurrenceId = entry.value; break;
      case 'ORGANIZER': current.organizer = person(entry); break;
      case 'ATTENDEE': current.attendees.push(person(entry)); break;
      default: break;
    }
  }
  const inRange = (event) => {
    const start = event.start?.date;
    if (!start) return false;
    const end = event.end?.date ?? start;
    if (event.rule) {
      const until = untilOf(event.rule);
      return (!to || start <= to) && (!from || !until || until >= from);
    }
    return (!to || start <= to) && (!from || end >= from);
  };
  return {
    name: calendarName,
    events: events.filter(inRange).map((event) => ({
      id: event.recurrenceId ? `${event.uid ?? ''}-${event.recurrenceId}` : (event.uid ?? `${event.title}-${event.start.date.toISOString()}`),
      kind: 'event',
      title: event.title ?? '',
      start: event.start.date.toISOString(),
      end: event.end?.date?.toISOString() ?? null,
      allDay: event.start.allDay,
      location: event.location ?? '',
      description: event.description ?? '',
      organizer: event.organizer ?? null,
      attendees: event.attendees,
      recurrence: event.rule ? describeRule(event.rule) : '',
      status: event.status && event.status !== 'Confirmed' ? event.status : '',
      calendar: calendarName ?? '',
      link: event.link ?? null,
    })),
  };
}
