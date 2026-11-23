// LandXML values come from named civil model elements and declared units.
// This bounded XML reader never loads schemas, DTDs, or external entities.
import { parseXml } from './xml-tree.js';
import { annotationRecorder, readCivilModel } from './landxml-elements.js';

const MAX_BYTES = 32 * 1024 * 1024;
const LANDXML_NS = /^https?:\/\/www\.landxml\.org\/schema\/LandXML-1\.[012]\/?$/i;
const LANDXML_ROOT = /<(?:[\w.-]+:)?LandXML\b/i;
const SNIFF_BYTES = 8192;
const UNIT_NAMES = {
  meter: 'm', metre: 'm', millimeter: 'mm', centimeter: 'cm', kilometer: 'km',
  foot: 'ft', ussurveyfoot: 'US survey ft', inch: 'in', yard: 'yd', mile: 'mi',
  squaremeter: 'm²', squaremetre: 'm²', squaremillimeter: 'mm²', squarecentimeter: 'cm²', squarekilometer: 'km²',
  squarefoot: 'ft²', squareussurveyfoot: 'US survey ft²', squareinch: 'in²', squareyard: 'yd²', squaremile: 'mi²',
  hectare: 'ha', acre: 'acre',
};

/** Whether a file's opening bytes are a LandXML document, as a civil export saved as .xml may be. */
export function isLandXmlContent(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''));
  return LANDXML_ROOT.test(bytes.subarray(0, SNIFF_BYTES).toString());
}

/**
 * Reads a LandXML 1.0–1.2 model without estimating unspecified quantities.
 * With `lines`, each measurement also says which source line holds it, for a
 * preview's Open file; indexed measurements never carry it.
 */
export function extractLandXmlDocument(buffer, { lines = false } = {}) {
  const result = { isDrawing: true, format: 'LandXML', method: 'landxml-properties', status: 'ready', warnings: [], pages: [] };
  const fail = (message) => ({ ...result, status: 'error', warnings: [message] });
  if (buffer.length > MAX_BYTES) return fail('LandXML exceeds the 32 MB extraction limit.');
  let root;
  try { root = parseXml(buffer.toString('utf8').replace(/^\uFEFF/, '')); } catch (error) { return fail(error.message); }
  if (root.name !== 'LandXML' || (root.namespace && !LANDXML_NS.test(root.namespace))) return { ...result, isDrawing: false, status: 'unsupported', warnings: ['Expected a LandXML exchange document.'] };
  if (root.attributes.version && !/^1\.[012]$/.test(root.attributes.version)) return { ...result, status: 'unsupported', warnings: [`Unsupported LandXML version ${root.attributes.version}.`] };
  const children = (node, name) => node.children.filter((child) => child.name === name && child.namespace === root.namespace);
  const warnings = new Set();
  const unitDeclarations = children(root, 'Units').flatMap((node) => [...children(node, 'Metric'), ...children(node, 'Imperial')]);
  if (unitDeclarations.length !== 1) return fail('LandXML must declare exactly one Metric or Imperial unit system.');
  const declarations = unitDeclarations[0].attributes;
  const unit = (kind) => {
    const declared = declarations[kind];
    const key = String(declared ?? '').toLowerCase();
    const areaUnit = /^(?:square|hectare$|acre$)/.test(key);
    const value = Object.hasOwn(UNIT_NAMES, key) && (kind === 'areaUnit') === areaUnit ? UNIT_NAMES[key] : null;
    if (!value) warnings.add(`Missing or unsupported declared ${kind}${declared ? ` "${declared}"` : ''}; measurements needing it were omitted.`);
    return value ?? null;
  };
  const record = annotationRecorder({ declarations, unit, warnings, lines, imperial: unitDeclarations[0].name === 'Imperial' });
  const annotations = readCivilModel(root, children, record, warnings);
  if (!annotations.length) warnings.add('No supported named parcel, alignment, profile, pipe, structure, point or surface values with declared units were found.');
  const project = children(root, 'Project')[0];
  const title = project?.attributes.name ?? 'LandXML civil model';
  const text = [title, ...annotations.map((annotation) => `${annotation.label}: ${annotation.value}`)].join('\n');
  return { ...result, status: warnings.size ? 'partial' : 'ready', warnings: [...warnings],
    pages: [{ pageNumber: 1, sheetNumber: null, title, text, annotations, status: warnings.size ? 'partial' : 'ready' }] };
}
