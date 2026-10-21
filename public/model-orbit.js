// Orbit camera for 3D wireframe previews (STEP). The camera is a turntable:
// azimuth turns about model +Z, elevation tilts toward a top view, and +Z stays
// up on screen. The projection is orthographic, so a camera is two screen axes.
// The server projects its default view with this code, so the first frame a
// client redraws matches the lines it was sent.
const TAU = Math.PI * 2;
// Short of a straight top or bottom view, so the screen's up stays defined.
const ELEVATION_LIMIT = Math.PI / 2 - Math.PI / 360;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const finitePoint = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

/** Looking down (1, 1, 1), where the three model axes foreshorten equally. */
export const ISOMETRIC_CAMERA = Object.freeze({ azimuth: Math.PI / 4, elevation: Math.atan(Math.SQRT1_2) });

/** The camera turned by the given angles. Elevation stops short of the poles. */
export function orbitCamera(camera, azimuthTurn, elevationTurn) {
  const turned = camera.azimuth + azimuthTurn;
  return {
    azimuth: turned - TAU * Math.floor(turned / TAU),
    elevation: Math.min(ELEVATION_LIMIT, Math.max(-ELEVATION_LIMIT, camera.elevation + elevationTurn)),
  };
}

/** Screen axes of a camera: right, up, and toward the viewer. */
export function cameraAxes({ azimuth, elevation }) {
  const ca = Math.cos(azimuth), sa = Math.sin(azimuth), ce = Math.cos(elevation), se = Math.sin(elevation);
  return { right: [-sa, ca, 0], up: [-se * ca, -se * sa, ce], toward: [ce * ca, ce * sa, se] };
}

export const projectPoint = (point, axes) => [dot(point, axes.right), dot(point, axes.up)];

/** Generators where a cylinder turns away from the viewer, as 3D segments. A
 * wireframe would otherwise show a shaft as two unconnected circles. */
export function cylinderSilhouettes(cylinder, toward) {
  const normal = cross(cylinder.axis, toward);
  const size = Math.hypot(...normal);
  if (size < 1e-6) return [];
  const lines = [];
  for (const sign of [1, -1]) {
    const direction = normal.map(value => value * sign / size);
    const angle = Math.atan2(dot(direction, cylinder.ydir), dot(direction, cylinder.xdir));
    if (cylinder.coverage && ((angle - cylinder.coverage.start) % TAU + TAU) % TAU > cylinder.coverage.sweep) continue;
    const at = height => cylinder.center.map((value, index) => value + direction[index] * cylinder.radius + cylinder.axis[index] * height);
    lines.push([at(cylinder.h0), at(cylinder.h1)]);
  }
  return lines;
}

/** A wireframe's screen polylines: its edges, then its cylinders' silhouettes. */
export function projectWireframe({ edges = [], cylinders = [] }, axes) {
  const project = line => line.map(point => projectPoint(point, axes));
  return [...edges.map(project), ...cylinders.flatMap(cylinder => cylinderSilhouettes(cylinder, axes.toward).map(project))];
}

/** A model point moved by a screen offset, at the same depth. The view keeps
 * one such point centred, so turning the camera orbits around it. */
export function shiftInView(point, axes, dx, dy) {
  return point.map((value, index) => value + axes.right[index] * dx + axes.up[index] * dy);
}

/** The camera and pivot of a preview whose every wireframe carries its 3D
 * edges, or null for flat plans and malformed data. */
export function orbitOf(preview) {
  const orbit = preview?.orbit;
  if (!Number.isFinite(orbit?.azimuth) || !Number.isFinite(orbit?.elevation) || Math.abs(orbit.elevation) > Math.PI / 2
    || !finitePoint(orbit.pivot, 3)) return null;
  const wires = (preview.elements ?? []).filter(element => element.lines?.length);
  if (!wires.length || !wires.every(element => Array.isArray(element.edges) && Array.isArray(element.cylinders))) return null;
  return { azimuth: orbit.azimuth, elevation: orbit.elevation, pivot: [...orbit.pivot] };
}
