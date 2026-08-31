// conflicts, alias, aliases, unalias — resolving names that mean two things.

import { ACTION, blank, dim, failure, fields, group, result, resultItem, text } from '../result.js';
import { plural } from './shared.js';

export function conflictsCommand(context, command) {
  const name = command.args.join(' ').trim();
  const conflicts = context.graph.conflicts(context.projectId, { name: name || null });

  if (!conflicts.length) {
    return result('conflicts', {
      headline: name ? `${name} is unambiguous` : 'No conflicting names',
      blocks: [dim(name
        ? 'Only one indexed source carries that name in this workspace.'
        : 'Every indexed dependency name resolves to exactly one source.')],
      data: { conflicts: [] },
    });
  }

  // `conflicts revenue` — one name, its candidates listed.
  if (name && conflicts.length === 1) {
    const [conflict] = conflicts;
    return result('conflicts', {
      headline: conflict.name,
      subhead: `${plural(conflict.candidates.length, 'candidate')}${conflict.resolved ? ' · an alias already pins one' : ''}`,
      blocks: [
        ...conflict.candidates.map((candidate, position) => group(`${position + 1}  ${candidate.path}`, [
          candidate.locator ? { text: candidate.locator, tone: 'dim' } : null,
          candidate.value == null ? null : { text: candidate.value, tone: 'normal' },
          { text: `${plural(candidate.references, 'reference')}${candidate.aliased ? ' · aliased' : ''}`, tone: 'dim' },
        ].filter(Boolean))),
        blank(),
        text('Pin one so the name resolves directly:'),
        dim(`alias ${conflict.name}-q3 ${conflict.candidates[0].address}`),
      ],
      results: conflict.candidates.map((candidate) => resultItem({
        title: candidate.path,
        lines: [candidate.locator || null, plural(candidate.references, 'reference')],
        value: candidate.value,
        badge: candidate.aliased ? 'aliased' : null,
        ref: { kind: 'object', objectId: candidate.objectId, objectKey: candidate.objectKey, name: candidate.name, path: candidate.path, address: candidate.address },
        actions: [ACTION.inspect],
      })),
      actions: [ACTION.inspect],
      data: { conflict },
    });
  }

  return result('conflicts', {
    headline: `${plural(conflicts.length, 'ambiguous name')}`,
    blocks: conflicts.slice(0, 40).map((conflict) => group(conflict.name, [{
      text: `${plural(conflict.candidates.length, 'candidate')} across ${plural(new Set(conflict.candidates.map((candidate) => candidate.path)).size, 'file')}`,
      meta: conflict.resolved ? 'an alias pins one' : null,
      tone: conflict.resolved ? 'dim' : 'warn',
    }])),
    results: conflicts.map((conflict) => resultItem({
      title: conflict.name,
      lines: [
        `${plural(conflict.candidates.length, 'candidate')}`,
        ...conflict.candidates.slice(0, 3).map((candidate) => `${candidate.path}${candidate.locator ? `  ${candidate.locator}` : ''}`),
      ],
      badge: conflict.resolved ? 'aliased' : null,
      tone: conflict.resolved ? 'normal' : 'warn',
      ref: { kind: 'conflict', name: conflict.name },
      actions: [ACTION.inspect],
    })),
    hints: ['`conflicts <name>` compares the candidates for one name.'],
    data: { conflicts },
  });
}

export function aliasCommand(context, command) {
  const [name, ...rest] = command.args;
  const address = rest.join(' ').trim();
  if (!name || !address) {
    return failure('alias', 'alias needs a name and a source address.', {
      hints: ['alias q3-revenue Finance/Q3/model.xlsx:Summary!B17', '`conflicts <name>` prints the addresses to choose between.'],
    });
  }

  const created = context.aliases.create(context.projectId, { name, address }, context.actor, context.graph);
  return result('alias', {
    headline: created.replaced ? `${created.alias.name} re-pointed` : `${created.alias.name} → ${created.alias.address}`,
    blocks: [
      fields([
        ['source', created.object.path],
        created.alias.locator ? ['location', created.alias.locator] : null,
        ['value', created.object.valueText],
        ['indexed name', created.object.name],
      ]),
      blank(),
      dim(`\`trace ${created.alias.name}\` now resolves straight to this source. The editor's autocomplete recognises it too.`),
    ],
    data: created,
  });
}

export function aliasesCommand(context) {
  const aliases = context.aliases.list(context.projectId);
  if (!aliases.length) {
    return result('aliases', {
      headline: 'No aliases',
      blocks: [dim('An alias pins an ambiguous name to one exact source location.')],
      hints: ['alias q3-revenue Finance/Q3/model.xlsx:Summary!B17'],
      data: { aliases: [] },
    });
  }
  return result('aliases', {
    headline: plural(aliases.length, 'alias', 'aliases'),
    blocks: [{
      kind: 'table',
      columns: ['alias', 'source', 'location'],
      rows: aliases.map((alias) => [alias.name, alias.path, alias.locator ?? '—']),
    }],
    results: aliases.map((alias) => {
      const object = context.graph.objectByKey(context.projectId, alias.objectKey);
      return resultItem({
        title: alias.name,
        lines: [alias.path, alias.locator || null, object ? null : 'the pinned source is no longer indexed'],
        value: object?.valueText ?? null,
        tone: object ? 'normal' : 'warn',
        ref: object
          ? { kind: 'object', objectId: object.id, objectKey: object.objectKey, name: alias.name, path: object.path }
          : { kind: 'alias', name: alias.name },
        actions: [ACTION.inspect],
      });
    }),
    hints: ['`unalias <name>` removes one.'],
    data: { aliases },
  });
}

export function unaliasCommand(context, command) {
  const name = command.args.join(' ').trim();
  if (!name) return failure('unalias', 'unalias needs an alias name.');
  const removed = context.aliases.remove(context.projectId, name);
  return result('unalias', {
    headline: `Removed ${removed.name}`,
    blocks: [dim(`${removed.name} no longer resolves to ${removed.address}.`)],
    data: removed,
  });
}
