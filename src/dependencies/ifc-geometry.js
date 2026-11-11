import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { pooled } from '../worker-pool.js';

const MAX_BYTES = 64_000_000;
const MAX_CACHE_ENTRIES = 3;
const MAX_CACHE_BYTES = 32_000_000;
const MAX_PENDING = 4;
/** Raised with the worker's union method; older stored models are dropped. */
export const IFC_MODEL_VERSION = 2;
const cache = new Map();
let cacheBytes = 0, pending = 0, queue = Promise.resolve();
/** Models kept on disk by content, so a drawing is worked out once, not once
 * per launch. Like the caches here it is derived data and may be missing. */
let modelStore = null;

export function keepIfcModelsIn(store) {
  modelStore = store;
}

/** Failures that say nothing about the file itself and so are not remembered. */
const passingFailure = message => /processing limit|busy|exited before|no longer waiting/.test(message);

function abandoned() {
  const error = new Error('The IFC preview was not made: no one is waiting for it any more.');
  error.name = 'AbortError';
  return error;
}

/** Waits for a model unless `signal` gives up first, such as a file clicked past. */
function waitFor(entry, signal) {
  entry.waiters += 1;
  if (!signal) return entry.promise;
  return new Promise((resolve, reject) => {
    const abort = () => { entry.waiters -= 1; reject(abandoned()); };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function remember(sourceHash, entry, model) {
  entry.size = Buffer.byteLength(JSON.stringify(model));
  cacheBytes += entry.size;
  for (const [hash, value] of cache) {
    if (cache.size <= MAX_CACHE_ENTRIES && cacheBytes <= MAX_CACHE_BYTES) break;
    if (!value.size) continue;
    cache.delete(hash); cacheBytes -= value.size;
  }
}

// Someone is waiting to see this model, so it goes before waiting indexing.
function runWorker(bytes) {
  return pooled(() => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ifc-geometry-worker.js', import.meta.url), {
      workerData: { bytes }, resourceLimits: { maxOldGenerationSizeMb: 256 },
      // Parent CLI/test-runner flags may be invalid for a file worker.
      execArgv: [],
    });
    let finished = false;
    const finish = (error, result) => {
      if (finished) return;
      finished = true; clearTimeout(timeout); void worker.terminate();
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('IFC visual preview exceeded the 30-second processing limit.')), 30_000);
    worker.once('message', message => finish(message.error ? new Error(message.error) : null, message.model));
    worker.once('error', error => finish(error));
    worker.once('exit', code => { if (!finished) finish(new Error(`IFC geometry worker exited before producing a preview (${code}).`)); });
  }), { interactive: true });
}

async function modelFor(bytes, sourceHash, signal) {
  const cached = cache.get(sourceHash);
  if (cached) {
    cache.delete(sourceHash); cache.set(sourceHash, cached);
    return waitFor(cached, signal);
  }
  const stored = modelStore?.get(sourceHash);
  if (stored?.error) throw new Error(stored.error);
  if (stored?.model) {
    const entry = { size: 0, waiters: 0, promise: Promise.resolve(stored.model) };
    cache.set(sourceHash, entry);
    remember(sourceHash, entry, stored.model);
    return stored.model;
  }
  if (pending >= MAX_PENDING) throw new Error('IFC visual preview is busy. Please retry shortly.');
  pending++;
  const entry = { size: 0, waiters: 0, promise: null };
  // Models are made one at a time. One whose every caller has gone by its
  // turn is skipped, so a run of files clicked past never holds up the last.
  const forget = () => { if (cache.get(sourceHash) === entry) cache.delete(sourceHash); };
  entry.promise = queue.then(() => {
    // Forgotten at once, so a new request for the file starts afresh.
    if (!entry.waiters) { forget(); throw abandoned(); }
    return runWorker(bytes);
  }).then(model => {
    remember(sourceHash, entry, model);
    modelStore?.set(sourceHash, { model });
    return model;
  }).catch(error => {
    forget();
    if (error.name !== 'AbortError' && !passingFailure(error.message)) modelStore?.set(sourceHash, { error: error.message });
    throw error;
  }).finally(() => { pending--; });
  queue = entry.promise.catch(() => {});
  cache.set(sourceHash, entry);
  return waitFor(entry, signal);
}

