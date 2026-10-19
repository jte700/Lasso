import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { BlobStore, hashBuffer } from './blob-store.js';
import { scanDirectory } from './scanner.js';
import { createStructuredDiff, deterministicEventTitle } from './diff.js';
import { ACTOR_TYPES } from '../config.js';
import { json, transaction } from '../db.js';
import { HttpError, VersionConflictError } from './errors.js';

function now() {
  return new Date().toISOString();
}

function id() {
  return crypto.randomUUID();
}

function manifestHash(files) {
  const manifest = files
    .map((file) => [file.path, file.contentHash, file.size, file.fileType])
    .sort(([a], [b]) => a.localeCompare(b));
  return hashBuffer(Buffer.from(JSON.stringify(manifest)));
}

function normalizeActor(actor, fallbackType = 'HUMAN_SELF') {
  const candidate = actor ?? {};
  const actorType = ACTOR_TYPES.has(candidate.actorType) ? candidate.actorType : fallbackType;
  const displayName = String(candidate.displayName ?? '').trim();
  if (!displayName) throw new HttpError(400, 'Actor displayName is required.');
  return {
    id: String(candidate.id ?? `${actorType.toLowerCase()}:${displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`),
    displayName,
    actorType,
  };
}

function rowToSnapshotFile(row) {
  return {
    snapshotId: row.snapshot_id,
    projectFileId: row.project_file_id,
    path: row.path,
    contentHash: row.content_hash,
    size: row.size,
    mtimeMs: row.mtime_ms,
    fileType: row.file_type,
    device: row.device,
    inode: row.inode,
    metadata: json(row.metadata_json, {}),
  };
}

function classifyPathChange(beforePath, afterPath) {
  return path.posix.basename(beforePath) === path.posix.basename(afterPath) ? 'MOVED' : 'RENAMED';
}

function normalizeProjectRootPath(input) {
  let value = String(input ?? '').trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === "'" || quote === '"') && value.at(-1) === quote) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/\\ /g, ' ');
  if (value === '~') value = os.homedir();
  else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

