// The Ranch: Lasso's native library window. One read gives it every
// directory with its files, two weeks of changes, the share links you made and
// the ones you received, the sources that need review, and how files connect.
// It only reads; the one thing it records is that a file was looked at.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoundedCache } from '../cache.js';
import { HttpError } from '../history/errors.js';
import { isWholeFile } from '../dependencies/file-reference.js';
import { isCodeType } from '../history/file-types.js';
import { activityScore, addCounts, EMPTY_COUNTS, latestTime, normalizedActivity } from './activity.js';
import { recentHistory } from './history.js';
import { MAX_SCANNED_BYTES, SCANNED_TEXT_TYPES, sourceKind } from './kinds.js';
import { addNameEdges, edgeCollector, mentionTargets } from './network.js';
import { directoryReviewItems, linkReviewItems, readingReviewItems, shareReviewItems } from './review.js';
import { cellChanges, spreadsheetView } from './sheets.js';
import { passageChanges } from './passages.js';
import { fileNamesIn, shareLinksIn } from './text-links.js';

// How many of a file's versions the sheet view's version menu lists.
const MAX_FILE_VERSIONS = 20;

/** Files listed in one read. Past this the window says the list is partial. */
export const MAX_RANCH_SOURCES = 25_000;
/** Visits closer together than this count once, as recommendation usage does. */
export const VISIT_SESSION_MS = 30 * 60 * 1000;
// Share links expire and the history window moves, so a read is rebuilt at
// least this often even when nothing else changed.
const REFRESH_BUCKET_MS = 10 * 60 * 1000;
const MAX_OUTGOING_LINKS = 300;
const MAX_RECEIVED_LINKS = 300;

const iso = (milliseconds) => (Number.isFinite(milliseconds) && milliseconds > 0 ? new Date(milliseconds).toISOString() : null);

export class RanchService {
  constructor({ timeline, dependencies, terminal, workspace, objectShares = null, now = () => Date.now() }) {
    this.timeline = timeline;
    this.dependencies = dependencies;
    this.terminal = terminal;
    this.workspace = workspace;
    this.objectShares = objectShares;
    this.db = timeline.db;
    this.now = now;
    this.cache = null;
    // What a text file links to and names never changes for the same bytes.
    this.texts = new BoundedCache({ maxEntries: 50_000 });
    // Creation dates per directory version; reading them stats every file.
    this.births = new BoundedCache({ maxEntries: 64 });
    /**
     * How a directory's current copy of a worksheet shows `value` in the cell
     * `anchor` names ("18,400"), or null; one format per file, whichever
     * version a caption is about.
     */
    this.shownValue = (directoryId, filePath, anchor, value) => {
      const project = directoryId ? this.timeline.getProject(directoryId) : null;
      const file = project?.currentSnapshotId ? this.timeline.snapshotFile(project.currentSnapshotId, filePath) : null;
      return file ? this.dependencies.shownCellValue(file.path, file.contentHash, anchor, value) : null;
    };
    /** `values` ({ field: value }) as the worksheet shows them, keeping only those it shows otherwise. */
    this.shownValues = (directoryId, filePath, anchor, values) => Object.fromEntries(Object.entries(values)
      .map(([field, value]) => [field, this.shownValue(directoryId, filePath, anchor, value)]).filter(([, shown]) => shown));
  }

  overview() {
    return this.current().value;
  }

  /**
   * The overview with a tag that changes whenever it does, so the Mac app's
   * polls can be answered "not modified" without sending it again.
   */
  current() {
    const key = this.revisionKey();
    if (this.cache?.key !== key) {
      this.cache = { key, value: this.build(), tag: `"${crypto.createHash('sha256').update(key).digest('base64url').slice(0, 24)}"` };
    }
    return this.cache;
  }

  /** Changes whenever anything the overview shows could have changed. */
  revisionKey() {
    const signature = this.db.prepare(`SELECT
      (SELECT COUNT(*) || ':' || COALESCE(MAX(last_used_at_ms), 0) FROM recommendation_usage) AS usage,
      (SELECT COALESCE(SUM(visit_count), 0) || ':' || COALESCE(MAX(last_visited_at_ms), 0) FROM source_visits) AS visits,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(revoked_at), '') FROM object_share_grants) AS shares,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(revoked_at), '') FROM dependency_share_grants) AS dependency_shares,
      (SELECT COUNT(*) FROM claim_dependency_versions) AS links,
      (SELECT COUNT(*) || ':' || COALESCE(MAX(detected_at), '') FROM index_failures WHERE resolved_at IS NULL) AS failures
    `).get();
    return [this.workspace.revision(), ...Object.values(signature), Math.floor(this.now() / REFRESH_BUCKET_MS)].join('#');
  }

