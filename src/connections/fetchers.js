// Reads a connected app's items through its own API. Each fetcher returns
// items in the shape providers.renderItem writes; none of them changes
// anything in the app it reads.
import { HttpError } from '../history/errors.js';
import { ITEM_LIMIT } from './providers.js';
import { parseCalendar } from './ics.js';

const REQUEST_TIMEOUT_MS = 30_000;

/** An answer from an app's API, with its own message when it refuses. */
async function request(name, url, { fetchImpl, token, method = 'GET', headers = {}, body } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HttpError(502, `${name} could not be reached: ${error.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    const reason = await response.json().then((payload) => payload?.error?.message ?? payload?.message).catch(() => null);
    const error = new HttpError(401, `${name} no longer accepts Lasso's access${reason ? `: ${reason}` : ''}. Connect it again.`);
    error.reauthorize = true;
    throw error;
  }
  if (response.status === 429) throw new HttpError(503, `${name} asked Lasso to slow down. It will try again shortly.`);
  if (!response.ok) {
    const reason = await response.json().then((payload) => payload?.error?.message ?? payload?.message).catch(() => null);
    throw new HttpError(502, `${name} answered with an error${reason ? `: ${reason}` : ` (HTTP ${response.status})`}.`);
  }
  return response;
}

const json = async (...args) => (await request(...args)).json();

function windowOf(settings, now = new Date()) {
  const day = 86_400_000;
  return { from: new Date(now.getTime() - settings.pastDays * day), to: new Date(now.getTime() + settings.futureDays * day) };
}

// ---------- Outlook (Microsoft Graph) ----------

const GRAPH = 'https://graph.microsoft.com/v1.0';

function graphTime(value) {
  if (!value?.dateTime) return null;
  // Asked for UTC, Graph still leaves the zone off the time itself.
  const text = /[zZ]|[+-]\d{2}:\d{2}$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const graphPerson = (entry) => entry?.emailAddress ? { name: entry.emailAddress.name, address: entry.emailAddress.address } : null;

async function graphPages(url, { fetchImpl, token, headers, limit }) {
  const values = [];
  let next = url;
  while (next && values.length < limit) {
    const page = await json('Outlook', next, { fetchImpl, token, headers });
    values.push(...(page.value ?? []));
    next = page['@odata.nextLink'] ?? null;
  }
  return values.slice(0, limit);
}

export async function outlookAccount({ token, fetchImpl }) {
  const me = await json('Outlook', `${GRAPH}/me?$select=displayName,mail,userPrincipalName`, { fetchImpl, token });
  return me.mail || me.userPrincipalName || me.displayName || 'Outlook';
}

export async function fetchOutlook({ token, settings, fetchImpl, now }) {
  const { from, to } = windowOf(settings, now);
  const headers = { prefer: 'outlook.body-content-type="text", outlook.timezone="UTC"' };
  const items = [];
  if (settings.parts.includes('mail')) {
    const folders = await graphPages(`${GRAPH}/me/mailFolders?$top=100&$select=id,displayName`,
      { fetchImpl, token, headers, limit: 500 }).catch(() => []);
    const folderNames = new Map(folders.map((folder) => [folder.id, folder.displayName]));
    const query = new URLSearchParams({
      $filter: `receivedDateTime ge ${from.toISOString()}`, $orderby: 'receivedDateTime desc', $top: '100',
      $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,webLink,parentFolderId,isDraft',
    });
    const messages = await graphPages(`${GRAPH}/me/messages?${query}`, { fetchImpl, token, headers, limit: ITEM_LIMIT });
    for (const message of messages) {
      if (message.isDraft) continue;
      items.push({
        id: message.id, kind: 'message', title: message.subject ?? '', from: graphPerson(message.from),
        to: (message.toRecipients ?? []).map(graphPerson).filter(Boolean),
        cc: (message.ccRecipients ?? []).map(graphPerson).filter(Boolean),
        received: message.receivedDateTime, folder: folderNames.get(message.parentFolderId) ?? '',
        body: message.body?.content ?? '', link: message.webLink ?? null,
      });
    }
  }
  if (settings.parts.includes('calendar')) {
    const query = new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '100', $orderby: 'start/dateTime',
      $select: 'id,subject,start,end,isAllDay,location,organizer,attendees,body,webLink,type,isCancelled',
    });
    const events = await graphPages(`${GRAPH}/me/calendarView?${query}`, { fetchImpl, token, headers, limit: ITEM_LIMIT });
    for (const event of events) {
      items.push({
        id: event.id, kind: 'event', title: event.subject ?? '', start: graphTime(event.start), end: graphTime(event.end),
        allDay: Boolean(event.isAllDay), location: event.location?.displayName ?? '',
        organizer: graphPerson(event.organizer), attendees: (event.attendees ?? []).map(graphPerson).filter(Boolean),
        description: event.body?.content ?? '', link: event.webLink ?? null, calendar: 'Outlook',
        recurrence: event.type === 'occurrence' ? 'Part of a repeating series' : '',
        status: event.isCancelled ? 'Cancelled' : '',
      });
    }
  }
  return { items };
}