export class TimelineService {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.blobs = new BlobStore(config.blobDir);
    this.watchers = new Map();
    this.pendingTimers = new Map();
    this.captureListeners = new Set();
    // Set by the terminal's index controls. The timeline owns scanning; the
    // terminal owns which paths the user excluded and what failed to be read.
    this.scanPolicy = null;
  }

  /**
   * Scans a project honouring the user's index exclusions, and hands whatever
   * could not be read to the index-control layer so `index failures` reports
   * real failures rather than an empty list.
   */
  scanProject(project) {
    this.drives?.assertOnline(project.id);
    const failures = [];
    const exclude = this.scanPolicy?.exclusionFilter?.(project.id) ?? null;
    const files = scanDirectory(project.rootPath, this.blobs, { exclude, failures });
    this.drives?.assertOnline(project.id);
    if (this.drives?.projectState(project.id).removableDriveId && failures.some(failure => ['DISAPPEARED', 'DEVICE_UNAVAILABLE'].includes(failure.code) || failure.path === '.')) {
      throw new HttpError(409, 'The drive changed or became unreadable during indexing. Its last complete snapshot was kept.');
    }
    this.scanPolicy?.recordFailures?.(project.id, failures);
    return files;
  }

  onCapture(listener) {
    this.captureListeners.add(listener);
    return () => this.captureListeners.delete(listener);
  }

  notifyCapture(result) {
    for (const listener of this.captureListeners) {
      try {
        listener(result);
      } catch (error) {
        console.error('Post-capture integration failed:', error.message);
      }
    }
  }

  close() {
    for (const watcher of this.watchers.values()) watcher.close();
    for (const timer of this.pendingTimers.values()) clearTimeout(timer);
    this.watchers.clear();
    this.pendingTimers.clear();
  }

  upsertActor(actor) {
    const normalized = normalizeActor(actor);
    const existing = this.db.prepare('SELECT * FROM actors WHERE id = ?').get(normalized.id);
    if (existing && existing.actor_type !== normalized.actorType) {
      throw new HttpError(409, 'An actor ID cannot change actor type.');
    }
    this.db.prepare(`
      INSERT INTO actors(id, display_name, actor_type, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name
    `).run(normalized.id, normalized.displayName, normalized.actorType, now());
    return normalized;
  }

  getProject(projectId) {
    const row = this.db.prepare(`
      SELECT p.*, s.version AS current_version
      FROM projects p LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
      WHERE p.id = ?
    `).get(projectId);
    if (!row) throw new HttpError(404, 'Project not found.');
    return {
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      currentSnapshotId: row.current_snapshot_id,
      currentVersion: row.current_version,
      watcherEnabled: Boolean(row.watcher_enabled),
      ...this.drives?.projectState(row.id),
    };
  }

  listProjects() {
    return this.db.prepare(`
      SELECT p.id, p.name, p.root_path, p.created_at, p.current_snapshot_id, s.version AS current_version,
        (SELECT COUNT(*) FROM snapshot_files sf WHERE sf.snapshot_id = p.current_snapshot_id) AS file_count
      FROM projects p LEFT JOIN snapshots s ON s.id = p.current_snapshot_id
      ORDER BY p.created_at DESC
    `).all().map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      createdAt: row.created_at,
      currentSnapshotId: row.current_snapshot_id,
      currentVersion: row.current_version,
      fileCount: row.file_count,
      ...this.drives?.projectState(row.id),
    }));
  }

  importProject(rootPath, actorInput, options = {}) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(normalizeProjectRootPath(rootPath));
    } catch {
      throw new HttpError(400, 'The selected project directory does not exist.');
    }
    if (!fs.statSync(realRoot).isDirectory()) throw new HttpError(400, 'The selected project path is not a directory.');
    const existing = this.db.prepare('SELECT id FROM projects WHERE root_path = ?').get(realRoot);
    if (existing) return { project: this.getProject(existing.id), imported: false };

    const actor = normalizeActor(actorInput);
    const failures = [];
    if (options.driveId) this.drives.assertDrive(options.driveId);
    const scanned = scanDirectory(realRoot, this.blobs, { failures });
    if (options.driveId) {
      this.drives.assertDrive(options.driveId);
      if (failures.some(failure => ['DISAPPEARED', 'DEVICE_UNAVAILABLE'].includes(failure.code) || failure.path === '.')) throw new HttpError(409, 'The drive became unavailable during indexing. Reconnect it and try again.');
    }
    const projectId = id();
    const snapshotId = id();
    const eventId = id();
    const timestamp = now();

    transaction(this.db, () => {
      this.upsertActor(actor);
      this.db.prepare(`INSERT INTO projects(id, name, root_path, created_at, watcher_enabled) VALUES (?, ?, ?, ?, ?)`)
        .run(projectId, options.name?.trim() || path.basename(realRoot), realRoot, timestamp, options.watch === false ? 0 : 1);
      this.db.prepare(`
        INSERT INTO snapshots(id, project_id, version, parent_snapshot_id, manifest_hash, created_at)
        VALUES (?, ?, 1, NULL, ?, ?)
      `).run(snapshotId, projectId, manifestHash(scanned), timestamp);

      const insertProjectFile = this.db.prepare('INSERT INTO project_files(id, project_id, created_at) VALUES (?, ?, ?)');
      const insertSnapshotFile = this.db.prepare(`
        INSERT INTO snapshot_files(snapshot_id, project_file_id, path, content_hash, size, mtime_ms, file_type, device, inode, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const assigned = [];
      for (const file of scanned) {
        const projectFileId = id();
        insertProjectFile.run(projectFileId, projectId, timestamp);
        insertSnapshotFile.run(
          snapshotId, projectFileId, file.path, file.contentHash, file.size, file.mtimeMs,
          file.fileType, file.device, file.inode, JSON.stringify(file.metadata),
        );
        assigned.push({ ...file, projectFileId });
      }
      this.db.prepare('UPDATE projects SET current_snapshot_id = ? WHERE id = ?').run(snapshotId, projectId);
      this.db.prepare(`
        INSERT INTO timeline_events(id, project_id, previous_snapshot_id, resulting_snapshot_id, actor_id, initiated_by_actor_id, occurred_at, source, title)
        VALUES (?, ?, NULL, ?, ?, NULL, ?, 'IMPORT', 'Project imported')
      `).run(eventId, projectId, snapshotId, actor.id, timestamp);
      const insertChange = this.db.prepare(`
        INSERT INTO file_changes(id, event_id, project_file_id, path_before, path_after, change_type, content_hash_before, content_hash_after, structured_diff_json)
        VALUES (?, ?, ?, NULL, ?, 'ADDED', NULL, ?, ?)
      `);
      for (const file of assigned) {
        insertChange.run(id(), eventId, file.projectFileId, file.path, file.contentHash, JSON.stringify({ format: 'file', message: 'File added.' }));
      }
    });

    if (options.driveId) this.scanPolicy?.recordFailures?.(projectId, failures);
    if (options.watch !== false && this.config.watchProjects) this.watchProject(projectId, actor);
    const result = { project: this.getProject(projectId), imported: true, event: this.getEvent(eventId) };
    this.notifyCapture({ changed: true, projectId, snapshot: this.getSnapshot(snapshotId), event: result.event });
    return result;
  }

  snapshotFiles(snapshotId) {
    return this.db.prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ? ORDER BY path').all(snapshotId).map(rowToSnapshotFile);
  }

  getSnapshot(snapshotId) {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(snapshotId);
    if (!row) throw new HttpError(404, 'Snapshot not found.');
    return {
      id: row.id,
      projectId: row.project_id,
      version: row.version,
      parentSnapshotId: row.parent_snapshot_id,
      manifestHash: row.manifest_hash,
      createdAt: row.created_at,
      files: this.snapshotFiles(snapshotId),
    };
  }

  snapshotFile(snapshotId, filePath) {
    const row = this.db.prepare('SELECT * FROM snapshot_files WHERE snapshot_id = ? AND path = ?').get(snapshotId, filePath);
    return row ? rowToSnapshotFile(row) : null;
  }

  compareScan(previousFiles, scannedFiles) {
    const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
    const scannedByPath = new Map(scannedFiles.map((file) => [file.path, file]));
    const assigned = [];
    const changes = [];
    const unmatchedBefore = [];
    const unmatchedAfter = [];

    for (const before of previousFiles) {
      const after = scannedByPath.get(before.path);
      if (!after) {
        unmatchedBefore.push(before);
        continue;
      }
      assigned.push({ ...after, projectFileId: before.projectFileId });
      if (before.contentHash !== after.contentHash) {
        changes.push({ changeType: 'MODIFIED', before, after: { ...after, projectFileId: before.projectFileId } });
      }
    }
    for (const after of scannedFiles) {
      if (!previousByPath.has(after.path)) unmatchedAfter.push(after);
    }

    const usedBefore = new Set();
    const usedAfter = new Set();
    const matchRename = (predicate) => {
      for (let afterIndex = 0; afterIndex < unmatchedAfter.length; afterIndex += 1) {
        if (usedAfter.has(afterIndex)) continue;
        const candidates = unmatchedBefore
          .map((before, beforeIndex) => ({ before, beforeIndex }))
          .filter(({ before, beforeIndex }) => !usedBefore.has(beforeIndex) && predicate(before, unmatchedAfter[afterIndex]));
        if (candidates.length !== 1) continue;
        const { before, beforeIndex } = candidates[0];
        const after = { ...unmatchedAfter[afterIndex], projectFileId: before.projectFileId };
        usedBefore.add(beforeIndex);
        usedAfter.add(afterIndex);
        assigned.push(after);
        changes.push({ changeType: classifyPathChange(before.path, after.path), before, after });
      }
    };

    matchRename((before, after) => before.device === after.device && before.inode === after.inode);
    matchRename((before, after) => before.contentHash === after.contentHash);

    unmatchedBefore.forEach((before, index) => {
      if (!usedBefore.has(index)) changes.push({ changeType: 'DELETED', before, after: null });
    });
    unmatchedAfter.forEach((after, index) => {
      if (usedAfter.has(index)) return;
      const added = { ...after, projectFileId: id() };
      assigned.push(added);
      changes.push({ changeType: 'ADDED', before: null, after: added, isNewIdentity: true });
    });

    assigned.sort((a, b) => a.path.localeCompare(b.path));
    changes.sort((a, b) => (a.after?.path ?? a.before?.path).localeCompare(b.after?.path ?? b.before?.path));
    return { assigned, changes };
  }

  capture(projectId, actorInput, options = {}) {
    const project = this.getProject(projectId);
    const actor = normalizeActor(actorInput, options.source === 'SYSTEM' ? 'SYSTEM' : 'HUMAN_SELF');
    if (options.expectedSnapshotId && options.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(options.expectedSnapshotId, project.currentSnapshotId);
    }
    const previous = this.getSnapshot(project.currentSnapshotId);
    const scanned = this.scanProject(project);
    const comparison = this.compareScan(previous.files, scanned);
    if (!comparison.changes.length) return { changed: false, snapshot: previous, event: null };

    const snapshotId = id();
    const eventId = id();
    const timestamp = now();
    const version = previous.version + 1;
    const title = deterministicEventTitle(comparison.changes.map((change) => ({
      changeType: change.changeType,
      pathBefore: change.before?.path,
      pathAfter: change.after?.path,
    })));

    transaction(this.db, () => {
      const current = this.db.prepare('SELECT current_snapshot_id FROM projects WHERE id = ?').get(projectId);
      if (current.current_snapshot_id !== previous.id) throw new VersionConflictError(previous.id, current.current_snapshot_id);
      this.upsertActor(actor);
      let initiatedBy = null;
      if (options.initiatedBy) {
        initiatedBy = normalizeActor(options.initiatedBy);
        this.upsertActor(initiatedBy);
      }
      this.db.prepare(`
        INSERT INTO snapshots(id, project_id, version, parent_snapshot_id, manifest_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(snapshotId, projectId, version, previous.id, manifestHash(comparison.assigned), timestamp);
      const insertProjectFile = this.db.prepare('INSERT INTO project_files(id, project_id, created_at) VALUES (?, ?, ?)');
      const insertSnapshotFile = this.db.prepare(`
        INSERT INTO snapshot_files(snapshot_id, project_file_id, path, content_hash, size, mtime_ms, file_type, device, inode, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const file of comparison.assigned) {
        if (comparison.changes.some((change) => change.isNewIdentity && change.after.projectFileId === file.projectFileId)) {
          insertProjectFile.run(file.projectFileId, projectId, timestamp);
        }
        insertSnapshotFile.run(
          snapshotId, file.projectFileId, file.path, file.contentHash, file.size, file.mtimeMs,
          file.fileType, file.device, file.inode, JSON.stringify(file.metadata),
        );
      }
      this.db.prepare(`
        INSERT INTO timeline_events(id, project_id, previous_snapshot_id, resulting_snapshot_id, actor_id, initiated_by_actor_id, occurred_at, source, title, agent_execution_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventId, projectId, previous.id, snapshotId, actor.id, initiatedBy?.id ?? null,
        timestamp, options.source ?? 'WATCHER', title, options.agentExecutionId ?? null,
      );
      const insertChange = this.db.prepare(`
        INSERT INTO file_changes(id, event_id, project_file_id, path_before, path_after, change_type, content_hash_before, content_hash_after, structured_diff_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const change of comparison.changes) {
        const fileType = change.after?.fileType ?? change.before?.fileType;
        const beforeBuffer = change.before ? this.blobs.get(change.before.contentHash) : null;
        const afterBuffer = change.after ? this.blobs.get(change.after.contentHash) : null;
        const structuredDiff = createStructuredDiff({
          fileType,
          filePath: change.after?.path ?? change.before?.path,
          beforeBuffer,
          afterBuffer,
          changeType: change.changeType,
        });
        insertChange.run(
          id(), eventId, change.after?.projectFileId ?? change.before.projectFileId,
          change.before?.path ?? null, change.after?.path ?? null, change.changeType,
          change.before?.contentHash ?? null, change.after?.contentHash ?? null, JSON.stringify(structuredDiff),
        );
      }
      this.db.prepare('UPDATE projects SET current_snapshot_id = ? WHERE id = ?').run(snapshotId, projectId);
    });

    const result = { changed: true, projectId, snapshot: this.getSnapshot(snapshotId), event: this.getEvent(eventId) };
    this.notifyCapture(result);
    return result;
  }

  listEvents(projectId) {
    this.getProject(projectId);
    return this.db.prepare(`
      SELECT e.*, a.display_name AS actor_name, a.actor_type,
        i.display_name AS initiator_name, i.actor_type AS initiator_type,
        ps.version AS previous_version, rs.version AS resulting_version,
        (SELECT COUNT(*) FROM file_changes fc WHERE fc.event_id = e.id) AS file_count,
        (SELECT COUNT(*) FROM dependency_changes dc WHERE dc.event_id = e.id) AS dependency_count
      FROM timeline_events e
      JOIN actors a ON a.id = e.actor_id
      LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
      LEFT JOIN snapshots ps ON ps.id = e.previous_snapshot_id
      JOIN snapshots rs ON rs.id = e.resulting_snapshot_id
      WHERE e.project_id = ?
      ORDER BY rs.version DESC
    `).all(projectId).map((row) => this.mapEventRow(row));
  }

  mapEventRow(row) {
    return {
      id: row.id,
      projectId: row.project_id,
      previousSnapshotId: row.previous_snapshot_id,
      resultingSnapshotId: row.resulting_snapshot_id,
      previousVersion: row.previous_version,
      resultingVersion: row.resulting_version,
      actor: { id: row.actor_id, displayName: row.actor_name, actorType: row.actor_type },
      initiatedBy: row.initiated_by_actor_id
        ? { id: row.initiated_by_actor_id, displayName: row.initiator_name, actorType: row.initiator_type }
        : null,
      occurredAt: row.occurred_at,
      source: row.source,
      title: row.title,
      fileCount: row.file_count,
      dependencyCount: row.dependency_count ?? 0,
      agentExecutionId: row.agent_execution_id,
    };
  }

  getEvent(eventId) {
    const row = this.db.prepare(`
      SELECT e.*, a.display_name AS actor_name, a.actor_type,
        i.display_name AS initiator_name, i.actor_type AS initiator_type,
        ps.version AS previous_version, rs.version AS resulting_version,
        (SELECT COUNT(*) FROM file_changes fc WHERE fc.event_id = e.id) AS file_count,
        (SELECT COUNT(*) FROM dependency_changes dc WHERE dc.event_id = e.id) AS dependency_count
      FROM timeline_events e
      JOIN actors a ON a.id = e.actor_id
      LEFT JOIN actors i ON i.id = e.initiated_by_actor_id
      LEFT JOIN snapshots ps ON ps.id = e.previous_snapshot_id
      JOIN snapshots rs ON rs.id = e.resulting_snapshot_id
      WHERE e.id = ?
    `).get(eventId);
    if (!row) throw new HttpError(404, 'Timeline event not found.');
    const event = this.mapEventRow(row);
    event.changes = this.db.prepare('SELECT * FROM file_changes WHERE event_id = ? ORDER BY COALESCE(path_after, path_before)').all(eventId)
      .map((change) => ({
        id: change.id,
        projectFileId: change.project_file_id,
        pathBefore: change.path_before,
        pathAfter: change.path_after,
        changeType: change.change_type,
        contentHashBefore: change.content_hash_before,
        contentHashAfter: change.content_hash_after,
        structuredDiff: json(change.structured_diff_json, {}),
      }));
    event.dependencyChanges = this.db.prepare(`
      SELECT dc.*, before_v.span_text AS before_span, before_v.status AS before_status,
        after_v.span_text AS after_span, after_v.status AS after_status,
        after_v.document_path AS document_path
      FROM dependency_changes dc
      LEFT JOIN claim_dependency_versions before_v ON before_v.id = dc.before_version_id
      LEFT JOIN claim_dependency_versions after_v ON after_v.id = dc.after_version_id
      WHERE dc.event_id = ? ORDER BY dc.rowid
    `).all(eventId).map((change) => ({
      id: change.id,
      dependencyId: change.dependency_id,
      changeType: change.change_type,
      beforeVersionId: change.before_version_id,
      afterVersionId: change.after_version_id,
      beforeSpan: change.before_span,
      afterSpan: change.after_span,
      beforeStatus: change.before_status,
      afterStatus: change.after_status,
      documentPath: change.document_path,
      details: json(change.details_json, {}),
    }));
    return event;
  }

  resolveProjectPath(project, relativePath) {
    this.drives?.assertOnline(project.id);
    if (!relativePath || path.isAbsolute(relativePath)) throw new HttpError(400, 'A relative project file path is required.');
    const root = path.resolve(project.rootPath);
    const destination = path.resolve(root, relativePath);
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
      throw new HttpError(400, 'File path escapes the project directory.');
    }
    return destination;
  }

  proposeAgentEdit(projectId, input) {
    const project = this.getProject(projectId);
    const agent = normalizeActor(input.agent, 'AI_AGENT');
    if (agent.actorType !== 'AI_AGENT') throw new HttpError(400, 'Agent edits require an AI_AGENT actor.');
    const initiatedBy = normalizeActor(input.initiatedBy, 'HUMAN_SELF');
    if (!['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(initiatedBy.actorType)) {
      throw new HttpError(400, 'Agent edit initiator must be a human actor.');
    }
    const baseSnapshotId = input.baseSnapshotId ?? project.currentSnapshotId;
    if (baseSnapshotId !== project.currentSnapshotId) throw new VersionConflictError(baseSnapshotId, project.currentSnapshotId);
    const relativePath = String(input.path ?? '').split(path.sep).join('/');
    this.resolveProjectPath(project, relativePath);
    const previousFile = this.snapshotFile(baseSnapshotId, relativePath);
    const beforeBuffer = previousFile ? this.blobs.get(previousFile.contentHash) : null;
    const afterBuffer = Buffer.from(String(input.content ?? ''), 'utf8');
    const proposedHash = this.blobs.put(afterBuffer);
    const fileType = previousFile?.fileType ?? 'text';
    const structuredDiff = createStructuredDiff({
      fileType,
      filePath: relativePath,
      beforeBuffer,
      afterBuffer,
      changeType: previousFile ? 'MODIFIED' : 'ADDED',
    });
    const executionId = id();
    const proposal = {
      path: relativePath,
      contentHashBefore: previousFile?.contentHash ?? null,
      contentHashAfter: proposedHash,
      changeType: previousFile ? 'MODIFIED' : 'ADDED',
      structuredDiff,
      provenance: Array.isArray(input.provenance) ? input.provenance : [],
      dependencyProposals: input.dependencyProposals
        ?? this.dependencies?.predictAgentDependencies(projectId, input)
        ?? [],
    };
    transaction(this.db, () => {
      this.upsertActor(agent);
      this.upsertActor(initiatedBy);
      this.db.prepare(`
        INSERT INTO agent_executions(id, project_id, agent_actor_id, initiated_by_actor_id, request_text, base_snapshot_id, status, proposal_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)
      `).run(executionId, projectId, agent.id, initiatedBy.id, String(input.request ?? ''), baseSnapshotId, JSON.stringify(proposal), now());
    });
    return { id: executionId, status: 'PROPOSED', baseSnapshotId, agent, initiatedBy, request: String(input.request ?? ''), proposal };
  }

  getExecution(executionId) {
    const row = this.db.prepare(`
      SELECT x.*, a.display_name AS agent_name, a.actor_type AS agent_type,
        i.display_name AS initiator_name, i.actor_type AS initiator_type
      FROM agent_executions x
      JOIN actors a ON a.id = x.agent_actor_id
      LEFT JOIN actors i ON i.id = x.initiated_by_actor_id
      WHERE x.id = ?
    `).get(executionId);
    if (!row) throw new HttpError(404, 'Agent execution not found.');
    return {
      id: row.id,
      projectId: row.project_id,
      baseSnapshotId: row.base_snapshot_id,
      status: row.status,
      request: row.request_text,
      proposal: json(row.proposal_json, {}),
      agent: { id: row.agent_actor_id, displayName: row.agent_name, actorType: row.agent_type },
      initiatedBy: row.initiated_by_actor_id
        ? { id: row.initiated_by_actor_id, displayName: row.initiator_name, actorType: row.initiator_type }
        : null,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  }

  approveAgentEdit(executionId) {
    const execution = this.getExecution(executionId);
    if (execution.status !== 'PROPOSED') throw new HttpError(409, 'Only proposed agent edits can be applied.');
    const project = this.getProject(execution.projectId);
    if (project.currentSnapshotId !== execution.baseSnapshotId) {
      this.db.prepare("UPDATE agent_executions SET status = 'CONFLICT' WHERE id = ?").run(executionId);
      throw new VersionConflictError(execution.baseSnapshotId, project.currentSnapshotId);
    }
    const proposal = execution.proposal;
    const currentFile = this.snapshotFile(project.currentSnapshotId, proposal.path);
    if ((currentFile?.contentHash ?? null) !== proposal.contentHashBefore) {
      this.db.prepare("UPDATE agent_executions SET status = 'CONFLICT' WHERE id = ?").run(executionId);
      throw new HttpError(409, 'The target file no longer matches the proposed before version.');
    }
    const destination = this.resolveProjectPath(project, proposal.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.lasso-${executionId}.tmp`;
    fs.writeFileSync(temporary, this.blobs.get(proposal.contentHashAfter), { flag: 'wx' });
    fs.renameSync(temporary, destination);

    const capture = this.capture(execution.projectId, execution.agent, {
      expectedSnapshotId: execution.baseSnapshotId,
      initiatedBy: execution.initiatedBy,
      source: 'AGENT_EDIT',
      agentExecutionId: execution.id,
    });
    this.db.prepare("UPDATE agent_executions SET status = 'APPLIED', applied_at = ? WHERE id = ?")
      .run(now(), executionId);
    for (const link of proposal.provenance ?? []) {
      this.addProvenanceLink(execution.projectId, {
        fromSnapshotId: capture.snapshot.id,
        fromPath: proposal.path,
        fromAnchor: link.fromAnchor ?? null,
        relation: link.relation,
        toSnapshotId: link.toSnapshotId ?? execution.baseSnapshotId,
        toPath: link.toPath ?? null,
        toAnchor: link.toAnchor ?? null,
        metadata: link.metadata ?? {},
        createdByEventId: capture.event.id,
      });
    }
    const appliedExecution = this.getExecution(executionId);
    const dependencyLinks = this.dependencies?.acceptAgentDependencies(appliedExecution, capture) ?? [];
    return { ...capture, execution: appliedExecution, dependencyLinks };
  }

  rejectAgentEdit(executionId) {
    const execution = this.getExecution(executionId);
    if (execution.status !== 'PROPOSED') throw new HttpError(409, 'Only proposed agent edits can be rejected.');
    this.db.prepare("UPDATE agent_executions SET status = 'REJECTED' WHERE id = ?").run(executionId);
    return this.getExecution(executionId);
  }

  addProvenanceLink(projectId, input) {
    this.getProject(projectId);
    const allowed = new Set([
      'DEPENDS_ON', 'DERIVED_FROM', 'GENERATED_BY', 'USES_DATASET', 'USED', 'USED_IN_FIGURE',
      'SUPPORTS', 'PROPOSED_BY', 'APPROVED_BY', 'REPLACED_BY', 'IDENTIFIED_BY',
    ]);
    if (!allowed.has(input.relation)) throw new HttpError(400, 'Unsupported provenance relationship.');
    const linkId = id();
    this.db.prepare(`
      INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation, to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      linkId, projectId, input.fromSnapshotId, input.fromPath, input.fromAnchor ? JSON.stringify(input.fromAnchor) : null,
      input.relation, input.toSnapshotId ?? null, input.toPath ?? null, input.toAnchor ? JSON.stringify(input.toAnchor) : null,
      JSON.stringify(input.metadata ?? {}), input.createdByEventId ?? null, now(),
    );
    return { id: linkId, ...input };
  }

  watchProject(projectId, actorInput) {
    if (!this.config.watchProjects) return;
    const project = this.getProject(projectId);
    const actor = normalizeActor(actorInput);
    this.unwatchProject(projectId);
    if (project.availability === 'offline' || !project.watcherEnabled) return;
    let watcher;
    try {
      watcher = fs.watch(project.rootPath, { recursive: true }, () => {
        clearTimeout(this.pendingTimers.get(projectId));
        this.pendingTimers.set(projectId, setTimeout(() => {
          this.pendingTimers.delete(projectId);
          try {
            this.capture(projectId, actor, { source: 'WATCHER' });
          } catch (error) {
            console.error(`Project watcher capture failed for ${projectId}:`, error.message);
          }
        }, this.config.watchDebounceMs));
      });
    } catch (error) {
      console.warn(`Project watcher unavailable for ${project.rootPath}: ${error.message}`);
      return;
    }
    watcher.on('error', (error) => console.error(`Project watcher error for ${projectId}:`, error.message));
    this.watchers.set(projectId, watcher);
  }

  unwatchProject(projectId) {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    clearTimeout(this.pendingTimers.get(projectId));
    this.pendingTimers.delete(projectId);
  }
}

export { normalizeActor, normalizeProjectRootPath };