  build() {
    const now = this.now();
    const state = this.workspace.state();
    const directories = this.directoryRows(state);
    let budget = MAX_RANCH_SOURCES;
    const files = [];
    for (const directory of directories) {
      const listed = this.filesOf(directory, budget);
      files.push(...listed);
      budget -= listed.length;
    }
    const fileIds = new Set(files.map((file) => file.id));
    const byPath = new Map(files.map((file) => [`${file.directoryId}\u0000${file.path}`, file]));
    const fileIdAt = (directoryId, filePath) => byPath.get(`${directoryId}\u0000${filePath}`)?.id ?? null;

    const counts = new Map();
    const lastUsed = new Map();
    const count = (id, name, amount = 1) => {
      if (!id) return;
      counts.set(id, addCounts(counts.get(id) ?? EMPTY_COUNTS, { [name]: amount }));
    };
    const used = (id, time) => { if (id) lastUsed.set(id, latestTime(lastUsed.get(id), time)); };
    for (const row of this.usageRows()) {
      count(row.project_file_id, row.kind === 'accept' ? 'tabs' : 'opens', row.sessions);
      used(row.project_file_id, row.last_used);
    }
    for (const row of this.db.prepare('SELECT project_file_id, visit_count, last_visited_at_ms FROM source_visits').all()) {
      count(row.project_file_id, 'visits', row.visit_count);
      used(row.project_file_id, row.last_visited_at_ms);
    }

    const network = edgeCollector();
    const outgoing = this.outgoingLinks(directories, fileIdAt);
    // Every link counts toward how used a file is; only working ones mark it as shared now.
    const activeShares = new Map();
    for (const share of outgoing) {
      count(share.fileId, 'shares');
      used(share.fileId, share.createdAt);
      if (share.fileId && share.status === 'active') activeShares.set(share.fileId, (activeShares.get(share.fileId) ?? 0) + 1);
    }
    const dependencies = this.currentDependencies(directories);
    for (const dependency of dependencies) {
      const sourceId = fileIdAt(dependency.source.projectId ?? dependency.projectId, dependency.source.path);
      count(sourceId, 'references');
      network.add(fileIdAt(dependency.projectId, dependency.documentPath), sourceId, 'link');
    }
    for (const row of this.db.prepare(`SELECT DISTINCT project_file_id, document_project_file_id
      FROM recommendation_document_usage`).all()) {
      if (fileIds.has(row.project_file_id) && fileIds.has(row.document_project_file_id)) {
        network.add(row.project_file_id, row.document_project_file_id, 'used-in');
      }
    }
    const received = this.receivedLinks(files, network);
    addNameEdges(network, files);

    const scores = new Map(files.map((file) => [file.id, activityScore(counts.get(file.id))]));
    const activity = normalizedActivity(scores);
    const sources = files.map((file) => ({
      ...file,
      lastUsedAt: lastUsed.get(file.id) ?? null,
      counts: counts.get(file.id) ?? EMPTY_COUNTS,
      activeShares: activeShares.get(file.id) ?? 0,
      activity: activity.get(file.id) ?? 0,
    }));

    const directoryScores = new Map(directories.map((directory) => [directory.id, 0]));
    for (const file of sources) directoryScores.set(file.directoryId, directoryScores.get(file.directoryId) + scores.get(file.id));
    const directoryActivity = normalizedActivity(directoryScores);
    const byDirectory = new Map(directories.map((directory) => [directory.id, []]));
    for (const file of sources) byDirectory.get(file.directoryId).push(file);
    const summarized = directories.map((directory) => {
      const own = byDirectory.get(directory.id);
      return {
        ...directory,
        listedCount: own.length,
        lastEditedAt: latestTime(own.map((file) => file.modifiedAt)),
        lastUsedAt: latestTime(own.map((file) => file.lastUsedAt).filter(Boolean)),
        activity: directoryActivity.get(directory.id) ?? 0,
      };
    });

    const review = [
      ...directoryReviewItems(directories),
      ...linkReviewItems(dependencies, fileIdAt, this.shownValue),
      ...directories.filter((directory) => directory.active && directory.available)
        .flatMap((directory) => readingReviewItems(directory.id, this.terminal.indexing.failures(directory.id), fileIdAt)),
      ...shareReviewItems(outgoing),
    ];

    const history = recentHistory(this.db, directories.map((directory) => directory.id), now, { shown: this.shownValue });
    return {
      generatedAt: new Date(now).toISOString(),
      truncated: budget <= 0,
      directories: summarized,
      sources,
      history: history.entries.map((entry) => ({ ...entry, fileId: fileIds.has(entry.fileId) ? entry.fileId : null })),
      historyTruncated: history.truncated,
      links: { outgoing: outgoing.slice(0, MAX_OUTGOING_LINKS), received: received.slice(0, MAX_RECEIVED_LINKS) },
      review,
      network: { edges: network.edges() },
    };
  }

