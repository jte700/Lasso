import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { inverseRotate, rotate, transformPoint } from './step-model.js';
import { ASSEMBLY_ELEMENT } from './step-extraction.js';

const MAX_BYTES = 64_000_000;
const MAX_CACHE_ENTRIES = 3;
const MAX_PENDING = 4;
const MAX_PREVIEW_POINTS = 120_000;
const cache = new Map();
let pending = 0, queue = Promise.resolve();

// Isometric projection looking down (1, 1, 1) with +Z up on screen.
const RIGHT = [-Math.SQRT1_2, Math.SQRT1_2, 0];
const UP = [-1 / Math.sqrt(6), -1 / Math.sqrt(6), 2 / Math.sqrt(6)];
const TOWARD = [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const project = point => [dot(point, RIGHT), dot(point, UP)];

function runWorker(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./step-geometry-worker.js', import.meta.url), {
      workerData: { bytes }, resourceLimits: { maxOldGenerationSizeMb: 512 }, execArgv: [],
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('STEP visual preview exceeded the 30-second processing limit.')), 30_000);
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.scene));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`STEP geometry worker exited before producing a preview (${code}).`)); });
  });
}

function sceneFor(bytes, sourceHash) {
  const cached = cache.get(sourceHash);
  if (cached) { cache.delete(sourceHash); cache.set(sourceHash, cached); return cached; }
  if (pending >= MAX_PENDING) throw new Error('STEP visual preview is busy. Please retry shortly.');
  pending++;
  const promise = queue.then(() => runWorker(bytes))
    .catch(error => { cache.delete(sourceHash); throw error; }).finally(() => { pending--; });
  queue = promise.catch(() => {});
  cache.set(sourceHash, promise);
  while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return promise;
}

