"""Builds a printable 3D Lasso mascot: a head wearing a cowboy hat, with white eyes.

The drawing (lasso-mascot.svg) is read as a front view. Its outline gives the
head's width and round chin, the hat's creased crown and the brim that curls up
at the sides; the depth is designed to suit it. Everything is described as
smooth distance functions and turned into closed meshes with marching cubes.

It prints standing on its flat base with no supports: the brim rises from the
head at about 39 degrees and curls up more towards its tips, so its underside
stays within about 53 degrees of vertical. The eyes sit in flat-bottomed
sockets 1.5 mm deep. Print them apart in white (lasso-head-eye-inserts.stl,
flat side down) and glue them in, or print lasso-head-eyes.stl in place on a
multi-colour printer, which costs a filament swap on every layer of the eyes.

Drawing units are SVG units (the head is 50 wide); SCALE turns them into mm.

Needs: pip install numpy shapely trimesh manifold3d scikit-image networkx
Run:   python gen.py [output_dir]
"""

import json
import sys
from pathlib import Path

import manifold3d
import numpy as np
import shapely
import trimesh
from shapely.geometry import Polygon
from skimage.measure import marching_cubes

HERE = Path(__file__).resolve().parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE

SCALE = 1.1         # mm per drawing unit: about 89 mm wide and 69 mm tall
STEP = 0.22         # grid step in drawing units (0.24 mm)
BASE_Z = 5.5        # the round chin is cut flat here so it sits on a desk

HEAD_HALF_WIDTH = 25.0
HEAD_HALF_DEPTH = 21.0
HEAD_ROUNDNESS = 2.5        # superellipse power: 2 is an ellipse, higher is boxier

BRIM_Z = 39.0               # brim mid-surface height where it leaves the hat
BRIM_INNER = (24.5, 20.6)   # where the brim meets the hat (half width, half depth)
BRIM_OUTER = (40.7, 29.0)   # brim edge
BRIM_THICK = 2.2
BRIM_RISE = 0.8             # brim slope by the hat (0.8 is about 39 degrees)
BRIM_CURL = 3.6             # extra lift at the side tips
BRIM_CURL_FROM = 0.6        # fraction of the brim width where the curl begins
BRIM_SIDES = 4.0            # how quickly the curl fades from the sides to the front
BRIM_ROLL = 2.3             # radius of the rolled edge at the side tips

EYE_CENTRES_X = (-8.5, 8.5)
EYE_CENTRE_Z = 86.0 - (51.39 + 17.54 / 2)   # from the eye rectangles in the SVG
EYE_RADIUS = 6.38 / 2
EYE_HALF_STRAIGHT = (17.54 - 6.38) / 2
EYE_DOME = 0.6              # eyes bulge this much past the face
EYE_SOCKET_MIN = 1.4        # thinnest white over the black socket floor
INSERT_CLEARANCE_MM = 0.12  # per side, for the glue-in eye inserts


# ---------------------------------------------------------------- helpers

def bezier(p0, p1, p2, p3, n=400):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = map(np.asarray, (p0, p1, p2, p3))
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3


def svg_point(x, y):
    """SVG (x, y) to drawing (half-width from the centre line, height from the chin)."""
    return (50.0 - x, 86.0 - y)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def superellipse_distance(x, y, a, b, p):
    """Approximate signed distance to |x/a|^p + |y/b|^p = 1 (negative inside)."""
    u, v = np.abs(x) / a, np.abs(y) / b
    r = np.maximum((u ** p + v ** p) ** (1 / p), 1e-4)
    gu = u ** (p - 1) / a
    gv = v ** (p - 1) / b
    grad = r ** (1 - p) * np.sqrt(gu ** 2 + gv ** 2) + 1e-9
    return (r - 1) / grad


def ellipse_radius(theta, a, b):
    return a * b / np.sqrt((b * np.cos(theta)) ** 2 + (a * np.sin(theta)) ** 2)


# ---------------------------------------------------------------- profiles from the drawing

# Chin: SVG "L25 65 C25 78 35 86 50 86" seen from the front.
_chin = np.array([svg_point(*p) for p in bezier((25, 65), (25, 78), (35, 86), (50, 86))])


def head_scale(z):
    """Head width at height z as a fraction of its full width."""
    w = np.interp(z, _chin[::-1, 1], _chin[::-1, 0], left=0.0, right=HEAD_HALF_WIDTH)
    return np.where(z >= _chin[0, 1], 1.0, np.maximum(w, 0.5) / HEAD_HALF_WIDTH)


