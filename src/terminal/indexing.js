// Index controls: what the indexer covers, what it skipped, and what it could
// not read.
//
// The timeline still owns scanning. This layer supplies the exclusion filter it
// consults and records the failures it collects, so `index failures` reports
// what actually happened during a scan.

import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { normalizeProjectRootPath } from '../history/service.js';

function now() { return new Date().toISOString(); }

export class IndexControlService {
  constructor(db, timeline, dependencies) {
    this.db = db;
    this.timeline = timeline;
    this.dependencies = dependencies;
    // Consulted by TimelineService.scanProject.
    timeline.scanPolicy = {
      exclusionFilter: (projectId) => this.exclusionFilter(projectId),
      recordFailures: (projectId, failures) => this.recordFailures(projectId, failures),
    };
  }

  // ── exclusions ───────────────────────────────────────────────────────────

  exclusions(projectId) {
    return this.db.prepare('SELECT * FROM index_exclusions WHERE project_id = ? ORDER BY path_prefix')
      .all(projectId)
      .map((row) => ({ id: row.id, pathPrefix: row.path_prefix, reason: row.reason, createdAt: row.created_at }));
  }

  exclusionFilter(projectId) {
    const prefixes = this.exclusions(projectId).map((exclusion) => exclusion.pathPrefix);
    if (!prefixes.length) return null;
    return (relativePath) => prefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  }

  /** Relative to the project root, so exclusions survive the project moving. */
  relativeTo(project, target) {
    const raw = String(target ?? '').trim();
    if (!raw) throw new HttpError(400, 'A path is required.');
    const absolute = path.isAbsolute(raw) || raw.startsWith('~') ? normalizeProjectRootPath(raw) : path.resolve(project.rootPath, raw);
    const relative = path.relative(project.rootPath, absolute).split(path.sep).join('/');
    if (relative.startsWith('..') || relative === '') {
      throw new HttpError(400, `${raw} is not inside ${project.rootPath}.`);
    }
    return relative;
  }

  exclude(projectId, target, reason = null) {
    const project = this.timeline.getProject(projectId);
    const prefix = this.relativeTo(project, target);
    this.db.prepare(`
      INSERT INTO index_exclusions(id, project_id, path_prefix, reason, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, path_prefix) DO NOTHING
    `).run(crypto.randomUUID(), projectId, prefix, reason, now());
    return { pathPrefix: prefix };
  }

  include(projectId, target) {
    const project = this.timeline.getProject(projectId);
    const prefix = this.relativeTo(project, target);
    const removed = this.db.prepare('DELETE FROM index_exclusions WHERE project_id = ? AND path_prefix = ?')
      .run(projectId, prefix);
    if (!removed.changes) throw new HttpError(404, `${prefix} is not excluded.`);
    return { pathPrefix: prefix };
  }

  // ── failures ─────────────────────────────────────────────────────────────

  /**
   * Replaces the failure set for a project with what the latest scan produced.
   * A failure that no longer occurs is resolved rather than deleted, so a retry
   * that works is visible.
   */
  recordFailures(projectId, failures) {
    const timestamp = now();
    const seen = new Set(failures.map((failure) => failure.path));
    const insert = this.db.prepare(`
      INSERT INTO index_failures(id, project_id, path, code, reason, detected_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_id, path) DO UPDATE SET code = excluded.code, reason = excluded.reason, resolved_at = NULL
    `);
    for (const failure of failures) {
      insert.run(crypto.randomUUID(), projectId, failure.path, failure.code, failure.reason, timestamp);
    }
    const open = this.db.prepare('SELECT id, path FROM index_failures WHERE project_id = ? AND resolved_at IS NULL').all(projectId);
    const resolve = this.db.prepare('UPDATE index_failures SET resolved_at = ? WHERE id = ?');
    for (const row of open) {
      if (!seen.has(row.path)) resolve.run(timestamp, row.id);
    }
  }

  /** A file the indexer read but could not turn into indexed objects. */
  recordParseFailure(projectId, filePath, code, reason) {
    this.db.prepare(`
      INSERT INTO index_failures(id, project_id, path, code, reason, detected_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(project_id, path) DO UPDATE SET code = excluded.code, reason = excluded.reason, resolved_at = NULL
    `).run(crypto.randomUUID(), projectId, filePath, code, reason, now());
  }

  failures(projectId, options = {}) {
    const stored = this.db.prepare(`
      SELECT * FROM index_failures WHERE project_id = ? ORDER BY detected_at DESC, path
    `).all(projectId)
      .filter((row) => options.includeResolved || !row.resolved_at)
      .map((row) => ({
        id: row.id,
        path: row.path,
        code: row.code,
        reason: row.reason,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
        retryable: row.code !== 'UNSUPPORTED_FORMAT',
      }));
    const project = this.timeline.getProject(projectId);
    const drawingProblems = new Map();
    for (const object of this.dependencies.objectsAt(projectId, project.currentSnapshotId, ['DRAWING'])) {
      if (object.objectType !== 'DRAWING' || !object.metadata.extractionStatus || object.metadata.extractionStatus === 'ready') continue;
      const previous = drawingProblems.get(object.path);
      const warnings = [...new Set([...(previous?.warnings ?? []), ...(object.metadata.warnings ?? [])])];
      drawingProblems.set(object.path, {
        id: `drawing:${object.id}`, path: object.path, code: `DRAWING_${object.metadata.extractionStatus.toUpperCase()}`,
        reason: warnings.join(' ') || 'Some drawing measurements could not be indexed.', warnings,
        detectedAt: this.timeline.getSnapshot(project.currentSnapshotId).createdAt, resolvedAt: null,
        retryable: false,
      });
    }
    return [...stored, ...[...drawingProblems.values()].filter((problem) => !stored.some((entry) => entry.path === problem.path))];
  }

