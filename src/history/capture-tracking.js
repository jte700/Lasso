// What the timeline tells the blob store's cleanup (retention.js,
// blob-compaction.js) about its captures: which are reading right now, and
// what a capture that met released bytes must read again. Installed on
// TimelineService by service.js.

import { BlobStore } from './blob-store.js';
import { BlobReleasedError } from './errors.js';

/** The timeline's blob store, which says when bytes it lacks were released on purpose. */
export function openTimelineBlobs(db, config) {
  const releasedAt = db.prepare('SELECT released_at FROM released_blobs WHERE content_hash = ?');
  return new BlobStore(config.blobDir, {
    rawCacheDir: config.rawBlobCacheDir, releasedAt: (hash) => releasedAt.get(hash)?.released_at ?? null,
  });
}

export const captureTrackingMethods = {
  /**
   * The same as importProject, as steps (see history/work.js).
   * `options.projectId` names the new project in advance, so a folder still
   * being read can be listed under the id it will keep.
   */
  *importProjectSteps(rootPath, actorInput, options = {}) {
    return yield* this.counted(this.recordImportSteps(rootPath, actorInput, options));
  },

  /**
   * The same as capture, as steps. `options.prepare(result)`, a step
   * generator, runs after a new snapshot is recorded and before capture
   * listeners hear of it, so a sliced capture can index the snapshot before
   * anything asks it for objects.
   */
  *captureSteps(projectId, actorInput, options = {}) {
    try {
      return yield* this.counted(this.recordCaptureSteps(projectId, actorInput, options));
    } catch (error) {
      if (error instanceof BlobReleasedError) this.forgetScannedBytes(projectId, error.contentHash);
      throw error;
    }
  },

  /**
   * Runs capture or import steps, counted in activeCaptures until they finish
   * or stop. Their bytes are stored before they are recorded, so cleanup
   * waits while any runs.
   */
  *counted(steps) {
    this.activeCaptures += 1;
    try {
      return yield* steps;
    } finally {
      this.activeCaptures -= 1;
    }
  },

  /**
   * Drops the scanned files that read as `contentHash` from a folder's scan
   * cache. A capture that met those bytes released would otherwise be
   * followed by captures that reuse the cached hash without reading the file
   * again; with the entry gone, the next scan reads it and stores its bytes.
   * What a restart would trust for those files is dropped with it.
   */
  forgetScannedBytes(projectId, contentHash) {
    this.verifiedStats.forgetBytes(projectId, contentHash);
    const cache = this.scanCaches.get(projectId);
    if (!cache) return;
    for (const [relativePath, entry] of cache) {
      if (entry.file?.contentHash === contentHash) cache.delete(relativePath);
    }
  },
};
