import crypto from 'node:crypto';
import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { MARKDOWN_LAYOUT, isMarkdownPath } from './markdown.js';
import { csvDelimiter } from '../history/diff.js';
import { correctedDocumentLabel } from '../dependencies/authors.js';
import { shareExpiry } from './expiry.js';

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
};

function now() {
  return new Date().toISOString();
}

/// Column letter for a zero-based spreadsheet column index.
function columnLetter(index) {
  let value = '';
  let remaining = index;
  while (remaining >= 0) {
    value = String.fromCharCode(65 + (remaining % 26)) + value;
    remaining = Math.floor(remaining / 26) - 1;
  }
  return value;
}

/**
 * Externally shareable source objects.
 *
 * A grant is an opaque bearer token that resolves to exactly one pinned object
 * version. Tokens are never derived from database identifiers, resolution is an
 * exact token match, and the real filesystem path is never exposed.
 */
export class ObjectShareService {
  constructor(db, timeline, config) {
    this.db = db;
    this.timeline = timeline;
    this.config = config;
  }

  /// 192 bits of CSPRNG output, URL-safe.
  static generateToken() {
    return crypto.randomBytes(24).toString('base64url');
  }

  baseUrl() {
    return this.config.shareBaseUrl ?? `http://localhost:${this.config.port}`;
  }

  shareUrl(token) {
    return `${this.baseUrl().replace(/\/+$/, '')}/d/${token}`;
  }

