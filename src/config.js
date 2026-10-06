import fs from 'node:fs';
import path from 'node:path';

export const ACTOR_TYPES = new Set([
  'HUMAN_SELF',
  'HUMAN_COLLABORATOR',
  'AI_AGENT',
  'SYSTEM',
]);

export const CHANGE_TYPES = new Set(['ADDED', 'DELETED', 'RENAMED', 'MOVED', 'MODIFIED']);

export function createConfig(overrides = {}) {
  const currentDataDir = path.join(process.cwd(), '.lasso-data');
  const previousDataDir = path.join(process.cwd(), '.colab-dry-data');
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.LASSO_DATA_DIR ?? process.env.COLAB_DRY_DATA_DIR
      ?? (fs.existsSync(currentDataDir) || !fs.existsSync(previousDataDir) ? currentDataDir : previousDataDir),
  );

  return {
    dataDir,
    databasePath: overrides.databasePath ?? path.join(dataDir, 'timeline.sqlite'),
    blobDir: overrides.blobDir ?? path.join(dataDir, 'blobs'),
    port: Number(overrides.port ?? process.env.PORT ?? 4317),
    // Base of externally shared dependency links. Isolated here so the same
    // share records can later be served from a hosted origin.
    shareBaseUrl: overrides.shareBaseUrl ?? process.env.SHARE_BASE_URL ?? null,
    watchDebounceMs: Number(overrides.watchDebounceMs ?? process.env.LASSO_WATCH_DEBOUNCE_MS
      ?? process.env.COLAB_WATCH_DEBOUNCE_MS ?? 2500),
    watchProjects: overrides.watchProjects ?? true,
    publicDir: overrides.publicDir ?? path.resolve('public'),
  };
}
