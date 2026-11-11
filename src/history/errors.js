export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export class VersionConflictError extends HttpError {
  constructor(expectedSnapshotId, currentSnapshotId) {
    super(409, 'The project changed from the expected parent version.', {
      expectedSnapshotId,
      currentSnapshotId,
      resolution: 'Refresh the project and reapply the change against the current version.',
    });
    this.name = 'VersionConflictError';
  }
}

/**
 * A version's bytes were released on purpose to save room (see
 * history/retention.js). Its recorded values and events remain; only the
 * original file can no longer be read.
 */
export class BlobReleasedError extends HttpError {
  constructor(contentHash, releasedAt) {
    super(410, 'The original bytes of this version were not kept. Its recorded values are still available.',
      { contentHash, releasedAt });
    this.name = 'BlobReleasedError';
    this.code = 'BLOB_RELEASED';
    this.contentHash = contentHash;
    this.releasedAt = releasedAt;
  }

  /** What a preview says in place of the original: which bytes, when they went, and why there is no file. */
  describe() {
    return { contentHash: this.contentHash, releasedAt: this.releasedAt, message: this.message };
  }
}

/** Bytes the store should hold are not there, and were never released: damage. */
export class BlobMissingError extends Error {
  constructor(contentHash) {
    super(`The stored copy of ${contentHash} is missing.`);
    this.name = 'BlobMissingError';
    this.code = 'BLOB_MISSING';
    this.contentHash = contentHash;
  }
}
