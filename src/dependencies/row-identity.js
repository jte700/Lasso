// How a table's rows are told apart from one version of a file to the next.
//
// A key is an object's identity, so a row's part of its key must not be its
// position: inserting one row would make every row below it a new object and
// leave links to them pointing at nothing. A row with a name is known by that
// name. A row without one is known by a token: the reader makes one from the
// row's own cells, and the identity step below hands an edited, moved or
// sorted row the token the same row had in the file's previous version.

import crypto from 'node:crypto';
import { normalizedVariable } from './tabular.js';

// What marks the second and later of equally named rows ("rent#2"), and a
// row without a name ("~3f9a..."). A normalised name is only [a-z0-9], so
// neither can be mistaken for one, and neither contains the ":" keys use.
const OCCURRENCE = '#';
const PROVISIONAL = '~';
// A label with no letters or digits a normalised name keeps ("%", "東京").
const UNSPELLED = '_';
const HASH_LENGTH = 12;

export function shortHash(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, HASH_LENGTH);
}

/** What a row with this label is called in keys before its occurrence: its normalised label. */
export function labelIdentity(label) {
  return normalizedVariable(label) || `${UNSPELLED}${shortHash(String(label ?? '').trim())}`;
}

export function withOccurrence(base, occurrence) {
  return occurrence > 1 ? `${base}${OCCURRENCE}${occurrence}` : base;
}

function splitOccurrence(identity) {
  const at = identity.lastIndexOf(OCCURRENCE);
  if (at < 0) return { base: identity, occurrence: 1 };
  return { base: identity.slice(0, at), occurrence: Number(identity.slice(at + 1)) || 1 };
}

/**
 * Tells equally named things in one table apart by their order: the first
 * "Rent" is "rent", the second "rent#2", and so on. Each call returns the
 * identity of the next thing with that base.
 *
 * Deleting one of several equally named rows renumbers the ones after it, so
 * those become the objects the earlier ones were. That is accepted: such
 * rows have nothing else that tells them apart.
 */
export function occurrenceCounter() {
  const seen = new Map();
  return (base) => {
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return withOccurrence(base, occurrence);
  };
}