function silhouettes(cylinder, matrix) {
  // Generators where the surface turns away from the viewer; a wireframe
  // would otherwise show a shaft as two unconnected circles.
  const worldAxis = rotate(matrix, cylinder.axis);
  const normal = [worldAxis[1] * TOWARD[2] - worldAxis[2] * TOWARD[1], worldAxis[2] * TOWARD[0] - worldAxis[0] * TOWARD[2], worldAxis[0] * TOWARD[1] - worldAxis[1] * TOWARD[0]];
  const size = Math.hypot(...normal);
  if (size < 1e-6) return [];
  const local = inverseRotate(matrix, normal.map(value => value / size));
  const lines = [];
  for (const sign of [1, -1]) {
    const direction = local.map(value => value * sign);
    const angle = Math.atan2(dot(direction, cylinder.ydir), dot(direction, cylinder.xdir));
    if (cylinder.coverage && ((angle - cylinder.coverage.start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) > cylinder.coverage.sweep) continue;
    const at = height => cylinder.center.map((value, index) => value + direction[index] * cylinder.radius + cylinder.axis[index] * height);
    lines.push([at(cylinder.h0), at(cylinder.h1)].map(point => project(transformPoint(matrix, point))));
  }
  return lines;
}

const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
function include(bounds, lines) {
  for (const line of lines) for (const [x, y] of line) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}
function padded(bounds, fraction = 0.12) {
  const margin = Math.max((bounds.maxX - bounds.minX) * fraction, (bounds.maxY - bounds.minY) * fraction, 1e-6);
  return { minX: bounds.minX - margin, minY: bounds.minY - margin, maxX: bounds.maxX + margin, maxY: bounds.maxY + margin };
}

/** Isometric wireframe of the preserved STEP version. The cited part (and
 * feature) is selected by its indexed identity; a missing identity is an
 * error rather than a fallback to another part. Coordinates are model units. */
export async function buildStepView(buffer, { elementId = null, featureId = null } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('STEP visual preview requires a nonempty file under 64 MB.');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const scene = await sceneFor(bytes, sourceHash);
  const assembly = elementId === ASSEMBLY_ELEMENT;
  const part = elementId && !assembly ? scene.parts.find(candidate => candidate.key === String(elementId)) : null;
  if (elementId && !assembly && !part) throw new Error('The cited part is not present in this source version.');
  const feature = part && featureId && !String(featureId).startsWith('extent:') ? part.features.find(candidate => candidate.featureId === String(featureId)) : null;
  if (part && featureId && !String(featureId).startsWith('extent:') && !feature) throw new Error('The cited feature is not present in this source version.');
  const featureEdges = feature ? new Set(feature.edgeKeys) : null;
  const featureCylinders = feature ? new Set(feature.cylinders ?? []) : null;
  const selectedPart = assembly ? null : part ? scene.parts.indexOf(part) : -1;
  const isSelected = index => assembly || index === selectedPart;
  const order = scene.occurrences.map((occurrence, index) => ({ occurrence, index }))
    .sort((a, b) => Number(isSelected(b.occurrence.part)) - Number(isSelected(a.occurrence.part)));
  let span = 1e-9;
  for (const item of scene.parts) for (const line of Object.values(item.edges)) for (const point of line) {
    for (const value of point) span = Math.max(span, Math.abs(value));
  }
  // Six significant digits of the model's size keep previews compact.
  const decimals = Math.min(9, Math.max(0, 6 - Math.floor(Math.log10(span))));
  const tidy = lines => lines.map(line => line.map(point => point.map(value => Number(value.toFixed(decimals)))));
  const elements = [], warnings = [...scene.warnings];
  let points = 0, skipped = 0;
  for (const { occurrence, index } of order) {
    const source = scene.parts[occurrence.part];
    const chosen = isSelected(occurrence.part);
    const size = Object.values(source.edges).reduce((total, line) => total + line.length, 0);
    if (!chosen && points + size > MAX_PREVIEW_POINTS) { skipped++; continue; }
    points += size;
    const context = [], highlight = [];
    for (const [key, line] of Object.entries(source.edges)) {
      const projected = line.map(point => project(transformPoint(occurrence.matrix, point)));
      (chosen && (!featureEdges || featureEdges.has(key)) ? highlight : context).push(projected);
    }
    source.cylinders.forEach((cylinder, cylinderIndex) => {
      const lines = silhouettes(cylinder, occurrence.matrix);
      (chosen && (!featureCylinders || featureCylinders.has(cylinderIndex)) ? highlight : context).push(...lines);
    });
    const identity = { id: index, guid: source.key, label: occurrence.label, entityType: 'PART', role: 'context', polygons: [] };
    if (context.length) elements.push({ ...identity, selected: false, lines: tidy(context) });
    if (highlight.length) elements.push({ ...identity, selected: true, lines: tidy(highlight) });
  }
  if (skipped) warnings.push(`${skipped} component instance${skipped === 1 ? ' is' : 's are'} omitted from this preview to keep it responsive.`);
  if (!elements.length) throw new Error('This STEP file contains no drawable edges.');
  const bounds = elements.reduce((total, element) => include(total, element.lines), emptyBounds());
  const selectedLines = elements.filter(element => element.selected).flatMap(element => element.lines);
  const focusBounds = selectedLines.length ? padded(include(emptyBounds(), selectedLines)) : bounds;
  const selected = assembly ? { id: null, guid: ASSEMBLY_ELEMENT, label: scene.rootName || 'Assembly', entityType: 'Assembly' }
    : part ? { id: selectedPart, guid: part.key, label: feature ? `${part.name} · ${feature.name}` : part.name,
      entityType: feature ? feature.name : featureId ? `Overall ${String(featureId).slice(7)} extent` : 'Part' } : null;
  return { kind: 'model-plan', format: 'step', sourceHash, units: scene.units || 'model units', projection: 'isometric', view: 'Isometric view',
    fillRule: 'evenodd', elements, bounds, focusBounds, selected, storey: null, warnings };
}
