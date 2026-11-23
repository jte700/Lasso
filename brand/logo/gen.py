"""Draws the Lasso logo in the soft, map-like style: forest green serif wordmark,
an organic badge with the rope loop cut out of it, and coastline blobs behind."""
import math, random, pathlib

GREEN = "#2f4322"
CREAM = "#f1eacb"
PALE = "#f8f6e4"
BLUE = "#c2cfef"
GREY = "#d3d6da"
OUT = pathlib.Path(__file__).parent


def smooth_path(pts):
    """Closed Catmull-Rom spline through pts, written as cubic Beziers."""
    n = len(pts)
    d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for i in range(n):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}"
    return d + "Z"


def coastline(cx, cy, rx, ry, seed, steps=90, rough=0.09):
    """A blob with a wandering, coastline edge like the shapes on a soft map."""
    rnd = random.Random(seed)
    waves = [(rnd.randint(2, 4), rnd.uniform(0.10, 0.18), rnd.uniform(0, 6.3)),
             (rnd.randint(5, 8), rnd.uniform(0.04, 0.08), rnd.uniform(0, 6.3)),
             (rnd.randint(11, 16), rough * 0.5, rnd.uniform(0, 6.3)),
             (rnd.randint(19, 25), rough * 0.3, rnd.uniform(0, 6.3))]
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        k = 1 + sum(a * math.sin(f * t + p) for f, a, p in waves)
        pts.append((cx + rx * k * math.cos(t), cy + ry * k * math.sin(t)))
    return smooth_path(pts)


def badge(cx, cy, r, steps=120):
    """A soft four-lobed pebble: a rounded diamond with gently pinched sides."""
    pts = []
    for i in range(steps):
        t = 2 * math.pi * i / steps
        n = 1.4
        s = (abs(math.cos(t)) ** n + abs(math.sin(t)) ** n) ** (-1 / n)
        k = s * (1 + 0.025 * math.sin(3 * t + 0.6))
        a = t  # corners point up, down, left and right
        pts.append((cx + r * k * math.cos(a) * 0.98, cy + r * k * math.sin(a) * 0.98))
    return smooth_path(pts)


def mark(cx, cy, r, fg=GREEN, cut=CREAM):
    """Badge with the lasso drawn in the background colour: loop, knot and tail."""
    sw = r * 0.13
    return f"""
  <g>
    <path d="{badge(cx, cy, r)}" fill="{fg}"/>
    <g transform="rotate(-14 {cx} {cy})" fill="none" stroke="{cut}" stroke-linecap="round">
      <ellipse cx="{cx - r*0.04:.1f}" cy="{cy - r*0.08:.1f}" rx="{r*0.43:.1f}" ry="{r*0.31:.1f}" stroke-width="{sw:.1f}"/>
      <path d="M{cx + r*0.22:.1f},{cy + r*0.22:.1f} C{cx + r*0.30:.1f},{cy + r*0.42:.1f} {cx + r*0.42:.1f},{cy + r*0.52:.1f} {cx + r*0.60:.1f},{cy + r*0.70:.1f}" stroke-width="{sw:.1f}"/>
    </g>
    <circle cx="{cx + r*0.17:.1f}" cy="{cy + r*0.17:.1f}" r="{r*0.13:.1f}" fill="{cut}"/>
  </g>"""


FONT = "@import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@60,600&amp;display=block');"
WORD = "font-family:'Source Serif 4',Georgia,serif;font-weight:600;font-variation-settings:'opsz' 60;letter-spacing:-0.01em"


def lockup(w, h, scale, bg, fg, cut, blobs=True):
    cx, cy = w / 2, h / 2
    r = 78 * scale
    fs = 150 * scale
    total = 2 * r * 0.95 + 26 * scale + fs * 1.62
    mx = cx - total / 2 + r * 0.95
    tx = mx + r * 0.95 + 26 * scale
    shapes = ""
    if blobs:
        shapes = f"""
  <path d="{coastline(w*0.06, h*0.86, w*0.27, h*0.42, 3)}" fill="{GREY}"/>
  <path d="{coastline(w*1.02, h*0.48, w*0.19, h*0.48, 11)}" fill="{BLUE}"/>
  <path d="{coastline(w*0.27, -h*0.02, w*0.09, h*0.09, 21, rough=0.14)}" fill="{PALE}"/>
  <path d="{coastline(w*0.57, h*1.02, w*0.07, h*0.18, 5, rough=0.14)}" fill="{PALE}"/>"""
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">
  <style>{FONT}</style>
  <rect width="{w}" height="{h}" fill="{bg}"/>{shapes}{mark(mx, cy, r, fg, cut)}
  <text x="{tx:.1f}" y="{cy + fs*0.24:.1f}" font-size="{fs:.1f}" fill="{fg}" style="{WORD}">lasso</text>
</svg>
"""


def icon(size, bg, fg, cut):
    c = size / 2
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" width="{size}" height="{size}">
  <rect width="{size}" height="{size}" rx="{size*0.22}" fill="{bg}"/>{mark(c, c, size*0.47, fg, cut)}
</svg>
"""


(OUT / "lasso-logo.svg").write_text(lockup(880, 660, 1.0, CREAM, GREEN, CREAM))
(OUT / "lasso-logo-plain.svg").write_text(lockup(880, 360, 1.0, CREAM, GREEN, CREAM, blobs=False))
(OUT / "lasso-logo-dark.svg").write_text(lockup(880, 360, 1.0, GREEN, CREAM, GREEN, blobs=False))
(OUT / "lasso-mark.svg").write_text(icon(256, CREAM, GREEN, CREAM))
