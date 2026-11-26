// Third-party apps connected to Lasso. Each connection mirrors its items
// into a folder Lasso manages (mail, events and pages as Markdown, files from
// a drive as the files they are), and that folder is indexed as a
// project: suggestions, sources, history and the on/off switch all work as
// they do for a work directory, while the menu lists it with the apps.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { runSliced } from '../history/work.js';
import { PROVIDERS, RENDER_VERSION, normalizeSettings, provider } from './providers.js';
import { writeItems } from './mirror.js';
import { folderDriveMethods, readsInPlace } from './folder-drive.js';
import { fetchGoogleDrive } from './google-drive.js';
import { OAUTH_APPS, SIGN_IN_TIMEOUT_MS, authorizationUrl, exchangeCode, idTokenClaims, pkcePair,
  redirectUri, refreshTokens, scopesFor } from './oauth.js';
import { fetchOneDrive } from './onedrive.js';
import { dropboxAccount, fetchDropbox } from './dropbox.js';
import { feedUrl, fetchFeed, fetchGoogleCalendar, fetchNotion, fetchOutlook, nativeEvents, notionAccount,
  outlookAccount } from './fetchers.js';

const systemActor = { id: 'system:connections', displayName: 'Lasso', actorType: 'SYSTEM' };
// Connected apps are read again this often while they are switched on.
export const SYNC_INTERVAL_MS = 30 * 60_000;
const SCHEDULE_CHECK_MS = 60_000;
// After a failure, wait this long before trying again on schedule.
const RETRY_AFTER_ERROR_MS = 10 * 60_000;

const now = () => new Date().toISOString();

/** Writes a file only this user can read, replacing the old one in one step. */
function writePrivate(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/**
 * Tokens, secrets and private calendar addresses, outside the history
 * database so they are never copied into snapshots, shares or backups of it.
 */
class CredentialStore {
  constructor(file) {
    this.file = file;
    this.cache = null;
  }

  read() {
    if (this.cache) return this.cache;
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.cache = {}; }
    this.cache.connections ??= {};
    this.cache.apps ??= {};
    return this.cache;
  }

  save() { writePrivate(this.file, `${JSON.stringify(this.read(), null, 2)}\n`); }

  get(id) { return this.read().connections[id] ?? null; }
  set(id, value) { this.read().connections[id] = value; this.save(); }
  delete(id) { delete this.read().connections[id]; this.save(); }
  app(id) { return this.read().apps[id] ?? null; }
  setApp(id, value) { this.read().apps[id] = value; this.save(); }
}

export class ConnectionService {
  constructor({ db, timeline, dependencies, workspace, config, fetchImpl = (...args) => fetch(...args) }) {
    this.db = db;
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.workspace = workspace;
    this.config = config;
    this.fetch = fetchImpl;
    this.root = path.join(config.dataDir, 'connected-apps');
    this.credentials = new CredentialStore(path.join(config.dataDir, 'connection-credentials.json'));
    // Sign-ins waiting for the browser to come back, by OAuth state.
    this.signIns = new Map();
    // One sync at a time per connection; asking again while one runs joins it.
    this.syncing = new Map();
    // How far a running sync has got reading the app, before indexing starts.
    this.progress = new Map();
    // Access being refreshed, by connection, so one refresh serves every request waiting on it.
    this.refreshing = new Map();
    this.closed = false;
    this.timer = null;
    workspace.connections = this;
  }

