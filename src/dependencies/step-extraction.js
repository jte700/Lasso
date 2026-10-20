// Indexes measured STEP CAD geometry as drawing facts. Every value is an exact
// B-rep measurement in the file's declared length unit, scoped to a named part.
import { createHash } from 'node:crypto';
import { readStepModel, stepFeatures, formatLength, formatDegrees } from './step-model.js';

const MAX_FACTS = 4_000;
const MAX_CACHE_ENTRIES = 8;
export const ASSEMBLY_ELEMENT = '@assembly';
/** Overall sizes, then holes and cylinders, arcs and straight edges: the order a
 * part's measurements are kept in past the limit, and offered in while typing. */
export const FEATURE_TIER = { extent: 0, hole: 1, cylinder: 1, arc: 2, edge: 3 };
const cache = new Map();

const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 20);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** What bounds an extent: its edges, or a sphere or torus face's own extreme point at either end. */
function extentBasis({ lowFace, highFace }) {
  const ends = [lowFace, highFace].filter(Boolean);
  if (!ends.length) return 'bounded exactly by its B-rep edges';
  const faces = [...new Map(ends.map((face) => [face.id, face])).values()]
    .map((face) => `${face.kind === 'sphere' ? 'spherical' : 'toroidal'} face #${face.id}`);
  const points = `the extreme point${ends.length > 1 ? 's' : ''} of its ${faces.join(' and ')}`;
  return ends.length > 1 ? `bounded exactly by ${points}` : `bounded exactly by its B-rep edges and ${points}`;
}
const SEARCH_TERMS = {
  extent: 'overall size dimension length width height thickness bounding box extent',
  hole: 'hole bore drilled diameter depth',
  cylinder: 'cylinder shaft boss pin diameter length',
  arc: 'arc radius fillet round curve arc length sweep angle',
  edge: 'straight edge line length',
};

function factsForPart(part, model, unitLabel, instances) {
  const { features, omitted } = stepFeatures(part, unitLabel);
  const unitNote = `Length unit: ${model.unit.source ?? unitLabel}${model.unit.convertedToMm ? ', converted to millimetres' : ''}.`;
  const facts = [];
  const fact = (feature, { measure, kind, propertyName, label, value: numericValue, evidence, recordId, extra = {} }) => {
    const value = Number(formatLength(numericValue));
    facts.push({ tier: FEATURE_TIER[feature.type], annotation: {
      id: `step-${hash(`STEP|${part.key}|${feature.featureId}|${measure}`)}`,
      label: `${part.name} ${label}`, entityName: part.name,
      kind, value: `${formatLength(numericValue)} ${unitLabel}`, numericValue: value, units: unitLabel,
      rawText: [evidence, unitNote, recordId ? model.recordText(recordId) : null].filter(Boolean).join('\n'),
      confidence: 1, measurementBasis: 'geometry', extractionMethod: 'step_brep_geometry',
      entityType: feature.type === 'extent' ? 'PART' : feature.type.toUpperCase(), elementId: part.key, featureId: feature.featureId,
      featureName: feature.name, featureType: feature.type, count: feature.count, instances,
      productId: part.productId || null, stepId: recordId ? `#${recordId}` : null,
      propertySet: feature.type === 'extent' ? 'Overall size' : feature.name, propertyName,
      searchTerms: SEARCH_TERMS[feature.type], bbox: null, ...extra,
    } });
  };
  for (const feature of features) {
    if (feature.type === 'extent') {
      fact(feature, { measure: 'extent', kind: 'length', propertyName: `${feature.axis} extent`, label: feature.name, value: feature.value,
        evidence: `${part.name} spans ${formatLength(feature.value)} ${unitLabel} along its ${feature.axis} axis (${formatLength(feature.min)} to ${formatLength(feature.max)}), ${extentBasis(feature)}.`,
        recordId: part.bodies.find((body) => !body.reference)?.id, extra: { axis: feature.axis } });
    } else if (feature.type === 'hole' || feature.type === 'cylinder') {
      const what = feature.type === 'hole' ? 'concave cylindrical hole' : 'convex cylindrical face';
      const evidence = `${plural(feature.count, what)} on ${part.name}: Ø${formatLength(feature.diameter)} ${unitLabel} (radius ${formatLength(feature.diameter / 2)} ${unitLabel}), ${formatLength(feature.length)} ${unitLabel} along the axis.`;
      const common = { evidence, recordId: feature.surfaceId };
      fact(feature, { ...common, measure: 'diameter', kind: 'diameter', propertyName: 'Diameter', label: `${feature.name} diameter`, value: feature.diameter });
      const depth = feature.type === 'hole' ? 'depth' : 'length';
      fact(feature, { ...common, measure: 'length', kind: depth, propertyName: depth === 'depth' ? 'Depth' : 'Length', label: `${feature.name} ${depth}`, value: feature.length });
    } else if (feature.type === 'arc') {
      const evidence = `${plural(feature.count, 'circular arc')} on ${part.name}: radius ${formatLength(feature.radius)} ${unitLabel}, ${formatDegrees(feature.sweep)}° sweep, arc length ${formatLength(feature.arcLength)} ${unitLabel}.`;
      const common = { evidence, recordId: feature.curveId, extra: { sweepDegrees: Number(formatDegrees(feature.sweep)) } };
      fact(feature, { ...common, measure: 'radius', kind: 'radius', propertyName: 'Radius', label: `${feature.name} radius`, value: feature.radius });
      fact(feature, { ...common, measure: 'arc-length', kind: 'arc_length', propertyName: 'Arc length', label: `${feature.name} length`, value: feature.arcLength });
    } else if (feature.type === 'edge') {
      fact(feature, { measure: 'length', kind: 'edge_length', propertyName: 'Length', label: `${feature.name} length`, value: feature.length,
        evidence: `${plural(feature.count, 'straight edge')} on ${part.name} measuring ${formatLength(feature.length)} ${unitLabel}.`, recordId: feature.edgeId });
    }
  }
  const notes = Object.entries(omitted).map(([type, count]) => `${part.name}: ${count} smaller ${type} size${count === 1 ? ' was' : 's were'} not indexed.`);
  return { facts, notes };
}

