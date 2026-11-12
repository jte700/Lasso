import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { rotate, transformPoint } from './step-model.js';
import { ASSEMBLY_ELEMENT } from './step-extraction.js';
import { ISOMETRIC_CAMERA, cameraAxes, projectWireframe } from '../../public/model-orbit.js';
import { pooled } from '../worker-pool.js';

const MAX_BYTES = 64_000_000;
const MAX_CACHE_ENTRIES = 3;
const MAX_PENDING = 4;
const MAX_PREVIEW_POINTS = 120_000;
const cache = new Map();
let pending = 0, queue = Promise.resolve();

// The default view the lines are projected in. Clients rotate the 3D edges.
const ISOMETRIC = cameraAxes(ISOMETRIC_CAMERA);

// Someone is waiting to see this model, so it goes before waiting indexing.
function runWorker(bytes) {
  return pooled(() => new Promise((resolve, reject) => {
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
  }), { interactive: true });
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

// Silhouettes depend on the view, so cylinders travel as surfaces in model
// space and each client draws their outline for its own camera.
const placeCylinder = (cylinder, matrix) => ({ ...cylinder, center: transformPoint(matrix, cylinder.center),
  axis: rotate(matrix, cylinder.axis), xdir: rotate(matrix, cylinder.xdir), ydir: rotate(matrix, cylinder.ydir) });

/** One component instance in assembly space, split into its context and its
 * cited geometry (a chosen part, narrowed to the cited feature if any). */
function placeWires(source, matrix, chosen, featureEdges, featureCylinders) {
  const context = { edges: [], cylinders: [] }, cited = { edges: [], cylinders: [] };
  for (const [key, line] of Object.entries(source.edges)) {
    (chosen && (!featureEdges || featureEdges.has(key)) ? cited : context).edges.push(line.map(point => transformPoint(matrix, point)));
  }
  source.cylinders.forEach((cylinder, index) => {
    (chosen && (!featureCylinders || featureCylinders.has(index)) ? cited : context).cylinders.push(placeCylinder(cylinder, matrix));
  });
  return [{ ...context, selected: false }, { ...cited, selected: true }];
}

// Coordinates keep a fixed number of decimals; directions keep nine.
function rounding(decimals) {
  const round = value => Number(value.toFixed(decimals));
  const unit = vector => vector.map(value => Number(value.toFixed(9)));
  return {
    round,
    lines: lines => lines.map(line => line.map(point => point.map(round))),
    cylinder: ({ center, radius, h0, h1, axis, xdir, ydir, coverage }) => ({
      center: center.map(round), radius: round(radius), h0: round(h0), h1: round(h1), axis: unit(axis), xdir: unit(xdir), ydir: unit(ydir),
      ...(coverage ? { coverage: { start: coverage.start, sweep: coverage.sweep } } : {}) }),
  };
}

const emptyBounds = () => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
function include(bounds, lines) {
  for (const line of lines) for (const [x, y] of line) {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  }
  return bounds;
}
// The middle of the cited geometry (or the whole model) is the orbit pivot.
function centerOf(wires) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const wire of wires) for (const point of [...wire.edges.flat(), ...wire.cylinders.map(cylinder => cylinder.center)]) {
    point.forEach((value, axis) => { low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value); });
  }
  return low.map((value, axis) => (value + high[axis]) / 2);
}
function padded(bounds, fraction = 0.12) {
  const margin = Math.max((bounds.maxX - bounds.minX) * fraction, (bounds.maxY - bounds.minY) * fraction, 1e-6);
  return { minX: bounds.minX - margin, minY: bounds.minY - margin, maxX: bounds.maxX + margin, maxY: bounds.maxY + margin };
}

/** Isometric wireframe of the preserved STEP version. The cited part (and
 * feature) is selected by its indexed identity; a missing identity is an
 * error rather than a fallback to another part. Coordinates are model units.
 * Each element also carries its edges and cylinders in 3D, so a client can
 * turn the view around `orbit.pivot`. */
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
  const tidy = rounding(decimals);
  const elements = [], warnings = [...scene.warnings], wires = [];
  let points = 0, skipped = 0;
  for (const { occurrence, index } of order) {
    const source = scene.parts[occurrence.part];
    const chosen = isSelected(occurrence.part);
    const size = Object.values(source.edges).reduce((total, line) => total + line.length, 0);
    if (!chosen && points + size > MAX_PREVIEW_POINTS) { skipped++; continue; }
    points += size;
    const identity = { id: index, guid: source.key, label: occurrence.label, entityType: 'PART', role: 'context', polygons: [] };
    for (const wire of placeWires(source, occurrence.matrix, chosen, featureEdges, featureCylinders)) {
      const lines = projectWireframe(wire, ISOMETRIC);
      if (!lines.length) continue;
      wires.push(wire);
      elements.push({ ...identity, selected: wire.selected, lines: tidy.lines(lines), edges: tidy.lines(wire.edges),
        cylinders: wire.cylinders.map(tidy.cylinder) });
    }
  }
  if (skipped) warnings.push(`${skipped} component instance${skipped === 1 ? ' is' : 's are'} omitted from this preview to keep it responsive.`);
  if (!elements.length) throw new Error('This STEP file contains no drawable edges.');
  const bounds = elements.reduce((total, element) => include(total, element.lines), emptyBounds());
  const selectedLines = elements.filter(element => element.selected).flatMap(element => element.lines);
  const focusBounds = selectedLines.length ? padded(include(emptyBounds(), selectedLines)) : bounds;
  const selected = assembly ? { id: null, guid: ASSEMBLY_ELEMENT, label: scene.rootName || 'Assembly', entityType: 'Assembly' }
    : part ? { id: selectedPart, guid: part.key, label: feature ? `${part.name} · ${feature.name}` : part.name,
      entityType: feature ? feature.name : featureId ? `Overall ${String(featureId).slice(7)} extent` : 'Part' } : null;
  const cited = wires.filter(wire => wire.selected);
  const orbit = { ...ISOMETRIC_CAMERA, pivot: centerOf(cited.length ? cited : wires).map(tidy.round) };
  return { kind: 'model-plan', format: 'step', sourceHash, units: scene.units || 'model units', projection: 'isometric', view: 'Isometric view',
    fillRule: 'evenodd', elements, bounds, focusBounds, selected, storey: null, orbit, warnings };
}
