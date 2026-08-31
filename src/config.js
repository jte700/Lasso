import path from 'node:path';

export const ACTOR_TYPES = new Set([
  'HUMAN_SELF',
  'HUMAN_COLLABORATOR',
  'AI_AGENT',
  'SYSTEM',
]);

export const CHANGE_TYPES = new Set(['ADDED', 'DELETED', 'RENAMED', 'MOVED', 'MODIFIED']);

export function createConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.COLAB_DRY_DATA_DIR ?? path.join(process.cwd(), '.colab-dry-data'),
  );

  return {
    dataDir,
    databasePath: overrides.databasePath ?? path.join(dataDir, 'timeline.sqlite'),
    blobDir: overrides.blobDir ?? path.join(dataDir, 'blobs'),
    port: Number(overrides.port ?? process.env.PORT ?? 4317),
    // Base of externally shared dependency links. Isolated here so the same
    // share records can later be served from a hosted origin.
    shareBaseUrl: overrides.shareBaseUrl ?? process.env.SHARE_BASE_URL ?? null,
    watchDebounceMs: Number(overrides.watchDebounceMs ?? process.env.COLAB_WATCH_DEBOUNCE_MS ?? 2500),
    watchProjects: overrides.watchProjects ?? true,
    publicDir: overrides.publicDir ?? path.resolve('public'),
  };
}
