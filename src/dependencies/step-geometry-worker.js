// Samples STEP B-rep edges into part-space polylines for the isometric preview.
// Feature membership comes from the same grouping that indexes measurements.
import { parentPort, workerData } from 'node:worker_threads';
import { readStepModel, sampleEdge, stepFeatures } from './step-model.js';

const MAX_SCENE_POINTS = 600_000;
const round = value => Math.round(value * 1e9) / 1e9;

export function buildStepScene(bytes) {
  const model = readStepModel(bytes);
  const unitLabel = model.unit ? (model.unit.convertedToMm ? 'mm' : model.unit.label) : null;
  const warnings = [...model.warnings];
  // Arcs are divided until the chord error is about a thousandth of the
  // model, so small holes need far fewer points than large rounds.
  const chord = model.parts.reduce((size, part) => Math.max(size, part.size || 0), 1e-9) / 1000;
  const arcStep = radius => Math.min(Math.PI / 4, Math.max(Math.PI / 18, 2 * Math.acos(Math.max(-1, 1 - chord / radius))));
  let points = 0;
  const parts = model.parts.map(part => {
    const edges = {};
    for (const [key, edge] of part.edges) {
      if (points > MAX_SCENE_POINTS) break;
      const radius = edge.radius ?? (edge.semiAxes ? Math.max(edge.semiAxes[0], edge.semiAxes[1]) : null);
      const sampled = sampleEdge(edge, radius ? arcStep(radius) : undefined).map(point => point.map(round));
      points += sampled.length;
      edges[key] = sampled;
    }
    const { features } = stepFeatures(part, unitLabel ?? 'mm');
    const cylinder = item => ({ center: item.center, axis: item.axis, xdir: item.xdir, ydir: item.ydir,
      radius: item.radius, h0: item.h0, h1: item.h1, coverage: item.coverage });
    return { key: part.key, name: part.name, edges,
      // Silhouette generators make cylinders legible in a wireframe view.
      cylinders: part.cylinders.map(cylinder),
      features: features.map(feature => ({ featureId: feature.featureId, name: feature.name, type: feature.type,
        edgeKeys: feature.edgeKeys, cylinders: feature.cylinders ? feature.cylinders.map(item => part.cylinders.indexOf(item)) : null })) };
  });
  if (points > MAX_SCENE_POINTS) warnings.push('STEP visual preview exceeds the edge sampling limit; some edges are not drawn.');
  return { units: unitLabel, rootName: model.rootName, parts, warnings,
    occurrences: model.occurrences.map(occurrence => ({ part: occurrence.part, matrix: occurrence.matrix,
      label: occurrence.path.filter(Boolean).join(' / ') || model.parts[occurrence.part].name })) };
}

if (parentPort) {
  try { parentPort.postMessage({ scene: buildStepScene(Buffer.from(workerData.bytes)) }); }
  catch (error) { parentPort.postMessage({ error: error.message }); }
}