  /**
   * Creates a share for one indexed object version. The version is pinned so the
   * recipient always sees the source as it was at the moment of sharing.
   */
  createShare({ projectId, objectId, versionId, actor, expiresAt = null,
    accessScope = "DOCUMENT", redactions = [], excerpt = null }) {
    if (!projectId) throw new HttpError(400, 'A project is required to share a source.');
    if (!objectId) throw new HttpError(400, 'An indexed object is required to share a source.');
    const normalizedScope = normalizeShareScope(accessScope);
    const normalizedRedactions = normalizeRedactions(redactions, normalizedScope);
    const normalizedExcerpt = normalizePdfExcerpt(excerpt, normalizedScope);

    const version = this.pinnedVersion(objectId, versionId);

    if (!version) throw new HttpError(404, 'That indexed source version was not found.');
    if (version.project_id !== projectId) throw new HttpError(404, 'That indexed source version was not found.');
    const isDrawing = /\.(?:ifc|dxf)$/i.test(version.path ?? '');
    const isPdf = /\.pdf$/i.test(version.path ?? '');
    if ((normalizedExcerpt || normalizedRedactions.some(entry => entry.kind === 'PDF')) && !isPdf) {
      throw new HttpError(400, 'PDF selections can only be shared from PDF documents.');
    }
    if (isPdf && normalizedRedactions.some(entry => entry.kind === 'PDF')
        && normalizedRedactions.some(entry => entry.kind !== 'PDF')) {
      throw new HttpError(400, 'PDF region redactions cannot be mixed with text section redactions.');
    }
    if (normalizedRedactions.some(entry => entry.kind === 'DRAWING') && !isDrawing) {
      throw new HttpError(400, 'Drawing regions can only redact DXF or IFC drawing previews.');
    }
    if (isDrawing && normalizedScope === 'REDACTED' && normalizedRedactions.some(entry => entry.kind !== 'DRAWING')) {
      throw new HttpError(400, 'Select drawing regions to redact this source.');
    }

    // Markdown text redactions address structured sections. The layout is
    // recorded so the stored indexes cannot drift to a different segmentation.
    let storedRedactions = isMarkdownPath(version.path)
      ? normalizedRedactions.map(entry => entry.kind === 'BLOCK' ? { ...entry, layout: MARKDOWN_LAYOUT } : entry)
      : normalizedRedactions;
    // Cells of a semicolon file are addressed in its semicolon columns.
    // Unmarked cell redactions keep the comma reading they were made with.
    if (/\.csv$/i.test(version.path ?? '') && storedRedactions.some(entry => entry.kind === 'CELL')) {
      const file = this.timeline.snapshotFile(version.snapshot_id, version.path);
      const content = file ? this.timeline.blobs.get(file.contentHash) : null;
      if (content && csvDelimiter(content.toString('utf8')) === ';') {
        storedRedactions = storedRedactions.map(entry => entry.kind === 'CELL' ? { ...entry, delimiter: ';' } : entry);
      }
    }

    const normalizedActor = actor?.id ? actor : { id: 'human-self:local', displayName: 'Local user', actorType: 'HUMAN_SELF' };
    this.timeline.upsertActor(normalizedActor);

    const token = ObjectShareService.generateToken();
    const record = {
      id: crypto.randomUUID(),
      token,
      createdAt: now(),
      expiresAt: shareExpiry(expiresAt),
    };
    this.db.prepare(`
      INSERT INTO object_share_grants(
        id, project_id, object_id, object_version_id, token,
        created_by_actor_id, created_at, expires_at, revoked_at, access_scope, redactions_json, excerpt_json, snapshot_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(record.id, projectId, objectId, version.id, token,
      normalizedActor.id, record.createdAt, record.expiresAt, normalizedScope,
      JSON.stringify(storedRedactions), normalizedExcerpt ? JSON.stringify(normalizedExcerpt) : null, version.snapshot_id);

    return {
      id: record.id,
      token,
      url: this.shareUrl(token),
      label: version.label,
      valueText: version.value_text,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      accessScope: normalizedScope,
      redactions: storedRedactions,
      excerpt: normalizedExcerpt,
    };
  }

  /**
   * The version a share or the inspector shows, with the snapshot it is shown
   * at: a pinned version at the folder's current snapshot while it is still
   * current there, or else where it was recorded; with no pin, the latest.
   */
  pinnedVersion(objectId, versionId) {
    const versions = this.timeline.objectVersions;
    if (!versionId) return versions.latest(objectId);
    const version = versions.versionById(versionId);
    if (!version || version.object_id !== objectId) return null;
    const snapshotId = versions.currentSnapshotOf(version);
    return { ...version, snapshot_id: snapshotId, snapshot_version: versions.snapshotVersion(snapshotId) };
  }

  /**
   * Describes one indexed object version directly, with no share involved.
   * Used by the local source inspector, which is not a published surface.
   */
  describe(objectId, versionId = null) {
    const version = this.pinnedVersion(objectId, versionId);
    if (!version) return { status: 'NOT_FOUND' };
    const rootPath = this.db.prepare('SELECT root_path FROM projects WHERE id = ?').get(version.project_id).root_path;

    const anchor = version.anchor_json ? JSON.parse(version.anchor_json) : {};
    const metadata = version.metadata_json ? JSON.parse(version.metadata_json) : {};
    return {
      status: 'OK',
      source: {
        label: correctedDocumentLabel(version.object_type, version.label, metadata),
        valueText: version.value_text,
        objectType: version.object_type,
        filename: path.basename(version.path),
        absolutePath: path.resolve(rootPath, version.path),
        snapshotVersion: version.snapshot_version,
        location: this.describeLocation(anchor, metadata),
        context: this.describeContext(anchor, metadata),
        anchor,
        metadata,
      },
      internal: { snapshotId: version.snapshot_id, filePath: version.path, versionId: version.id },
    };
  }

  /**
   * Resolves a token to its pinned source. Returns a status rather than throwing
   * so callers can distinguish missing, revoked and expired without leaking
   * whether other tokens exist.
   */
  resolveShare(token) {
    if (typeof token !== 'string' || !token) return { status: 'NOT_FOUND' };
    const grant = this.db.prepare('SELECT * FROM object_share_grants WHERE token = ?').get(token);
    if (!grant) return { status: 'NOT_FOUND' };
    if (grant.revoked_at) return { status: 'REVOKED' };
    if (grant.expires_at && new Date(grant.expires_at).getTime() <= Date.now()) return { status: 'EXPIRED' };

    // A share stays at the snapshot it was made from. Shares made before
    // versions were carried forward use the snapshot their version recorded.
    const version = this.db.prepare(`
      SELECT v.*, o.object_type, s.id AS shared_snapshot_id, s.version AS snapshot_version
      FROM scientific_object_versions v
      JOIN scientific_objects o ON o.id = v.object_id
      JOIN snapshots s ON s.id = COALESCE(?, v.snapshot_id)
      WHERE v.id = ?
    `).get(grant.snapshot_id, grant.object_version_id);
    if (!version) return { status: 'NOT_FOUND' };

    const anchor = version.anchor_json ? JSON.parse(version.anchor_json) : {};
    const metadata = version.metadata_json ? JSON.parse(version.metadata_json) : {};

    return {
      status: 'OK',
      share: {
        id: grant.id,
        token: grant.token,
        createdAt: grant.created_at,
        expiresAt: grant.expires_at,
        accessScope: grant.access_scope ?? 'DOCUMENT',
        redactions: JSON.parse(grant.redactions_json ?? '[]'),
        excerpt: grant.excerpt_json ? JSON.parse(grant.excerpt_json) : null,
      },
      source: {
        label: correctedDocumentLabel(version.object_type, version.label, metadata),
        valueText: version.value_text,
        objectType: version.object_type,
        // Only the file's own name is ever published, never its location.
        filename: path.basename(version.path),
        snapshotVersion: version.snapshot_version,
        location: this.describeLocation(anchor, metadata),
        context: this.describeContext(anchor, metadata),
        anchor,
        metadata,
      },
      // Internal only: never serialized to the client.
      internal: { snapshotId: version.shared_snapshot_id, filePath: version.path },
    };
  }

  /// Human-readable position inside the source, e.g. "Accounting!B17".
  describeLocation(anchor = {}, metadata = {}) {
    if (anchor.kind === 'cad-property') {
      return [metadata.storey ?? anchor.layer,
        metadata.roomNumber ?? anchor.stepId ?? anchor.elementId,
        anchor.propertyName ?? metadata.propertyName].filter(Boolean).join(' · ') || 'Model property';
    }
    if (anchor.kind === 'cad-model') return 'Model overview';
    const sheet = anchor.sheet ?? metadata.sheet ?? null;
    if (Number.isInteger(anchor.rowIndex) && Number.isInteger(anchor.columnIndex)) {
      const cell = `${columnLetter(anchor.columnIndex)}${anchor.rowIndex + 1}`;
      return sheet ? `${sheet}!${cell}` : cell;
    }
    if (Number.isInteger(anchor.rowIndex)) {
      const row = `row ${anchor.rowIndex + 1}`;
      return sheet ? `${sheet} · ${row}` : row;
    }
    if (Number.isInteger(anchor.columnIndex)) {
      const column = `Column ${columnLetter(anchor.columnIndex)}`;
      return sheet ? `${sheet} · ${column}` : column;
    }
    if (Number.isInteger(anchor.pageNumber)) return `Page ${anchor.pageNumber}`;
    if (Number.isInteger(anchor.lineStart)) {
      return anchor.lineEnd && anchor.lineEnd !== anchor.lineStart
        ? `lines ${anchor.lineStart}–${anchor.lineEnd}`
        : `line ${anchor.lineStart}`;
    }
    if (anchor.rowKey) return sheet ? `${sheet} · ${anchor.rowKey}` : String(anchor.rowKey);
    return sheet ?? '—';
  }

  describeContext(anchor = {}, metadata = {}) {
    const parts = [metadata.dataset ?? null, anchor.sheet ?? metadata.sheet ?? null,
      metadata.variable ?? anchor.rowKey ?? null].filter(Boolean);
    return parts.length ? [...new Set(parts)].join(' › ') : '—';
  }

  /**
   * The pinned source file. Resolution is by snapshot and recorded path only, so
   * a token can never reach a file that is not its registered source.
   */
  sourceFile(token) {
    const resolved = this.resolveShare(token);
    if (resolved.status !== 'OK') return resolved;
    if (resolved.share.accessScope !== 'DOCUMENT') return { status: 'SCOPE_RESTRICTED' };
    const file = this.timeline.snapshotFile(resolved.internal.snapshotId, resolved.internal.filePath);
    if (!file) return { status: 'SOURCE_MISSING' };
    // Content is content-addressed; the snapshot row only carries its hash.
    const content = this.timeline.blobs.get(file.contentHash);
    if (!content) return { status: 'SOURCE_MISSING' };
    const extension = path.extname(file.path).toLowerCase();
    return {
      status: 'OK',
      filename: path.posix.basename(file.path),
      contentType: MIME_TYPES[extension] ?? 'application/octet-stream',
      content,
    };
  }

  revokeShare(token) {
    const result = this.db.prepare('UPDATE object_share_grants SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
      .run(now(), token);
    if (!result.changes) throw new HttpError(404, 'Share not found.');
    return { revoked: true };
  }

  revokeShareById(id) {
    const result = this.db.prepare('UPDATE object_share_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(now(), id);
    if (!result.changes) throw new HttpError(404, 'Share not found.');
    return { revoked: true };
  }

  listShares(projectId) {
    return this.db.prepare(`
      SELECT g.id, g.token, g.created_at, g.expires_at, g.revoked_at, g.access_scope, g.redactions_json, g.excerpt_json, v.label, v.value_text
      FROM object_share_grants g
      JOIN scientific_object_versions v ON v.id = g.object_version_id
      WHERE g.project_id = ?
      ORDER BY g.created_at DESC
    `).all(projectId).map((row) => ({
      id: row.id,
      token: row.token,
      url: this.shareUrl(row.token),
      label: row.label,
      valueText: row.value_text,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      accessScope: row.access_scope ?? 'DOCUMENT',
      redactions: JSON.parse(row.redactions_json ?? '[]'),
      excerpt: row.excerpt_json ? JSON.parse(row.excerpt_json) : null,
    }));
  }
}
const SHARE_SCOPES = new Set(['DOCUMENT', 'INDEXED', 'REDACTED']);
const REDACTION_KINDS = new Set(['CELL', 'BLOCK', 'DRAWING', 'PDF']);
const REDACTION_EFFECTS = new Set(['BLUR', 'BLANK']);

function normalizeShareScope(value) {
  const scope = String(value ?? 'DOCUMENT').toUpperCase();
  if (!SHARE_SCOPES.has(scope)) throw new HttpError(400, 'Unknown share access scope.');
  return scope;
}

export function normalizeRedactions(value, scope) {
  if (scope !== 'REDACTED') return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'Redactions must be a list.');
  if (value.length > 512) throw new HttpError(400, 'Too many redactions.');
  const normalized = [];
  const seen = new Set();
  for (const entry of value) {
    const kind = String(entry?.kind ?? '').toUpperCase();
    const effect = String(entry?.effect ?? 'BLUR').toUpperCase();
    if (!REDACTION_KINDS.has(kind) || !REDACTION_EFFECTS.has(effect)) {
      throw new HttpError(400, 'Invalid redaction.');
    }
    let target;
    if (kind === 'DRAWING' || kind === 'PDF') {
      const { x, y, width, height } = entry;
      if (![x, y, width, height].every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))
          || x < 0 || y < 0 || width <= 0 || height <= 0
          || x + width > 1 || y + height > 1) {
        throw new HttpError(400, `Invalid ${kind === 'PDF' ? 'PDF' : 'drawing'} redaction region.`);
      }
      const page = Number(entry.page);
      if (kind === 'PDF' && (!Number.isInteger(page) || page < 1 || page > 1000)) throw new HttpError(400, 'Invalid PDF redaction page.');
      target = { kind, ...(kind === 'PDF' ? { page } : {}), x, y, width, height, effect };
    } else if (kind === 'CELL') {
      const sheet = entry.sheet == null ? 0 : Number(entry.sheet);
      const row = Number(entry.row);
      const column = Number(entry.column);
      if (!Number.isInteger(sheet) || sheet < 0 || sheet > 99
          || !Number.isInteger(row) || row < 0 || row > 9999
          || !Number.isInteger(column) || column < 0 || column > 999) {
        throw new HttpError(400, 'Invalid cell redaction.');
      }
      target = { kind, sheet, row, column, effect };
    } else {
      const block = Number(entry.block);
      if (!Number.isInteger(block) || block < 0 || block > 9999) {
        throw new HttpError(400, 'Invalid text redaction.');
      }
      target = { kind, block, effect };
    }
    const key = JSON.stringify(target);
    if (!seen.has(key)) { seen.add(key); normalized.push(target); }
  }
  if (normalized.filter(entry => entry.kind === 'DRAWING').length > 64) throw new HttpError(400, 'Select no more than 64 drawing regions.');
  if (!normalized.length) throw new HttpError(400, 'Select at least one area to redact.');
  return normalized;
}

export function normalizePdfExcerpt(value, scope) {
  if (value == null || scope !== 'INDEXED') return null;
  if (String(value.kind ?? '').toUpperCase() !== 'PDF') throw new HttpError(400, 'Invalid PDF excerpt.');
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  if (text.length > 100_000 || !Array.isArray(value.regions ?? [])) throw new HttpError(400, 'Invalid PDF excerpt.');
  const regions = value.regions ?? [];
  if (regions.length > 512) throw new HttpError(400, 'Too many PDF selection regions.');
  const normalized = regions.map(region => {
    if (!region || typeof region !== 'object') throw new HttpError(400, 'Invalid PDF selection region.');
    const { x, y, width, height } = region;
    const page = Number(region.page);
    if (!Number.isInteger(page) || page < 1 || page > 1000
        || ![x, y, width, height].every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate))
        || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
      throw new HttpError(400, 'Invalid PDF selection region.');
    }
    return { page, x, y, width, height };
  });
  if (!text && !normalized.length) throw new HttpError(400, 'Select text or an area from the PDF before sharing.');
  const page = value.page == null ? null : Number(value.page);
  if (page != null && (!Number.isInteger(page) || page < 1 || page > 1000)) throw new HttpError(400, 'Invalid PDF selection page.');
  return { kind: 'PDF', text, regions: normalized, ...(page ? { page } : {}) };
}