// ---------- Google Calendar ----------

const GOOGLE_CALENDAR = 'https://www.googleapis.com/calendar/v3';

export async function googleCalendars({ token, fetchImpl }) {
  const list = await json('Google Calendar', `${GOOGLE_CALENDAR}/users/me/calendarList?minAccessRole=reader&maxResults=250`,
    { fetchImpl, token });
  return (list.items ?? []).map((calendar) => ({ id: calendar.id, name: calendar.summaryOverride ?? calendar.summary,
    primary: Boolean(calendar.primary), selected: calendar.selected !== false }));
}

const googleTime = (value) => value?.dateTime ?? value?.date ?? null;
const googlePerson = (entry) => entry ? { name: entry.displayName ?? '', address: entry.email ?? '' } : null;

export async function fetchGoogleCalendar({ token, settings, fetchImpl, now }) {
  const { from, to } = windowOf(settings, now);
  const calendars = await googleCalendars({ token, fetchImpl });
  const chosen = settings.calendars?.length
    ? calendars.filter((calendar) => settings.calendars.includes(calendar.id))
    : calendars.filter((calendar) => calendar.selected);
  const items = [];
  for (const calendar of chosen) {
    let pageToken = null;
    do {
      const query = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true',
        orderBy: 'startTime', maxResults: '250', ...(pageToken ? { pageToken } : {}) });
      const page = await json('Google Calendar',
        `${GOOGLE_CALENDAR}/calendars/${encodeURIComponent(calendar.id)}/events?${query}`, { fetchImpl, token });
      for (const event of page.items ?? []) {
        if (event.status === 'cancelled') continue;
        items.push({
          id: `${calendar.id}:${event.id}`, kind: 'event', title: event.summary ?? '',
          start: googleTime(event.start), end: googleTime(event.end), allDay: Boolean(event.start?.date),
          location: event.location ?? '', organizer: googlePerson(event.organizer),
          attendees: (event.attendees ?? []).map(googlePerson).filter(Boolean),
          description: event.description ?? '', link: event.htmlLink ?? null, calendar: calendar.name ?? '',
          recurrence: event.recurringEventId ? 'Part of a repeating series' : '',
          status: event.status === 'tentative' ? 'Tentative' : '',
        });
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken && items.length < ITEM_LIMIT);
    if (items.length >= ITEM_LIMIT) break;
  }
  return { items: items.slice(0, ITEM_LIMIT) };
}

// ---------- Notion ----------

const NOTION = 'https://api.notion.com/v1';
const NOTION_HEADERS = { 'notion-version': '2022-06-28' };
// Notion allows about three requests a second for an integration.
const NOTION_SPACING_MS = 340;
const NOTION_PAGE_LIMIT = 400;
const NOTION_BLOCK_LIMIT = 600;
const NOTION_DEPTH = 3;

const plain = (richText = []) => richText.map((part) => part.plain_text ?? '').join('');

export async function notionAccount({ token, fetchImpl }) {
  const me = await json('Notion', `${NOTION}/users/me`, { fetchImpl, token, headers: NOTION_HEADERS });
  return me.bot?.workspace_name || me.name || 'Notion';
}

