// index — operate the index directly.

import { ACTION, blank, dim, failure, fields, group, result, resultItem, text } from '../result.js';
import { formatRelative, plural } from './shared.js';

const SUBCOMMANDS = ['status', 'add', 'remove', 'include', 'refresh', 'reindex', 'failures', 'excluded', 'retry'];

function statusReport(context) {
  const status = context.indexing.status(context.projectId);
  const blocks = [
    fields([
      ['Indexed directories', String(status.workspace.directories)],
      ['Files', status.project.files.toLocaleString('en-US')],
      ['Dependencies', status.project.dependencies.toLocaleString('en-US')],
      ['Last scan', formatRelative(status.project.lastScanAt)],
      ['Version', String(status.project.version)],
      ['Reader', status.freshness.stale ? 'older than this build' : 'current'],
    ]),
    blank(),
    {
      kind: 'table',
      columns: ['directory', 'files', 'state'],
      rows: status.directories.map((directory) => [
        directory.name,
        String(directory.files),
        directory.health,
      ]),
    },
  ];

  if (status.grantedDirectories.length > 1) {
    blocks.push(blank(), text('granted directories'));
    for (const directory of status.grantedDirectories) {
      blocks.push(group(directory.name, [{
        text: directory.rootPath,
        meta: `${plural(directory.files, 'file')}${directory.active ? ' · active' : ''}`,
        tone: directory.active ? 'normal' : 'dim',
      }]));
    }
  }
  if (status.failures.length) {
    blocks.push(blank(), text(`${plural(status.failures.length, 'file')} could not be indexed: \`index failures\` lists them`, 'warn'));
  }
  if (status.freshness.stale) {
    blocks.push(blank(), text('These sources were read by an older build. `index reindex` re-reads them.', 'warn'));
  }

  return result('index', {
    headline: status.project.name,
    subhead: status.project.rootPath,
    blocks,
    data: status,
  });
}

function failureReport(context) {
  const failures = context.indexing.failures(context.projectId, {
    includeResolved: context.command.flags.all === true,
  });
  if (!failures.length) {
    return result('index', {
      headline: 'No indexing failures',
      blocks: [dim('Every tracked file in this directory was read and indexed.')],
      data: { failures: [] },
    });
  }
  return result('index', {
    headline: plural(failures.length, 'failure'),
    blocks: failures.map((failureRow) => group(failureRow.path, [
      { text: failureRow.reason, tone: failureRow.resolvedAt ? 'dim' : 'warn' },
      failureRow.resolvedAt ? { text: 'resolved on a later scan', tone: 'dim' } : null,
    ].filter(Boolean))),
    results: failures.map((failureRow) => resultItem({
      title: failureRow.path,
      lines: [failureRow.reason, failureRow.retryable ? 'retryable' : 'not retryable'],
      badge: failureRow.resolvedAt ? 'resolved' : null,
      tone: failureRow.resolvedAt ? 'normal' : 'warn',
      ref: { kind: 'indexFailure', path: failureRow.path, retryable: failureRow.retryable },
      actions: failureRow.retryable ? [ACTION.retry] : [],
    })),
    actions: [ACTION.retry],
    hints: ['`index retry <path>` rescans one file.'],
    data: { failures },
  });
}

