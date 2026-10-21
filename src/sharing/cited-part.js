import { ASSEMBLY_ELEMENT } from '../dependencies/step-extraction.js';

function boundsOf(elements) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const element of elements) for (const line of element.lines ?? []) for (const [x, y] of line) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}

/**
 * What a cited-part share of a 3D CAD model publishes: one instance of the
 * cited part with its cited feature (a hole, a bearing seat, an edge) still
 * marked, and no other component of the assembly. Null when the citation names
 * no single part, as a model overview or an assembly size does: such a model
 * is shared whole or not at all.
 */
export function citedPartModel(model) {
  if (model?.kind !== 'model-plan' || model.format !== 'step') return null;
  const part = model.selected?.guid;
  if (!part || part === ASSEMBLY_ELEMENT) return null;
  const instance = model.elements.find(element => element.guid === part && element.selected)?.id;
  if (instance === undefined) return null;
  const elements = model.elements.filter(element => element.guid === part && element.id === instance);
  const bounds = boundsOf(elements);
  // Warnings describe the rest of the assembly, which this share leaves out.
  return { ...model, elements, bounds, focusBounds: { ...bounds }, warnings: [], citedPart: true };
}
