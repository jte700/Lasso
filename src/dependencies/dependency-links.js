// Linking a span of writing to a source, and reading the recorded links back.

import { json } from '../db.js';
import { normalizeActor } from '../history/service.js';
import { HttpError, VersionConflictError } from '../history/errors.js';
import { id, now } from './basics.js';

const SELECTION_METHODS = new Set(['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL', 'SYSTEM_LINKED', 'IMPORTED']);

export const dependencyLinksMethods = {
  cloneTransition(projectId, actorInput, { source, title, initiatedBy = null }, callback) {
    const project = this.timeline.getProject(projectId);
    const previous = this.timeline.getSnapshot(project.currentSnapshotId);
    const actor = normalizeActor(actorInput, source === 'DEPENDENCY_STALE' ? 'SYSTEM' : 'HUMAN_SELF');
    const resultingSnapshotId = id();
    const eventId = id();
    const timestamp = now();
    this.timeline.files.transaction(resultingSnapshotId, () => {
      const current = this.db.prepare('SELECT current_snapshot_id FROM projects WHERE id = ?').get(projectId);
      if (current.current_snapshot_id !== previous.id) throw new VersionConflictError(previous.id, current.current_snapshot_id);
      this.timeline.upsertActor(actor);
      let initiator = null;
      if (initiatedBy) { initiator = normalizeActor(initiatedBy); this.timeline.upsertActor(initiator); }
      // The files are unchanged, so the new version carries all of them forward.
      const filesBase = this.timeline.files.baseFor(previous.id);
      this.db.prepare(`
        INSERT INTO snapshots(id, project_id, version, parent_snapshot_id, manifest_hash, created_at, files_base_snapshot_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(resultingSnapshotId, projectId, previous.version + 1, previous.id, previous.manifestHash, timestamp, filesBase);
      this.timeline.files.write(resultingSnapshotId, previous.files, filesBase);
      this.db.prepare(`
        INSERT INTO timeline_events(id, project_id, previous_snapshot_id, resulting_snapshot_id, actor_id, initiated_by_actor_id, occurred_at, source, title)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, projectId, previous.id, resultingSnapshotId, actor.id, initiator?.id ?? null, timestamp, source, title);
      callback({ previous, resultingSnapshotId, eventId, timestamp, actor });
      this.db.prepare('UPDATE projects SET current_snapshot_id = ? WHERE id = ?').run(resultingSnapshotId, projectId);
    });
    return { snapshot: this.timeline.getSnapshot(resultingSnapshotId), event: this.timeline.getEvent(eventId) };
  },

  link(projectId, input, actorInput) {
    const project = this.timeline.getProject(projectId);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    this.ensureIndex(projectId, project.currentSnapshotId);
    const anchored = this.validateAnchor(project.currentSnapshotId, input.documentPath, input.anchor, input.spanText);
    const object = this.sourceVersion(input.sourceObjectId, input.sourceSnapshotId, {
      destinationProjectId: projectId, newLink: true,
    });
    if (!object) throw new HttpError(404, 'The selected scientific object does not exist in that project version.');
    const method = SELECTION_METHODS.has(input.selectionMethod) ? input.selectionMethod : 'MANUAL';
    const dependencyId = id();
    const result = this.cloneTransition(projectId, actorInput, {
      source: 'DEPENDENCY_LINKED', title: `Linked “${anchored.span.slice(0, 64)}” to ${object.label}`,
      initiatedBy: input.initiatedBy,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      const versionId = id();
      this.db.prepare('INSERT INTO claim_dependencies(id, project_id, document_project_file_id, created_at) VALUES (?, ?, ?, ?)')
        .run(dependencyId, projectId, anchored.file.projectFileId, timestamp);
      this.db.prepare(`
        INSERT INTO claim_dependency_versions(
          id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
          source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
          status_details_json, created_by_actor_id, created_at, is_removed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINKED', '{}', ?, ?, 0)
      `).run(
        versionId, dependencyId, resultingSnapshotId, resultingSnapshotId, input.documentPath,
        JSON.stringify(anchored.anchor), anchored.span, object.object_id, object.snapshot_id, object.value_text,
        method, input.confidence ?? null, actor.id, timestamp,
      );
      this.db.prepare(`
        INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
        VALUES (?, ?, ?, NULL, ?, 'DEPENDENCY_LINKED', ?)
      `).run(id(), eventId, dependencyId, versionId, JSON.stringify({ sourceLabel: object.label, sourceType: object.object_type }));
      this.db.prepare(`
        INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
          to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
      `).run(
        id(), projectId, resultingSnapshotId, input.documentPath, JSON.stringify(anchored.anchor),
        object.snapshot_id, object.path, object.anchor_json,
        JSON.stringify({ dependencyId, objectId: object.object_id, objectType: object.object_type, label: object.label, value: object.value_text }),
        eventId, timestamp,
      );
      if (['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL'].includes(method)
        && ['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(actor.actorType)) {
        this.recordRecommendationUsage(object.project_id, {
          objectId: object.object_id, kind: 'accept', sessionId: input.sessionId,
          documentPath: object.project_id === projectId ? input.documentPath : null,
        }, { allowMissingSource: true });
      }
    });
    return { dependency: this.getDependency(dependencyId), ...result };
  },

  linkMany(projectId, input, actorInput) {
    const project = this.timeline.getProject(projectId);
    if (input.expectedSnapshotId && input.expectedSnapshotId !== project.currentSnapshotId) {
      throw new VersionConflictError(input.expectedSnapshotId, project.currentSnapshotId);
    }
    const links = Array.isArray(input.links) ? input.links.slice(0, 50) : [];
    if (!links.length) throw new HttpError(400, 'At least one dependency link is required.');
    this.ensureIndex(projectId, project.currentSnapshotId);
    const prepared = links.map((link) => {
      const anchored = this.validateAnchor(project.currentSnapshotId, link.documentPath, link.anchor, link.spanText);
      const object = this.sourceVersion(link.sourceObjectId, link.sourceSnapshotId, {
        destinationProjectId: projectId, newLink: true,
      });
      if (!object) throw new HttpError(404, 'A selected scientific object does not exist in that project version.');
      return {
        input: link,
        anchored,
        object,
        method: SELECTION_METHODS.has(link.selectionMethod) ? link.selectionMethod : 'MANUAL',
        dependencyId: id(),
      };
    });
    const title = prepared.length === 1
      ? `Linked “${prepared[0].anchored.span.slice(0, 64)}” to ${prepared[0].object.label}`
      : `Linked ${prepared.length} manuscript dependencies`;
    const result = this.cloneTransition(projectId, actorInput, {
      source: 'DEPENDENCY_LINKED', title, initiatedBy: input.initiatedBy,
    }, ({ resultingSnapshotId, eventId, timestamp, actor }) => {
      for (const item of prepared) {
        const versionId = id();
        this.db.prepare('INSERT INTO claim_dependencies(id, project_id, document_project_file_id, created_at) VALUES (?, ?, ?, ?)')
          .run(item.dependencyId, projectId, item.anchored.file.projectFileId, timestamp);
        this.db.prepare(`
          INSERT INTO claim_dependency_versions(
            id, dependency_id, snapshot_id, document_snapshot_id, document_path, document_anchor_json, span_text,
            source_object_id, source_snapshot_id, source_value_text, selection_method, confidence, status,
            status_details_json, created_by_actor_id, created_at, is_removed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINKED', '{}', ?, ?, 0)
        `).run(
          versionId, item.dependencyId, resultingSnapshotId, resultingSnapshotId, item.input.documentPath,
          JSON.stringify(item.anchored.anchor), item.anchored.span, item.object.object_id, item.object.snapshot_id,
          item.object.value_text, item.method, item.input.confidence ?? null, actor.id, timestamp,
        );
        this.db.prepare(`
          INSERT INTO dependency_changes(id, event_id, dependency_id, before_version_id, after_version_id, change_type, details_json)
          VALUES (?, ?, ?, NULL, ?, 'DEPENDENCY_LINKED', ?)
        `).run(id(), eventId, item.dependencyId, versionId,
          JSON.stringify({ sourceLabel: item.object.label, sourceType: item.object.object_type }));
        this.db.prepare(`
          INSERT INTO provenance_links(id, project_id, from_snapshot_id, from_path, from_anchor_json, relation,
            to_snapshot_id, to_path, to_anchor_json, metadata_json, created_by_event_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'DEPENDS_ON', ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, resultingSnapshotId, item.input.documentPath, JSON.stringify(item.anchored.anchor),
          item.object.snapshot_id, item.object.path, item.object.anchor_json,
          JSON.stringify({
            dependencyId: item.dependencyId, objectId: item.object.object_id,
            objectType: item.object.object_type, label: item.object.label, value: item.object.value_text,
          }),
          eventId, timestamp,
        );
        if (['AUTOCOMPLETE', 'PREDICTED_ACCEPTED', 'MANUAL'].includes(item.method)
          && ['HUMAN_SELF', 'HUMAN_COLLABORATOR'].includes(actor.actorType)) {
          this.recordRecommendationUsage(item.object.project_id, {
            objectId: item.object.object_id, kind: 'accept', sessionId: input.sessionId,
            documentPath: item.object.project_id === projectId ? item.input.documentPath : null,
          }, { allowMissingSource: true });
        }
      }
    });
    return { dependencies: prepared.map((item) => this.getDependency(item.dependencyId)), ...result };
  },

  latestVersionRow(dependencyId, maximumProjectVersion = null) {
    const versions = this.db.prepare(`
      SELECT v.*, s.version AS project_version, a.display_name AS actor_name, a.actor_type,
        origin_v.created_by_actor_id AS linked_by_actor_id,
        origin_a.display_name AS linked_by_actor_name, origin_a.actor_type AS linked_by_actor_type,
        o.object_type, o.object_key, o.project_id AS source_project_id
      FROM claim_dependency_versions v
      JOIN snapshots s ON s.id = v.snapshot_id
      JOIN actors a ON a.id = v.created_by_actor_id
      JOIN claim_dependency_versions origin_v ON origin_v.id = (
        SELECT first_v.id FROM claim_dependency_versions first_v
        WHERE first_v.dependency_id = v.dependency_id
        ORDER BY first_v.created_at, first_v.rowid LIMIT 1
      )
      JOIN actors origin_a ON origin_a.id = origin_v.created_by_actor_id
      JOIN scientific_objects o ON o.id = v.source_object_id
      WHERE v.dependency_id = ? AND (? IS NULL OR s.version <= ?)
      ORDER BY s.version DESC
    `).iterate(dependencyId, maximumProjectVersion, maximumProjectVersion);
    // The newest version whose source resolves at the snapshot it was linked from.
    for (const row of versions) {
      const source = this.timeline.objectVersions.at(row.source_snapshot_id, row.source_object_id);
      if (!source) continue;
      return {
        ...row, source_path: source.path, source_anchor_json: source.anchor_json, source_label: source.label,
        source_metadata_json: source.metadata_json, source_content_hash: source.content_hash,
      };
    }
    return null;
  },

  mapDependency(row) {
    if (!row) return null;
    return {
      id: row.dependency_id,
      versionId: row.id,
      projectVersion: row.project_version,
      snapshotId: row.snapshot_id,
      documentSnapshotId: row.document_snapshot_id,
      documentPath: row.document_path,
      anchor: json(row.document_anchor_json, {}),
      spanText: row.span_text,
      selectionMethod: row.selection_method,
      confidence: row.confidence,
      status: row.status,
      statusDetails: json(row.status_details_json, {}),
      removed: Boolean(row.is_removed),
      createdAt: row.created_at,
      createdBy: { id: row.created_by_actor_id, displayName: row.actor_name, actorType: row.actor_type },
      linkedBy: {
        id: row.linked_by_actor_id,
        displayName: row.linked_by_actor_name,
        actorType: row.linked_by_actor_type,
      },
      source: {
        id: row.source_object_id,
        projectId: row.source_project_id,
        objectKey: row.object_key,
        objectType: row.object_type,
        snapshotId: row.source_snapshot_id,
        path: row.source_path,
        anchor: json(row.source_anchor_json, null),
        label: row.source_label,
        valueText: row.source_value_text,
        contentHash: row.source_content_hash,
        metadata: json(row.source_metadata_json, {}),
      },
    };
  },

  getDependency(dependencyId, maximumProjectVersion = null) {
    const row = this.latestVersionRow(dependencyId, maximumProjectVersion);
    if (!row) throw new HttpError(404, 'Claim dependency not found.');
    const dependency = this.mapDependency(row);
    const projectId = this.db.prepare('SELECT project_id FROM claim_dependencies WHERE id = ?').get(dependencyId).project_id;
    dependency.source = this.enrichObject(projectId, dependency.source);
    return dependency;
  },

  currentDependencies(projectId, options = {}) {
    const project = this.timeline.getProject(projectId);
    const snapshot = this.db.prepare('SELECT version, project_id FROM snapshots WHERE id = ?')
      .get(options.snapshotId ?? project.currentSnapshotId);
    if (!snapshot) throw new HttpError(404, 'Snapshot not found.');
    if (snapshot.project_id !== projectId) throw new HttpError(400, 'Snapshot does not belong to this project.');
    const maximum = snapshot.version;
    const ids = this.db.prepare(`
      SELECT d.id FROM claim_dependencies d
      WHERE d.project_id = ? AND (? IS NULL OR d.document_project_file_id = ?)
      ORDER BY d.created_at
    `).all(projectId, options.projectFileId ?? null, options.projectFileId ?? null);
    return ids.map(({ id: dependencyId }) => this.mapDependency(this.latestVersionRow(dependencyId, maximum)))
      .filter((dependency) => dependency && !dependency.removed);
  },

  findForSelection(projectId, { projectFileId, snapshotId, anchor }) {
    const dependencies = this.currentDependencies(projectId, { projectFileId, snapshotId });
    return dependencies.find((dependency) => {
      if (dependency.anchor.blockIndex !== anchor.blockIndex) return false;
      const selection = anchor.selection ?? { start: anchor.start, end: anchor.end };
      const start = selection?.start ?? 0;
      const end = selection?.end ?? Number.MAX_SAFE_INTEGER;
      return dependency.anchor.start < end && dependency.anchor.end > start;
    }) ?? null;
  },
};
