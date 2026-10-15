import path from 'node:path';
import { buildIfcPlan } from './ifc-geometry.js';

/** Render only the supplied, versioned bytes and the indexed element identity. */
export async function buildModelPreview(file, source = {}) {
  if (!file?.content || path.extname(file.path ?? '').toLowerCase() !== '.ifc') return null;
  const anchor = source.anchor ?? {};
  const metadata = source.metadata ?? {};
  const elementId = anchor.elementId ?? metadata.globalId ?? metadata.elementId;
  const stepId = anchor.stepId ?? metadata.stepId;
  const context = {
    path: file.path,
    fileName: path.basename(file.path),
    label: source.label ?? metadata.entityName ?? null,
    valueText: source.valueText ?? null,
    propertyName: anchor.propertyName ?? metadata.propertyName ?? null,
    propertySet: anchor.propertySet ?? metadata.propertySet ?? null,
    sourceText: metadata.rawText ?? '',
  };
  // An indexed property must never silently open an unrelated overview.
  if (anchor.kind === 'cad-property' && !elementId && !stepId) {
    return { ...context, kind: 'model-unavailable', reason: 'This indexed property has no model element identifier.' };
  }
  try {
    return { ...context, ...await buildIfcPlan(file.content, { elementId, stepId }) };
  } catch (error) {
    return { ...context, kind: 'model-unavailable',
      reason: error.message || 'The source model does not provide displayable geometry for this element.' };
  }
}