# Crown: SVG "C28 29 29 21 33 18 C37 15 42 22 50 22" above the brim at (26, 34).
_crown_side = np.array([svg_point(*p) for p in bezier((26, 34), (28, 29), (29, 21), (33, 18))])
_crown_top = np.array([svg_point(*p) for p in bezier((33, 18), (37, 15), (42, 22), (50, 22))])
_crown_right = np.vstack([[(24.5, 36.0), (24.4, 44.0)], _crown_side, _crown_top[1:]])
CROWN = Polygon(np.vstack([_crown_right, (_crown_right * [-1, 1])[::-1]])).buffer(0)

_peak = int(np.argmax(_crown_top[:, 1]))
_outer = np.vstack([[(24.5, 30.0), (24.4, 44.0)], _crown_side, _crown_top[1:_peak + 1]])
CROWN_TOP_Z = float(_crown_top[_peak, 1])


def crown_half_width(z):
    return np.interp(z, _outer[:, 1], _outer[:, 0], right=_outer[-1, 0])


def front_distance(poly, xs, zs):
    """Signed distance to a front-view outline on an x-by-z grid (negative inside)."""
    gx, gz = np.meshgrid(xs, zs, indexing="ij")
    pts = shapely.points(gx.ravel(), gz.ravel())
    d = shapely.distance(pts, poly.boundary)
    inside = shapely.contains(poly, pts)
    return np.where(inside, -d, d).reshape(gx.shape)


def eye_capsule(x, z, cx):
    dz = np.maximum(np.abs(z - EYE_CENTRE_Z) - EYE_HALF_STRAIGHT, 0.0)
    return np.sqrt((x - cx) ** 2 + dz ** 2) - EYE_RADIUS


def eyes_2d(x, z):
    return np.minimum(*(eye_capsule(x, z, cx) for cx in EYE_CENTRES_X))


def head_front_y(x, z):
    """Where the head surface is, looking from the front (negative y is the face)."""
    k = head_scale(z)
    a, b = HEAD_HALF_WIDTH * k, HEAD_HALF_DEPTH * k
    return -b * np.clip(1 - np.abs(x / a) ** HEAD_ROUNDNESS, 0, 1) ** (1 / HEAD_ROUNDNESS)


# The socket floor is a flat plane behind the eyes, so the eye inserts have a flat back.
_ex, _ez = np.meshgrid(np.linspace(-13, 13, 261), np.linspace(10, 40, 301), indexing="ij")
_in_eye = eyes_2d(_ex, _ez) <= 0
SOCKET_FLOOR_Y = float(head_front_y(_ex[_in_eye], _ez[_in_eye]).max() + EYE_SOCKET_MIN)


# ---------------------------------------------------------------- the solid

def brim_fields(xs, ys):
    """The brim on an x-by-y grid: a sheet rising from the hat, ending in a rolled edge.

    The roll sits on the upper side of the sheet, so the sheet's underside runs
    smoothly into it and the roll adds no overhang.
    """
    gx, gy = np.meshgrid(xs, ys, indexing="ij")
    theta = np.arctan2(gy, gx)
    radius = np.hypot(gx, gy)
    r_in = ellipse_radius(theta, *BRIM_INNER)
    r_out = ellipse_radius(theta, *BRIM_OUTER)
    width = r_out - r_in
    side = np.abs(np.cos(theta)) ** BRIM_SIDES
    curl = BRIM_CURL * side
    half = 0.5 * BRIM_THICK
    roll = half + (BRIM_ROLL - half) * side

    def mid(s):
        return BRIM_Z + BRIM_RISE * width * s + curl * (np.clip(s - BRIM_CURL_FROM, 0, None) / (1 - BRIM_CURL_FROM)) ** 2

    def slope(s):
        return BRIM_RISE + 2 * curl * np.clip(s - BRIM_CURL_FROM, 0, None) / ((1 - BRIM_CURL_FROM) ** 2 * width)

    # Where the sheet hands over to the roll, chosen so the roll's outside is the brim edge.
    s_end = 1 - roll / width
    for _ in range(4):
        g = slope(s_end)
        r_end = r_out - roll + (roll - half) * g / np.sqrt(1 + g ** 2)
        s_end = (r_end - r_in) / width
    g = slope(s_end)
    roll_r = r_end - (roll - half) * g / np.sqrt(1 + g ** 2)
    roll_z = mid(s_end) + (roll - half) / np.sqrt(1 + g ** 2)

    s = (radius - r_in) / width
    height = mid(s)
    gh_x, gh_y = np.gradient(height, xs, ys)
    stretch = np.sqrt(1 + gh_x ** 2 + gh_y ** 2)
    inner = -(s + 0.35) * width   # the brim ends inside the head
    return {
        "height": height, "half": half * stretch, "stretch": stretch, "inner": inner,
        "radius": radius, "end_r": r_end, "end_z": mid(s_end), "end_slope": g,
        "roll_r": roll_r, "roll_z": roll_z, "roll": roll,
    }


