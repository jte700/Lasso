// What an AI agent may read. Folders added to Lasso are the person's own
// library; handing them to a model is a separate decision, so an agent sees
// only the folders it was launched with (`--scope`), and only while they are
// enabled in Lasso. Authorization runs before retrieval: a file outside the
// scope contributes no name, count or preview to any answer.

import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.js';

// Files that hold credentials rather than content. An agent never receives
// them, even inside a folder it may read, because a model's context is not a
// place a secret can be taken back from.
const SECRET_NAMES = [
  /^\.env(?:\..*)?$/i, /^\.envrc$/i, /^\.netrc$/i, /^\.npmrc$/i, /^\.pypirc$/i, /^\.htpasswd$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i, /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i,
  /^credentials(?:\.[a-z]+)?$/i, /^secrets?(?:\.[a-z]+)?$/i, /^service[-_]?account.*\.json$/i,
];
const SECRET_DIRECTORIES = new Set(['.ssh', '.aws', '.gnupg', '.git', '.azure', '.kube', '.docker']);

/** Whether a folder-relative path names a credential file the agent never sees. */
export function isSecretPath(relativePath) {
  const parts = String(relativePath ?? '').split('/');
  if (parts.slice(0, -1).some((part) => SECRET_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1) ?? '';
  return SECRET_NAMES.some((pattern) => pattern.test(name));
}

function realpath(value) {
  try { return fs.realpathSync(value); } catch { return null; }
}

/**
 * `folders` lists what the agent may read: a folder's name as Lasso shows it,
 * its root path, or `*` for every enabled folder.
 */
export class AgentScope {
  constructor({ db, dependencies, rules = null, folders = [] }) {
    this.db = db;
    this.dependencies = dependencies;
    this.rules = rules;
    this.selectors = [...new Set((folders ?? []).map((value) => String(value).trim()).filter(Boolean))];
    this.everything = this.selectors.some((value) => value === '*' || value.toLowerCase() === 'all');
  }

  get configured() { return this.everything || this.selectors.length > 0; }

  describe() { return this.everything ? ['*'] : [...this.selectors]; }

  selects(project) {
    if (this.everything) return true;
    const root = realpath(project.rootPath) ?? project.rootPath;
    return this.selectors.some((selector) => selector === project.id
      || selector.toLowerCase() === String(project.name).toLowerCase()
      || (path.isAbsolute(selector) && (realpath(selector) ?? path.resolve(selector)) === root));
  }

  /**
   * Enabled, available folders inside the scope, each with the snapshot an
   * agent is answered from: the current one once it is indexed, otherwise
   * the newest indexed one, reported as lagging. Asking an unindexed snapshot
   * would make the agent's request do the indexing, on whichever process it
   * reached, in competition with the app.
   */
  projects() {
    if (!this.configured) {
      throw new AgentError('scope_not_configured',
        'No folders are shared with agents. Start Lasso\'s agent server with --scope <folder> (or --scope "*").');
    }
    const rows = this.db.prepare(`SELECT p.id, p.name, p.root_path, p.current_snapshot_id, s.version
      FROM projects p LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
      WHERE p.workspace_active = 1 AND p.workspace_removed = 0 AND p.current_snapshot_id IS NOT NULL
      ORDER BY p.created_at, p.id`).all();
    return rows.map((row) => ({ id: row.id, name: row.name, rootPath: row.root_path,
      currentSnapshotId: row.current_snapshot_id, currentVersion: row.version }))
      .filter((project) => this.selects(project))
      .map((project) => {
        let available = false;
        try { available = fs.statSync(project.rootPath).isDirectory(); } catch { /* disconnected or removed */ }
        const indexed = this.indexedSnapshot(project);
        return { ...project, available, snapshotId: indexed?.id ?? null, version: indexed?.version ?? null,
          indexedAt: indexed?.indexedAt ?? null, lagging: indexed ? indexed.id !== project.currentSnapshotId : true };
      });
  }

  indexedSnapshot(project) {
    if (this.dependencies.isIndexed(project.currentSnapshotId)) {
      const row = this.db.prepare('SELECT indexed_at FROM snapshot_object_indexes WHERE snapshot_id = ?').get(project.currentSnapshotId);
      return { id: project.currentSnapshotId, version: project.currentVersion, indexedAt: row?.indexed_at ?? null };
    }
    const recent = this.db.prepare(`SELECT s.id, s.version, i.indexed_at FROM snapshots s
      JOIN snapshot_object_indexes i ON i.snapshot_id = s.id
      WHERE s.project_id = ? ORDER BY s.version DESC LIMIT 8`).all(project.id);
    const row = recent.find((candidate) => this.dependencies.isIndexed(candidate.id));
    return row ? { id: row.id, version: row.version, indexedAt: row.indexed_at } : null;
  }

  /** Paths the person excluded from suggestions stay out of an agent's answers too. */
  suppressed(projectId) {
    try { return this.rules?.suppressedPathPrefixes(projectId) ?? []; } catch { return []; }
  }

  /** A filter over folder-relative paths of one folder already inside the scope. */
  pathFilter(projectId) {
    const prefixes = this.suppressed(projectId);
    return (relativePath) => !isSecretPath(relativePath)
      && !prefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  }
}
