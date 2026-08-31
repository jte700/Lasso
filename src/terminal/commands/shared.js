// Helpers shared by the command implementations.

import { ACTION, dim, failure, resultItem, text } from '../result.js';

/** Aug 21, 2026 2:14 PM — the form the terminal prints timestamps in. */
export function formatMoment(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function formatDay(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric' });
}

export function formatRelative(value, reference = Date.now()) {
  if (!value) return 'never';
  const elapsed = reference - Date.parse(value);
  if (!Number.isFinite(elapsed)) return 'unknown';
  const seconds = Math.max(0, Math.round(elapsed / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'} ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** `Finance/Q3/model.xlsx` with the file name emphasised by position, not markup. */
export function sourceLine(entry) {
  return [entry.path, entry.locator].filter(Boolean).join('  ');
}

/** A search or resolution candidate, rendered the same way everywhere. */
export function objectResult(object, { graph, projectId, badge = null, extraLines = [] } = {}) {
  const references = graph ? graph.referenceCount(projectId, object.id) : null;
  return resultItem({
    title: object.name,
    lines: [
      object.path,
      object.locator || null,
      ...extraLines,
      references ? plural(references, 'reference') : null,
    ],
    value: object.valueText ?? null,
    badge,
    ref: { kind: 'object', objectId: object.id, objectKey: object.objectKey, name: object.name, path: object.path },
    actions: [ACTION.inspect, ACTION.impact],
  });
}

/**
 * The response to a name that matches nothing or matches several things.
 * Ambiguity is reported with every candidate; the terminal never picks one.
 */
export function unresolved(command, resolution, { graph, projectId }) {
  if (resolution.status === 'ALIAS_BROKEN') {
    return failure(command, `The alias ${resolution.alias.name} points at ${resolution.alias.address}, which is no longer indexed.`, {
      hints: [`Re-point it with \`alias ${resolution.alias.name} <path>:<location>\`, or remove it with \`unalias ${resolution.alias.name}\`.`],
    });
  }
  if (resolution.status === 'AMBIGUOUS') {
    return {
      ...failure(command, `${resolution.query} matches ${resolution.candidates.length} indexed sources.`),
      blocks: [
        text('Name an exact source, or pin one with `alias`:'),
        dim(`alias ${resolution.query} ${resolution.candidates[0].path}:${resolution.candidates[0].locator}`),
      ],
      results: resolution.candidates.map((candidate) => objectResult(candidate, { graph, projectId })),
      hints: ['[Enter] inspect a candidate'],
    };
  }
  const near = resolution.candidates ?? [];
  return {
    ...failure(command, `No indexed dependency named ${resolution.query}.`),
    blocks: near.length ? [dim('Closest indexed sources:')] : [dim('Try `find` to search the index.')],
    results: near.map((candidate) => objectResult(candidate, { graph, projectId })),
  };
}

/**
 * Resolves a name, or returns the response that explains why it could not be.
 * Every command that takes a dependency name goes through here, so ambiguity
 * behaves identically across the terminal.
 */
export function requireObject(context, command, name, options = {}) {
  const resolution = context.graph.resolve(context.projectId, name, options);
  if (resolution.status === 'RESOLVED') return { object: resolution.object, alias: resolution.alias ?? null };
  return { response: unresolved(command, resolution, context) };
}
