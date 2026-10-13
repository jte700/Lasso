import { extractDrawingDocument } from './drawing-extraction.js';
import { extractIfcDocument } from './ifc-extraction.js';
import { extractDxfDocument } from './dxf-extraction.js';
import { extractLandXmlDocument } from './landxml-extraction.js';
import path from 'node:path';

export function extractDesignDocument(file, buffer) {
  const extension = path.extname(file.path).toLowerCase();
  if (extension === '.pdf') return extractDrawingDocument(buffer, { filePath: file.path });
  if (extension === '.ifc') return extractIfcDocument(buffer);
  if (extension === '.dxf') return extractDxfDocument(buffer, { filePath: file.path });
  if (extension === '.landxml' || extension === '.xml' && /<(?:[\w.-]+:)?LandXML\b/i.test(buffer.subarray(0, 8192).toString())) {
    const extracted = extractLandXmlDocument(buffer);
    return extension === '.landxml' ? { ...extracted, isDrawing: true } : extracted;
  }
  if (['.dwg', '.rvt', '.dgn'].includes(extension)) return {
    isDrawing: true, format: extension.slice(1).toUpperCase(), method: null, status: 'unsupported', pages: [],
    warnings: [extension === '.rvt' ? 'Export IFC with rooms/spaces and base quantities from Revit to index model properties.'
      : 'Export a DXF drawing, IFC model, or LandXML civil data from the authoring application to index this file.'],
  };
  return { isDrawing: false, pages: [], warnings: [] };
}

// Facts share the immutable object/version index used by tables and documents.
// Only explicit annotations are values; geometry is never measured from scale.
export function drawingDescriptors(file, buffer) {
  const drawing = extractDesignDocument(file, buffer);
  if (!drawing.isDrawing) return { drawing, descriptors: [] };
  const descriptors = [];
  const pdf = path.extname(file.path).toLowerCase() === '.pdf';
  const pages = drawing.pages.length ? drawing.pages : [{ pageNumber: null, title: path.basename(file.path), annotations: [], text: '' }];
  for (const page of pages) {
    const sheetKey = pdf ? `page:${page.pageNumber}` : 'model';
    const common = {
      drawing: true, format: drawing.format ?? (pdf ? 'PDF' : path.extname(file.path).slice(1).toUpperCase()), pageNumber: pdf ? page.pageNumber : null,
      sheetNumber: page.sheetNumber ?? null, title: page.title ?? null,
      extraction: drawing.method, extractionStatus: page.status ?? drawing.status,
      warnings: [...new Set([...(drawing.warnings ?? []), ...(page.warnings ?? [])])],
      pageWidth: page.width, pageHeight: page.height,
    };
    descriptors.push({
      key: `${file.projectFileId}:drawing:${sheetKey}`, type: 'DRAWING',
      path: file.path, contentHash: file.contentHash,
      label: [page.sheetNumber, page.title].filter(Boolean).join(' · ') || `Drawing · page ${page.pageNumber}`,
      value: null,
      anchor: { kind: pdf ? 'drawing-sheet' : 'cad-model', pageNumber: pdf ? page.pageNumber : null, sheetNumber: page.sheetNumber },
      metadata: { ...common, textExcerpt: String(page.text ?? '').slice(0, 20_000), annotationCount: page.annotations.length },
    });
    for (const annotation of page.annotations) {
      const propertyWords = String(annotation.propertyName ?? '').replace(/([a-z])([A-Z])/g, '$1 $2');
      const label = propertyWords && !annotation.label.toLowerCase().replace(/\s/g, '').includes(propertyWords.toLowerCase().replace(/\s/g, ''))
        ? `${annotation.label} ${propertyWords}` : annotation.label;
      descriptors.push({
        key: `${file.projectFileId}:drawing:${sheetKey}:${annotation.id}`,
        type: 'DRAWING_ANNOTATION', path: file.path, label,
        value: annotation.value, contentHash: file.contentHash,
        anchor: { kind: pdf ? 'drawing-annotation' : 'cad-property', pageNumber: pdf ? page.pageNumber : null,
          sheetNumber: page.sheetNumber, identifier: annotation.id, label, bbox: annotation.bbox,
          elementId: annotation.elementId, propertyName: annotation.propertyName, propertySet: annotation.propertySet,
          layer: annotation.layer, stepId: annotation.stepId, propertyStepId: annotation.propertyStepId },
        metadata: { ...common, ...annotation, variable: label,
          pageNumber: pdf ? page.pageNumber : null,
          measurementBasis: annotation.measurementBasis ?? 'explicit', textExcerpt: annotation.rawText,
          description: `${label}. ${annotation.measurementBasis ?? 'explicit'}; ${/area/.test(annotation.kind) ? 'area square footage square feet square metres' : annotation.kind.replaceAll('_', ' ')}.` },
      });
    }
  }
  return { drawing, descriptors };
}

export function drawingContext(source) {
  const metadata = source.metadata ?? {};
  const page = source.anchor?.pageNumber ?? metadata.pageNumber;
  const location = [metadata.sheetNumber, page ? `page ${page}` : null, metadata.stepId, metadata.elementId, metadata.propertySet, metadata.propertyName].filter(Boolean).join(' · ');
  const warnings = (metadata.warnings ?? []).join(' ');
  const evidence = metadata.rawText ?? metadata.textExcerpt ?? '';
  return {
    kind: 'text-context', text: [location, evidence, warnings].filter(Boolean).join('\n'),
    citedText: metadata.rawText ?? source.valueText ?? source.label,
    pageNumber: source.anchor?.pageNumber, bbox: source.anchor?.bbox ?? null,
    measurementBasis: metadata.measurementBasis ?? null,
  };
}
