// The connections The Loop's network view draws between files, in the same
// directory or across directories. Every edge names why it exists:
//   link      a document links a value from the file (accepted with Tab)
//   used-in   the file was accepted while writing that document
//   mention   a text file names the other file
//   same-name the two share a distinctive name (Bracket.step, Bracket.pdf)
// and keeps a few reasons, so the view can say what joins two files: the value
// linked, the name mentioned, the name shared, each with the file it starts from.
import { nameGroups, nameStem } from './name-groups.js';

/** The strongest edges are kept; a network past this is too busy to read. */
export const MAX_EDGES = 2_000;
const KIND_WEIGHT = { link: 1, 'used-in': 1, mention: 0.75, 'same-name': 0.5 };
// A name shared by more files than this is too common to say which one is meant.
const MAX_MENTION_TARGETS = 3;
/** Reasons kept per edge; more say nothing new on a card. */
const MAX_REASONS = 3;
const MAX_REASON_LENGTH = 80;

/**
 * @typedef {{ from: string | null, text: string | null }} EdgeReason
 *   `from` is the file the connection starts from (the document that links,
 *   the file that names); null when it runs both ways, as a shared name does.
 */

/**
 * Collects edges, adding up repeats of the same pair and kind.
 * @returns {{ add(from: string, to: string, kind: string, count?: number, reason?: EdgeReason): void, edges(): object[] }}
 */
export function edgeCollector() {
  const edges = new Map();
  return {
    add(from, to, kind, count = 1, reason = null) {
      if (!from || !to || from === to) return;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}|${b}|${kind}`;
      const before = edges.get(key);
      const weight = (before?.weight ?? 0) + count * (KIND_WEIGHT[kind] ?? 0.5);
      edges.set(key, { from: a, to: b, kind, weight: Math.round(weight * 100) / 100,
        reasons: withReason(before?.reasons ?? [], reason) });
    },
    edges() {
      return [...edges.values()].sort((left, right) => right.weight - left.weight
        || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)).slice(0, MAX_EDGES);
    },
  };
}

/** The reasons with one more, unless it repeats one or there are enough. */
function withReason(reasons, reason) {
  if (!reason || reasons.length >= MAX_REASONS) return reasons;
  const text = typeof reason.text === 'string' ? reason.text.trim().slice(0, MAX_REASON_LENGTH) || null : null;
  const next = { from: reason.from ?? null, text };
  if (reasons.some((known) => known.from === next.from && known.text === next.text)) return reasons;
  return [...reasons, next];
}

/**
 * Which files a mention means: the named files in the mentioning file's own
 * directory when there are any, otherwise anywhere, unless the name is common.
 * @param {Map<string, { id: string, directoryId: string }[]>} filesByName lower-case file name → files
 */
export function mentionTargets(filesByName, name, from) {
  const named = (filesByName.get(name) ?? []).filter((file) => file.id !== from.id);
  const local = named.filter((file) => file.directoryId === from.directoryId);
  const chosen = local.length ? local : named;
  return chosen.length <= MAX_MENTION_TARGETS ? chosen : [];
}

/** Chains each same-name group, so three related files draw two lines, not three. */
export function addNameEdges(collector, files) {
  const names = new Map(files.map((file) => [file.id, file.name]));
  for (const group of nameGroups(files.map((file) => ({ key: file.id, name: file.name })))) {
    const ordered = [...group].sort();
    const reason = { from: null, text: nameStem(names.get(ordered[0])) };
    ordered.slice(1).forEach((id, index) => collector.add(ordered[index], id, 'same-name', 1, reason));
  }
}