  /** Work directories, then connected apps, each with its current version. */
  directoryRows(state) {
    const projects = new Map(this.workspace.projects().map((project) => [project.id, project]));
    const added = new Map(this.db.prepare('SELECT id, created_at FROM projects').all().map((row) => [row.id, row.created_at]));
    const folders = state.directories.filter((directory) => !directory.pending && directory.currentSnapshotId)
      .map((directory) => ({
        id: directory.id, name: directory.name, rootPath: directory.rootPath, kind: 'folder', symbol: null,
        active: Boolean(directory.active), available: directory.available !== false,
        offline: directory.availability === 'offline', snapshotId: directory.currentSnapshotId,
        fileCount: directory.fileCount ?? 0, issue: directory.issue?.message ?? directory.error ?? null,
        createdAt: this.folderBirth(directory) ?? added.get(directory.id) ?? null, addedAt: added.get(directory.id) ?? null,
      }));
    const apps = (state.connections ?? []).filter((connection) => projects.get(connection.projectId)?.currentSnapshotId)
      .map((connection) => {
        const project = projects.get(connection.projectId);
        return {
          id: project.id, name: connection.name, rootPath: project.rootPath, kind: 'app', symbol: connection.symbol ?? null,
          active: Boolean(connection.active), available: connection.available !== false, offline: false,
          snapshotId: project.currentSnapshotId, fileCount: connection.itemCount ?? 0,
          issue: connection.issue?.message ?? null, createdAt: added.get(project.id) ?? null, addedAt: added.get(project.id) ?? null,
        };
      });
    return [...folders, ...apps];
  }

  folderBirth(directory) {
    if (!directory.available || directory.availability === 'offline') return null;
    try { return iso(fs.statSync(directory.rootPath).birthtimeMs); } catch { return null; }
  }

  filesOf(directory, budget) {
    if (budget <= 0) return [];
    const files = this.timeline.snapshotFiles(directory.snapshotId).slice(0, budget);
    const firstSeen = new Map(this.db.prepare('SELECT id, created_at FROM project_files WHERE project_id = ?')
      .all(directory.id).map((row) => [row.id, row.created_at]));
    const births = this.birthTimes(directory, files);
    return files.map((file) => ({
      id: file.projectFileId,
      directoryId: directory.id,
      path: file.path,
      name: path.posix.basename(file.path),
      kind: sourceKind(file.path, file.fileType),
      fileType: file.fileType,
      // Code is sent as a copy of the file, never as a Lasso share link.
      shareable: !isCodeType(file.fileType),
      size: file.size,
      contentHash: file.contentHash,
      modifiedAt: iso(file.mtimeMs),
      // When the file was made, where the disk says; otherwise when Lasso first saw it.
      createdAt: births.get(file.path) ?? firstSeen.get(file.projectFileId) ?? null,
    }));
  }

  birthTimes(directory, files) {
    // Nothing is remembered while the folder is out of reach, so its real
    // dates are read once it is back rather than after its next change.
    if (!directory.available || directory.offline) return new Map();
    const key = `${directory.id}:${directory.snapshotId}`;
    const cached = this.births.get(key);
    if (cached) return cached;
    const births = new Map();
    for (const file of files) {
      try {
        const birth = iso(fs.statSync(path.join(directory.rootPath, file.path)).birthtimeMs);
        if (birth) births.set(file.path, birth);
      } catch { /* moved since it was recorded; the first-seen date stands in */ }
    }
    this.births.set(key, births);
    return births;
  }

  usageRows() {
    return this.db.prepare(`SELECT project_file_id, kind, COUNT(*) AS sessions, MAX(last_used_at_ms) AS last_used
      FROM recommendation_usage GROUP BY project_file_id, kind`).all();
  }

