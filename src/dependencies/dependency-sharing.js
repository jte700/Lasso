// Sharing a linked source: grants, their settings, and what a recipient sees.

import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeActor } from '../history/service.js';
import { HttpError } from '../history/errors.js';
import { parseDelimited } from '../history/diff.js';
import { extractDocxDocument, extractPdfFullText, extractSpreadsheetTables } from './document-extraction.js';
import { originalFindingSentence } from './completion.js';
import { shareExpiry } from '../sharing/expiry.js';
import { drawingContext } from './drawing-objects.js';
import { spreadsheetLayout, tabularLayout } from './tabular.js';
import { isCodePath } from '../history/file-types.js';
import { id, now } from './basics.js';
import { semanticDependencySource } from './row-field-match.js';

export const dependencySharingMethods = {
  activeShareGrants(dependencyId) {
    return this.db.prepare(`
      SELECT grant_row.*, actor.display_name AS created_by_name
      FROM dependency_share_grants grant_row
      JOIN actors actor ON actor.id = grant_row.created_by_actor_id
      WHERE grant_row.dependency_id = ? AND grant_row.revoked_at IS NULL
        AND (grant_row.expires_at IS NULL OR grant_row.expires_at > ?)
      ORDER BY grant_row.created_at DESC
    `).all(dependencyId, now()).map((row) => ({
      id: row.id,
      token: row.token,
      scope: row.access_scope,
      recipientLabel: row.recipient_label,
      contextRadius: row.context_radius,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      createdBy: row.created_by_name,
      url: `/?share=${encodeURIComponent(row.token)}`,
    }));
  },

  dependencyShareSettings(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    return {
      dependency: {
        id: dependency.id,
        spanText: dependency.spanText,
        source,
      },
      recommendedScope: 'CONTEXT',
      grants: this.activeShareGrants(dependencyId),
    };
  },

  configureDependencyShare(dependencyId, input, actorInput) {
    this.getDependency(dependencyId);
    const actor = normalizeActor(actorInput);
    this.timeline.upsertActor(actor);
    const scope = String(input.scope ?? 'CONTEXT').toUpperCase();
    if (scope === 'PRIVATE') {
      this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE dependency_id = ? AND revoked_at IS NULL')
        .run(now(), dependencyId);
      return this.dependencyShareSettings(dependencyId);
    }
    if (!['CONTEXT', 'FULL'].includes(scope)) throw new HttpError(400, 'Share scope must be private, cited context, or full source.');
    if (isCodePath(semanticDependencySource(this.getDependency(dependencyId)).path)) {
      throw new HttpError(422, 'Lasso doesn’t make share links for code files. Send a copy of the file instead.');
    }
    const timestamp = now();
    const token = crypto.randomBytes(24).toString('base64url');
    const parsedRadius = Number(input.contextRadius);
    const contextRadius = Number.isFinite(parsedRadius)
      ? Math.max(0, Math.min(5, parsedRadius))
      : 1;
    const expiresAt = shareExpiry(input.expiresAt, new Date(timestamp));
    this.db.prepare(`
      INSERT INTO dependency_share_grants(
        id, dependency_id, token, access_scope, recipient_label, context_radius,
        created_by_actor_id, created_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id(), dependencyId, token, scope, String(input.recipientLabel ?? '').trim() || null,
      contextRadius, actor.id, timestamp, expiresAt,
    );
    return this.dependencyShareSettings(dependencyId);
  },

  revokeDependencyShare(token) {
    const result = this.db.prepare('UPDATE dependency_share_grants SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
      .run(now(), token);
    if (!result.changes) throw new HttpError(404, 'Share grant not found.');
    return { revoked: true };
  },

  tabularShareContent(file, buffer, anchor, scope, radius) {
    // A large table's share reads its first rows or the rows around the cited one.
    const window = this.tableWindow(file, buffer, anchor ?? {}, scope === 'FULL'
      ? { before: 0, after: 1_000 } : { before: Math.max(radius, 2), after: Math.max(radius, 2) });
    if (window) anchor = window.anchor;
    const table = window ? window.table : file.fileType === 'spreadsheet'
      ? extractSpreadsheetTables(buffer).find((sheet) => !anchor?.sheet || sheet.name === anchor.sheet)
      : {
        name: null,
        rows: parseDelimited(buffer.toString('utf8'), path.extname(file.path).toLowerCase() === '.tsv' ? '\t' : ','),
      };
    if (!table?.rows?.length) return null;
    const layout = file.fileType === 'spreadsheet' || window ? spreadsheetLayout(table) : tabularLayout(table.rows);
    const headers = layout.headers;
    const data = layout.rows;
    const rowReference = anchor?.kind === 'table-row';
    const selectedColumn = rowReference ? -1 : Number.isInteger(anchor?.columnIndex) ? anchor.columnIndex
      : Math.max(0, headers.findIndex((header) => String(header) === String(anchor?.column)));
    let selectedRow = Number.isInteger(anchor?.rowIndex)
      ? (layout.rowNumbers && anchor.rowCoordinate === 'worksheet' ? layout.rowNumbers.indexOf(anchor.rowIndex) : anchor.rowIndex - layout.headerRowIndex - 1) : -1;
    if (selectedRow < 0 || selectedRow >= data.length) {
      selectedRow = data.findIndex((row) => String(row[0] ?? '') === String(anchor?.rowKey ?? ''));
    }
    if (scope === 'FULL') {
      return {
        kind: 'table',
        sheet: table.name,
        headers,
        rows: data.slice(0, 1000),
        selectedRow,
        selectedColumn,
        truncated: data.length > 1000,
      };
    }
    if (rowReference) {
      const row = selectedRow >= 0 && selectedRow < data.length ? data[selectedRow] : null;
      return {
        kind: 'table-context',
        sheet: table.name,
        headers,
        rows: row ? [row] : [],
        selectedRow: row ? 0 : -1,
        selectedColumn: -1,
        contextRadius: radius,
        referenceKind: 'ROW',
      };
    }
    const groupColumns = headers.map((header, index) => /^(?:group|cohort|condition|arm|treatment)$/i.test(String(header)) ? index : -1)
      .filter((index) => index >= 0);
    const columnIndexes = [...new Set([0, ...groupColumns, selectedColumn].filter((index) => index >= 0 && index < headers.length))];
    const start = Math.max(0, selectedRow - radius);
    const end = Math.min(data.length, selectedRow + radius + 1);
    return {
      kind: 'table-context',
      sheet: table.name,
      headers: columnIndexes.map((index) => headers[index]),
      rows: data.slice(start, end).map((row) => columnIndexes.map((index) => row[index] ?? '')),
      selectedRow: selectedRow - start,
      selectedColumn: columnIndexes.indexOf(selectedColumn),
      contextRadius: radius,
    };
  },

  sharedSourceContent(dependency, scope, radius) {
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The shared source version is no longer available.');
    if (source.metadata?.drawing && scope !== 'FULL') return drawingContext(source);
    const buffer = this.timeline.blobs.get(file.contentHash);
    if (['table', 'spreadsheet'].includes(file.fileType)) {
      return this.tabularShareContent(file, buffer, source.anchor ?? {}, scope, radius)
        ?? { kind: 'text', text: source.valueText ?? dependency.spanText };
    }
    let text = '';
    if (['markdown', 'text', 'code', 'yaml', 'json'].includes(file.fileType)) text = buffer.toString('utf8');
    else if (file.fileType === 'document') text = extractDocxDocument(buffer).textExcerpt;
    else if (file.fileType === 'presentation') text = this.fileText(file, source.objectType);
    else if (file.fileType === 'pdf') text = extractPdfFullText(buffer);
    else text = [source.metadata.title, source.metadata.subject, source.valueText]
      .filter(Boolean).join('\n');
    if (scope === 'FULL') return { kind: 'text', text: text.slice(0, 100_000), truncated: text.length > 100_000 };
    if (file.fileType === 'pdf' && source.metadata.componentType === 'PDF_EXCERPT') {
      const selectedText = source.anchor?.selectedText ?? source.metadata.rawText ?? source.valueText ?? '';
      const sourceSentence = originalFindingSentence(selectedText, dependency.spanText);
      return { kind: 'text-context', text: selectedText, citedText: dependency.spanText,
        pageNumber: source.anchor?.pageNumber ?? source.metadata.pageNumber,
        bbox: source.anchor?.bbox ?? null, contextRadius: radius,
        ...(sourceSentence ? { sourceSentence } : {}) };
    }
    // A Markdown or text passage is located by its own recorded offsets.
    if (source.metadata.componentType === 'TEXT_EXCERPT') text = text.replace(/\r\n?/g, '\n');
    const excerptStart = source.metadata.componentType === 'TEXT_EXCERPT' && Number.isInteger(source.anchor?.start)
      && Number.isInteger(source.anchor?.end) && source.anchor.end <= text.length ? source.anchor.start : -1;
    const lower = text.toLowerCase();
    const locate = (value) => {
      const needle = String(value ?? '').trim();
      const index = needle ? lower.indexOf(needle.toLowerCase()) : -1;
      if (index >= 0) return { needle, index };
      if (file.fileType !== 'pdf' || !needle) return null;
      const pattern = needle.split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      const match = text.match(new RegExp(pattern, 'iu'));
      return match ? { needle: match[0], index: match.index } : null;
    };
    let found = locate(dependency.spanText);
    if (excerptStart >= 0 && (!found || found.index < excerptStart || found.index >= source.anchor.end)) {
      found = { needle: text.slice(excerptStart, source.anchor.end), index: excerptStart };
    }
    let sourceSentence = null;
    if (!found && file.fileType === 'pdf' && (['PAPER', 'REFERENCE'].includes(source.objectType)
      || source.metadata.componentType === 'PDF_EXCERPT')) {
      const sentence = originalFindingSentence(text.replace(/\s*\n\s*/g, ' '), dependency.spanText);
      const original = locate(sentence);
      if (original) { sourceSentence = sentence; found = original; }
    }
    found ??= locate(source.valueText) ?? locate(source.metadata.title);
    const center = found ? found.index + Math.floor(found.needle.length / 2) : 0;
    const contextSize = 420 + radius * 180;
    const start = Math.max(0, center - contextSize);
    const end = Math.min(text.length, center + contextSize);
    return {
      kind: 'text-context',
      text: `${start ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
      citedText: dependency.spanText,
      ...(sourceSentence ? { sourceSentence } : {}),
      contextRadius: radius,
    };
  },

  sharedDependency(token) {
    const grant = this.db.prepare(`
      SELECT * FROM dependency_share_grants
      WHERE token = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `).get(token, now());
    if (!grant) throw new HttpError(404, 'This source-sharing link is unavailable or has expired.');
    const dependency = this.getDependency(grant.dependency_id);
    if (dependency.removed) throw new HttpError(404, 'This source-sharing link is unavailable or has expired.');
    const source = semanticDependencySource(dependency);
    // Like object shares, publish file names only. Folder names can identify
    // a client or matter, and the owner's manuscript path is private.
    return {
      claim: dependency.spanText,
      source: {
        label: source.label,
        path: path.posix.basename(source.path),
        objectType: source.objectType,
        valueText: source.valueText,
        metadata: {
          title: source.metadata.title ?? null,
          author: source.metadata.author ?? null,
          year: source.metadata.year ?? null,
          variable: source.metadata.variable ?? source.metadata.column ?? null,
          row: source.metadata.row ?? source.anchor?.rowKey ?? null,
          column: source.metadata.column ?? source.anchor?.column ?? null,
        },
      },
      access: {
        scope: grant.access_scope,
        recipientLabel: grant.recipient_label,
        expiresAt: grant.expires_at,
      },
      content: this.sharedSourceContent(dependency, grant.access_scope, grant.context_radius),
    };
  },
};
