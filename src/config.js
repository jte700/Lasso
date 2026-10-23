import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACTOR_TYPES = new Set([
  'HUMAN_SELF',
  'HUMAN_COLLABORATOR',
  'AI_AGENT',
  'SYSTEM',
]);

export const CHANGE_TYPES = new Set(['ADDED', 'DELETED', 'RENAMED', 'MOVED', 'MODIFIED']);

/**
 * App registrations that connected apps sign in with: from the environment,
 * or written into the app by a build that had them (desktop/build.sh).
 */
function connectorApps() {
  let built = {};
  try { built = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../connector-apps.json', import.meta.url)), 'utf8')); }
  catch { /* this build has none of its own */ }
  return {
    microsoft: { clientId: process.env.LASSO_MICROSOFT_CLIENT_ID || built.microsoft?.clientId || null },
    google: { clientId: process.env.LASSO_GOOGLE_CLIENT_ID || built.google?.clientId || null,
      clientSecret: process.env.LASSO_GOOGLE_CLIENT_SECRET || built.google?.clientSecret || null },
  };
}

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
    // Saves that keep arriving cannot postpone a capture longer than this.
    watchMaxWaitMs: Number(overrides.watchMaxWaitMs ?? process.env.LASSO_WATCH_MAX_WAIT_MS ?? 15000),
    watchProjects: overrides.watchProjects ?? true,
    driveToken: overrides.driveToken ?? process.env.LASSO_DRIVE_TOKEN ?? null,
    publicDir: overrides.publicDir ?? fileURLToPath(new URL('../public', import.meta.url)),
    // Connected apps are read again on a schedule; tests sync by hand.
    syncConnections: overrides.syncConnections ?? true,
    // Without a registration of Lasso's own, one is entered in the Connect window.
    connectorApps: overrides.connectorApps ?? connectorApps(),
    // Pause between Notion requests, within its rate limit.
    notionSpacingMs: overrides.notionSpacingMs ?? 340,
  };
}