  currentDependencies(directories) {
    return directories.flatMap((directory) => {
      try {
        return this.dependencies.currentDependencies(directory.id)
          .map((dependency) => ({ ...dependency, projectId: directory.id }));
      } catch { return []; }
    });
  }

  /** Share links made from this Mac, newest first, each tied to its file. */
  outgoingLinks(directories, fileIdAt) {
    const base = this.objectShares?.baseUrl().replace(/\/+$/, '') ?? '';
    return directories.flatMap((directory) => this.terminal.graph.shares(directory.id, { includeRevoked: true, includeExpired: true })
      .map((share) => ({
        id: share.id, token: share.token, kind: share.kind,
        url: share.url.startsWith('/') ? `${base}${share.url}` : share.url,
        directoryId: directory.id, path: share.path, fileId: fileIdAt(directory.id, share.path),
        name: share.fileName, locator: share.locator ?? null, scope: share.scope ?? 'DOCUMENT',
        status: share.status, drifted: Boolean(share.drifted),
        sharedValue: share.sharedValue ?? null, currentValue: share.currentValue ?? null,
        ...this.shownValues(directory.id, share.path, share.anchor, { sharedDisplay: share.sharedValue, currentDisplay: share.currentValue }),
        documentPath: share.documentPath ?? null,
        createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt,
      })))
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  /**
   * Share links someone else made that arrived in an indexed file: a mail
   * item from a connected app, a note, a document. Reading text files for
   * them also finds which other files each one names.
   */
  receivedLinks(files, network) {
    const own = new Set(this.db.prepare(`SELECT token FROM object_share_grants
      UNION SELECT token FROM dependency_share_grants`).all().map((row) => row.token));
    const filesByName = new Map();
    for (const file of files) {
      const name = file.name.toLowerCase();
      if (!filesByName.has(name)) filesByName.set(name, []);
      filesByName.get(name).push(file);
    }
    const received = [];
    for (const file of files) {
      if (!SCANNED_TEXT_TYPES.has(file.fileType) || file.size > MAX_SCANNED_BYTES) continue;
      const found = this.textLinks(file.contentHash);
      for (const link of found.links) {
        if (own.has(link.token)) continue;
        received.push({ id: `${file.id}:${link.token}`, url: link.url, token: link.token,
          directoryId: file.directoryId, path: file.path, fileId: file.id, receivedAt: file.modifiedAt });
      }
      for (const name of found.names) {
        for (const target of mentionTargets(filesByName, name, file)) network.add(file.id, target.id, 'mention');
      }
    }
    return received.sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)));
  }

  textLinks(contentHash) {
    const cached = this.texts.get(contentHash);
    if (cached) return cached;
    let text = '';
    try { text = this.timeline.blobs.get(contentHash)?.toString('utf8') ?? ''; } catch { /* unreadable copy: nothing found */ }
    const found = { links: shareLinksIn(text), names: fileNamesIn(text) };
    this.texts.set(contentHash, found);
    return found;
  }

  /** Counts one look at a file, once per half hour however often it is clicked. */
  recordVisit(input) {
    const { project, file } = this.currentFile(input);
    const time = Math.trunc(this.now());
    this.db.prepare(`INSERT INTO source_visits (project_id, project_file_id, visit_count, last_visited_at_ms)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(project_id, project_file_id) DO UPDATE SET
        visit_count = visit_count + CASE WHEN excluded.last_visited_at_ms - last_visited_at_ms >= ? THEN 1 ELSE 0 END,
        last_visited_at_ms = MAX(last_visited_at_ms, excluded.last_visited_at_ms)`)
      .run(project.id, file.projectFileId, time, VISIT_SESSION_MS);
    const row = this.db.prepare('SELECT visit_count, last_visited_at_ms FROM source_visits WHERE project_id = ? AND project_file_id = ?')
      .get(project.id, file.projectFileId);
    return { fileId: file.projectFileId, visits: row.visit_count, lastVisitedAt: iso(row.last_visited_at_ms) };
  }

  /** The indexed object that stands for a whole file, which a share link pins. */
  shareTarget(input) {
    const { project, file } = this.currentFile(input);
    if (isCodeType(file.fileType)) {
      throw new HttpError(422, 'Lasso doesn’t make share links for code files. Use Send a Copy to send the file itself.');
    }
    const objects = this.terminal.graph.namedObjects(project.id)
      .filter((object) => object.path === file.path && (!object.projectId || object.projectId === project.id));
    const chosen = objects.find(isWholeFile) ?? objects[0];
    if (!chosen) throw new HttpError(404, 'Lasso hasn’t indexed anything in this file, so it can’t make a share link for it.');
    return { projectId: project.id, objectId: chosen.id, versionId: chosen.versionId ?? null,
      label: chosen.name ?? chosen.label ?? file.path, path: file.path };
  }

  /**
   * A workbook's cells as Lasso reads them, for the sheet view: the current
   * version, or the one `input.version` names. Also the file's versions,
   * newest first, for the viewer's version menu, and the cells the shown
   * version changed, each with what it was.
   */
  sheet(input) {
    const { project, file: current } = this.currentFile(input);
    const all = this.fileVersions(project.id, current.projectFileId);
    // The menu lists the newest; an older version it names can still be opened.
    const versions = all.slice(0, MAX_FILE_VERSIONS)
      .map((version) => ({ ...version, available: this.timeline.blobs.has(version.contentHash) }));
    const chosen = input?.version ? all.find((version) => version.snapshotId === input.version) : all[0];
    if (input?.version && !chosen) throw new HttpError(404, 'Lasso has no such version of this file.');
    const file = chosen ? this.timeline.snapshotFileById(chosen.snapshotId, current.projectFileId) ?? current : current;
    const content = this.timeline.blobs.get(file.contentHash);
    if (!content) throw new HttpError(404, 'Lasso no longer has a copy of this file.');
    return { ...spreadsheetView(content), version: chosen?.snapshotId ?? null,
      versions: versions.map(({ contentHash, ...version }) => version),
      changes: chosen ? cellChanges(this.db, chosen.snapshotId, file.path,
        (anchor, value) => this.dependencies.shownCellValue(file.path, file.contentHash, anchor, value)) : [] };
  }

  /**
   * The passages of a text or PDF file that its latest version changed, each
   * with what it was, for the viewer to tint: { version, changes }.
   */
  passages(input) {
    const { project, file } = this.currentFile(input);
    const latest = this.fileVersions(project.id, file.projectFileId)[0];
    return { version: latest?.snapshotId ?? null, changes: latest ? passageChanges(this.db, latest.snapshotId, file.path) : [] };
  }

  /**
   * The versions of a file, newest first: each snapshot that gave it new
   * bytes, with when. A rename or move that kept the bytes is part of the
   * version before it, not one of its own.
   */
  fileVersions(projectId, projectFileId) {
    const rows = this.db.prepare(`SELECT e.resulting_snapshot_id AS snapshot_id, e.occurred_at, c.content_hash_after
      FROM file_changes c JOIN timeline_events e ON e.id = c.event_id
      WHERE e.project_id = ? AND c.project_file_id = ? AND c.change_type IN ('ADDED', 'MODIFIED', 'RENAMED', 'MOVED')
        AND e.resulting_snapshot_id IS NOT NULL
      ORDER BY e.occurred_at, e.rowid`).all(projectId, projectFileId);
    const versions = [];
    for (const row of rows) {
      if (versions.length && row.content_hash_after && versions.at(-1).contentHash === row.content_hash_after) continue;
      versions.push({ snapshotId: row.snapshot_id, at: row.occurred_at, contentHash: row.content_hash_after });
    }
    return versions.reverse();
  }

  /** The recorded copy of a file, for a directory whose drive is disconnected. */
  fileContent(input) {
    const { file } = this.currentFile(input);
    const content = this.timeline.blobs.get(file.contentHash);
    if (!content) throw new HttpError(404, 'Lasso no longer has a copy of this file.');
    return { name: path.posix.basename(file.path), content };
  }

  currentFile(input) {
    const directoryId = input?.directoryId;
    const filePath = input?.path;
    if (typeof directoryId !== 'string' || !directoryId || directoryId.length > 128) {
      throw new HttpError(400, 'Choose a directory.');
    }
    if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || filePath.includes('\u0000')) {
      throw new HttpError(400, 'Choose a file.');
    }
    const project = this.timeline.getProject(directoryId);
    const file = project.currentSnapshotId ? this.timeline.snapshotFile(project.currentSnapshotId, filePath) : null;
    if (!file) throw new HttpError(404, 'This file is not in the directory any more.');
    return { project, file };
  }
}
