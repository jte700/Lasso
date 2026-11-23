// Times, sizes, counts and people as the CLI writes them.

import os from 'node:os';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const asTime = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));

/** "just now", "4m", "3h", "yesterday", "5d", then "Nov 3". */
export function ago(value, now = Date.now()) {
  const time = asTime(value);
  if (!Number.isFinite(time)) return '';
  const elapsed = Math.max(0, now - time);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < HOUR) return `${Math.max(1, Math.round(elapsed / MINUTE))}m ago`;
  if (elapsed < DAY) return `${Math.round(elapsed / HOUR)}h ago`;
  if (sameDay(time, now - DAY)) return 'yesterday';
  if (elapsed < 7 * DAY) return `${Math.round(elapsed / DAY)}d ago`;
  return shortDate(time, now);
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

/** "Nov 3", with the year when it is not this one. */
export function shortDate(value, now = Date.now()) {
  const date = new Date(asTime(value));
  const year = date.getFullYear() === new Date(now).getFullYear() ? '' : `, ${date.getFullYear()}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()}${year}`;
}

/** "7:11 PM". */
export function clock(value) {
  const date = new Date(asTime(value));
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "Nov 21, 7:11 PM". */
export const stamp = (value, now = Date.now()) => `${shortDate(value, now)}, ${clock(value)}`;

/** The heading a day's entries go under: "Today", "Yesterday", "Thu Nov 19". */
export function dayHeading(value, now = Date.now()) {
  const time = asTime(value);
  if (sameDay(time, now)) return 'Today';
  if (sameDay(time, now - DAY)) return 'Yesterday';
  const date = new Date(time);
  return `${WEEKDAYS[date.getDay()]} ${shortDate(time, now)}`;
}

export const count = (number) => Number(number ?? 0).toLocaleString('en-US');

export function plural(number, one, many = `${one}s`) {
  return `${count(number)} ${number === 1 ? one : many}`;
}

export function bytes(size) {
  if (!Number.isFinite(size)) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = -1;
  do { value /= 1024; unit += 1; } while (value >= 1024 && unit < units.length - 1);
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** A path under the home folder written from "~". */
export function tilde(filePath, home = os.homedir()) {
  const text = String(filePath ?? '');
  return home && (text === home || text.startsWith(`${home}/`)) ? `~${text.slice(home.length)}` : text;
}

/** "~/x" read as the home folder. */
export function untilde(filePath, home = os.homedir()) {
  const text = String(filePath ?? '');
  return text === '~' ? home : text.startsWith('~/') ? `${home}${text.slice(1)}` : text;
}

// Names a person's own Lasso records its edits under.
const SELF_NAMES = new Set(['desktop', 'local user', 'terminal', 'you', 'me']);

/**
 * Who made a change, as the CLI says it: "you" for the person's own
 * edits, the agent's name with what it is, Lasso for its own records.
 */
export function who(actor) {
  if (!actor) return { name: 'someone', kind: 'unknown' };
  const name = actor.name ?? actor.displayName ?? 'someone';
  const type = actor.type ?? actor.actorType;
  if (type === 'AI_AGENT') return { name, kind: 'agent' };
  if (type === 'SYSTEM') return { name: 'Lasso', kind: 'system' };
  if (type === 'HUMAN_SELF' && SELF_NAMES.has(String(name).toLowerCase())) return { name: 'You', kind: 'self' };
  if (type === 'HUMAN_SELF') return { name, kind: 'self' };
  return { name, kind: 'person' };
}

/** How a change was recorded, in a word or two. */
export function how(source) {
  return {
    WATCHER: 'saved', IMPORT: 'first read', AGENT_EDIT: 'AI edit', REINDEX: 'read again', DOCUMENT_CHANGE: 'edited in Lasso',
    OPEN_RECONCILE: 'found on opening', MANUAL: 'checkpoint', DEPENDENCY_LINKED: 'linked', DEPENDENCY_CHANGED: 'link updated',
    DEPENDENCY_STALE: 'link went stale', DEPENDENCY_REMOVED: 'link removed', REVIEW_EDIT: 'review edit',
  }[source] ?? String(source ?? '').toLowerCase().replaceAll('_', ' ');
}

export const shortHash = (hash) => (hash ? `${hash.slice(0, 8)}…${hash.slice(-4)}` : '');
