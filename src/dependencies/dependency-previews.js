// Previews of a linked source: its file, figure, model and the viewer around its anchor.

import path from 'node:path';
import { HttpError } from '../history/errors.js';
import { parseDelimited } from '../history/diff.js';
import { extractDocxDocument, extractSpreadsheetTables } from './document-extraction.js';
import { renderPdfFigurePage } from './figure-preview.js';
import { drawingContext } from './drawing-objects.js';
import { normalizedVariable, spreadsheetLayout, tabularLayout } from './tabular.js';
import { buildModelPreview } from './model-preview.js';
import { semanticDependencySource } from './row-field-match.js';
import { wordTokens } from './text-similarity.js';

export const dependencyPreviewsMethods = {
  figurePreviewImage(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (source.objectType !== 'FIGURE' || file?.fileType !== 'pdf') {
      throw new HttpError(400, 'This dependency is not a figure inside a PDF.');
    }
    const identifier = source.metadata.identifier ?? source.anchor?.identifier
      ?? String(source.label).match(/\b(?:Figure|Fig\.?)\s+([A-Za-z0-9.-]+)/i)?.[1];
    if (!identifier) throw new HttpError(422, 'The cited figure number is unavailable.');
    const cacheKey = `${file.contentHash}:${normalizedVariable(identifier)}`;
    if (!this.figurePreviewCache.has(cacheKey)) {
      const buffer = this.timeline.blobs.get(file.contentHash);
      try {
        const preview = renderPdfFigurePage(buffer, identifier);
        this.figurePreviewCache.set(cacheKey, preview);
        return preview;
      } catch (error) {
        throw new HttpError(422, error.message);
      }
    }
    return this.figurePreviewCache.get(cacheKey);
  },

  dependencySourceFile(dependencyId) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The indexed source version is no longer available.');
    const extension = path.extname(file.path).toLowerCase();
    const mimeTypes = {
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
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
    };
    return {
      content: this.timeline.blobs.get(file.contentHash),
      contentType: mimeTypes[extension] ?? 'application/octet-stream',
      filename: path.posix.basename(file.path),
    };
  },

  async sourceModelPreview(source) {
    if (!/\.(?:ifc|dxf|step|stp)$/i.test(source?.path ?? '')) return null;
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) return { kind: 'model-unavailable', reason: 'The indexed source version is no longer available.' };
    return buildModelPreview({ path: file.path, content: this.timeline.blobs.get(file.contentHash) }, source);
  },

  dependencyModelPreview(dependencyId) {
    return this.sourceModelPreview(semanticDependencySource(this.getDependency(dependencyId)));
  },

  dependencySourceViewer(dependencyId, options = {}) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const file = this.timeline.snapshotFile(source.snapshotId, source.path);
    if (!file) throw new HttpError(404, 'The indexed source version is no longer available.');
    const buffer = this.timeline.blobs.get(file.contentHash);
    const fileUrl = `/api/dependencies/${encodeURIComponent(dependencyId)}/source-file`;
    const base = {
      dependencyId,
      source,
      path: file.path,
      fileType: file.fileType,
      version: this.timeline.snapshotRecord(source.snapshotId)?.version ?? null,
      fileUrl,
    };

    if (source.metadata?.drawing && file.fileType !== 'pdf') {
      const text = drawingContext(source).text;
      const selectedText = source.metadata.rawText ?? source.valueText ?? '';
      return { ...base, kind: 'document', text,
        selectedText, selectedStart: selectedText ? text.indexOf(selectedText) : -1,
        locationLabel: [source.metadata.elementId, source.metadata.propertySet, source.metadata.propertyName].filter(Boolean).join(' · ') };
    }

    if (file.fileType === 'pdf') {
      let pageNumber = Number(source.anchor?.pageNumber) || 1;
      if (source.objectType === 'FIGURE') {
        try { pageNumber = this.figurePreviewImage(dependencyId).pageNumber || pageNumber; } catch { /* open at page one */ }
      }
      return {
        ...base,
        kind: 'pdf',
        pageNumber,
        selectedText: source.anchor?.selectedText ?? source.metadata.rawText ?? '',
        locationLabel: `${source.metadata.componentLabel ?? source.label}${pageNumber ? ` · page ${pageNumber}` : ''}`,
      };
    }

    if (['table', 'spreadsheet'].includes(file.fileType)) {
      // A large table shows the rows around the cited one, from the table index.
      const window = this.tableWindow(file, buffer, source.anchor ?? {}, {
        before: 2_500, after: 2_500, sheet: String(options.sheet ?? '').trim() || null });
      const anchor = window?.anchor ?? source.anchor;
      const tables = window ? [window.table] : file.fileType === 'spreadsheet'
        ? extractSpreadsheetTables(buffer)
        : [{
          name: path.posix.basename(file.path),
          rows: parseDelimited(buffer.toString('utf8'), path.extname(file.path).toLowerCase() === '.tsv' ? '\t' : ','),
        }];
      if (!tables.length) return { ...base, kind: 'binary', locationLabel: source.label };
      const requestedSheet = String(options.sheet ?? '').trim();
      const table = tables.find((candidate) => candidate.name === requestedSheet)
        ?? tables.find((candidate) => candidate.name === source.anchor?.sheet)
        ?? tables[0];
      const layout = file.fileType === 'spreadsheet' || window ? spreadsheetLayout(table) : tabularLayout(table.rows);
      const rowReference = anchor?.kind === 'table-row';
      const selectedColumn = rowReference ? -1
        : Number.isInteger(anchor?.columnIndex) ? anchor.columnIndex
          : layout.headers.findIndex((header) => String(header) === String(anchor?.column));
      let selectedRow = Number.isInteger(anchor?.rowIndex)
        ? (layout.rowNumbers && anchor.rowCoordinate === 'worksheet' ? layout.rowNumbers.indexOf(anchor.rowIndex) : anchor.rowIndex - layout.headerRowIndex - 1) : -1;
      if (selectedRow < 0 || selectedRow >= layout.rows.length) {
        selectedRow = layout.rows.findIndex((row) => String(row[0] ?? '') === String(anchor?.rowKey ?? ''));
      }
      const isIndexedSheet = !anchor?.sheet || table.name === anchor.sheet;
      // Show numbers as the sheet does ($129,950); rows were matched on stored values above.
      const rows = layout.rows.slice(0, 5000).map((row, index) => {
        const shown = table.displayRows?.[layout.headerRowIndex + 1 + index];
        return shown?.length ? row.map((cell, column) => shown[column] ?? cell) : row;
      });
      return {
        ...base,
        kind: 'table',
        sheet: table.name,
        sheets: window?.sheets ?? tables.map((candidate) => candidate.name),
        headers: layout.headers,
        rows,
        selectedRow: isIndexedSheet ? selectedRow : -1,
        selectedColumn: isIndexedSheet ? selectedColumn : -1,
        truncated: window ? window.totalRows > rows.length : layout.rows.length > rows.length,
        totalRows: window?.totalRows ?? layout.rows.length,
        ...(window ? { firstRow: window.firstRow } : {}),
        locationLabel: [source.anchor?.sheet, source.anchor?.rowKey, rowReference ? null : source.anchor?.column]
          .filter(Boolean).join(' · ') || source.label,
      };
    }

    if (file.fileType === 'image') {
      return { ...base, kind: 'image', locationLabel: source.label };
    }

    let text;
    if (file.fileType === 'document') text = extractDocxDocument(buffer).textExcerpt;
    else if (file.fileType === 'presentation') text = this.fileText(file, source.objectType);
    else if (['markdown', 'text', 'code', 'yaml', 'json', 'notebook'].includes(file.fileType)) text = buffer.toString('utf8');
    if (text != null) {
      const selectedText = String(source.valueText ?? dependency.spanText ?? source.label ?? '').trim();
      const selectedStart = selectedText ? text.toLowerCase().indexOf(selectedText.toLowerCase()) : -1;
      return {
        ...base,
        kind: 'document',
        text: text.slice(0, 250_000),
        truncated: text.length > 250_000,
        selectedText,
        selectedStart,
        locationLabel: source.label,
      };
    }

    return { ...base, kind: 'binary', locationLabel: source.label };
  },

  dependencyPreview(dependencyId, options = {}) {
    const dependency = this.getDependency(dependencyId);
    const source = semanticDependencySource(dependency);
    const parsedRadius = Number(options.contextRadius);
    const contextRadius = Number.isFinite(parsedRadius)
      ? Math.max(0, Math.min(5, parsedRadius)) : 1;
    let content;
    if (source.objectType === 'FIGURE' && /\.pdf$/i.test(source.path)) {
      try {
        const rendered = this.figurePreviewImage(dependencyId);
        const rawCaption = String(source.valueText ?? source.metadata.textExcerpt ?? '').trim();
        const caption = wordTokens(rawCaption).length >= 3 ? rawCaption : '';
        content = {
          kind: 'pdf-figure',
          imageUrl: `/api/dependencies/${encodeURIComponent(dependencyId)}/figure-image`,
          label: source.metadata.componentLabel ?? source.label,
          caption,
          pageNumber: rendered.pageNumber,
          located: rendered.located,
        };
      } catch {
        content = this.sharedSourceContent(dependency, 'CONTEXT', contextRadius);
      }
    } else content = this.sharedSourceContent(dependency, 'CONTEXT', contextRadius);
    return {
      claim: dependency.spanText,
      source,
      accessScope: 'CONTEXT',
      content,
    };
  },
};