function propertyText(property) {
  switch (property?.type) {
    case 'title': case 'rich_text': return plain(property[property.type]);
    case 'number': return property.number == null ? '' : String(property.number);
    case 'select': case 'status': return property[property.type]?.name ?? '';
    case 'multi_select': return property.multi_select.map((option) => option.name).join(', ');
    case 'date': return property.date ? [property.date.start, property.date.end].filter(Boolean).join(' – ') : '';
    case 'people': return property.people.map((entry) => entry.name ?? '').filter(Boolean).join(', ');
    case 'checkbox': return property.checkbox ? 'Yes' : 'No';
    case 'url': case 'email': case 'phone_number': return property[property.type] ?? '';
    case 'formula': {
      const value = property.formula;
      return value?.type === 'date' ? value.date?.start ?? '' : value?.[value?.type] == null ? '' : String(value[value.type]);
    }
    case 'rollup': return property.rollup?.type === 'number' && property.rollup.number != null ? String(property.rollup.number) : '';
    case 'unique_id': return property.unique_id?.number == null ? '' : `${property.unique_id.prefix ? `${property.unique_id.prefix}-` : ''}${property.unique_id.number}`;
    case 'created_time': case 'last_edited_time': return property[property.type] ?? '';
    case 'relation': return property.relation?.length ? `${property.relation.length} linked` : '';
    default: return '';
  }
}

function pageTitle(page) {
  const title = Object.values(page.properties ?? {}).find((property) => property.type === 'title');
  return plain(title?.title) || 'Untitled';
}

function blockText(block, numbered) {
  const value = block[block.type] ?? {};
  const text = plain(value.rich_text);
  switch (block.type) {
    case 'paragraph': return text;
    case 'heading_1': return `## ${text}`;
    case 'heading_2': return `### ${text}`;
    case 'heading_3': return `#### ${text}`;
    case 'bulleted_list_item': return `- ${text}`;
    case 'numbered_list_item': return `${numbered}. ${text}`;
    case 'to_do': return `- [${value.checked ? 'x' : ' '}] ${text}`;
    case 'toggle': return `- ${text}`;
    case 'quote': return `> ${text}`;
    case 'callout': return `> ${value.icon?.emoji ? `${value.icon.emoji} ` : ''}${text}`;
    case 'code': return `\`\`\`${value.language ?? ''}\n${text}\n\`\`\``;
    case 'equation': return `$$ ${value.expression ?? ''} $$`;
    case 'divider': return '---';
    case 'child_page': return `**${value.title ?? 'Page'}** (subpage)`;
    case 'child_database': return `**${value.title ?? 'Database'}** (database)`;
    case 'bookmark': case 'embed': case 'link_preview': return value.url ?? '';
    case 'table_row': return `| ${(value.cells ?? []).map((cell) => plain(cell).replace(/\|/g, '\\|')).join(' | ')} |`;
    default: return text;
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function notionBlocks(pageId, { token, fetchImpl, spacing }) {
  const lines = [];
  let count = 0;
  const walk = async (blockId, depth) => {
    let cursor = null, numbered = 0;
    do {
      if (spacing) await pause(spacing);
      const query = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) });
      const page = await json('Notion', `${NOTION}/blocks/${blockId}/children?${query}`, { fetchImpl, token, headers: NOTION_HEADERS });
      for (const block of page.results ?? []) {
        if (++count > NOTION_BLOCK_LIMIT) return;
        numbered = block.type === 'numbered_list_item' ? numbered + 1 : 0;
        const indent = '  '.repeat(Math.max(0, depth));
        const text = blockText(block, numbered);
        if (text) lines.push(block.type === 'table_row' || block.type === 'code' ? text : `${indent}${text}`);
        if (block.type === 'table' && block.has_children) {
          const header = lines.length;
          await walk(block.id, depth);
          // A Markdown table needs a rule under its first row.
          if (lines.length > header) {
            const columns = (lines[header].match(/(?<!\\)\|/g)?.length ?? 2) - 1;
            lines.splice(header + 1, 0, `|${' --- |'.repeat(Math.max(1, columns))}`);
          }
        } else if (block.has_children && depth + 1 < NOTION_DEPTH && !['child_page', 'child_database'].includes(block.type)) {
          await walk(block.id, depth + 1);
        }
      }
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
  };
  await walk(pageId, 0);
  // Items of one list, or rows of one table, stay together.
  const listed = (line) => /^\s*(?:- |\d+\. |\|)/.test(line);
  return lines.reduce((text, line, index) => (index === 0 ? line
    : `${text}${listed(line) && listed(lines[index - 1]) ? '\n' : '\n\n'}${line}`), '');
}

