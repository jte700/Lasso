import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECENT_TOUCH_WINDOW_MS } from './history/blob-store.js';

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

// A version keeps its bytes while it is among this many of its file's newest…
const DEFAULT_RETAINED_VERSIONS = 10;
// …or was the file's content within this many days. A count alone would keep
// only minutes of work in a folder whose every save is recorded.
const DEFAULT_RETAINED_DAYS = 30;
// Cleanup starts this long after the last capture, so it never competes with a burst of saves.
const DEFAULT_RETENTION_IDLE_MS = 60_000;
// Bytes stored, or found again by a capture, this recently are never
// released. Another Lasso sharing the data folder stores a file's bytes
// before it records them, and its captures cannot be seen from here.
const DEFAULT_RETENTION_GRACE_MS = 6 * 60 * 60 * 1000;

/** A whole number no smaller than `minimum`; anything else reads as the default. */
function wholeNumber(value, fallback, minimum) {
  const number = Number(value ?? fallback);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
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
    // Raw copies of compressed blobs, for readers that are handed a path.
    rawBlobCacheDir: overrides.rawBlobCacheDir ?? path.join(dataDir, 'derived', 'raw-blobs'),
    // Compressing (zstd) text versions that no folder holds any longer, in
    // idle batches. A file's current version always stays raw, where earlier
    // builds read it. On unless switched off (LASSO_BLOB_COMPRESSION=off);
    // `npm run blobs:decompress` turns compressed blobs back into raw ones.
    blobCompressionEnabled: overrides.blobCompressionEnabled ?? process.env.LASSO_BLOB_COMPRESSION !== 'off',
    // How long after the last capture compression waits before its first batch.
    blobCompressionIdleMs: wholeNumber(overrides.blobCompressionIdleMs, DEFAULT_RETENTION_IDLE_MS, 0),
    // Bytes stored or found again this recently are neither compressed nor released.
    blobTouchWindowMs: wholeNumber(overrides.blobTouchWindowMs, RECENT_TOUCH_WINDOW_MS, 0),
    // Releasing the bytes of old versions cannot be undone, so it stays off
    // unless switched on. With it off nothing is ever released.
    blobRetentionEnabled: overrides.blobRetentionEnabled ?? process.env.LASSO_BLOB_RETENTION === 'on',
    // With it on, a version keeps its bytes while it is among its file's
    // newest versions, or stopped being the file's content this recently.
    blobRetentionVersions: wholeNumber(overrides.blobRetentionVersions ?? process.env.LASSO_BLOB_RETENTION_VERSIONS,
      DEFAULT_RETAINED_VERSIONS, 1),
    blobRetentionDays: wholeNumber(overrides.blobRetentionDays ?? process.env.LASSO_BLOB_RETENTION_DAYS,
      DEFAULT_RETAINED_DAYS, 0),
    // How long after the last capture cleanup waits before its first batch.
    blobRetentionIdleMs: wholeNumber(overrides.blobRetentionIdleMs, DEFAULT_RETENTION_IDLE_MS, 0),
    blobRetentionGraceMs: wholeNumber(overrides.blobRetentionGraceMs, DEFAULT_RETENTION_GRACE_MS, 0),
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
