// Files a cloud drive keeps online alone, for folders and cloud drives read
// in place: how many there are, and downloading them when the person asks.
// Lasso never downloads one on its own (cloud-placeholders.js). These
// methods are installed on WorkspaceService (workspace.js).
import path from 'node:path';
import { HttpError } from './history/errors.js';

const systemActor = { id: 'system:workspace', displayName: 'Lasso', actorType: 'SYSTEM' };
// Downloads run this many at a time, so a large folder does not crowd the disk and network.
const DOWNLOADS_AT_ONCE = 2;

export const workspaceCloudMethods = {
  /** How many of a folder's files are only in the cloud, as its last read found them. */
  onlyInCloud(projectId) {
    return this.timeline.cloudOnly?.get(projectId)?.length ?? 0;
  },

  /** A folder's entry with its count of files only in the cloud, when it has any. */
  withCloudCount(directory) {
    const count = this.onlyInCloud(directory.id);
    return count ? { ...directory, onlyInCloud: count } : directory;
  },

  /**
   * Starts downloading a folder's files that are only in the cloud, then
   * reads them. `finished` settles once they are indexed.
   */
  startCloudDownload(projectId, actor = systemActor) {
    const project = this.projects().find((entry) => entry.id === projectId);
    if (!project) throw new HttpError(404, 'Work directory not found.');
    // Asked again while one runs, the request joins it.
    this.cloudDownloads ??= new Map();
    const running = this.cloudDownloads.get(projectId);
    if (running) return running;
    const paths = [...(this.timeline.cloudOnly?.get(projectId) ?? [])];
    if (!paths.length) return { requested: 0, finished: Promise.resolve({ downloaded: 0, failed: 0 }) };
    const finished = this.downloadAndRead(project, paths, actor)
      .finally(() => this.cloudDownloads.delete(projectId));
    const download = { requested: paths.length, finished };
    this.cloudDownloads.set(projectId, download);
    return download;
  },

  async downloadCloudFiles(projectId, actor = systemActor) {
    const { requested, finished } = this.startCloudDownload(projectId, actor);
    return { requested, ...(await finished) };
  },

  async downloadAndRead(project, paths, actor) {
    const progress = this.beginIndexing(project.id, { kind: 'updating' });
    const placeholders = this.timeline.placeholders;
    let next = 0, downloaded = 0, failed = 0;
    const worker = async () => {
      while (next < paths.length && !this.closed) {
        const relative = paths[next++];
        try {
          await placeholders.materialize(path.join(project.rootPath, ...relative.split('/')));
          downloaded += 1;
        } catch (error) {
          failed += 1;
          console.warn(`Could not download ${relative} from the cloud:`, error.message);
        }
        progress.report({ phase: 'listing', files: downloaded + failed });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, paths.length) }, worker));
      // Read the folder again: files now on this Mac are read, the rest kept as they were.
      await this.enqueue(() => this.runIndexing(this.timeline.captureSteps(project.id, actor, {
        source: 'OPEN_RECONCILE', prepare: (capture) => this.dependencies.ensureIndexSteps(project.id, capture.snapshot.id),
      }), progress));
      await this.enqueue(() => this.runIndexing(this.dependencies.ensureIndexSteps(project.id), progress));
    } finally {
      this.endIndexing(project.id, progress);
    }
    return { downloaded, failed };
  },
};
