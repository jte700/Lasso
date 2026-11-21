/* The mascot in 3D. The silhouette from the avatar kit is extruded into a soft, rounded figure that
   sways, follows the pointer, blinks, and spins. Scrolling past it spins it, a click spins it, and
   it spins on its own every few seconds. Each time it passes edge-on it comes round as a different
   colour and expression from the kit. Without WebGL it falls back to the kit's flat drawings, and
   with reduced motion it stays still and changes only when clicked. */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const BODY = 'M33 18C37 15 42 22 50 22C58 22 63 15 67 18C71 21 72 29 74 34C78 36 82 33 85 31C89 28 92 32 90 37C87 43 80 46 75 47L75 65C75 78 65 86 50 86C35 86 25 78 25 65L25 47C20 46 13 43 10 37C8 32 11 28 15 31C18 33 22 36 26 34C28 29 29 21 33 18Z';
export const PALETTES = {
  sky: { color: '#8ec5f4', eye: '#0b1a28' },
  lime: { color: '#d4f75c', eye: '#20281b' },
  terracotta: { color: '#c96749', eye: '#201a17' },
  rope: { color: '#d7bd85', eye: '#30291e' },
  sage: { color: '#91a984', eye: '#20281b' },
  forest: { color: '#2f4322', eye: '#f1eacb' },
  ink: { color: '#252923', eye: '#f1eacb' },
};
const EXPRESSIONS = ['idle', 'happy', 'thinking'];
const CX = 50, CY = 52;                 // the drawing's centre, in its own 100 x 100 units
const DEPTH = 12, BEVEL = 6.5, BEVEL_SIZE = 3.4;
const FRONT = DEPTH / 2 + BEVEL;        // z of the face

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

/* The order the looks come round in. Dark ink disappears on a dark page, so it joins only in light. */
export function looks() {
  const names = Object.keys(PALETTES).filter((n) => theme() === 'light' || n !== 'ink');
  const out = [];
  for (let i = 0; i < names.length * EXPRESSIONS.length; i++) out.push({ palette: names[i % names.length], expression: EXPRESSIONS[i % EXPRESSIONS.length] });
  return out;
}

/* ---------- geometry ---------- */
function shapeFromPath(d) {
  const tokens = d.match(/[MLCZ]|-?\d*\.?\d+/gi);
  const shape = new THREE.Shape();
  const p = (x, y) => [x - CX, CY - y];
  let i = 0, cmd = '';
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[MLCZ]/i.test(tokens[i])) cmd = tokens[i++].toUpperCase();
    if (cmd === 'M') shape.moveTo(...p(num(), num()));
    else if (cmd === 'L') shape.lineTo(...p(num(), num()));
    else if (cmd === 'C') { const a = p(num(), num()), b = p(num(), num()), c = p(num(), num()); shape.bezierCurveTo(...a, ...b, ...c); }
    else if (cmd === 'Z') shape.closePath();
  }
  return shape;
}

function bodyGeometry() {
  let geo = new THREE.ExtrudeGeometry(shapeFromPath(BODY), {
    depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL_SIZE, bevelOffset: -1.2, bevelSegments: 14, curveSegments: 40,
  });
  geo.translate(0, 0, -DEPTH / 2);
  geo.deleteAttribute('normal');
  geo.deleteAttribute('uv');
  geo = mergeVertices(geo, 1e-3);
  geo.computeVertexNormals();
  return geo;
}

function pill(w, h) {
  // a capsule standing upright, pressed flat into the face
  const g = new THREE.CapsuleGeometry(w / 2, Math.max(0.01, h - w), 10, 20);
  g.scale(1, 1, 0.5);
  return g;
}

function arc(x0, y0, cx, cy, x1, y1, width) {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(x0 - CX, CY - y0, 0), new THREE.Vector3(cx - CX, CY - cy, 0), new THREE.Vector3(x1 - CX, CY - y1, 0));
  const r = width / 2;
  const tube = new THREE.TubeGeometry(curve, 40, r, 14, false);
  const capA = new THREE.SphereGeometry(r, 16, 12); capA.translate(x0 - CX, CY - y0, 0);
  const capB = new THREE.SphereGeometry(r, 16, 12); capB.translate(x1 - CX, CY - y1, 0);
  const group = new THREE.Group();
  [tube, capA, capB].forEach((g) => { g.scale(1, 1, 0.5); group.add(new THREE.Mesh(g)); });
  return group;
}