/** Deterministic local extraction of a STEP AP203/AP214/AP242 file. */
export function extractStepDocument(buffer) {
  const base = { isDrawing: true, format: 'STEP', method: 'step-brep-geometry', status: 'ready', warnings: [], pages: [] };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ...base, status: 'error', warnings: ['STEP input is empty.'] };
  const key = createHash('sha256').update(buffer).digest('hex');
  if (cache.has(key)) return structuredClone(cache.get(key));
  let model;
  try { model = readStepModel(buffer); } catch (error) {
    return { ...base, status: error.status ?? 'error', warnings: [`Cannot read STEP geometry: ${error.message}`] };
  }
  const warnings = [...model.warnings];
  const ranked = [];
  const instances = new Map();
  for (const occurrence of model.occurrences) instances.set(occurrence.part, (instances.get(occurrence.part) ?? 0) + 1);
  const unitLabel = model.unit ? (model.unit.convertedToMm ? 'mm' : model.unit.label) : null;
  if (unitLabel) {
    if (model.assembly) {
      const assembly = { key: ASSEMBLY_ELEMENT, name: model.assembly.name || 'Assembly', productId: '', bodies: [] };
      for (const extent of model.assembly.extents) {
        if (!extent.exact) { warnings.push(`${assembly.name} assembly ${extent.axis} extent was not indexed because a component's extent is not exact.`); continue; }
        const feature = { featureId: `extent:${extent.axis}`, type: 'extent', name: `overall ${extent.axis} extent`, count: 1 };
        const value = extent.max - extent.min;
        ranked.push({ tier: FEATURE_TIER.extent, annotation: {
          id: `step-${hash(`STEP|${ASSEMBLY_ELEMENT}|${feature.featureId}|extent`)}`,
          label: `${assembly.name} assembly overall ${extent.axis} extent`, entityName: assembly.name, kind: 'length',
          value: `${formatLength(value)} ${unitLabel}`, numericValue: Number(formatLength(value)), units: unitLabel,
          rawText: `${assembly.name} spans ${formatLength(value)} ${unitLabel} along the assembly ${extent.axis} axis (${formatLength(extent.min)} to ${formatLength(extent.max)}) across ${plural(model.occurrences.length, 'placed component')}.\nLength unit: ${model.unit.source ?? unitLabel}.`,
          confidence: 1, measurementBasis: 'geometry', extractionMethod: 'step_brep_geometry', entityType: 'ASSEMBLY',
          elementId: ASSEMBLY_ELEMENT, featureId: feature.featureId, featureName: feature.name, featureType: 'extent', count: 1,
          instances: model.occurrences.length, stepId: null, propertySet: 'Assembly size', propertyName: `${extent.axis} extent`,
          axis: extent.axis, searchTerms: SEARCH_TERMS.extent, bbox: null,
        } });
      }
    }
    model.parts.forEach((part, index) => {
      if (!part.unitKnown) { warnings.push(`${part.name} has no supported length unit; its geometry was not measured.`); return; }
      const { facts, notes } = factsForPart(part, model, unitLabel, instances.get(index) ?? 0);
      ranked.push(...facts);
      warnings.push(...part.notes, ...notes);
    });
  }
  // Overall sizes and holes are kept ahead of arcs and edges when a large
  // assembly exceeds the per-file measurement limit.
  ranked.sort((a, b) => a.tier - b.tier);
  if (ranked.length > MAX_FACTS) warnings.push(`STEP measurement index limited to ${MAX_FACTS.toLocaleString('en-US')} values; smaller features were omitted.`);
  const annotations = ranked.slice(0, MAX_FACTS).map((entry) => entry.annotation);
  if (!annotations.length && unitLabel) warnings.push('No measurable solid geometry was found. Export solid bodies with their B-rep faces and edges.');
  const partLines = model.parts.slice(0, 200).map((part, index) => {
    const size = part.extents.length === 3 && part.extents.every((extent) => extent.exact)
      ? ` — ${part.extents.map((extent) => formatLength(extent.max - extent.min)).join(' × ')} ${unitLabel}` : '';
    return `${part.name} — ${plural(instances.get(index) ?? 0, 'instance')}${size}`;
  });
  const title = model.rootName || (model.parts.length === 1 ? model.parts[0].name : null) || 'STEP model';
  const result = { ...base, protocol: model.protocol, schema: model.schema, originatingSystem: model.originatingSystem,
    units: unitLabel, partCount: model.parts.length, instanceCount: model.occurrences.length,
    status: warnings.length ? 'partial' : 'ready', warnings: [...new Set(warnings)].slice(0, 50),
    pages: [{ pageNumber: null, sheetNumber: null, title,
      text: [`${model.protocol ?? 'STEP'} CAD model · ${model.schema} · ${plural(model.parts.length, 'part')} · ${plural(model.occurrences.length, 'instance')} · ${plural(annotations.length, 'measurement')}`,
        ...partLines].join('\n'),
      annotations }] };
  cache.set(key, result);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return structuredClone(result);
}
