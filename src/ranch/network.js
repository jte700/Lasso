// The connections The Ranch's network view draws between files, in the same
// directory or across directories. Every edge names why it exists:
//   link      a document links a value from the file (accepted with Tab)
//   used-in   the file was accepted while writing that document
//   mention   a text file names the other file
//   same-name the two share a distinctive name (Bracket.step, Bracket.pdf)
import { nameGroups } from './name-groups.js';

/** The strongest edges are kept; a network past this is too busy to read. */
export const MAX_EDGES = 2_000;
const KIND_WEIGHT = { link: 1, 'used-in': 1, mention: 0.75, 'same-name': 0.5 };
// A name shared by more files than this is too common to say which one is meant.
const MAX_MENTION_TARGETS = 3;

/**
 * Collects edges, adding up repeats of the same pair and kind.
 * @returns {{ add(from: string, to: string, kind: string, count?: number): void, edges(): object[] }}
 */
export function edgeCollector() {
  const edges = new Map();
  return {
    add(from, to, kind, count = 1) {
      if (!from || !to || from === to) return;
      const [a, b] = from < to ? [from, to] : [to, from];
      const key = `${a}|${b}|${kind}`;
      const weight = (edges.get(key)?.weight ?? 0) + count * (KIND_WEIGHT[kind] ?? 0.5);
      edges.set(key, { from: a, to: b, kind, weight: Math.round(weight * 100) / 100 });
    },
    edges() {
      return [...edges.values()].sort((left, right) => right.weight - left.weight
        || left.from.localeCompare(right.from) || left.to.localeCompare(right.to)).slice(0, MAX_EDGES);
    },
  };
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
  for (const group of nameGroups(files.map((file) => ({ key: file.id, name: file.name })))) {
    const ordered = [...group].sort();
    ordered.slice(1).forEach((id, index) => collector.add(ordered[index], id, 'same-name'));
  }
}