/* The eyes for each expression, in the kit's own coordinates. */
function buildEyes(expression, material) {
  const group = new THREE.Group();
  const add = (obj) => { obj.traverse((m) => { if (m.isMesh) m.material = material; }); group.add(obj); };
  if (expression === 'happy') {
    add(arc(36.91, 61.75, 41.5, 52.63, 46.09, 61.75, 3.83));
    add(arc(53.91, 61.75, 58.5, 52.63, 63.09, 61.75, 3.83));
  } else if (expression === 'thinking') {
    const l = new THREE.Mesh(pill(6.38, 16)); l.position.set(42.8 - CX, CY - 58.4, 0);
    const r = new THREE.Mesh(pill(6.38, 15.3)); r.position.set(59.8 - CX, CY - 58.6, 0);
    add(l); add(r);
  } else {
    const l = new THREE.Mesh(pill(6.38, 17.54)); l.position.set(41.5 - CX, CY - 60, 0);
    const r = new THREE.Mesh(pill(6.38, 17.54)); r.position.set(58.5 - CX, CY - 60, 0);
    add(l); add(r);
  }
  group.position.z = FRONT - 0.35;
  return group;
}

function webgl() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

/* ---------- the flat fallback ---------- */
function mountFlat(host, opts) {
  const list = looks();
  let index = opts.start % list.length;
  const img = host.querySelector('.mascot-still') || new Image();
  img.className = 'mascot-flat';
  img.alt = '';
  img.decoding = 'async';
  const show = () => { const l = list[index]; img.src = `/assets/img/mascot/${l.palette}-${l.expression}.svg`; opts.onLook?.(l); };
  show();
  host.append(img);
  const next = () => {
    if (reducedMotion) { index = (index + 1) % list.length; show(); return; }
    img.classList.remove('flip'); void img.offsetWidth; img.classList.add('flip');
    setTimeout(() => { index = (index + 1) % list.length; show(); }, 260);
  };
  host.addEventListener('click', next);
  return { spin: next };
}

