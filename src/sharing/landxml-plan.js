// A LandXML model drawn in plan, as a civil engineer sees it in Civil 3D:
// parcel outlines, alignment centrelines with their curves, pipes between
// their structures, and survey points, the cited element highlighted. Only
// coordinates the file states are drawn. LandXML writes a point northing
// first, so x is the easting and y the northing.

import { parseXml } from '../dependencies/xml-tree.js';
import { textNumbers } from '../dependencies/landxml-elements.js';

const ARC_STEPS = 24;
const MAX_LABELS = 60;
const STRUCTURE_SIZE = 0.006;
const POINT_SIZE = 0.003;
const FOCUS_MARGIN = 0.2;
const CONTEXT_MARGIN = 0.08;
const LABEL_SIZE = 0.06;

const childrenNamed = (node, name) => node.children.filter((child) => child.name === name);

/** A plan point [easting, northing] from a coordinate element or the survey point it names. */
function planPoint(node, points) {
  if (!node) return null;
  if (node.attributes.pntRef) return points.get(node.attributes.pntRef) ?? null;
  const [northing, easting] = textNumbers(node);
  return northing == null || easting == null ? null : [easting, northing];
}

/** An arc from start to end about its centre, turning the way the file says. */
function arcPoints(start, center, end, clockwise) {
  const radius = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const from = Math.atan2(start[1] - center[1], start[0] - center[0]);
  let sweep = Math.atan2(end[1] - center[1], end[0] - center[0]) - from;
  if (clockwise && sweep > 0) sweep -= 2 * Math.PI;
  if (!clockwise && sweep < 0) sweep += 2 * Math.PI;
  return Array.from({ length: ARC_STEPS + 1 }, (_, step) => {
    const angle = from + (sweep * step) / ARC_STEPS;
    return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  });
}

/** The polyline of a CoordGeom, and each of its curves on its own. */
function coordGeomPath(geometry, points) {
  const path = [];
  const curves = [];
  const append = (vertices) => {
    for (const vertex of vertices) {
      const last = path.at(-1);
      if (!last || Math.hypot(last[0] - vertex[0], last[1] - vertex[1]) > 1e-9) path.push(vertex);
    }
  };
  for (const part of geometry.children) {
    const start = planPoint(childrenNamed(part, 'Start')[0], points);
    const end = planPoint(childrenNamed(part, 'End')[0], points);
    if (!start || !end) continue;
    const center = part.name === 'Curve' ? planPoint(childrenNamed(part, 'Center')[0], points) : null;
    const vertices = center ? arcPoints(start, center, end, part.attributes.rot === 'cw') : [start, end];
    append(vertices);
    if (part.name === 'Curve') curves.push({ node: part, vertices });
  }
  return { path, curves };
}