  // ── status ───────────────────────────────────────────────────────────────

  /** What is indexed right now, per granted directory and per subdirectory. */
  status(projectId) {
    const project = this.timeline.getProject(projectId);
    const snapshot = this.timeline.getSnapshot(project.currentSnapshotId);
    this.dependencies.ensureIndex(projectId, snapshot.id);

    const objectCount = this.db.prepare(`
      SELECT COUNT(*) AS count FROM scientific_object_versions v
      JOIN scientific_objects o ON o.id = v.object_id
      WHERE o.project_id = ? AND v.snapshot_id = ?
    `).get(projectId, snapshot.id).count;

    const lastEvent = this.db.prepare(`
      SELECT occurred_at, source, title FROM timeline_events
      WHERE project_id = ? ORDER BY occurred_at DESC LIMIT 1
    `).get(projectId);

    const failures = this.failures(projectId);
    const exclusions = this.exclusions(projectId);
    const failuresByDirectory = new Map();
    for (const failure of failures) {
      const top = failure.path.split('/')[0] || '.';
      failuresByDirectory.set(top, (failuresByDirectory.get(top) ?? 0) + 1);
    }

    const directories = new Map();
    for (const file of snapshot.files) {
      const top = file.path.includes('/') ? file.path.split('/')[0] : '.';
      const entry = directories.get(top) ?? { name: top, files: 0 };
      entry.files += 1;
      directories.set(top, entry);
    }
    for (const exclusion of exclusions) {
      const top = exclusion.pathPrefix.split('/')[0];
      if (!directories.has(top)) directories.set(top, { name: top, files: 0 });
    }

    const rows = [...directories.values()].map((entry) => {
      const excluded = exclusions.some((exclusion) => entry.name === exclusion.pathPrefix
        || exclusion.pathPrefix.startsWith(`${entry.name}/`));
      const errors = failuresByDirectory.get(entry.name) ?? 0;
      return {
        ...entry,
        excluded,
        errors,
        health: excluded ? 'excluded' : errors ? `${errors} error${errors === 1 ? '' : 's'}` : 'healthy',
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const workspace = this.timeline.listProjects();
    return {
      project: {
        id: project.id,
        name: project.name,
        rootPath: project.rootPath,
        version: snapshot.version,
        files: snapshot.files.length,
        dependencies: objectCount,
        indexedAt: this.db.prepare('SELECT indexed_at FROM snapshot_object_indexes WHERE snapshot_id = ?')
          .get(snapshot.id)?.indexed_at ?? null,
        lastScanAt: lastEvent?.occurred_at ?? null,
        lastScanTitle: lastEvent?.title ?? null,
      },
      workspace: {
        directories: workspace.length,
        files: workspace.reduce((total, entry) => total + (entry.fileCount ?? 0), 0),
      },
      directories: rows,
      grantedDirectories: workspace.map((entry) => ({
        id: entry.id,
        name: entry.name,
        rootPath: entry.rootPath,
        files: entry.fileCount ?? 0,
        active: entry.id === projectId,
      })),
      exclusions,
      failures,
    };
  }

  // ── operations ───────────────────────────────────────────────────────────

  add(rootPath, actor, name = null) {
    return this.timeline.importProject(rootPath, actor, { name });
  }

  refresh(projectId, actor) {
    const capture = this.timeline.capture(projectId, actor, { source: 'EXPLICIT_CHECKPOINT' });
    const project = this.timeline.getProject(projectId);
    this.dependencies.ensureIndex(project.id, project.currentSnapshotId);
    return capture;
  }

  /** Retries one previously failed path without rescanning everything else. */
  retry(projectId, filePath, actor) {
    const failure = this.db.prepare('SELECT * FROM index_failures WHERE project_id = ? AND path = ?')
      .get(projectId, filePath);
    if (!failure) throw new HttpError(404, `${filePath} is not a recorded indexing failure.`);
    if (failure.code === 'UNSUPPORTED_FORMAT') {
      throw new HttpError(409, `${filePath} cannot be retried: ${failure.reason}.`);
    }
    const capture = this.refresh(projectId, actor);
    const stillFailing = this.db.prepare('SELECT resolved_at FROM index_failures WHERE project_id = ? AND path = ?')
      .get(projectId, filePath);
    return { capture, resolved: Boolean(stillFailing?.resolved_at) };
  }
}