/* ---------- the 3D figure ---------- */
export function mountMascot(host, opts = {}) {
  opts = { start: 0, auto: 7000, scroll: true, ...opts };
  host.classList.add('mascot3d');
  if (!webgl()) return mountFlat(host, opts);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.85;
  const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(-60, 90, 120); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 1.1); rim.position.set(80, 40, -120); scene.add(rim);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 0.35));

  const camera = new THREE.PerspectiveCamera(28, 1, 10, 1000);
  camera.position.set(0, 0, 228);

  const skin = new THREE.MeshPhysicalMaterial({ roughness: 0.46, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.32, sheen: 0.5, sheenRoughness: 0.55, sheenColor: new THREE.Color('#ffffff') });
  const eyeSkin = new THREE.MeshPhysicalMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.45, envMapIntensity: 0.3 });

  const figure = new THREE.Group();   // sway, spin and pointer
  const tilt = new THREE.Group();     // the thinking tilt
  const body = new THREE.Mesh(bodyGeometry(), skin);
  tilt.add(body);
  figure.add(tilt);
  scene.add(figure);
  let eyes = null;

  const list = looks();
  let index = opts.start % list.length;
  let current = null;
  function apply(look) {
    current = look;
    const p = PALETTES[look.palette];
    skin.color.set(p.color);
    eyeSkin.color.set(p.eye);
    if (eyes) tilt.remove(eyes);
    eyes = buildEyes(look.expression, eyeSkin);
    tilt.add(eyes);
    host.style.setProperty('--look', p.color);
    host.dataset.look = `${look.palette} ${look.expression}`;
    opts.onLook?.(look);
  }
  apply(list[index]);

  /* ---------- motion state ---------- */
  let angle = 0, velocity = 0, target = 0;       // the spin, in radians
  let pop = 1, popV = 0;                         // a small squash when the look changes
  let lookX = 0, lookY = 0, aimX = 0, aimY = 0;  // pointer follow
  let tiltZ = 0, blink = 1, blinkUntil = 0, nextBlink = performance.now() + 2200;
  let lastInput = performance.now(), settleTimer = 0;
  const TAU = Math.PI * 2;
  const half = (a) => Math.floor((a - Math.PI / 2) / Math.PI);  // which half turn we are on; it changes edge-on
  let lastHalf = half(0);

  const spinBy = (turns) => {
    lastInput = performance.now();
    target = Math.round(target / TAU) * TAU + turns * TAU;
  };
  const settle = (dir) => { target = (dir >= 0 ? Math.ceil(target / TAU - 0.15) : Math.floor(target / TAU + 0.15)) * TAU; };

  host.addEventListener('click', () => spinBy(velocity < -0.5 ? -1 : 1));
  host.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); spinBy(1); } });

  addEventListener('pointermove', (e) => {
    const r = host.getBoundingClientRect();
    aimX = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (innerWidth * 0.5)));
    aimY = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (innerHeight * 0.6)));
  }, { passive: true });

  /* Scrolling turns it like a wheel under the page, then lets it settle facing you. */
  let lastY = scrollY;
  if (opts.scroll && !reducedMotion) {
    addEventListener('scroll', () => {
      const dy = scrollY - lastY; lastY = scrollY;
      if (!visible) return;
      lastInput = performance.now();
      target += dy * 0.006;
      target = Math.max(angle - 2.2 * TAU, Math.min(angle + 2.2 * TAU, target));
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => settle(dy), 140);
    }, { passive: true });
  }

  /* ---------- size and visibility ---------- */
  const resize = () => {
    const w = host.clientWidth || 1, h = host.clientHeight || w;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();
  let visible = true;
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) start(); }, { rootMargin: '80px' }).observe(host);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) start(); });
  document.addEventListener('lasso:theme', () => { /* the next look respects the new page colour */ });

  /* ---------- the loop ---------- */
  let frame = 0, last = performance.now();
  function tick(now) {
    frame = 0;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    const t = now / 1000;

    if (!reducedMotion && opts.auto && now - lastInput > opts.auto && Math.abs(target - angle) < 0.01) spinBy(1);

    // spring toward the target: quick but never overshooting much
    const k = 34, c = 2 * Math.sqrt(k) * 0.92;
    velocity += (k * (target - angle) - c * velocity) * dt;
    angle += velocity * dt;

    const h = half(angle);
    if (h !== lastHalf) {
      lastHalf = h;
      const fresh = looks();
      index = (index + (velocity >= 0 ? 1 : fresh.length - 1)) % fresh.length;
      apply(fresh[index]);
      popV -= 2.2;
    }
    popV += (-90 * (pop - 1) - 12 * popV) * dt; pop += popV * dt;

    lookX += (aimX - lookX) * Math.min(1, dt * 4);
    lookY += (aimY - lookY) * Math.min(1, dt * 4);
    const sway = reducedMotion ? 0 : Math.sin(t * 0.7) * 0.12;
    figure.rotation.y = angle + sway + lookX * 0.42;
    figure.rotation.x = lookY * 0.28 + (reducedMotion ? 0 : Math.sin(t * 0.9) * 0.03);
    figure.position.y = reducedMotion ? 0 : Math.sin(t * 1.5) * 1.6;
    figure.scale.set(1 / Math.sqrt(pop), pop, 1 / Math.sqrt(pop));

    const wantTilt = current.expression === 'thinking' ? 0.09 : 0;
    tiltZ += (wantTilt - tiltZ) * Math.min(1, dt * 6);
    tilt.rotation.z = tiltZ;

    if (!reducedMotion && current.expression !== 'happy') {
      if (now > nextBlink) { blinkUntil = now + 130; nextBlink = now + 2400 + Math.random() * 2800; if (Math.random() < 0.25) nextBlink = now + 320; }
      const want = now < blinkUntil ? 0.12 : 1;
      blink += (want - blink) * Math.min(1, dt * 28);
    } else blink = 1;
    if (eyes) eyes.scale.y = blink;

    renderer.render(scene, camera);
    const moving = Math.abs(target - angle) > 0.0005 || Math.abs(velocity) > 0.0005 || Math.abs(pop - 1) > 0.0005;
    if (visible && !document.hidden && (!reducedMotion || moving || Math.abs(aimX - lookX) > 0.002 || Math.abs(aimY - lookY) > 0.002)) frame = requestAnimationFrame(tick);
  }
  function start() { if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); } }
  addEventListener('pointermove', start, { passive: true });
  host.addEventListener('click', start);
  start();

  return { spin: () => { spinBy(1); start(); }, get look() { return current; } };
}
