// shares — externally shared dependencies created from the app.

import { ACTION, blank, dim, failure, fields, group, result, resultItem, text } from '../result.js';
import { formatDay, formatMoment, plural } from './shared.js';

function shareRows(share) {
  return [
    { text: share.target, tone: 'dim' },
    { text: `created ${formatDay(share.createdAt)}${share.createdBy ? ` by ${share.createdBy}` : ''}`, tone: 'dim' },
    share.sharedValue == null ? null : { text: `shared value ${share.sharedValue}`, tone: 'dim' },
    share.drifted
      ? { text: `source has since changed to ${share.currentValue}`, tone: 'warn' }
      : { text: `status ${share.status}`, tone: share.status === 'active' ? 'dim' : 'warn' },
  ].filter(Boolean);
}

export function sharesCommand(context, command) {
  const flags = command.flags;
  const name = command.args.join(' ').trim();

  const status = flags.revoked ? 'revoked' : flags.expired ? 'expired' : flags.all ? null : 'active';
  const shares = context.graph.shares(context.projectId, {
    status,
    name: name || null,
    includeRevoked: true,
    includeExpired: true,
  });

  if (name && !shares.length) {
    const resolution = context.graph.resolve(context.projectId, name);
    if (resolution.status !== 'RESOLVED') {
      return failure('shares', `No shares and no indexed dependency named ${name}.`);
    }
    return result('shares', {
      headline: `${resolution.object.name} has never been shared`,
      blocks: [dim('Inserting a dependency does not share it; sharing is a separate action in the editor.')],
      data: { shares: [] },
    });
  }

  if (!shares.length) {
    return result('shares', {
      headline: status ? `No ${status} shares` : 'No shares',
      blocks: [dim('Nothing from this workspace is currently published outside the app.')],
      data: { shares: [] },
    });
  }

  const drifted = shares.filter((share) => share.drifted);
  const blocks = shares.map((share) => group(share.name, shareRows(share)));
  if (drifted.length) {
    blocks.push(blank(), text(`${plural(drifted.length, 'share')} pinned to a value the source has since changed.`, 'warn'));
    blocks.push(dim('A recipient still sees the version that was shared. Revoke and reshare to publish the new value.'));
  }

  return result('shares', {
    headline: `${plural(shares.length, `${status ?? ''} share`.trim())}`,
    subhead: name || null,
    blocks,
    results: shares.map((share) => resultItem({
      title: share.name,
      lines: [
        share.target,
        [share.fileName, share.locator].filter(Boolean).join(' · '),
        `created ${formatMoment(share.createdAt)}`,
        share.drifted ? `shared ${share.sharedValue} · source now ${share.currentValue}` : `status ${share.status}`,
      ],
      value: share.sharedValue,
      badge: share.status === 'active' ? null : share.status,
      tone: share.status === 'active' && !share.drifted ? 'normal' : 'warn',
      ref: {
        kind: 'share',
        token: share.token,
        shareKind: share.kind,
        url: share.url,
        objectId: share.objectId,
        name: share.name,
        status: share.status,
      },
      actions: [ACTION.revoke, ACTION.open, ACTION.copyLink, ACTION.inspectDependency],
    })),
    actions: [ACTION.revoke, ACTION.open, ACTION.copyLink, ACTION.inspectDependency],
    hints: ['`shares --expired` and `shares --revoked` list the rest.'],
    data: { shares },
  });
}

/** Backing the `[r] revoke` action. Revocation takes effect immediately. */
export function revokeShareCommand(context, command) {
  const token = command.args[0];
  if (!token) return failure('shares', 'revoke needs a share token.');
  const share = context.graph.shares(context.projectId, { includeRevoked: true, includeExpired: true })
    .find((candidate) => candidate.token === token);
  if (!share) return failure('shares', 'That share does not belong to this workspace.');
  if (share.status === 'revoked') {
    return result('shares', { headline: `${share.name} was already revoked`, data: { share } });
  }
  if (share.kind === 'OBJECT') context.objectShares.revokeShare(token);
  else context.dependencies.revokeDependencyShare(token);
  return result('shares', {
    headline: `Revoked the share of ${share.name}`,
    blocks: [
      fields([['target', share.target], ['created', formatMoment(share.createdAt)]]),
      blank(),
      dim('The link now refuses access. The record is kept, not deleted.'),
    ],
    data: { share },
  });
}
