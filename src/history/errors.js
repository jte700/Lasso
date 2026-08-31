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
