import { extractDrawingDocument } from './drawing-extraction.js';
import { extractIfcDocument } from './ifc-extraction.js';
import { extractDxfDocument } from './dxf-extraction.js';
import { extractLandXmlDocument } from './landxml-extraction.js';
import { extractStepDocument, FEATURE_TIER } from './step-extraction.js';
import path from 'node:path';

const NATIVE_CAD = ['.sldprt', '.sldasm', '.ipt', '.iam', '.f3d', '.catpart', '.catproduct', '.x_t', '.x_b', '.igs', '.iges', '.3dm'];
/** Files the design readers inspect; generic .xml is checked for LandXML. */
export const DESIGN_FILE = new RegExp(`\\.(?:ifc|dxf|dwg|rvt|dgn|landxml|xml|step|stp|${NATIVE_CAD.map((extension) => extension.slice(1)).join('|')})$`, 'i');
export const isDesignFile = (file) => ['drawing', 'xml'].includes(file.fileType) || DESIGN_FILE.test(file.path);

export function extractDesignDocument(file, buffer) {
  const extension = path.extname(file.path).toLowerCase();
  if (extension === '.pdf') return extractDrawingDocument(buffer, { filePath: file.path });
  if (extension === '.ifc') return extractIfcDocument(buffer);
  if (extension === '.step' || extension === '.stp') return extractStepDocument(buffer);
  if (extension === '.dxf') return extractDxfDocument(buffer, { filePath: file.path });
  if (extension === '.landxml' || extension === '.xml' && /<(?:[\w.-]+:)?LandXML\b/i.test(buffer.subarray(0, 8192).toString())) {
    const extracted = extractLandXmlDocument(buffer);
    return extension === '.landxml' ? { ...extracted, isDrawing: true } : extracted;
  }
  if (NATIVE_CAD.includes(extension)) return {
    isDrawing: true, format: extension.slice(1).toUpperCase(), method: null, status: 'unsupported', pages: [],
    warnings: ['Export a STEP AP242 or AP214 file (solid bodies) from the CAD application to index part dimensions, holes and arcs.'],
  };
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
          layer: annotation.layer, stepId: annotation.stepId, propertyStepId: annotation.propertyStepId, featureId: annotation.featureId },
        metadata: { ...common, ...annotation, variable: label,
          pageNumber: pdf ? page.pageNumber : null,
          measurementBasis: annotation.measurementBasis ?? 'explicit', textExcerpt: annotation.rawText,
          description: `${label}. ${annotation.measurementBasis ?? 'explicit'}; ${/area/.test(annotation.kind) ? 'area square footage square feet square metres' : annotation.kind.replaceAll('_', ' ')}${annotation.searchTerms ? ` ${annotation.searchTerms}` : ''}.` },
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

// A feature's size (a diameter or radius) comes before its depth or length.
const FOLLOWING_MEASURES = new Set(['depth', 'length', 'arc_length']);

/** A part's natural order: overall sizes, holes, arcs, then edges. Other facts are unordered. */
export function measurementOrder(object) {
  const tier = FEATURE_TIER[object.metadata?.featureType];
  if (tier === undefined) return Number.MAX_SAFE_INTEGER;
  return tier + (FOLLOWING_MEASURES.has(object.metadata.kind) ? 0.5 : 0);
}

const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const writtenWords = (value) => String(value ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const sameWord = (word, written) => [word, `${word}s`, `${word}es`].includes(written);

/**
 * How closely the words written after a drawing or part name describe one of
 * its measurements. Words of the measurement's name count most ("holes with a
 * diameter of"), its search terms less ("bore"); a written count ("four holes")
 * or the start of a value being typed picks out the matching feature.
 */
export function measurementRelevance(object, tail) {
  const written = writtenWords(tail);
  const mentioned = (word) => written.some((item) => sameWord(word, item));
  // Sizes and units in a name ("10 mm straight edge") are not words to match.
  const named = [...new Set(writtenWords(object.label))]
    .filter((word) => !/^\d/.test(word) && word !== String(object.metadata?.units ?? '').toLowerCase());
  const related = [...new Set(writtenWords(object.metadata?.searchTerms))].filter((word) => !named.includes(word));
  const counted = written.some((word, index) => {
    const count = COUNT_WORDS.indexOf(word) + 1 || Number(word);
    return count > 0 && count === object.metadata?.count && named.some((name) => sameWord(name, written[index + 1]));
  });
  // A value being typed, with or without its unit ("6", "60 m"), is completed rather than replaced.
  const compact = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, '');
  const typing = String(tail ?? '').match(/(?:^|\s)(\d+(?:\.\d*)?(?:\s*\p{L}+)?)$/u)?.[1];
  const typedValue = Boolean(typing) && compact(object.valueText).startsWith(compact(typing));
  // "10" is the 10 mm value, ahead of the 100 mm one it also begins.
  const exactValue = typedValue && Number.parseFloat(object.valueText) === Number.parseFloat(typing);
  return Math.min(0.5, 0.12 * named.filter(mentioned).length + 0.04 * related.filter(mentioned).length
    + (counted ? 0.06 : 0) + (typedValue ? 0.3 : 0) + (exactValue ? 0.05 : 0));
}