def build_fields(xs, ys, zs):
    crown_2d = front_distance(CROWN, xs, zs)                     # (x, z)
    gx2, gz2 = np.meshgrid(xs, zs, indexing="ij")
    eye_2d = eyes_2d(gx2, gz2)                                   # (x, z)
    dome = EYE_DOME * np.sqrt(np.clip(-eye_2d / EYE_RADIUS, 0, 1))
    b = {k: v[:, :, None] for k, v in brim_fields(xs, ys).items()}

    body = np.empty((len(xs), len(ys), len(zs)), dtype=np.float32)
    eyes = np.empty_like(body)
    X = xs[:, None, None]
    Y = ys[None, :, None]
    chunk = 16
    for k0 in range(0, len(zs), chunk):
        sl = slice(k0, k0 + chunk)
        Z = zs[None, None, sl]

        k = head_scale(Z)
        head = superellipse_distance(X, Y, HEAD_HALF_WIDTH * k, HEAD_HALF_DEPTH * k, HEAD_ROUNDNESS)
        head = np.maximum(head, Z - 42.5)          # the crown takes over under the brim

        aw = crown_half_width(Z)
        crown_plan = superellipse_distance(X, Y, aw, 0.84 * aw, 2.3)
        crown = smax(crown_2d[:, None, sl], crown_plan, 2.0)

        sheet = (np.abs(Z - b["height"]) - b["half"]) / b["stretch"]
        # End the sheet square to its own surface, so both corners land on the roll.
        end = ((b["radius"] - b["end_r"]) + (Z - b["end_z"]) * b["end_slope"]) / np.sqrt(1 + b["end_slope"] ** 2)
        sheet = np.maximum(sheet, end)
        roll = np.sqrt((b["radius"] - b["roll_r"]) ** 2 + (Z - b["roll_z"]) ** 2) - b["roll"]
        brim = np.maximum(np.minimum(sheet, roll), b["inner"])   # they already meet tangentially

        solid = smin(smin(head, crown, 1.0), brim, 1.5)
        solid = np.maximum(solid, BASE_Z - Z)                    # flat base

        eye_footprint = eye_2d[:, None, sl]
        socket = np.maximum(eye_footprint, Y - SOCKET_FLOOR_Y)
        body[:, :, sl] = np.maximum(solid, -socket)
        eyes[:, :, sl] = np.maximum(socket, solid - dome[:, None, sl])
    return body, eyes


def surface(field, xs, ys, zs):
    padded = np.pad(field, 1, constant_values=10.0)
    verts, faces, _, _ = marching_cubes(padded, level=0.0, spacing=(STEP,) * 3,
                                        gradient_direction="ascent", allow_degenerate=False)
    verts += np.array([xs[0], ys[0], zs[0]]) - STEP
    mesh = trimesh.Trimesh(verts, faces, process=True)
    trimesh.repair.fix_normals(mesh)
    return mesh


def simplified(mesh, tolerance_mm=0.02):
    """Merges triangles on gentle curves while keeping the mesh a closed solid."""
    if mesh.volume < 0:
        mesh.invert()
    m = manifold3d.Manifold(manifold3d.Mesh(
        vert_properties=np.asarray(mesh.vertices, dtype=np.float32),
        tri_verts=np.asarray(mesh.faces, dtype=np.uint32)))
    if m.status() != manifold3d.Error.NoError:
        raise SystemExit(f"mesh is not a closed solid: {m.status()}")
    out = m.simplify(tolerance_mm).to_mesh()
    result = trimesh.Trimesh(out.vert_properties[:, :3], out.tri_verts, process=True)
    if result.volume < 0:
        result.invert()
    return result


