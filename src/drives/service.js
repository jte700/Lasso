import fs from 'node:fs';
import path from 'node:path';
import { transaction } from '../db.js';
import { HttpError } from '../history/errors.js';

const systemActor = { id: 'system:removable-drives', displayName: 'Drive monitor', actorType: 'SYSTEM' };
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const stamp = root => {
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error('Volume is not a directory.');
  return `${stat.dev}:${stat.ino}`;
};

/** Native host supplies volume identities; paths and labels never identify a drive. */
export class RemovableDriveService {
  constructor(timeline, dependencies, config) {
    this.timeline = timeline;
    this.db = timeline.db;
    this.dependencies = dependencies;
    this.supported = Boolean(config.driveToken);
    this.mounts = new Map();
    // A saved mounted path is not proof that the same volume is attached now.
    this.db.exec(`UPDATE removable_drives SET pending_action = CASE
      WHEN connected = 1 AND EXISTS (SELECT 1 FROM drive_projects WHERE drive_id = removable_drives.id)
      THEN 'disconnected' ELSE pending_action END, connected = 0`);
    timeline.drives = this;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM removable_drives WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, 'Drive not found.');
    return { id: row.id, name: row.name, rootPath: row.root_path, connected: Boolean(row.connected),
      pendingAction: row.pending_action, updatedAt: row.updated_at,
      projects: this.db.prepare('SELECT project_id FROM drive_projects WHERE drive_id = ?').all(id)
        .map(row => this.timeline.getProject(row.project_id)) };
  }

  list() {
    return { supported: this.supported, drives: this.db.prepare(`SELECT id FROM removable_drives
      WHERE connected = 1 OR EXISTS (SELECT 1 FROM drive_projects WHERE drive_id = removable_drives.id)
      ORDER BY connected DESC, name`).all().map(row => this.get(row.id)) };
  }

  projectState(projectId) {
    const row = this.db.prepare(`SELECT d.*, dp.relative_path FROM drive_projects dp
      JOIN removable_drives d ON d.id = dp.drive_id WHERE dp.project_id = ?`).get(projectId);
    if (!row) return {};
    return { removableDriveId: row.id, driveName: row.name,
      availability: this.projectMounted(row) ? 'online' : 'offline' };
  }

  projectMounted(row) {
    if (!this.isMounted(row.id)) return false;
    try {
      const root = path.resolve(row.root_path, row.relative_path);
      const canonical = fs.realpathSync(root);
      return inside(row.root_path, canonical) && canonical === root && fs.statSync(canonical).isDirectory();
    } catch { return false; }
  }

  isMounted(id) {
    const mount = this.mounts.get(id);
    if (!mount) return false;
    try { return stamp(mount.rootPath) === mount.stamp; } catch { return false; }
  }

  assertOnline(projectId) {
    const state = this.projectState(projectId);
    if (state.availability === 'offline') throw new HttpError(409,
      `${state.driveName} is offline. Reconnect the drive to change or refresh its files; cached sources remain available.`);
  }

  assertDrive(id) {
    const drive = this.get(id);
    if (!drive.connected || !this.isMounted(id)) throw new HttpError(409, 'This drive is disconnected. Reconnect it and try again.');
    return drive;
  }

  disconnect(id) {
    this.mounts.delete(id);
    const projects = this.db.prepare('SELECT project_id FROM drive_projects WHERE drive_id = ?').all(id);
    for (const row of projects) this.timeline.unwatchProject(row.project_id);
    this.db.prepare(`UPDATE removable_drives SET connected = 0, pending_action = ?, updated_at = ? WHERE id = ?`)
      .run(projects.length ? 'disconnected' : null, new Date().toISOString(), id);
  }

  sync(volumes) {
    if (!Array.isArray(volumes) || volumes.length > 128) throw new HttpError(400, 'A mounted-volume list is required.');
    const seen = new Set();
    const inventory = volumes.map(volume => {
      if (!volume || typeof volume.id !== 'string' || !volume.id.trim() || volume.id.length > 512
        || typeof volume.name !== 'string' || volume.name.length > 512
        || typeof volume.rootPath !== 'string' || !path.isAbsolute(volume.rootPath)
        || seen.has(volume.id)) throw new HttpError(400, 'Invalid or duplicate volume identity.');
      seen.add(volume.id);
      try {
        const rootPath = fs.realpathSync(volume.rootPath);
        return { id: volume.id, name: volume.name.trim() || path.basename(rootPath), rootPath, stamp: stamp(rootPath) };
      } catch { return null; } // Can disappear between native enumeration and this request.
    }).filter(Boolean);
    const present = new Set(inventory.map(volume => volume.id));
    for (const row of this.db.prepare('SELECT id FROM removable_drives WHERE connected = 1').all()) {
      if (!present.has(row.id)) this.disconnect(row.id);
    }
    for (const volume of inventory) {
      const previous = this.db.prepare('SELECT * FROM removable_drives WHERE id = ?').get(volume.id);
      const changed = !previous?.connected || previous.root_path !== volume.rootPath
        || this.mounts.get(volume.id)?.stamp !== volume.stamp;
      const linked = this.db.prepare('SELECT * FROM drive_projects WHERE drive_id = ?').all(volume.id);
      if (changed) for (const row of linked) this.timeline.unwatchProject(row.project_id);
      this.db.prepare(`INSERT INTO removable_drives(id, name, root_path, connected, pending_action, updated_at)
        VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        root_path = excluded.root_path, connected = 1, pending_action = excluded.pending_action, updated_at = excluded.updated_at`)
        .run(volume.id, volume.name, volume.rootPath, changed ? (linked.length ? null : 'connected') : previous.pending_action,
          changed ? new Date().toISOString() : previous.updated_at);
      this.mounts.set(volume.id, volume);
      for (const row of linked) {
        const root = path.resolve(volume.rootPath, row.relative_path);
        const conflict = this.db.prepare('SELECT id FROM projects WHERE root_path = ? AND id != ?').get(root, row.project_id);
        if (conflict) {
          // Never merge distinct disks just because the OS reused a mount name.
          this.disconnect(volume.id);
          break;
        }
        this.db.prepare('UPDATE projects SET root_path = ? WHERE id = ?').run(root, row.project_id);
        if (changed && this.timeline.getProject(row.project_id).availability === 'online') {
          try { this.timeline.capture(row.project_id, systemActor, { source: 'OPEN_RECONCILE' }); }
          catch (error) { console.warn('Drive reconnection retained the last complete snapshot:', error.message); }
          if (this.timeline.getProject(row.project_id).watcherEnabled) this.timeline.watchProject(row.project_id, systemActor);
        }
      }
    }
    return this.list();
  }

  resolveFolder(id, relative = '.') {
    const drive = this.assertDrive(id);
    if (typeof relative !== 'string' || relative.length > 4096 || path.isAbsolute(relative)
      || relative.includes('\\') || relative.includes('\0') || relative.split('/').includes('..')) {
      throw new HttpError(400, 'Choose a folder inside this drive.');
    }
    let root;
    try { root = fs.realpathSync(path.resolve(drive.rootPath, relative)); }
    catch { throw new HttpError(404, 'This folder is no longer available.'); }
    if (!inside(drive.rootPath, root)) throw new HttpError(400, 'The selected folder is outside this drive.');
    if (!fs.statSync(root).isDirectory()) throw new HttpError(400, 'Choose a folder, not a file.');
    return { root, relative: path.relative(drive.rootPath, root).split(path.sep).join('/') || '.', drive };
  }

  folders(id, relative = '.') {
    const folder = this.resolveFolder(id, relative);
    try {
      return { path: folder.relative, folders: fs.readdirSync(folder.root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(entry => ({ name: entry.name, path: [folder.relative === '.' ? '' : folder.relative, entry.name].filter(Boolean).join('/') })) };
    } catch { throw new HttpError(403, 'Lasso cannot read this folder. Check its permissions.'); }
  }

  index(id, paths, actor) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 128) throw new HttpError(400, 'Choose the whole drive or at least one folder.');
    const selections = paths.map(relative => this.resolveFolder(id, relative));
    // Parent selections already include children; avoid duplicate workspaces.
    const roots = selections.filter((folder, index) => !selections.some((other, otherIndex) =>
      otherIndex !== index && inside(other.root, folder.root) && (other.root !== folder.root || otherIndex < index)));
    // Validate the complete selection before beginning an import.
    for (const folder of roots) {
      const existing = this.db.prepare(`SELECT p.id, dp.drive_id FROM projects p
        LEFT JOIN drive_projects dp ON dp.project_id = p.id WHERE p.root_path = ?`).get(folder.root);
      if (existing?.drive_id && existing.drive_id !== id) throw new HttpError(409,
        'Another saved drive uses this location. Remove its saved index or mount this drive at a different location.');
    }
    const projects = [];
    for (const folder of roots) {
      this.assertDrive(id);
      const result = this.timeline.importProject(folder.root, actor, {
        name: folder.relative === '.' ? folder.drive.name : `${folder.drive.name} / ${path.basename(folder.root)}`,
        watch: false, driveId: id,
      });
      this.db.prepare('INSERT OR IGNORE INTO drive_projects(project_id, drive_id, relative_path) VALUES (?, ?, ?)')
        .run(result.project.id, id, folder.relative);
      this.db.prepare('UPDATE projects SET watcher_enabled = 1 WHERE id = ?').run(result.project.id);
      this.dependencies.ensureIndex(result.project.id);
      this.timeline.watchProject(result.project.id, actor);
      projects.push(this.timeline.getProject(result.project.id));
    }
    this.db.prepare('UPDATE removable_drives SET pending_action = NULL WHERE id = ?').run(id);
    return { projects, drive: this.get(id) };
  }

  decision(id, action) {
    const drive = this.get(id);
    if (!['keep', 'remove', 'dismiss'].includes(action)) throw new HttpError(400, 'Choose keep, remove, or dismiss.');
    if (action === 'remove' && drive.connected) throw new HttpError(409, 'Disconnect the drive before removing its saved indexes.');
    const removedProjectIds = action === 'remove' ? drive.projects.map(project => project.id) : [];
    if (removedProjectIds.length) this.removeProjects(removedProjectIds);
    this.db.prepare('UPDATE removable_drives SET pending_action = NULL WHERE id = ?').run(id);
    return { drive: this.get(id), removedProjectIds };
  }

  removeProjects(ids) {
    const placeholders = ids.map(() => '?').join(',');
    const hashes = new Set(this.db.prepare(`SELECT DISTINCT sf.content_hash FROM snapshot_files sf
      JOIN snapshots s ON s.id = sf.snapshot_id WHERE s.project_id IN (${placeholders})`).all(...ids).map(row => row.content_hash));
    for (const row of this.db.prepare(`SELECT proposal_json FROM agent_executions WHERE project_id IN (${placeholders})`).all(...ids)) {
      const proposal = JSON.parse(row.proposal_json);
      if (/^[a-f0-9]{64}$/.test(proposal.contentHashAfter ?? '')) hashes.add(proposal.contentHashAfter);
    }
    for (const id of ids) this.timeline.unwatchProject(id);
    // Explicit deletion is the sole exception to immutable history. Drop only
    // deletion guards inside this transaction and restore them before commit.
    // Other projects' references still enforce FKs and cause a full rollback.
    try {
      transaction(this.db, () => {
        this.db.exec('PRAGMA defer_foreign_keys = ON');
        const guards = this.db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
          AND name LIKE '%_immutable_delete'`).all();
        for (const guard of guards) this.db.exec(`DROP TRIGGER "${guard.name.replaceAll('"', '""')}"`);
        // Carried-forward history refers to snapshots without cascading.
        for (const table of ['snapshot_object_indexes', 'object_index_bases', 'scientific_object_removals', 'object_changes',
          'snapshot_index_summaries', 'snapshot_index_files']) {
          this.db.prepare(`DELETE FROM ${table} WHERE snapshot_id IN
            (SELECT id FROM snapshots WHERE project_id IN (${placeholders}))`).run(...ids);
        }
        this.db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).run(...ids);
        for (const guard of guards) this.db.exec(guard.sql);
      });
    } catch (error) {
      if (error.message.includes('FOREIGN KEY')) throw new HttpError(409,
        'Other projects still reference these sources. Keep the indexes until those references are removed.');
      throw error;
    }
    this.timeline.notifyCapture({ changed: false, removedProjectIds: ids });
    for (const cache of ['completionCorpusCache', 'studyVariableCache', 'workspaceRetrievalCache', 'sourceTextCache', 'figurePreviewCache']) {
      this.dependencies[cache]?.clear();
    }
    // Content-addressed copies may be shared by unrelated projects. Only
    // release this drive's blobs after checking every surviving reference.
    const proposals = this.db.prepare('SELECT proposal_json FROM agent_executions').all();
    for (const hash of hashes) {
      const used = this.db.prepare(`SELECT 1 FROM snapshot_files WHERE content_hash = ?
        UNION ALL SELECT 1 FROM scientific_object_versions WHERE content_hash = ?
        UNION ALL SELECT 1 FROM document_edit_layer_versions WHERE source_content_hash = ?
        UNION ALL SELECT 1 FROM file_changes WHERE content_hash_before = ? OR content_hash_after = ? LIMIT 1`)
        .get(hash, hash, hash, hash, hash);
      if (!used && !proposals.some(row => row.proposal_json.includes(hash))) {
        // Every stored form goes: the raw bytes, the compressed ones, and any raw copy.
        try { this.timeline.blobs.remove(hash); }
        catch (error) { console.warn('Unable to release unreferenced drive snapshot:', error.message); }
      }
    }
  }
}
