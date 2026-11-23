"""Renders lasso-head-preview.png from the STL files (run after gen.py).

A small depth-buffered renderer, so hidden faces stay hidden.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh

HERE = Path(__file__).resolve().parent
BACKGROUND = np.array([0.957, 0.945, 0.918])
PX_PER_MM = 7.0
SIZE = 760  # pixels per view before downsampling by 2

# The STLs stand on z = 0 with the face towards -y. Turn them so y is up and
# the face points at +z, the way the renderer looks.
UPRIGHT = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], dtype=float)


def load(name):
    mesh = trimesh.load(HERE / name)
    mesh.apply_transform(UPRIGHT)
    return mesh


PARTS = [
    (load("lasso-head.stl"), np.array([0.05, 0.05, 0.055]), 0.45),
    (load("lasso-head-eyes.stl"), np.array([0.94, 0.94, 0.93]), 0.2),
]


def basis(azimuth, elevation):
    az, el = np.radians(azimuth), np.radians(elevation)
    toward_camera = np.array([np.sin(az) * np.cos(el), np.sin(el), np.cos(az) * np.cos(el)])
    right = np.cross([0.0, 1.0, 0.0], toward_camera)
    right /= np.linalg.norm(right)
    up = np.cross(toward_camera, right)
    return right, up, toward_camera


def render(azimuth, elevation):
    right, up, toward = basis(azimuth, elevation)
    light = toward + np.array([-0.7, 1.0, 0.3]); light /= np.linalg.norm(light)
    half = (light + toward) / np.linalg.norm(light + toward)
    depth = np.full((SIZE, SIZE), -np.inf)
    image = np.tile(BACKGROUND, (SIZE, SIZE, 1))
    centre = np.array([0.0, 35.0, 0.0])
    for mesh, base, gloss in PARTS:
        v = mesh.vertices - centre
        sx = v @ right * PX_PER_MM + SIZE / 2
        sy = SIZE / 2 - v @ up * PX_PER_MM
        sz = v @ toward
        normals = mesh.vertex_normals
        for f, n in zip(mesh.faces, mesh.face_normals):
            if n @ toward <= 0:
                continue
            xs, ys, zs = sx[f], sy[f], sz[f]
            x0, x1 = int(max(np.floor(xs.min()), 0)), int(min(np.ceil(xs.max()), SIZE - 1))
            y0, y1 = int(max(np.floor(ys.min()), 0)), int(min(np.ceil(ys.max()), SIZE - 1))
            if x1 < x0 or y1 < y0:
                continue
            px, py = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            d = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2])
            if abs(d) < 1e-12:
                continue
            w0 = ((ys[1] - ys[2]) * (px - xs[2]) + (xs[2] - xs[1]) * (py - ys[2])) / d
            w1 = ((ys[2] - ys[0]) * (px - xs[2]) + (xs[0] - xs[2]) * (py - ys[2])) / d
            w2 = 1 - w0 - w1
            inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not inside.any():
                continue
            z = w0 * zs[0] + w1 * zs[1] + w2 * zs[2]
            window = depth[y0:y1 + 1, x0:x1 + 1]
            closer = inside & (z > window)
            if not closer.any():
                continue
            # Smooth shading from the vertex normals.
            nv = (w0[..., None] * normals[f[0]] + w1[..., None] * normals[f[1]] + w2[..., None] * normals[f[2]])
            nv /= np.linalg.norm(nv, axis=-1, keepdims=True) + 1e-12
            diffuse = np.clip(nv @ light, 0, 1)[..., None]
            specular = gloss * np.clip(nv @ half, 0, 1)[..., None] ** 30
            rim = 0.10 * (1 - np.clip(nv @ toward, 0, 1))[..., None] ** 2
            colour = np.clip(base * (0.35 + 0.65 * diffuse) + specular + rim, 0, 1)
            window[closer] = z[closer]
            image[y0:y1 + 1, x0:x1 + 1][closer] = colour[closer]
    return image.reshape(SIZE // 2, 2, SIZE // 2, 2, 3).mean(axis=(1, 3))


views = [("Three-quarter", -35, 12), ("Front", 0, 4), ("Side", 90, 4), ("From behind", 150, 18)]
report = json.loads((HERE / "report.json").read_text())
w, d, h = report["head"]["size_mm"]
fig, axes = plt.subplots(1, len(views), figsize=(4.2 * len(views), 4.9), facecolor=BACKGROUND)
for ax, (title, az, el) in zip(axes, views):
    ax.imshow(render(az, el), interpolation="lanczos")
    ax.set_title(title, color="#333", fontsize=12)
    ax.set_axis_off()
fig.suptitle(f"Lasso head  ·  {w:g} wide, {d:g} deep, {h:g} tall (mm)  ·  black, white eyes",
             color="#222", fontsize=14)
plt.subplots_adjust(left=0.01, right=0.99, bottom=0.01, top=0.86, wspace=0.02)
fig.savefig(HERE / "lasso-head-preview.png", dpi=110, facecolor=BACKGROUND)