def check(name, mesh):
    report = {
        "watertight": bool(mesh.is_watertight),
        "winding_consistent": bool(mesh.is_winding_consistent),
        "volume_cm3": round(float(mesh.volume) / 1000, 2),
        "triangles": int(len(mesh.faces)),
        "size_mm": [round(float(v), 1) for v in mesh.extents],
    }
    if not (report["watertight"] and report["winding_consistent"] and mesh.volume > 0):
        raise SystemExit(f"{name} is not a printable solid: {report}")
    return report


def overhangs(mesh, limit_degrees=55.0):
    """Area of downward faces steeper than the limit from vertical, ignoring the base."""
    n = mesh.face_normals
    centres = mesh.triangles_center
    down = -n[:, 2]
    off_bed = centres[:, 2] > 0.3
    steep = (down > np.cos(np.radians(90 - limit_degrees)) - 1e-9) & off_bed
    worst = np.degrees(np.arccos(np.clip(down[off_bed & (down > 0)], -1, 1)))
    return {
        f"area_over_{limit_degrees:g}_degrees_mm2": round(float(mesh.area_faces[steep].sum()), 1),
        "steepest_overhang_from_vertical_degrees": round(float(90 - worst.min()), 1) if len(worst) else 0.0,
    }


def lay_flat_inserts(eyes_mesh):
    """Two separate eye inserts, flat back on the bed, side by side."""
    parts = []
    for i, part in enumerate(sorted(eyes_mesh.split(only_watertight=True), key=lambda m: m.bounds[0, 0])):
        # Drawing (x, y, z) to bed (x, z, floor - y): the socket floor becomes the bed.
        v = part.vertices
        flat = np.column_stack([v[:, 0], v[:, 2], SOCKET_FLOOR_Y * SCALE - v[:, 1]])
        flat[:, 0] -= flat[:, 0].mean()
        flat[:, 1] -= flat[:, 1].mean()
        flat[:, 2] -= flat[:, 2].min()
        flat[:, 0] += (i - 0.5) * 14.0
        parts.append(trimesh.Trimesh(flat, part.faces, process=True))
    return trimesh.util.concatenate(parts)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    xs = np.arange(-42.5, 42.5 + STEP, STEP)
    ys = np.arange(-31.5, 31.5 + STEP, STEP)
    zs = np.arange(BASE_Z - 2 * STEP, CROWN_TOP_Z + 1.5, STEP)
    body_field, eyes_field = build_fields(xs, ys, zs)

    def to_mm(mesh):
        mesh.apply_scale(SCALE)
        mesh.apply_translation([0, 0, -BASE_Z * SCALE])
        return mesh

    body = simplified(to_mm(surface(body_field, xs, ys, zs)))
    eyes = simplified(to_mm(surface(eyes_field, xs, ys, zs)))
    del body_field, eyes_field

    # Glue-in inserts: the same eyes, a little narrower so they slide into the sockets.
    c = INSERT_CLEARANCE_MM / SCALE
    ex = xs[(xs > -14) & (xs < 14)]
    ey = ys[(ys > -25) & (ys < SOCKET_FLOOR_Y + 1)]
    ez = zs[(zs > 12) & (zs < 40)]
    _, insert_field = build_fields(ex, ey, ez)
    gx2, gz2 = np.meshgrid(ex, ez, indexing="ij")
    insert_field = np.maximum(insert_field, (eyes_2d(gx2, gz2) + c)[:, None, :])
    inserts = lay_flat_inserts(simplified(to_mm(surface(insert_field, ex, ey, ez))))

    report = {
        "head": {**check("head", body), **overhangs(body)},
        "eyes": check("eyes", eyes),
        "eye_inserts": check("eye_inserts", inserts),
        "base_mm": [round(float(v), 1) for v in
                    np.ptp(body.vertices[body.vertices[:, 2] < 0.01][:, :2], axis=0)],
        "centre_of_mass_height_mm": round(float(body.center_mass[2]), 1),
        "socket_depth_mm": [round(EYE_SOCKET_MIN * SCALE, 2)],
    }
    body.export(OUT / "lasso-head.stl")
    eyes.export(OUT / "lasso-head-eyes.stl")
    inserts.export(OUT / "lasso-head-eye-inserts.stl")
    (OUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