/** One row's cells as [column, value] pairs, in an order that does not depend on the columns' order. */
function contentOf(pairs) {
  const byColumn = new Map();
  for (const [column, value] of pairs) if (!byColumn.has(column)) byColumn.set(column, String(value ?? ''));
  return [...byColumn].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

const contentHash = (content) => shortHash(content.map(([column, value]) => `${column}\u001f${value}`).join('\u001e'));

/** The provisional token of a row without a name, made from its indexed cells as [column, value] pairs. */
export function provisionalToken(pairs) {
  return `${PROVISIONAL}${contentHash(contentOf(pairs))}`;
}

const CELL_KEY = /^(.*?):cell:(~[0-9a-f]+(?:#\d+)?):(.*)$/s;

/** A cell of a row without a name: its table's key prefix, its row's token and its column. */
function tokenCell(key) {
  const match = CELL_KEY.exec(key);
  return match ? { prefix: match[1], token: match[2], column: match[3] } : null;
}

export function hasProvisionalRows(descriptors) {
  return descriptors.some((descriptor) => tokenCell(descriptor.key));
}

/**
 * The rows without names in objects of one file, by table: each with its
 * token, its cells and the hash of their content, in file order. `objects`
 * are { key, value, anchor }; recorded ones come in no particular order, so
 * rows are ordered by the row their cells are anchored at.
 */
function rowsByTable(objects) {
  const tables = new Map();
  for (const [position, object] of objects.entries()) {
    const cell = tokenCell(object.key);
    if (!cell) continue;
    if (!tables.has(cell.prefix)) tables.set(cell.prefix, new Map());
    const rows = tables.get(cell.prefix);
    if (!rows.has(cell.token)) rows.set(cell.token, { token: cell.token, pairs: [], position, rowIndex: object.anchor?.rowIndex ?? position });
    rows.get(cell.token).pairs.push([cell.column, object.value]);
  }
  const output = new Map();
  for (const [prefix, rows] of tables) {
    const ordered = [...rows.values()].sort((left, right) => left.rowIndex - right.rowIndex || left.position - right.position)
      .map((row) => {
        const content = contentOf(row.pairs);
        return { token: row.token, cells: new Set(content.map(([column, value]) => `${column}\u001f${value}`)),
          hash: contentHash(content) };
      });
    output.set(prefix, ordered);
  }
  return output;
}

function sharedCells(left, right) {
  let shared = 0;
  for (const cell of left.cells) if (right.cells.has(cell)) shared += 1;
  return shared;
}

/** Pairs rows whose content is unchanged, wherever they now are: a sorted table keeps every identity. */
function matchUnchanged(fresh, previous, partner) {
  const waiting = new Map();
  for (const [index, row] of previous.entries()) {
    if (!waiting.has(row.hash)) waiting.set(row.hash, []);
    waiting.get(row.hash).push(index);
  }
  for (const [index, row] of fresh.entries()) {
    const candidates = waiting.get(row.hash);
    if (candidates?.length) partner[index] = candidates.shift();
  }
}

/** The runs of rows step (1) left unmatched, each with the previous rows its matched neighbours came from. */
function unmatchedRuns(partner, previousCount) {
  const runs = [];
  let before = -1;
  let run = [];
  for (let index = 0; index <= partner.length; index += 1) {
    if (index < partner.length && partner[index] == null) {
      run.push(index);
      continue;
    }
    const after = index < partner.length ? partner[index] : previousCount;
    if (run.length) runs.push({ rows: run, low: Math.min(before, after), high: Math.max(before, after) });
    run = [];
    if (index < partner.length) before = partner[index];
  }
  return runs;
}

/** Whether pairing fresh row `index` with previous row `candidate` keeps the pairs already made in order. */
function keepsOrder(pairs, index, candidate) {
  let low = 0;
  let high = pairs.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pairs[middle][0] < index) low = middle + 1;
    else high = middle;
  }
  return (low === 0 || pairs[low - 1][1] < candidate) && (low === pairs.length || pairs[low][1] > candidate);
}

/**
 * Pairs rows still unmatched with unmatched previous rows between the
 * previous rows their matched neighbours came from, when they share at least
 * half of their cells: an edited row keeps its identity. The pairs sharing
 * the most cells are made first (the earlier rows first among equals), so a
 * row inserted beside an edited one, sharing fewer of its cells, cannot take
 * its identity; pairs that would cross ones already made are left out.
 */
function matchEdited(fresh, previous, partner) {
  const taken = new Set(partner.filter((index) => index != null));
  for (const { rows, low, high } of unmatchedRuns(partner, previous.length)) {
    const scored = [];
    for (const index of rows) {
      for (let candidate = low + 1; candidate < high; candidate += 1) {
        if (taken.has(candidate)) continue;
        const shared = sharedCells(fresh[index], previous[candidate]);
        if (shared && shared * 2 >= Math.max(fresh[index].cells.size, previous[candidate].cells.size)) {
          scored.push({ index, candidate, shared });
        }
      }
    }
    scored.sort((left, right) => right.shared - left.shared || left.index - right.index || left.candidate - right.candidate);
    const pairs = [];
    for (const { index, candidate } of scored) {
      if (partner[index] != null || taken.has(candidate) || !keepsOrder(pairs, index, candidate)) continue;
      partner[index] = candidate;
      taken.add(candidate);
      const at = pairs.findIndex(([other]) => other > index);
      pairs.splice(at < 0 ? pairs.length : at, 0, [index, candidate]);
    }
  }
}

/** The next token after `token` with its base that nothing in `used` has. */
function unusedToken(token, used) {
  const { base, occurrence } = splitOccurrence(token);
  let next = occurrence;
  while (used.has(withOccurrence(base, next))) next += 1;
  return withOccurrence(base, next);
}

/** Each fresh row's token: the previous row's it was matched with, or its own made unique. */
function tableTokens(fresh, previous) {
  const partner = new Array(fresh.length).fill(null);
  matchUnchanged(fresh, previous, partner);
  matchEdited(fresh, previous, partner);
  const used = new Set(previous.map((row) => row.token));
  const tokens = new Map();
  for (const [index, row] of fresh.entries()) {
    if (partner[index] != null) tokens.set(row.token, previous[partner[index]].token);
  }
  for (const [index, row] of fresh.entries()) {
    if (partner[index] != null) continue;
    const token = unusedToken(row.token, used);
    used.add(token);
    tokens.set(row.token, token);
  }
  return tokens;
}

/**
 * The identity step. `descriptors` are a fresh reading of one file, whose
 * rows without names carry provisional tokens; `recorded` are the objects
 * recorded for the same file at the index this reading builds on, as
 * { key, value, anchor }. Returns the descriptors with each such row's cells
 * keyed by the token it is given:
 *
 * 1. a row whose content equals a previous row's takes that row's token,
 *    matched as a multiset regardless of order, so sorting keeps them all;
 * 2. a row still unmatched takes the token of an unmatched previous row
 *    between its matched neighbours that shares at least half of its cells,
 *    the pairs sharing most cells first, so an edited row keeps its identity;
 * 3. any other row keeps its provisional token, made unique against the
 *    tokens in use.
 *
 * Descriptors are not changed in place; a re-keyed one is a copy. A table
 * reads at most 1,500 cells, so the pairing below is bounded by that.
 */
export function stableRowIdentities(descriptors, recorded) {
  const fresh = rowsByTable(descriptors);
  if (!fresh.size) return descriptors;
  const previous = rowsByTable(recorded);
  const renamed = new Map();
  for (const [prefix, rows] of fresh) {
    for (const [from, to] of tableTokens(rows, previous.get(prefix) ?? [])) {
      if (from !== to) renamed.set(`${prefix}\u0000${from}`, to);
    }
  }
  if (!renamed.size) return descriptors;
  return descriptors.map((descriptor) => {
    const cell = tokenCell(descriptor.key);
    const token = cell && renamed.get(`${cell.prefix}\u0000${cell.token}`);
    return token ? { ...descriptor, key: `${cell.prefix}:cell:${token}:${cell.column}` } : descriptor;
  });
}

export const rowIdentityMethods = {
  /**
   * A file's fresh reading with its rows without names given the identities
   * they had at `baseSnapshotId`, the index this reading is recorded on.
   */
  withStableRowIdentities(projectId, baseSnapshotId, file, descriptors) {
    if (!projectId || !baseSnapshotId || !['table', 'spreadsheet'].includes(file.fileType)) return descriptors;
    if (!hasProvisionalRows(descriptors)) return descriptors;
    const recorded = this.timeline.objectVersions.tokenCellsAt(baseSnapshotId, projectId, `${file.projectFileId}:`)
      .map((row) => ({ key: row.object_key, value: row.value_text, anchor: JSON.parse(row.anchor_json ?? 'null') }));
    return stableRowIdentities(descriptors, recorded);
  },
};
