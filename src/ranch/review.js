// The Ranch's Needs Review list: sources with a potential problem, each with
// what happened in plain words. Lasso never fixes these on its own; the list
// says where to look.

const LINK_PROBLEMS = {
  STALE: { kind: 'changed', title: 'Linked value changed' },
  BROKEN: { kind: 'missing', title: 'Linked source can’t be found' },
  NEEDS_REVIEW: { kind: 'unverified', title: 'Link can’t be verified' },
};

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Links whose source changed, moved or no longer resolves, one item per source.
 * @param {{ projectId: string, documentPath: string, status: string,
 *   source: { projectId: string, path: string } }[]} dependencies
 * @param {(directoryId: string, filePath: string) => string | null} fileIdAt
 */
export function linkReviewItems(dependencies, fileIdAt) {
  const grouped = new Map();
  for (const dependency of dependencies) {
    const problem = LINK_PROBLEMS[dependency.status];
    if (!problem) continue;
    const directoryId = dependency.source.projectId ?? dependency.projectId;
    const key = `${problem.kind}\u0000${directoryId}\u0000${dependency.source.path}`;
    const item = grouped.get(key) ?? { id: `link:${key}`, kind: problem.kind, title: problem.title,
      directoryId, path: dependency.source.path, fileId: fileIdAt(directoryId, dependency.source.path), documents: [] };
    grouped.set(key, { ...item, documents: [...new Set([...item.documents, dependency.documentPath])] });
  }
  return [...grouped.values()].map((item) => ({
    ...item,
    detail: item.kind === 'changed'
      ? `Changed since it was linked in ${plural(item.documents.length, 'document')}. The documents still show the earlier value.`
      : item.kind === 'unverified'
        ? `Lasso can’t confirm the linked text in ${plural(item.documents.length, 'document')} still matches it.`
        : `${plural(item.documents.length, 'document')} link to it, but it is no longer where it was.`,
  }));
}

/** Files Lasso could only partly read: damaged, protected or too large to index whole. */
export function readingReviewItems(directoryId, failures, fileIdAt) {
  return failures.filter((failure) => failure.code !== 'UNSUPPORTED_FORMAT').map((failure) => ({
    id: `reading:${directoryId}:${failure.path}`, kind: 'unreadable', title: 'Couldn’t be fully read',
    directoryId, path: failure.path, fileId: fileIdAt(directoryId, failure.path), documents: [],
    detail: failure.reason || 'Lasso could read only part of this file.',
  }));
}

/** A folder that is missing, withheld by macOS, or could not be started. */
export function directoryReviewItems(directories) {
  return directories.filter((directory) => directory.issue).map((directory) => ({
    id: `directory:${directory.id}`, kind: 'directory', title: 'Directory needs attention',
    directoryId: directory.id, path: null, fileId: null, documents: [], detail: directory.issue,
  }));
}

/** Active links whose source has changed since: recipients still see the old version. */
export function shareReviewItems(shares) {
  return shares.filter((share) => share.drifted).map((share) => ({
    id: `share:${share.id}`, kind: 'drifted', title: 'Changed since you shared it',
    directoryId: share.directoryId, path: share.path, fileId: share.fileId, documents: [],
    detail: 'The share link still shows the version you shared. Share it again to send the current one.',
  }));
}