function boundsOf(vertices) {
  const xs = vertices.map((vertex) => vertex[0]);
  const ys = vertices.map((vertex) => vertex[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

const square = ([x, y], half) => [[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]];

/** Everything the plan can draw, before sizes that depend on the whole extent are known. */
function planParts(root) {
  const points = new Map();
  const parts = [];
  for (const collection of childrenNamed(root, 'CgPoints')) for (const point of childrenNamed(collection, 'CgPoint')) {
    const at = planPoint({ ...point, attributes: {} }, points);
    if (!at || !point.attributes.name) continue;
    points.set(point.attributes.name, at);
    parts.push({ node: point, label: `Point ${point.attributes.name}`, entityType: 'CgPoint', marker: at, size: POINT_SIZE });
  }
  for (const collection of childrenNamed(root, 'Parcels')) for (const parcel of childrenNamed(collection, 'Parcel')) {
    for (const geometry of childrenNamed(parcel, 'CoordGeom')) {
      const { path: traced } = coordGeomPath(geometry, points);
      // A closed boundary ends where it began; the ring states that corner once.
      const closes = traced.length > 3 && Math.hypot(traced[0][0] - traced.at(-1)[0], traced[0][1] - traced.at(-1)[1]) < 1e-9;
      const path = closes ? traced.slice(0, -1) : traced;
      if (path.length >= 3) parts.push({ node: parcel, label: `Parcel ${parcel.attributes.name ?? ''}`.trim(), entityType: 'Parcel', role: 'space', polygon: path });
    }
  }
  for (const collection of childrenNamed(root, 'Alignments')) for (const alignment of childrenNamed(collection, 'Alignment')) {
    for (const geometry of childrenNamed(alignment, 'CoordGeom')) {
      const { path, curves } = coordGeomPath(geometry, points);
      if (path.length >= 2) parts.push({ node: alignment, label: `Alignment ${alignment.attributes.name ?? ''}`.trim(), entityType: 'Alignment', line: path });
      curves.forEach((curve, index) => parts.push({ node: curve.node, label: `${alignment.attributes.name ?? 'Alignment'} curve ${index + 1}`, entityType: 'Curve', line: curve.vertices }));
    }
  }
  for (const networks of childrenNamed(root, 'PipeNetworks')) for (const network of childrenNamed(networks, 'PipeNetwork')) {
    const centres = new Map();
    for (const structs of childrenNamed(network, 'Structs')) for (const structure of childrenNamed(structs, 'Struct')) {
      const at = planPoint(childrenNamed(structure, 'Center')[0], points);
      if (!at || !structure.attributes.name) continue;
      centres.set(structure.attributes.name, at);
      parts.push({ node: structure, label: `Structure ${structure.attributes.name}`, entityType: 'Struct', marker: at, size: STRUCTURE_SIZE, named: structure.attributes.name });
    }
    for (const pipes of childrenNamed(network, 'Pipes')) for (const pipe of childrenNamed(pipes, 'Pipe')) {
      const from = centres.get(pipe.attributes.refStart);
      const to = centres.get(pipe.attributes.refEnd);
      if (from && to) parts.unshift({ node: pipe, label: `Pipe ${pipe.attributes.name ?? ''}`.trim(), entityType: 'Pipe', line: [from, to] });
    }
  }
  return parts;
}

/** The drawn element of a cited value: the deepest one whose path holds the value's element. */
function selectedPart(parts, elementId) {
  if (!elementId) return null;
  return parts.filter((part) => elementId === part.node.path || elementId.startsWith(`${part.node.path}/`))
    .sort((a, b) => b.node.path.length - a.node.path.length)[0] ?? null;
}

/**
 * The plan of a LandXML file, or null when it states no coordinates to draw
 * or none for the cited element. `cited` is the value the card shows, if any.
 */
export function buildLandXmlPlan(content, cited = null) {
  let root;
  try {
    root = parseXml(Buffer.from(content).toString('utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const parts = planParts(root);
  if (!parts.length) return null;
  const selected = selectedPart(parts, cited?.elementId);
  if (cited && !selected) return null;
  const extent = boundsOf(parts.flatMap((part) => part.polygon ?? part.line ?? [part.marker]));
  const span = Math.max(extent.maxX - extent.minX, extent.maxY - extent.minY, 1);
  const elements = parts.map((part, index) => {
    const vertices = part.polygon ?? part.line ?? square(part.marker, span * part.size);
    return {
      id: index + 1, guid: part.node.path, label: part.label, entityType: part.entityType,
      role: part.role ?? 'context', selected: part === selected,
      ...(part.line ? { lines: [part.line] } : { polygons: [vertices] }),
      bounds: boundsOf(vertices),
    };
  });
  const bounds = { minX: extent.minX - span * 0.02, minY: extent.minY - span * 0.02, maxX: extent.maxX + span * 0.02, maxY: extent.maxY + span * 0.02 };
  const chosen = elements.find((element) => element.selected);
  const focus = chosen?.bounds ?? bounds;
  const margin = Math.max((focus.maxX - focus.minX) * FOCUS_MARGIN, (focus.maxY - focus.minY) * FOCUS_MARGIN, span * CONTEXT_MARGIN);
  const focusBounds = { minX: focus.minX - margin, minY: focus.minY - margin, maxX: focus.maxX + margin, maxY: focus.maxY + margin };
  // Structure names, as a plan labels its manholes, sized to the part of the plan in view.
  const named = parts.filter((part) => part.named);
  const labelHeight = (focusBounds.maxY - focusBounds.minY) * LABEL_SIZE;
  const drawing = named.length <= MAX_LABELS ? named.map((part, index) => ({
    id: `label-${index + 1}`, type: 'text', text: part.named, height: labelHeight, elevation: 0,
    point: [part.marker[0] + span * part.size * 1.6, part.marker[1] + span * part.size * 1.6],
  })) : [];
  return {
    kind: 'model-plan', format: 'landxml', projection: 'plan', fillRule: 'evenodd',
    elements, drawing, bounds, focusBounds, view: 'Plan view', storey: null, warnings: [],
    selected: chosen ? { label: cited ? `${cited.label} ${cited.value}` : chosen.label, entityType: chosen.entityType } : null,
  };
}
