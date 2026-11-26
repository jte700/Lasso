// Cloud drives as the menu offers them, and iCloud Drive, the one whose files
// are already on this Mac. Apple has no web API for iCloud Drive, but on a
// Mac it is a folder; that folder is indexed in place, as a work directory
// is, while its connection lists it with the cloud drives, by its logo.
// Nothing is copied, and disconnecting leaves every file where it is.
// These methods are installed on ConnectionService (service.js).
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError } from '../history/errors.js';
import { OAUTH_APPS } from './oauth.js';
import { PROVIDERS, normalizeSettings, provider } from './providers.js';

const now = () => new Date().toISOString();
// How long the folders connected in place are remembered between asks.
const IN_PLACE_CACHE_MS = 2_000;

/** Whether a provider's items are read in place rather than fetched into a mirror. */
export const readsInPlace = (entry) => entry?.auth === 'folder';

export const folderDriveMethods = {
  /** Whether a provider runs here: iCloud Drive only on a Mac. */
  runsHere(entry) {
    return !entry.platform || entry.platform === this.config.platform;
  },

  /** Whether a sign-in through the provider's app registration can start now. */
  signInReady(app) {
    const config = this.appConfig(app.id);
    return Boolean(config.clientId && (!app.needsSecret || config.clientSecret));
  },

  /** The real path of a folder drive's folder, or null when it is not on this computer. */
  folderRoot(entry) {
    if (!readsInPlace(entry)) return null;
    try {
      const root = fs.realpathSync(this.config.icloudDrivePath);
      return fs.statSync(root).isDirectory() ? root : null;
    } catch { return null; }
  },

  /** The folder an in-place connection indexes, by its row. */
  rootOf(row) {
    const entry = provider(row.provider);
    return readsInPlace(entry) ? this.folderRoot(entry) : this.folderFor(row.id);
  },

  /**
   * The folders connected in place, so the workspace lists them with the
   * cloud drives. The workspace asks once per folder each time its state is
   * read, so the answer is kept briefly, and dropped when a connection changes.
   */
  inPlaceRoots() {
    const cached = this.inPlaceCache;
    if (cached && Date.now() - cached.at < IN_PLACE_CACHE_MS) return cached.roots;
    const roots = this.rows().filter((row) => readsInPlace(provider(row.provider)))
      .map((row) => this.rootOf(row)).filter(Boolean);
    this.inPlaceCache = { at: Date.now(), roots };
    return roots;
  },

  /**
   * Every cloud drive that runs here, for the menu's Cloud Drives section:
   * whether one is connected yet, whether it can be (iCloud Drive needs its
   * folder), and how it signs in: "browser" straight away, "setup" once its
   * app registration is entered, or "none".
   */
  cloudOffers() {
    const connected = new Set(this.rows().map((row) => row.provider));
    return Object.values(PROVIDERS).filter((entry) => entry.cloud && this.runsHere(entry)).map((entry) => {
      const app = entry.oauthApp ? OAUTH_APPS[entry.oauthApp] : null;
      return {
        provider: entry.id, name: entry.name, symbol: entry.symbol, connected: connected.has(entry.id),
        available: readsInPlace(entry) ? Boolean(this.folderRoot(entry)) : true,
        signIn: app ? (this.signInReady(app) ? 'browser' : 'setup') : 'none',
      };
    });
  },

  /** Connects a folder drive in one step; its folder is indexed in the background. */
  connectInPlace(entry, input = {}) {
    if (!this.runsHere(entry)) throw new HttpError(409, `${entry.name} is only on a Mac.`);
    if (!this.folderRoot(entry)) {
      throw new HttpError(409, `${entry.name} is not on this Mac. Turn it on in System Settings, under your Apple Account, then iCloud.`);
    }
    if (this.rows().some((row) => row.provider === entry.id)) throw new HttpError(409, `${entry.name} is already connected.`);
    const id = crypto.randomUUID();
    const time = now();
    this.db.prepare(`INSERT INTO app_connections(id, provider, account, settings_json, status, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'syncing', ?, ?)`).run(id, entry.id, JSON.stringify(normalizeSettings(entry.id, input.settings)), time, time);
    this.inPlaceCache = null;
    this.sync(id).catch(() => {});
    return { connection: this.connection(id) };
  },

  /**
   * Brings a folder drive's project into being, or back, and names it. Its
   * files are kept current by the folder's watcher, as any directory's are.
   */
  async syncInPlace(id) {
    this.update(id, { status: 'syncing' });
    try {
      const projectId = await this.ensureProject(this.row(id));
      if (!projectId) throw new HttpError(409, 'Lasso could not read the folder.');
      this.update(id, { status: 'ready', last_error: null, last_synced_at: now() });
    } catch (error) {
      if (this.closed) throw error;
      try { this.update(id, { status: 'error', last_error: error.message, last_synced_at: now() }); }
      catch { /* disconnected meanwhile */ }
      throw error;
    }
    return this.connection(id);
  },
};