function combinedBounds(elements) {
  return elements.reduce((bounds, element) => ({ minX: Math.min(bounds.minX, element.bounds.minX),
    minY: Math.min(bounds.minY, element.bounds.minY), maxX: Math.max(bounds.maxX, element.bounds.maxX),
    maxY: Math.max(bounds.maxY, element.bounds.maxY) }),
  { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}
function padded(bounds, fraction = 0.2) {
  const margin = Math.max(0.6, (bounds.maxX - bounds.minX) * fraction, (bounds.maxY - bounds.minY) * fraction);
  return { minX: bounds.minX - margin, minY: bounds.minY - margin, maxX: bounds.maxX + margin, maxY: bounds.maxY + margin };
}
const identity = entity => entity ? { id: entity.id, guid: entity.guid, label: entity.label, entityType: entity.entityType } : null;

/** Build a source-version-specific plan from actual IFC representations.
 * Explicit anchors never fall back to a nearby name or another element. A
 * product type/spatial container may select its explicitly related instances.
 * Rings use even-odd fill, including holes; coordinates are IFC XY in metres.
 */
export async function buildIfcPlan(buffer, { elementId = null, stepId = null, storey = null, signal = null } = {}) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('IFC visual preview requires a nonempty file under 64 MB.');
  const sourceHash = createHash('sha256').update(bytes).digest('hex');
  const model = await modelFor(bytes, sourceHash, signal);
  const guid = elementId == null ? null : String(elementId);
  const step = stepId == null ? null : Number(String(stepId).replace(/^#/, ''));
  const selected = guid ? model.entities.find(entity => entity.guid === guid)
    : step != null ? model.entities.find(entity => entity.id === step) : null;
  if ((guid || step != null) && !selected) throw new Error('The cited IFC element is not present in this source version.');
  if (selected && step != null && selected.id !== step) throw new Error('The IFC GUID and STEP identifier do not identify the same source element.');
  const parents = new Map(model.parents), instances = new Map(model.instances);
  function isDescendant(id, ancestor) {
    const seen = new Set();
    while (id && !seen.has(id)) {
      if (id === ancestor) return true;
      seen.add(id); id = parents.get(id);
    }
    return false;
  }
  const instanceIds = selected ? new Set(instances.get(selected.id) ?? []) : new Set();
  const ownGeometry = selected && model.elements.find(element => element.id === selected.id);
  const targets = ownGeometry ? [ownGeometry] : selected ? model.elements.filter(element =>
    isDescendant(element.id, selected.id) || instanceIds.has(element.id)) : [];
  if (selected && !targets.length) throw new Error(`No supported geometric representation is available for ${selected.label} in this IFC source.`);
  let storeyEntity = storey == null ? null : model.storeys.find(entity => entity.guid === String(storey) || entity.id === Number(storey));
  if (storey != null && !storeyEntity) throw new Error('The requested storey is not present in this IFC source.');
  if (!storeyEntity && targets.length) {
    const storeyIds = new Set(targets.map(element => element.storeyId).filter(Boolean));
    if (storeyIds.size === 1) storeyEntity = model.storeys.find(entity => entity.id === [...storeyIds][0]);
  }
  if (!storeyEntity && !selected) {
    // A whole-file preview opens the lowest inhabited storey instead of
    // superimposing several unrelated floor plans into an unreadable drawing.
    storeyEntity = [...model.storeys].filter(floor => model.elements.some(element => element.storeyId === floor.id && element.role === 'space'))
      .sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0))[0] ?? null;
  }
  const targetIds = new Set(targets.map(element => element.id));
  const elements = model.elements.filter(element => targetIds.has(element.id)
    || ((!storeyEntity || element.storeyId === storeyEntity.id) && element.entityType !== 'IFCOPENINGELEMENT'))
    .map(({ hasRepresentation, elevation, ...element }) => ({ ...element, selected: targetIds.has(element.id) }));
  const rank = element => element.selected ? 4 : /SLAB|ROOF|SITE/.test(element.entityType) ? 0 : element.role === 'space' ? 1 : 2;
  elements.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  if (!elements.length) throw new Error('The requested IFC view contains no supported geometry.');
  const bounds = combinedBounds(elements);
  return { kind: 'model-plan', format: 'ifc', sourceHash, units: 'm', projection: 'plan', fillRule: 'evenodd',
    elements, bounds, focusBounds: padded(targets.length ? combinedBounds(targets) : bounds),
    selected: identity(selected), storey: identity(storeyEntity), warnings: [...model.warnings] };
}