/**
 * Pages shared with the integration, newest edits first. A page whose last
 * edit is already mirrored keeps its file, so its blocks are not read again.
 */
export async function fetchNotion({ token, fetchImpl, previous = {}, spacing = NOTION_SPACING_MS }) {
  const pages = [];
  let cursor = null;
  do {
    const page = await json('Notion', `${NOTION}/search`, { fetchImpl, token, method: 'POST', headers: NOTION_HEADERS,
      body: { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } });
    pages.push(...(page.results ?? []).filter((entry) => !entry.archived && !entry.in_trash));
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor && pages.length < NOTION_PAGE_LIMIT);
  const titles = new Map(pages.map((page) => [page.id, pageTitle(page)]));
  const items = [];
  for (const page of pages.slice(0, NOTION_PAGE_LIMIT)) {
    const title = titles.get(page.id);
    const parent = page.parent?.page_id ? titles.get(page.parent.page_id) : page.parent?.database_id ? 'Database' : '';
    const known = previous[page.id];
    const unchanged = known && known.edited === page.last_edited_time;
    const properties = Object.entries(page.properties ?? {})
      .filter(([, property]) => property.type !== 'title').map(([name, property]) => [name, propertyText(property)])
      .filter(([, value]) => value);
    items.push({
      id: page.id, kind: 'page', title, path: parent ?? '', properties, edited: page.last_edited_time,
      link: page.url ?? null, unchanged: Boolean(unchanged),
      body: unchanged ? null : await notionBlocks(page.id, { token, fetchImpl, spacing }),
    });
  }
  return { items };
}

// ---------- Calendar feeds (iCal) ----------

/** webcal:// is the same address over https. Only web addresses are fetched. */
export function feedUrl(input) {
  const text = String(input ?? '').trim().replace(/^webcals?:\/\//i, 'https://');
  let url;
  try { url = new URL(text); } catch { throw new HttpError(400, 'Enter the calendar’s iCal address, starting with https:// or webcal://.'); }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Enter the calendar’s iCal address, starting with https:// or webcal://.');
  if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(url.hostname)) {
    throw new HttpError(400, 'A calendar feed is read from the web, not from this computer.');
  }
  return url.toString();
}

export async function fetchFeed({ url, settings, fetchImpl, now }) {
  const response = await request('The calendar', url, { fetchImpl, headers: { accept: 'text/calendar, text/plain, */*' } });
  const text = await response.text();
  const { from, to } = windowOf(settings, now);
  let calendar;
  try { calendar = parseCalendar(text, { from, to }); }
  catch (error) { throw new HttpError(422, error.message); }
  return { name: calendar.name, items: calendar.events.slice(0, ITEM_LIMIT) };
}

// ---------- Calendar on this Mac ----------

/** Events the Mac app read with EventKit, checked before they are written. */
export function nativeEvents(input) {
  if (!Array.isArray(input)) throw new HttpError(400, 'Send the calendar’s events as a list.');
  const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
  const people = (value) => (Array.isArray(value) ? value.slice(0, 100).map((entry) => ({
    name: text(entry?.name, 200), address: text(entry?.address, 320) })) : []);
  return input.slice(0, ITEM_LIMIT).filter((event) => event && typeof event.id === 'string' && event.id).map((event) => ({
    id: event.id.slice(0, 400), kind: 'event', title: text(event.title, 500),
    start: text(event.start, 40) || null, end: text(event.end, 40) || null, allDay: Boolean(event.allDay),
    location: text(event.location, 500), description: text(event.notes ?? event.description, 20_000),
    organizer: event.organizer ? { name: text(event.organizer.name, 200), address: text(event.organizer.address, 320) } : null,
    attendees: people(event.attendees), calendar: text(event.calendar, 200), recurrence: text(event.recurrence, 200),
    status: text(event.status, 40), link: /^https?:\/\//.test(event.url ?? '') ? text(event.url, 2000) : null,
  }));
}
