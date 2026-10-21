import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ISOMETRIC_CAMERA, cameraAxes, cylinderSilhouettes, orbitCamera, orbitOf, projectPoint, projectWireframe, shiftInView,
} from '../public/model-orbit.js';

const near = (actual, expected, what) => {
  assert.equal(actual.length, expected.length, what);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-9, `${what}: ${actual} ≉ ${expected}`));
};
const shaft = { center: [0, 0, 0], axis: [0, 0, 1], xdir: [1, 0, 0], ydir: [0, 1, 0], radius: 2, h0: 0, h1: 10 };

test('the default camera is the classic isometric view looking down (1, 1, 1) with Z up', () => {
  const axes = cameraAxes(ISOMETRIC_CAMERA);
  near(axes.right, [-Math.SQRT1_2, Math.SQRT1_2, 0], 'right');
  near(axes.up, [-1 / Math.sqrt(6), -1 / Math.sqrt(6), 2 / Math.sqrt(6)], 'up');
  near(axes.toward, [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], 'toward');
});

test('turning the camera keeps model Z vertical on screen and returns after a full turn', () => {
  const front = { azimuth: 0, elevation: 0 };
  near(projectPoint([0, 1, 0], cameraAxes(front)), [1, 0], 'Y runs to the right seen from +X');
  near(projectPoint([0, 0, 1], cameraAxes(front)), [0, 1], 'Z is up');
  const turned = orbitCamera(ISOMETRIC_CAMERA, Math.PI / 3, 0);
  const [x] = projectPoint([0, 0, 5], cameraAxes(turned));
  assert.ok(Math.abs(x) < 1e-12, 'a Z edge stays vertical at any azimuth');
  const back = orbitCamera(orbitCamera(ISOMETRIC_CAMERA, Math.PI, 0), Math.PI, 0);
  near([back.azimuth, back.elevation], [ISOMETRIC_CAMERA.azimuth, ISOMETRIC_CAMERA.elevation], 'full turn');
});

test('elevation stops short of the top and bottom views instead of flipping the model over', () => {
  const top = orbitCamera(ISOMETRIC_CAMERA, 0, 10);
  const bottom = orbitCamera(ISOMETRIC_CAMERA, 0, -10);
  assert.ok(top.elevation < Math.PI / 2 && top.elevation > Math.PI / 2 - .01);
  assert.equal(bottom.elevation, -top.elevation);
  assert.ok(cameraAxes(top).up[2] > 0, 'model Z still points up the screen');
  assert.deepEqual(orbitCamera(top, 0, 1), top);
});

test('cylinder silhouettes follow the camera and respect partial coverage', () => {
  const axes = cameraAxes(ISOMETRIC_CAMERA);
  const lines = cylinderSilhouettes(shaft, axes.toward);
  assert.equal(lines.length, 2);
  for (const [start, end] of lines) {
    assert.ok(Math.abs(Math.hypot(start[0], start[1]) - 2) < 1e-9, 'generators lie on the surface');
    near([end[2] - start[2]], [10], 'generators run the full height');
  }
  const front = cylinderSilhouettes(shaft, cameraAxes({ azimuth: 0, elevation: 0 }).toward);
  near(front.map(([start]) => start[1]).sort(), [-2, 2], 'seen from +X the outline is at Y = ±r');
  const half = { ...shaft, coverage: { start: 0, sweep: Math.PI } };
  assert.deepEqual(cylinderSilhouettes(half, [1, 0, 0]).map(([start]) => Math.sign(start[1])), [1], 'only the covered half');
  assert.deepEqual(cylinderSilhouettes(shaft, [0, 0, 1]), [], 'end-on cylinders have no generators');
});

test('a wireframe projects its edges, then its silhouettes', () => {
  const axes = cameraAxes({ azimuth: 0, elevation: 0 });
  const lines = projectWireframe({ edges: [[[0, 0, 0], [0, 3, 4]]], cylinders: [shaft] }, axes);
  assert.equal(lines.length, 3);
  near(lines[0].flat(), [0, 0, 3, 4], 'edge');
  near(lines[1].flat().concat(lines[2].flat()).map(Math.abs), [2, 0, 2, 10, 2, 0, 2, 10], 'silhouettes');
});

test('panning moves the orbit target within the screen plane, so turning back restores the view', () => {
  const axes = cameraAxes(ISOMETRIC_CAMERA);
  const pivot = [10, 20, 5];
  const target = shiftInView(pivot, axes, 3, -4);
  const [x, y] = projectPoint(pivot, axes);
  near(projectPoint(target, axes), [x + 3, y - 4], 'the target moves by the screen offset');
  near([target[0] * axes.toward[0] + target[1] * axes.toward[1] + target[2] * axes.toward[2]],
    [pivot[0] * axes.toward[0] + pivot[1] * axes.toward[1] + pivot[2] * axes.toward[2]], 'at the same depth');
  const turned = orbitCamera(ISOMETRIC_CAMERA, .7, .3);
  const back = orbitCamera(turned, -.7, -.3);
  near(projectPoint(target, cameraAxes(back)), [x + 3, y - 4], 'the same target is centred again');
});

test('only a valid camera, pivot and 3D wireframe make a preview orbitable', () => {
  const element = { lines: [[[0, 0], [1, 1]]], edges: [[[0, 0, 0], [1, 1, 1]]], cylinders: [] };
  const preview = { orbit: { ...ISOMETRIC_CAMERA, pivot: [0, 0, 0] }, elements: [element] };
  assert.deepEqual(orbitOf(preview).pivot, [0, 0, 0]);
  assert.equal(orbitOf({ ...preview, orbit: { ...preview.orbit, pivot: [0, NaN, 0] } }), null);
  assert.equal(orbitOf({ ...preview, orbit: { azimuth: 'x', elevation: 0, pivot: [0, 0, 0] } }), null);
  assert.equal(orbitOf({ ...preview, elements: [{ lines: element.lines }] }), null, 'plans stay flat');
  assert.equal(orbitOf({ elements: [element] }), null);
});
