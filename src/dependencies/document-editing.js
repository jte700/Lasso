// The documents a workspace holds as editable text: listing, reading and saving them.

import fs from 'node:fs';
import { HttpError, VersionConflictError } from '../history/errors.js';
import { diffInternals } from '../history/diff.js';
import { extractDocxDocument, extractPdfDocument } from './document-extraction.js';
import { id, posixPath } from './basics.js';
import { anchorForSpan } from './object-descriptors.js';

const EDITABLE_DOCUMENT_TYPES = new Set(['markdown', 'text', 'document', 'pdf']);

function plainDocumentBlocks(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [{ type: 'paragraph', text: '' }];
  const explicit = text.split(/\n\s*\n+/).map((part) => part.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.map((part) => ({ type: 'paragraph', text: part }));
  const sentences = text.match(/[^.!?]+[.!?]+(?:[”’"']+)?|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [text];
  const blocks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > 900) {
      blocks.push({ type: 'paragraph', text: current });
      current = sentence;
    } else current = `${current}${current ? ' ' : ''}${sentence}`;
  }
  if (current) blocks.push({ type: 'paragraph', text: current });
  return blocks;
}

export const documentEditingMethods = {
  documentEditLayer(projectId, projectFileId, snapshotId) {
    const maximumVersion = this.timeline.snapshotRecord(snapshotId).version;
    return this.db.prepare(`
      SELECT layer.*, snapshot.version AS snapshot_version
      FROM document_edit_layer_versions layer
      JOIN snapshots snapshot ON snapshot.id = layer.snapshot_id
      WHERE layer.project_id = ? AND layer.project_file_id = ? AND snapshot.version <= ?
      ORDER BY snapshot.version DESC LIMIT 1
    `).get(projectId, projectFileId, maximumVersion) ?? null;
  },

  extractedEditableContent(file, buffer) {
    if (file.fileType === 'markdown' || file.fileType === 'text') return buffer.toString('utf8');
    if (file.fileType === 'document') return extractDocxDocument(buffer).textExcerpt;
    if (file.fileType === 'pdf') return extractPdfDocument(buffer).textExcerpt;
    return '';
  },

  editableDocumentModel(projectId, file, snapshotId) {
    const buffer = this.timeline.blobs.get(file.contentHash ?? file.content_hash);
    const layer = this.documentEditLayer(projectId, file.projectFileId ?? file.project_file_id, snapshotId);
    const original = this.extractedEditableContent(file, buffer);
    const content = layer?.content ?? original;
    const richLayer = Boolean(layer) || file.fileType === 'markdown';
    return {
      content,
      blocks: richLayer ? diffInternals.markdownBlocks(content) : plainDocumentBlocks(content),
      editLayer: layer ? {
        snapshotId: layer.snapshot_id,
        sourceContentHash: layer.source_content_hash,
        updatedAt: layer.created_at,
      } : null,
      editingMode: ['document', 'pdf'].includes(file.fileType) ? 'TEXT_LAYER' : 'NATIVE_TEXT',
      originalPreserved: ['document', 'pdf'].includes(file.fileType),
    };
  },

  listDocuments(projectId) {
    const project = this.timeline.getProject(projectId);
    const snapshot = this.timeline.getSnapshot(project.currentSnapshotId);
    return snapshot.files.filter((file) => EDITABLE_DOCUMENT_TYPES.has(file.fileType)).map((file) => {
      const audit = this.audit(projectId, { projectFileId: file.projectFileId, reconcile: false });
      const layer = this.documentEditLayer(projectId, file.projectFileId, snapshot.id);
      return {
        path: file.path,
        projectFileId: file.projectFileId,
        fileType: file.fileType,
        size: file.size,
        editingMode: ['document', 'pdf'].includes(file.fileType) ? 'TEXT_LAYER' : 'NATIVE_TEXT',
        hasEditLayer: Boolean(layer),
        ...audit.summary,
      };
    });
  },

  getDocument(projectId, filePath) {
    const project = this.timeline.getProject(projectId);
    this.reconcileProject(projectId);
    const current = this.timeline.getProject(projectId);
    const snapshot = this.timeline.getSnapshot(current.currentSnapshotId);
    const file = this.timeline.snapshotFile(snapshot.id, filePath);
    if (!file || !EDITABLE_DOCUMENT_TYPES.has(file.fileType)) throw new HttpError(404, 'Editable document not found.');
    const model = this.editableDocumentModel(projectId, file, snapshot.id);
    return {
      path: file.path,
      projectFileId: file.projectFileId,
      fileType: file.fileType,
      editingMode: model.editingMode,
      originalPreserved: model.originalPreserved,
      editLayer: model.editLayer,
      snapshotId: snapshot.id,
      version: snapshot.version,
      contentHash: file.contentHash,
      content: model.content,
      blocks: model.blocks,
      dependencies: this.currentDependencies(projectId, { projectFileId: file.projectFileId }),
      audit: this.audit(projectId, { projectFileId: file.projectFileId, reconcile: false }),
    };
  },

  /**
   * Whether a document is exactly as it was when the editor opened `openedAt`.
   * Other files in the folder may change meanwhile; that must not block a save.
   */
  documentUnchangedSince(project, openedAt, relativePath) {
    const opened = this.timeline.snapshotFile(openedAt, relativePath);
    const current = this.timeline.snapshotFile(project.currentSnapshotId, relativePath);
    if (!opened || !current || opened.contentHash !== current.contentHash) return false;
    // DOCX and PDF edits live in a layer; a newer layer is a newer document.
    const openedVersion = this.db.prepare('SELECT version FROM snapshots WHERE id = ? AND project_id = ?')
      .get(openedAt, project.id)?.version;
    if (openedVersion == null) return false;
    const newerLayer = this.db.prepare(`SELECT 1 FROM document_edit_layer_versions v JOIN snapshots s ON s.id = v.snapshot_id
      WHERE v.project_file_id = ? AND s.version > ? LIMIT 1`).get(current.projectFileId, openedVersion);
    return !newerLayer;
  },

  saveDocument(projectId, input, actorInput) {
    this.timeline.drives?.assertOnline(projectId);
    const actor = this.timeline.validateActor(actorInput);
    const project = this.timeline.getProject(projectId);
    const relativePath = posixPath(input.path);
    const requestedBase = input.baseSnapshotId ?? project.currentSnapshotId;
    if (requestedBase !== project.currentSnapshotId && !this.documentUnchangedSince(project, requestedBase, relativePath)) {
      throw new VersionConflictError(requestedBase, project.currentSnapshotId);
    }
    const baseSnapshotId = project.currentSnapshotId;
    const existing = this.timeline.snapshotFile(baseSnapshotId, relativePath);
    if (!existing || !EDITABLE_DOCUMENT_TYPES.has(existing.fileType)) throw new HttpError(400, 'This tracked file is not editable here.');
    const destination = this.timeline.assertWorkingFileUnchanged(project, relativePath, existing.contentHash);
    if (['document', 'pdf'].includes(existing.fileType)) {
      const content = String(input.content ?? '');
      return this.cloneTransition(projectId, actor, {
        source: 'DOCUMENT_CHANGE',
        title: `Edited ${relativePath} without changing the original ${existing.fileType.toUpperCase()}`,
      }, ({ resultingSnapshotId, timestamp, actor }) => {
        this.db.prepare(`
          INSERT INTO document_edit_layer_versions(
            id, project_id, project_file_id, snapshot_id, source_content_hash, source_format,
            content, created_by_actor_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id(), projectId, existing.projectFileId, resultingSnapshotId, existing.contentHash,
          existing.fileType, content, actor.id, timestamp,
        );
      });
    }
    const temporary = `${destination}.lasso-document-${id()}.tmp`;
    fs.writeFileSync(temporary, String(input.content ?? ''), { flag: 'wx' });
    fs.renameSync(temporary, destination);
    return this.timeline.capture(projectId, actor, {
      expectedSnapshotId: baseSnapshotId,
      source: 'DOCUMENT_CHANGE',
    });
  },

  validateAnchor(snapshotId, filePath, anchor, expectedSpan = null) {
    const file = this.timeline.snapshotFile(snapshotId, filePath);
    if (!file || !EDITABLE_DOCUMENT_TYPES.has(file.fileType)) throw new HttpError(400, 'Dependency anchors require an editable document version.');
    if (anchor?.kind !== 'manuscript-span' || !Number.isInteger(anchor.blockIndex)) throw new HttpError(400, 'A stable manuscript span anchor is required.');
    const projectId = this.timeline.snapshotRecord(snapshotId).projectId;
    const blocks = this.editableDocumentModel(projectId, file, snapshotId).blocks;
    const block = blocks[anchor.blockIndex];
    if (!block) throw new HttpError(400, 'The anchored paragraph is not present in this document version.');
    const span = block.text.slice(anchor.start, anchor.end);
    if (!span || (expectedSpan != null && span !== expectedSpan)) throw new HttpError(409, 'The selected text no longer matches its document anchor.');
    return { file, block, span, anchor: anchorForSpan(anchor.blockIndex, block.type, block.text, anchor.start, anchor.end) };
  },
};