  start() {
    if (this.timer || !this.config.syncConnections) return;
    this.timer = setInterval(() => this.syncDue(), SCHEDULE_CHECK_MS);
    this.timer.unref?.();
    // Bring connections up to date shortly after Lasso starts.
    setTimeout(() => this.syncDue(), 5_000).unref?.();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- Records ----------

  row(id) {
    const row = this.db.prepare('SELECT * FROM app_connections WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'That connection was not found.');
    return row;
  }

  rows() { return this.db.prepare('SELECT * FROM app_connections ORDER BY created_at, id').all(); }

  update(id, fields) {
    const entries = Object.entries({ ...fields, updated_at: now() });
    this.db.prepare(`UPDATE app_connections SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), id);
  }

  folderFor(id) { return path.join(this.root, id); }

  /** A connection's settings, with anything unknown dropped. */
  settingsOf(row) { return normalizeSettings(row.provider, JSON.parse(row.settings_json || '{}')); }

  /** Whether a project's folder is one of the connections' mirrors, or a drive connected in place. */
  ownsRoot(rootPath) {
    if (typeof rootPath !== 'string') return false;
    if (this.inPlaceRoots().includes(rootPath)) return true;
    const root = this.realRoot ??= (() => { try { return fs.realpathSync(this.root); } catch { return null; } })();
    return [this.root, root].some((base) => base && rootPath.startsWith(`${base}${path.sep}`));
  }

  /** The name a connection shows, in the menu and as its project's name. */
  title(row) {
    const entry = provider(row.provider);
    const settings = JSON.parse(row.settings_json || '{}');
    const name = settings.label || entry?.name || row.provider;
    return row.account && row.account !== name ? `${name} · ${row.account}` : name;
  }

  /**
   * Connections as the menu and the Connect window show them. `projects` are
   * the workspace's entries for the connections' folders, with their
   * switch, availability and indexing progress.
   */
  describe(projects = []) {
    const byId = new Map(projects.map((project) => [project.id, project]));
    const byRoot = new Map(projects.map((project) => [path.basename(project.rootPath), project]));
    const byPath = new Map(projects.map((project) => [project.rootPath, project]));
    return this.rows().map((row) => {
      const entry = provider(row.provider);
      const inPlace = readsInPlace(entry);
      // A folder still being read for the first time is known by its name, the
      // connection's id, or for a drive read in place by its path.
      const project = byId.get(row.project_id) ?? (inPlace ? byPath.get(this.rootOf(row)) : byRoot.get(row.id)) ?? null;
      const fetching = this.progress.get(row.id);
      const settings = JSON.parse(row.settings_json || '{}');
      return {
        id: row.id, provider: row.provider, providerName: entry?.name ?? row.provider, symbol: entry?.symbol ?? 'app',
        // A cloud drive is listed as a cloud connector, with its logo; others as apps.
        kind: entry?.cloud ? 'cloud' : 'app',
        // Written by an older Lasso: the Mac app reads Calendar again for it.
        outdated: this.outdated(row),
        name: this.title(row), account: row.account, settings,
        status: row.status, error: row.last_error, lastSyncedAt: row.last_synced_at,
        // A drive read in place has as many items as its folder has files.
        itemCount: inPlace ? project?.fileCount ?? 0 : row.item_count,
        // Files its cloud drive keeps online alone, which Lasso has not read.
        ...(project?.onlyInCloud ? { onlyInCloud: project.onlyInCloud } : {}),
        projectId: project?.id ?? row.project_id ?? null,
        // A connection waiting for its first sign-in has nothing to switch yet.
        active: project ? Boolean(project.active) : row.status !== 'error',
        available: project ? project.available !== false : true,
        indexing: project?.indexing ?? (fetching ? { kind: 'adding', phase: 'fetching', percent: fetching.percent } : null),
        issue: row.status === 'error' && row.last_error
          ? { kind: 'CONNECTION', message: row.last_error, fix: { label: 'Sync Now' } } : project?.issue ?? null,
      };
    });
  }

  /**
   * Where each mirrored item opens in its app, by the file's path on this
   * Mac: a Google Doc in Docs, a Dropbox file on dropbox.com. The Mac app
   * opens these instead of the copy here, whose edits would not reach the app.
   */
  webLinks() {
    const links = {};
    for (const row of this.rows()) {
      let folder;
      try { folder = fs.realpathSync(this.folderFor(row.id)); } catch { continue; }
      const files = JSON.parse(row.sync_state_json || '{}').files ?? {};
      for (const known of Object.values(files)) {
        if (/^https:\/\//i.test(known.link ?? '')) links[path.join(folder, known.path)] = known.link;
      }
    }
    return links;
  }

  /** Whether the connection's files were written in an earlier format. */
  outdated(row) {
    if (!row.last_synced_at) return false;
    return (JSON.parse(row.sync_state_json || '{}').format ?? 1) !== RENDER_VERSION;
  }

  // ---------- Catalog ----------

  appConfig(appId) {
    const stored = this.credentials.app(appId) ?? {};
    const configured = this.config.connectorApps?.[appId] ?? {};
    return { clientId: stored.clientId || configured.clientId || null,
      clientSecret: stored.clientSecret || configured.clientSecret || null,
      builtIn: Boolean(configured.clientId) && !stored.clientId };
  }

  catalog({ native = false } = {}) {
    return Object.values(PROVIDERS).map((entry) => {
      const app = entry.oauthApp ? OAUTH_APPS[entry.oauthApp] : null;
      const config = app ? this.appConfig(app.id) : null;
      return {
        ...entry,
        // Calendar on this Mac is read by the Mac app, not the server; iCloud
        // Drive is there only on a Mac that has it switched on.
        available: (entry.auth !== 'native' || native) && this.runsHere(entry)
          && (!readsInPlace(entry) || Boolean(this.folderRoot(entry))),
        signIn: app ? {
          app: app.id, appName: app.name, configured: this.signInReady(app),
          builtIn: config.builtIn, needsSecret: app.needsSecret, setup: app.setup,
          redirectUri: app.registeredRedirect,
        } : null,
      };
    });
  }

  /** Saves the app registration a provider's sign-in uses, entered in the Connect window. */
  configureApp(appId, { clientId, clientSecret } = {}) {
    const app = OAUTH_APPS[appId];
    if (!app) throw new HttpError(404, 'That sign-in provider is not known.');
    const id = String(clientId ?? '').trim();
    if (!/^[A-Za-z0-9._-]{8,200}$/.test(id)) throw new HttpError(400, `Enter the client ID of your ${app.name} app registration.`);
    const secret = String(clientSecret ?? '').trim();
    if (app.needsSecret && !secret) throw new HttpError(400, `Enter the client secret of your ${app.name} OAuth client.`);
    this.credentials.setApp(appId, { clientId: id, ...(secret ? { clientSecret: secret } : {}) });
    return this.catalog();
  }

  // ---------- Connecting ----------

  async create(input = {}) {
    const entry = provider(input.provider);
    if (!entry) throw new HttpError(400, 'Choose an app to connect.');
    if (readsInPlace(entry)) return this.connectInPlace(entry, input);
    const settings = normalizeSettings(entry.id, input.settings);
    const id = crypto.randomUUID();
    const insert = (status, account) => {
      const time = now();
      this.db.prepare(`INSERT INTO app_connections(id, provider, account, settings_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, entry.id, account, JSON.stringify(settings), status, time, time);
    };
    if (entry.auth === 'oauth') {
      const app = OAUTH_APPS[entry.oauthApp];
      const config = this.appConfig(app.id);
      if (!config.clientId || (app.needsSecret && !config.clientSecret)) {
        throw new HttpError(409, `Lasso needs your ${app.name} app registration before you can sign in.`);
      }
      insert('connecting', null);
      return { connection: this.connection(id), authorizeUrl: this.beginSignIn(id, entry) };
    }
    if (entry.auth === 'token') {
      const token = String(input.token ?? '').trim();
      if (token.length < 20) throw new HttpError(400, 'Paste the integration’s secret. It starts with ntn_ or secret_.');
      const account = await notionAccount({ token, fetchImpl: this.fetch });
      insert('syncing', account);
      this.credentials.set(id, { token });
    } else if (entry.auth === 'url') {
      const url = feedUrl(input.url);
      // Reading it once proves it is a calendar before anything is saved.
      const feed = await fetchFeed({ url, settings, fetchImpl: this.fetch });
      const host = new URL(url).hostname.replace(/^www\./, '');
      if (!settings.label && feed.name) settings.label = feed.name.slice(0, 80);
      insert('syncing', host);
      this.update(id, { settings_json: JSON.stringify(settings) });
      this.credentials.set(id, { url });
    } else {
      insert('syncing', typeof input.account === 'string' && input.account.trim() ? input.account.trim().slice(0, 120) : 'This Mac');
    }
    if (entry.auth !== 'native') this.sync(id).catch(() => {});
    return { connection: this.connection(id) };
  }

  /** The browser address that signs a connection in, again if the first was closed. */
  beginSignIn(id, entry) {
    const app = OAUTH_APPS[entry.oauthApp];
    const config = this.appConfig(app.id);
    for (const [state, pending] of this.signIns) {
      if (pending.connectionId === id || Date.now() - pending.createdAt > SIGN_IN_TIMEOUT_MS) this.signIns.delete(state);
    }
    const state = crypto.randomBytes(24).toString('hex');
    const { verifier, challenge } = pkcePair();
    const redirect = redirectUri(app, this.config.port);
    this.signIns.set(state, { connectionId: id, app: app.id, verifier, redirect, createdAt: Date.now() });
    // A sign-in asks only for what its provider reads: Drive's sign-in never reaches Calendar.
    return authorizationUrl(app, { clientId: config.clientId, redirect, state, challenge,
      scopes: scopesFor(app, entry, this.settingsOf(this.row(id))) });
  }

  reauthorize(id) {
    const row = this.row(id);
    const entry = provider(row.provider);
    if (entry?.auth !== 'oauth') throw new HttpError(409, 'This connection does not sign in.');
    return { connection: this.connection(id), authorizeUrl: this.beginSignIn(id, entry) };
  }

  /** Finishes a sign-in the provider redirected back to this computer. */
  async completeSignIn(query) {
    const pending = this.signIns.get(String(query.state ?? ''));
    if (!pending || Date.now() - pending.createdAt > SIGN_IN_TIMEOUT_MS) {
      throw new HttpError(400, 'This sign-in has expired. Start it again from Lasso’s Connect window.');
    }
    this.signIns.delete(String(query.state));
    const app = OAUTH_APPS[pending.app];
    const row = this.row(pending.connectionId);
    if (query.error) {
      if (row.status === 'connecting') this.update(row.id, { status: 'error', last_error: `${app.name} sign-in was cancelled.` });
      throw new HttpError(400, query.error_description ? String(query.error_description) : `${app.name} sign-in was cancelled.`);
    }
    const config = this.appConfig(app.id);
    const tokens = await exchangeCode(app, { ...config, code: String(query.code ?? ''), verifier: pending.verifier,
      redirect: pending.redirect, scopes: scopesFor(app, provider(row.provider), this.settingsOf(row)) }, this.fetch);
    const account = await this.accountName(app, tokens);
    this.credentials.set(row.id, { ...tokens });
    this.update(row.id, { account, status: 'syncing', last_error: null });
    this.sync(row.id).catch(() => {});
    return this.connection(row.id);
  }

  /** Who signed in, as the menu names the connection. */
  async accountName(app, tokens) {
    const context = { token: tokens.accessToken, fetchImpl: this.fetch };
    switch (app.id) {
      case 'microsoft': return outlookAccount(context);
      case 'dropbox': return dropboxAccount(context);
      default: return idTokenClaims(tokens.idToken).email ?? app.name;
    }
  }

  connection(id) {
    const row = this.row(id);
    const projects = this.workspace.state({ pending: true }).connections ?? [];
    return projects.find((entry) => entry.id === row.id) ?? this.describe().find((entry) => entry.id === id);
  }

  // ---------- Reading items ----------

  async accessToken(row) {
    const entry = provider(row.provider);
    const stored = this.credentials.get(row.id);
    if (!stored) {
      const error = new HttpError(401, `Lasso is not signed in to ${entry.name}. Connect it again.`);
      error.reauthorize = true;
      throw error;
    }
    if (entry.auth !== 'oauth') return stored.token ?? null;
    if (stored.expiresAt - Date.now() > 60_000) return stored.accessToken;
    if (!stored.refreshToken) {
      const error = new HttpError(401, `${entry.name} sign-in has expired. Connect it again.`);
      error.reauthorize = true;
      throw error;
    }
    // A refresh token may work only once, so two asking at once share one refresh.
    const running = this.refreshing.get(row.id);
    if (running) return running;
    const app = OAUTH_APPS[entry.oauthApp];
    const task = refreshTokens(app, { ...this.appConfig(app.id), refreshToken: stored.refreshToken,
      scopes: scopesFor(app, entry, this.settingsOf(row)) }, this.fetch).then((tokens) => {
      this.credentials.set(row.id, { ...stored, ...tokens });
      return tokens.accessToken;
    }).finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, task);
    return task;
  }

  async read(row, state) {
    const settings = this.settingsOf(row);
    const context = { settings, fetchImpl: this.fetch };
    switch (row.provider) {
      case 'outlook': return fetchOutlook({ ...context, token: await this.accessToken(row) });
      case 'google-calendar': return fetchGoogleCalendar({ ...context, token: await this.accessToken(row) });
      // Pages written in an earlier format are read again in full.
      case 'notion': return fetchNotion({ ...context, token: await this.accessToken(row),
        previous: this.outdated(row) ? {} : state.files ?? {}, spacing: this.config.notionSpacingMs });
      // Downloads wait for the store, so each asks for the access then current.
      case 'google-drive': return fetchGoogleDrive({ ...context, accessToken: () => this.accessToken(row),
        previous: state.files ?? {} });
      case 'onedrive': return fetchOneDrive({ ...context, accessToken: () => this.accessToken(row), previous: state.files ?? {} });
      case 'dropbox': return fetchDropbox({ ...context, accessToken: () => this.accessToken(row), previous: state.files ?? {} });
      case 'ics': return fetchFeed({ ...context, url: this.credentials.get(row.id)?.url });
      default: throw new HttpError(409, 'The Mac app brings this calendar up to date.');
    }
  }

  /** Reads the app again and brings its folder up to date. */
  sync(id) {
    const running = this.syncing.get(id);
    if (running) return running;
    const task = this.runSync(id).finally(() => {
      if (this.syncing.get(id) === task) this.syncing.delete(id);
      this.progress.delete(id);
    });
    this.syncing.set(id, task);
    return task;
  }

  async runSync(id) {
    let row = this.row(id);
    if (provider(row.provider)?.auth === 'native') throw new HttpError(409, 'The Mac app brings this calendar up to date.');
    if (readsInPlace(provider(row.provider))) return this.syncInPlace(id);
    if (row.status === 'connecting') throw new HttpError(409, 'Finish signing in first.');
    this.update(id, { status: 'syncing' });
    this.progress.set(id, { percent: 5 });
    try {
      const state = JSON.parse(row.sync_state_json || '{}');
      const { items, partial = false } = await this.read(row, state);
      if (this.closed) return this.connection(id);
      row = this.row(id);
      this.progress.set(id, { percent: 25 });
      await this.store(row, items, state, { partial });
      return this.connection(id);
    } catch (error) {
      if (this.closed) throw error;
      try {
        this.update(id, { status: 'error', last_error: error.message, last_synced_at: now() });
      } catch { /* disconnected meanwhile */ }
      throw error;
    }
  }

  /** Items the Mac app read from the Calendar app, for a native connection. */
  async receive(id, events) {
    const row = this.row(id);
    if (provider(row.provider)?.auth !== 'native') throw new HttpError(409, 'Only the Mac app sends items for this connection.');
    const items = nativeEvents(events);
    const state = JSON.parse(row.sync_state_json || '{}');
    const running = this.syncing.get(id) ?? Promise.resolve();
    const task = running.catch(() => {}).then(() => this.store(this.row(id), items, state));
    this.syncing.set(id, task);
    try { return await task; }
    finally { if (this.syncing.get(id) === task) this.syncing.delete(id); }
  }

  /**
   * Writes items into the connection's folder, rewriting only files whose
   * content changed and removing files of items the app no longer has, then
   * indexes the folder, or lets its watcher pick the changes up.
   */
  async store(row, items, state, { partial = false } = {}) {
    const entry = provider(row.provider);
    const folder = this.folderFor(row.id);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Downloading a drive's files fills the bar from a quarter to most of the way.
    const onProgress = (share) => {
      if (this.progress.has(row.id)) this.progress.set(row.id, { percent: Math.round(25 + 60 * share) });
    };
    // A listing cut short keeps the files it did not reach rather than removing them.
    const { files, changed } = await writeItems({ folder, items, previous: state.files ?? {}, providerName: entry.name,
      onProgress, keepMissing: partial });
    // A folder with nothing in it yet still gets its project, so the switch shows.
    if (!items.length && !fs.readdirSync(folder).length) fs.writeFileSync(path.join(folder, 'README.md'),
      `# ${entry.name}\n\nLasso has not found any items to bring in yet.\n`);
    else if (items.length) fs.rmSync(path.join(folder, 'README.md'), { force: true });
    this.update(row.id, { sync_state_json: JSON.stringify({ files, format: RENDER_VERSION }), item_count: Object.keys(files).length });
    const projectId = await this.ensureProject(this.row(row.id));
    if (changed && projectId && this.workspace.isActive(projectId) && !this.timeline.watchers.has(projectId)) {
      // Without a watcher (as in tests), capture the change now.
      await this.workspace.enqueue(() => runSliced(this.timeline.captureSteps(projectId, systemActor, {
        source: 'WATCHER', prepare: (capture) => this.dependencies.ensureIndexSteps(projectId, capture.snapshot.id),
      })));
    }
    this.update(row.id, { status: 'ready', last_error: null, last_synced_at: now() });
    return this.connection(row.id);
  }

  /** Indexes the connection's folder as a project the first time, and names it. */
  async ensureProject(row) {
    const root = this.rootOf(row);
    if (!root) throw new HttpError(409, `${provider(row.provider)?.name ?? 'The folder'} is not on this computer.`);
    const folder = fs.realpathSync(root);
    const known = this.db.prepare('SELECT id, workspace_removed FROM projects WHERE id = ? OR root_path = ?')
      .get(row.project_id ?? '', folder);
    if (known && !known.workspace_removed) {
      if (row.project_id !== known.id) {
        // A folder the person had added themselves is only lent to the drive:
        // disconnecting gives it back as a work directory, history and all.
        const adopted = readsInPlace(provider(row.provider)) && !row.project_id;
        this.update(row.id, { project_id: known.id,
          ...(adopted ? { sync_state_json: JSON.stringify({ adopted: true }) } : {}) });
      }
      this.inPlaceCache = null;
      this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(this.title(row), known.id);
      return known.id;
    }
    await this.workspace.add([folder], systemActor);
    this.inPlaceCache = null;
    const project = this.db.prepare('SELECT id FROM projects WHERE root_path = ?').get(folder);
    if (!project) return null;
    this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(this.title(row), project.id);
    this.update(row.id, { project_id: project.id });
    return project.id;
  }

  /** Sign-ins abandoned in the browser, or lost when Lasso restarted, leave nothing behind. */
  pruneAbandoned() {
    for (const row of this.rows()) {
      if (row.status !== 'connecting' || row.project_id) continue;
      const waiting = [...this.signIns.values()].some((pending) => pending.connectionId === row.id
        && Date.now() - pending.createdAt <= SIGN_IN_TIMEOUT_MS);
      if (waiting) continue;
      this.credentials.delete(row.id);
      this.db.prepare('DELETE FROM app_connections WHERE id = ?').run(row.id);
    }
  }

  /** Brings every switched-on connection up to date that is due. */
  async syncDue() {
    if (this.closed) return;
    this.pruneAbandoned();
    for (const row of this.rows()) {
      if (this.closed) return;
      const entry = provider(row.provider);
      // Calendar is brought up to date by the Mac app, iCloud Drive by its folder's watcher.
      if (!entry || entry.auth === 'native' || readsInPlace(entry) || row.status === 'connecting' || this.syncing.has(row.id)) continue;
      if (row.project_id && !this.workspace.isActive(row.project_id)) continue;
      const last = Date.parse(row.last_synced_at ?? '') || 0;
      const wait = row.status === 'error' ? RETRY_AFTER_ERROR_MS : SYNC_INTERVAL_MS;
      if (Date.now() - last < wait && !this.outdated(row)) continue;
      try { await this.sync(row.id); }
      catch (error) { if (!this.closed) console.warn(`Syncing ${this.title(row)} failed:`, error.message); }
    }
  }

  // ---------- Switching and removing ----------

  async setActive(id, active) {
    if (typeof active !== 'boolean') throw new HttpError(400, 'A connection is switched on with true or off with false.');
    const row = this.row(id);
    if (!row.project_id) throw new HttpError(409, 'This connection has not finished its first sync yet.');
    await this.workspace.toggle(row.project_id, active, systemActor);
    // Switched back on after a while off, it reads the app again.
    const entry = provider(row.provider);
    if (active && entry?.auth !== 'native' && !readsInPlace(entry)
      && Date.now() - (Date.parse(row.last_synced_at ?? '') || 0) > SYNC_INTERVAL_MS) this.sync(id).catch(() => {});
    return this.connection(id);
  }

  /**
   * Stops syncing and forgets the connection: its sign-in, its folder, and
   * the history Lasso kept of its items. Nothing changes in the app itself.
   */
  async disconnect(id) {
    const row = this.row(id);
    for (const [state, pending] of this.signIns) if (pending.connectionId === id) this.signIns.delete(state);
    await this.syncing.get(id)?.catch(() => {});
    this.inPlaceCache = null;
    if (row.project_id && JSON.parse(row.sync_state_json || '{}').adopted) {
      // The folder goes back to the work directories under its own name.
      const project = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(row.project_id);
      if (project) this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(path.basename(project.root_path), row.project_id);
    } else if (row.project_id) {
      try { await this.workspace.remove(row.project_id); } catch { /* already gone */ }
      try { this.timeline.drives?.removeProjects([row.project_id]); }
      catch (error) {
        // Another folder's document still cites one of its items; that
        // history stays so the citation keeps resolving.
        if (error.status !== 409) throw error;
      }
    }
    this.credentials.delete(id);
    // A drive read in place keeps every file where it is; only a mirror is Lasso's to remove.
    if (!readsInPlace(provider(row.provider))) fs.rmSync(this.folderFor(id), { recursive: true, force: true });
    this.db.prepare('DELETE FROM app_connections WHERE id = ?').run(id);
    return this.workspace.state();
  }
}

Object.assign(ConnectionService.prototype, folderDriveMethods);