export function indexCommand(context, command) {
  const [subcommand = 'status', ...rest] = command.args;
  const target = rest.join(' ').trim();
  const contextWithCommand = { ...context, command };

  if (!SUBCOMMANDS.includes(subcommand)) {
    return failure('index', `index has no subcommand ${subcommand}.`, {
      hints: SUBCOMMANDS.map((name) => `index ${name}`),
    });
  }

  switch (subcommand) {
    case 'status': return statusReport(contextWithCommand);
    case 'failures': return failureReport(contextWithCommand);

    case 'excluded': {
      const exclusions = context.indexing.exclusions(context.projectId);
      if (!exclusions.length) {
        return result('index', {
          headline: 'Nothing excluded',
          blocks: [dim('Every directory under the project root is indexed.')],
          hints: ['`index remove <path>` excludes a directory from the index.'],
          data: { exclusions: [] },
        });
      }
      return result('index', {
        headline: plural(exclusions.length, 'excluded path'),
        blocks: exclusions.map((exclusion) => group(exclusion.pathPrefix, [
          { text: exclusion.reason ?? 'excluded by the user', tone: 'dim' },
        ])),
        hints: ['`index include <path>` puts one back.'],
        data: { exclusions },
      });
    }

    case 'add': {
      if (!target) return failure('index', 'index add needs a directory path.', { hints: ['index add ~/Documents/Finance'] });
      const added = context.indexing.add(target, context.actor, typeof command.flags.name === 'string' ? command.flags.name : null);
      return result('index', {
        headline: added.imported ? `Indexed ${added.project.name}` : `${added.project.name} was already indexed`,
        blocks: [fields([
          ['path', added.project.rootPath],
          ['version', String(added.project.currentVersion)],
        ])],
        hints: added.imported ? ['`index status` shows what it found.'] : [],
        data: added,
      });
    }

    case 'remove': {
      if (!target) return failure('index', 'index remove needs a path inside the project.', { hints: ['index remove ~/Documents/Archive'] });
      const excluded = context.indexing.exclude(context.projectId, target,
        typeof command.flags.reason === 'string' ? command.flags.reason : null);
      return result('index', {
        headline: `Excluded ${excluded.pathPrefix}`,
        blocks: [
          dim('Already-recorded versions are kept; the next scan will not read this path.'),
          blank(),
          text('`index refresh` applies it now.'),
        ],
        hints: ['`index include ' + excluded.pathPrefix + '` reverses this.'],
        data: excluded,
      });
    }

    case 'include': {
      if (!target) return failure('index', 'index include needs an excluded path.');
      const included = context.indexing.include(context.projectId, target);
      return result('index', {
        headline: `${included.pathPrefix} will be indexed again`,
        blocks: [text('`index refresh` applies it now.')],
        data: included,
      });
    }

    case 'refresh': {
      // `index refresh Finance` narrows the report, but a scan is always whole:
      // a partial scan cannot tell a deletion from a path it did not visit.
      const capture = context.indexing.refresh(context.projectId, context.actor);
      const status = context.indexing.status(context.projectId);
      const scoped = target
        ? status.directories.filter((directory) => directory.name.toLowerCase().startsWith(target.toLowerCase()))
        : status.directories;
      return result('index', {
        headline: capture.changed
          ? `Version ${capture.snapshot.version} recorded`
          : 'No changes since the last scan',
        subhead: capture.changed ? capture.event?.title ?? null : null,
        blocks: [
          fields([
            ['files', String(status.project.files)],
            ['dependencies', String(status.project.dependencies)],
            ['scanned', formatRelative(status.project.lastScanAt)],
          ]),
          ...(target ? [blank(), {
            kind: 'table',
            columns: ['directory', 'files', 'state'],
            rows: scoped.map((directory) => [directory.name, String(directory.files), directory.health]),
          }] : []),
        ],
        hints: target && !scoped.length ? [`No indexed directory starts with ${target}.`] : [],
        data: { capture, status },
      });
    }

    case 'reindex': {
      // Whole-project, like a scan: the reader that produced a version is
      // recorded against that version, so half of one cannot be re-read.
      // `index reindex Finance` only narrows what the report shows.
      const reindexed = context.indexing.reindex(context.projectId, context.actor, {
        reason: typeof command.flags.reason === 'string' ? command.flags.reason : null,
      });
      const status = context.indexing.status(context.projectId);
      const scoped = target
        ? status.directories.filter((directory) => directory.name.toLowerCase().startsWith(target.toLowerCase()))
        : status.directories;
      const review = reindexed.dependenciesNeedingReview;
      return result('index', {
        headline: reindexed.changed
          ? `Version ${reindexed.snapshot.version} recorded from a new reading`
          : 'The current reader reads these files exactly as recorded',
        subhead: reindexed.changed ? reindexed.event?.title ?? null : null,
        blocks: [
          fields([
            ['sources before', String(reindexed.objects.before)],
            ['sources now', String(reindexed.objects.after)],
            ['files', String(status.project.files)],
          ]),
          blank(),
          dim(reindexed.changed
            ? 'The files did not change. Earlier versions keep what the reader produced then, so existing links and shares still resolve.'
            : 'Nothing was recorded, because nothing about the reading changed.'),
          ...(review ? [blank(), text(`${plural(review, 'claim')} need review: \`stale\` lists them.`, 'warn')] : []),
          ...(target ? [blank(), {
            kind: 'table',
            columns: ['directory', 'files', 'state'],
            rows: scoped.map((directory) => [directory.name, String(directory.files), directory.health]),
          }] : []),
        ],
        hints: target && !scoped.length ? [`No indexed directory starts with ${target}.`] : [],
        data: { reindexed, status },
      });
    }

    case 'retry': {
      if (!target) return failure('index', 'index retry needs the path of a recorded failure.');
      const retried = context.indexing.retry(context.projectId, target, context.actor);
      return result('index', {
        headline: retried.resolved ? `${target} indexed` : `${target} still cannot be read`,
        blocks: [dim(retried.capture.changed
          ? `Version ${retried.capture.snapshot.version} recorded.`
          : 'The rescan found no other changes.')],
        data: retried,
      });
    }

    default: return failure('index', `index ${subcommand} is not implemented.`);
  }
}
