// The website's letter field, behind the Connect window: lines of source
// text, a lasso's loop and trailing rope lit up in them, and values from
// mail, calendars and pages being caught and pulled toward what the window
// shows: the headline at first, then the sheet of apps.
(() => {
  const PI = Math.PI;
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const rng = (low, high) => low + Math.random() * (high - low);
  const DARK = matchMedia('(prefers-color-scheme: dark)');
  const STILL = matchMedia('(prefers-reduced-motion: reduce)');

  const SOURCES = [
    { app: 'Outlook', file: 'Outlook › Inbox', loc: 'Re: Q3 budget', key: 'total', val: '€ 48,210' },
    { app: 'Outlook', file: 'Outlook › Sent', loc: 'Retention terms', key: 'retention', val: '5 %' },
    { app: 'Calendar', file: 'Calendar › Thu 30 Oct', loc: 'Site walk', key: 'at', val: '14:00' },
    { app: 'Calendar', file: 'Calendar › Work', loc: 'Slab pour L2', key: 'on', val: 'day 41' },
    { app: 'Notion', file: 'Notion › Specs', loc: 'Load cases', key: 'live load', val: '12.5 kN/m²' },
    { app: 'Notion', file: 'Notion › Leases', loc: 'Unit 4', key: 'notice', val: '6 months' },
    { app: 'Google Calendar', file: 'Google Calendar', loc: 'Design review', key: 'room', val: 'B-204' },
    { app: 'Outlook', file: 'Outlook › Inbox', loc: 'Assay results', key: 'IC50', val: '3.7 µM' },
    { app: 'Notion', file: 'Notion › Roadmap', loc: 'Launch', key: 'target', val: '12 Nov' },
    { app: 'Calendar feed', file: 'handover.ics', loc: 'Handover', key: 'at', val: '09:30' },
    { app: 'Outlook', file: 'Outlook › Projects', loc: 'MSA v4', key: 'cap', val: '€ 250,000' },
    { app: 'Notion', file: 'Notion › Survey', loc: 'Respondents', key: 'n', val: '1,284' },
    { app: 'Calendar', file: 'Calendar › Home', loc: 'Inspection', key: 'with', val: 'J. Okafor' },
    { app: 'Outlook', file: 'Outlook › Inbox', loc: 'Energy model', key: 'demand', val: '38 kWh/m²a' },
    { app: 'Google Calendar', file: 'Google Calendar', loc: 'Board call', key: 'length', val: '45 min' },
    { app: 'Notion', file: 'Notion › Pipes', loc: 'Outfall P-17', key: 'diameter', val: 'DN 300' },
  ];
  const FILLER = ['synced 14:02:11', 'inbox +3', 'event moved', 'page edited', 'token refreshed', 'indexed locally',
    'v3 → v4', 'passage 118/402', 'ranked 0.91', '¶ 22–24', 'linked ↳ site-report.md', 'no guess: ambiguous', 'pinned',
    'scope project', 'local', 'calendarView', 'mail 30 days', 'next 90 days', 'shared with integration', 'read only'];
  const SCRAMBLE = '·:;+=*<>/\\|{}[]01#%abcdefxyz';

  const LIGHT = { bg: '#f5f3f1', text: [0, 0, 0], accent: [31, 157, 85], pulse: [41, 204, 87], pin: [59, 108, 246],
    base: .05, inside: .03, rope: .42, dimFloor: .16, okBg: '#eafaf0', markBg: '#fff4cc' };
  const NIGHT = { bg: '#161615', text: [255, 255, 255], accent: [41, 204, 87], pulse: [41, 204, 87], pin: [120, 160, 255],
    base: .07, inside: .03, rope: .4, dimFloor: .12, okBg: '#0f2a18', markBg: '#2a2614' };

  function createField(canvas, { host, zone }) {
    const ctx = canvas.getContext('2d');
    let T = DARK.matches ? NIGHT : LIGHT;
    let W = 0, H = 0, cw = 7.2, lh = 16, cols = 0, rows = 0;
    let chars = [], ropeW, ropeS, inside, dim, scrambled, alternate, tokens = [];
    let events = [], nextSpawn = 0, sequence = 400, lastFrame = 0, frame = 0;
    const mouse = { x: -9999, y: -9999 };
    const recent = [];
    const size = () => (innerWidth < 640 ? 10.5 : 12);
    const font = (scale = 1, weight = 400) => `${weight} ${size() * scale}px ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`;
    const rgba = (color, alpha) => `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;

    function zoneBox(pad = 0) {
      const outer = host.getBoundingClientRect(), box = zone();
      return { x0: box.left - outer.left - pad, y0: box.top - outer.top - pad, x1: box.right - outer.left + pad, y1: box.bottom - outer.top + pad };
    }

    function buildGrid() {
      chars = new Array(rows); tokens = [];
      for (let r = 0; r < rows; r++) {
        let line = ' '.repeat((Math.random() * 6) | 0);
        while (line.length < cols + 40) {
          if (Math.random() < .72) {
            const source = pick(SOURCES), head = `${source.file} › ${source.loc} ${source.key} `, start = line.length + head.length;
            line += head + source.val;
            if (start + source.val.length <= cols) tokens.push({ row: r, col: start, len: source.val.length, src: source });
          } else line += pick(FILLER);
          line += pick(['   ', '  ·  ', '    ', ' │ ']);
        }
        chars[r] = Array.from(line.slice(0, cols));
        while (chars[r].length < cols) chars[r].push(' ');
      }
    }

    // A loop of rope around the window, a knot, and the standing part trailing off the corner.
    function buildRope() {
      const cx = W * .5, cy = H * .5;
      const rx = W * .485, ry = H * .47;
      const tilt = -.08, cT = Math.cos(tilt), sT = Math.sin(tilt), knotA = .62 * PI, points = [];
      for (let i = 0; i <= 420; i++) {
        const a = knotA + (i / 420) * PI * 2.04, wobble = 1 + .03 * Math.sin(3 * a + .7) + .018 * Math.sin(5 * a);
        const x = Math.cos(a) * rx * wobble, y = Math.sin(a) * ry * wobble;
        points.push([cx + x * cT - y * sT, cy + x * sT + y * cT]);
      }
      const k = points[0], p1 = [k[0] - W * .06, k[1] + H * .12], p2 = [W * .12, H * .96], p3 = [-W * .06, H * 1.1], tail = [];
      for (let i = 1; i <= 160; i++) {
        const t = i / 160, u = 1 - t;
        tail.push([u * u * u * k[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
          u * u * u * k[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
      }
      const all = tail.reverse().concat(points), length = [0];
      for (let i = 1; i < all.length; i++) length.push(length[i - 1] + Math.hypot(all[i][0] - all[i - 1][0], all[i][1] - all[i - 1][1]));
      const total = length[length.length - 1], width = Math.max(18, Math.min(W, H) * .045);
      const N = rows * cols;
      ropeW = new Float32Array(N); ropeS = new Float32Array(N); inside = new Uint8Array(N); dim = new Float32Array(N);
      const box = zoneBox();
      for (let r = 0; r < rows; r++) {
        const py = r * lh + lh * .5;
        for (let c = 0; c < cols; c++) {
          const px = c * cw + cw * .5, index = r * cols + c;
          let best = 1e9, nearest = 0;
          for (let i = 0; i < all.length; i += 2) {
            const dx = all[i][0] - px, dy = all[i][1] - py, d = dx * dx + dy * dy;
            if (d < best) { best = d; nearest = i; }
          }
          const w = Math.max(0, 1 - Math.sqrt(best) / width);
          ropeW[index] = w * w * (3 - 2 * w); ropeS[index] = length[nearest] / total;
          const dx = px - cx, dy = py - cy, ux = dx * cT + dy * sT, uy = -dx * sT + dy * cT;
          inside[index] = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) < .92 ? 1 : 0;
          // Text fades toward what the window shows, so its own text stays legible.
          const qx = Math.max(0, Math.max(box.x0 - px, px - box.x1)) / 70, qy = Math.max(0, Math.max(box.y0 - py, py - box.y1)) / 60;
          dim[index] = T.dimFloor + (1 - T.dimFloor) * Math.min(1, Math.hypot(qx, qy));
        }
      }
      scrambled = new Uint8Array(N); alternate = new Array(N);
    }

    function resize() {
      const bounds = host.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      W = bounds.width; H = bounds.height;
      canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = font(); cw = ctx.measureText('M').width; lh = Math.round(size() * 1.4);
      cols = Math.ceil(W / cw); rows = Math.ceil(H / lh);
      buildGrid(); buildRope(); events = [];
      draw(performance.now());
    }

    const overlaps = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

    /** A value clear of the zone to catch, and the point on the zone’s edge it is pulled to. */
    function spawn(now) {
      const box = zoneBox(14), busy = events.map((event) => event.box);
      for (let attempt = 0; attempt < 40; attempt++) {
        const token = pick(tokens);
        if (!token || recent.includes(token.src)) continue;
        const tb = { x0: token.col * cw - 22, y0: token.row * lh - 16, x1: (token.col + token.len) * cw + 22, y1: (token.row + 1) * lh + 34 };
        if (tb.x0 < 6 || tb.x1 > W - 6 || tb.y0 < 6 || tb.y1 > H - 6 || overlaps(tb, box) || busy.some((other) => overlaps(other, tb))) continue;
        const cx = (tb.x0 + tb.x1) / 2, cy = token.row * lh + lh / 2;
        const target = { x: Math.min(box.x1 - 4, Math.max(box.x0 + 4, cx)), y: Math.min(box.y1 - 4, Math.max(box.y0 + 4, cy)) };
        if (Math.hypot(target.x - cx, target.y - cy) > 420) continue;
        recent.push(token.src); if (recent.length > 6) recent.shift();
        events.push({ t0: now, token, box: tb, target, id: ++sequence, rot: rng(-.18, .18), seed: Math.random() * 10 });
        return;
      }
    }

    function rounded(x, y, w, h, r) {
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }

    function drawCatch(event, now) {
      const t = now - event.t0, loopEnd = 700, pullAt = 1250, pullEnd = 2550, fadeAt = 2900, end = 3500;
      const fade = t > fadeAt ? Math.max(0, 1 - (t - fadeAt) / (end - fadeAt)) : 1;
      const { token } = event, tx = token.col * cw, ty = token.row * lh, tw = token.len * cw;
      const value = chars[token.row].slice(token.col, token.col + token.len).join('');
      ctx.save(); ctx.globalAlpha = fade; ctx.font = font(); ctx.textBaseline = 'middle';
      const p = Math.min(1, t / loopEnd), ease = 1 - Math.pow(1 - p, 3);
      ctx.fillStyle = T.bg; ctx.fillRect(tx - 3, ty, tw + 6, lh);
      ctx.fillStyle = T.markBg; ctx.globalAlpha = fade * ease; rounded(tx - 3, ty, tw + 6, lh, 3); ctx.fill(); ctx.globalAlpha = fade;
      const pulled = t > pullAt ? Math.min(1, (t - pullAt) / (pullEnd - pullAt)) : 0;
      ctx.fillStyle = rgba(T.text, (.45 + .55 * ease) * (1 - pulled * .6)); ctx.font = font(1, 600);
      ctx.fillText(value, tx, ty + lh / 2); ctx.font = font();
      // The loop, thrown around the value.
      const cxL = tx + tw / 2, cyL = ty + lh / 2, rx = tw / 2 + 14, ry = lh / 2 + 9, a0 = -PI * .8, sweep = PI * 2.15 * ease;
      ctx.strokeStyle = rgba(T.accent, .95); ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.beginPath();
      let knot = null;
      for (let i = 0; i <= 60; i++) {
        const a = a0 + (i / 60) * sweep, wobble = 1 + .06 * Math.sin(a * 3 + event.seed) + .03 * (i / 60);
        const x = Math.cos(a) * rx * wobble, y = Math.sin(a) * ry * wobble;
        const px = cxL + x * Math.cos(event.rot) - y * Math.sin(event.rot), py = cyL + x * Math.sin(event.rot) + y * Math.cos(event.rot);
        if (i) ctx.lineTo(px, py); else { ctx.moveTo(px, py); knot = [px, py]; }
      }
      ctx.stroke();
      // Its label, as a value caught with a version.
      if (t > loopEnd) {
        const label = `idx ${String(event.id).padStart(4, '0')} · ${token.src.app}`, labelW = label.length * cw * .84 + 16, labelH = lh * 1.05;
        const lx = Math.min(Math.max(6, tx), W - labelW - 8), ly = ty + lh + 10, k = Math.min(1, (t - loopEnd) / 220);
        ctx.globalAlpha = fade * k; ctx.fillStyle = T.okBg; rounded(lx, ly, labelW, labelH, labelH / 2); ctx.fill();
        ctx.fillStyle = rgba(T.accent, 1); ctx.font = font(.84, 600); ctx.fillText(label, lx + 8, ly + labelH / 2 + .5); ctx.font = font();
        ctx.globalAlpha = fade;
      }
      // The rope runs from the knot to the zone, and the value travels along it.
      if (t > pullAt - 350 && knot) {
        const grow = Math.min(1, (t - (pullAt - 350)) / 350);
        const sx = knot[0], sy = knot[1], ex = event.target.x, ey = event.target.y;
        const mx = (sx + ex) / 2 + (ey - sy) * .22, my = (sy + ey) / 2 - (ex - sx) * .22;
        const at = (u) => { const v = 1 - u; return [v * v * sx + 2 * v * u * mx + u * u * ex, v * v * sy + 2 * v * u * my + u * u * ey]; };
        ctx.setLineDash([3, 4]); ctx.lineDashOffset = -now / 40; ctx.strokeStyle = rgba(T.accent, .6); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(sx, sy);
        for (let i = 1; i <= 40 * grow; i++) { const [x, y] = at(i / 40); ctx.lineTo(x, y); }
        ctx.stroke(); ctx.setLineDash([]);
        if (pulled > 0 && pulled < 1) {
          const travel = pulled * pulled * (3 - 2 * pulled), [x, y] = at(travel);
          ctx.globalAlpha = fade * (1 - travel * .85); ctx.fillStyle = rgba(T.accent, 1); ctx.font = font(1, 600);
          ctx.fillText(value, x - tw / 2, y); ctx.font = font(); ctx.globalAlpha = fade;
        }
      }
      ctx.restore();
      return t < end;
    }

    const LEVELS = 14, buckets = Array.from({ length: LEVELS }, () => []), lit = Array.from({ length: 6 }, () => []);
    function draw(now) {
      ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
      ctx.font = font(); ctx.textBaseline = 'middle';
      const still = STILL.matches, phase = still ? -1 : (now / 5200) % 1.25, sweepY = ((now / 9000) % 1.6) * H;
      const mx = mouse.x, my = mouse.y, spread = 2 * 110 * 110;
      buckets.forEach((bucket) => (bucket.length = 0)); lit.forEach((bucket) => (bucket.length = 0));
      if (!still) {
        for (let i = 0, n = (rows * cols * .0025) | 0; i < n; i++) {
          const k = (Math.random() * rows * cols) | 0; scrambled[k] = 4 + ((Math.random() * 8) | 0); alternate[k] = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
        }
      }
      for (let r = 0; r < rows; r++) {
        const row = chars[r], py = r * lh + lh * .5, sweep = still ? 0 : Math.exp(-((py - sweepY) ** 2) / 1800) * .12;
        for (let c = 0; c < cols; c++) {
          if (row[c] === ' ') continue;
          const k = r * cols + c, w = ropeW[k];
          let alpha = T.base + inside[k] * T.inside + sweep, pulse = 0;
          if (w > 0) { if (phase >= 0) { const d = ropeS[k] - phase; pulse = Math.exp(-(d * d) / .0035); } alpha += w * (T.rope + .4 * pulse); }
          if (mx > -1000) { const dx = c * cw - mx, dy = py - my; alpha += .45 * Math.exp(-(dx * dx + dy * dy) / spread); }
          alpha *= dim[k];
          if (w > .35 && pulse > .45 && dim[k] > .6) lit[Math.min(5, (pulse * w * 6) | 0)].push(k);
          else buckets[Math.min(LEVELS - 1, (alpha * LEVELS) | 0)].push(k);
        }
      }
      const put = (k) => {
        const r = (k / cols) | 0, c = k - r * cols;
        let character = chars[r][c];
        if (scrambled[k]) { character = alternate[k]; scrambled[k]--; }
        ctx.fillText(character, c * cw, r * lh + lh * .5);
      };
      for (let i = 0; i < LEVELS; i++) if (buckets[i].length) { ctx.fillStyle = rgba(T.text, Math.min(1, (i + .5) / LEVELS)); buckets[i].forEach(put); }
      for (let i = 0; i < 6; i++) if (lit[i].length) { ctx.fillStyle = rgba(T.pulse, .5 + i * .09); lit[i].forEach(put); }
      if (!still) {
        events = events.filter((event) => drawCatch(event, now));
        if (now > nextSpawn && events.length < (W < 900 ? 2 : 3)) { spawn(now); nextSpawn = now + rng(700, 1500); }
      }
    }

    host.addEventListener('pointermove', (event) => {
      const bounds = host.getBoundingClientRect(); mouse.x = event.clientX - bounds.left; mouse.y = event.clientY - bounds.top;
    });
    host.addEventListener('pointerleave', () => { mouse.x = mouse.y = -9999; });
    let pending;
    const relayout = () => { clearTimeout(pending); pending = setTimeout(resize, 120); };
    addEventListener('resize', relayout);
    DARK.addEventListener('change', () => { T = DARK.matches ? NIGHT : LIGHT; buildRope(); draw(performance.now()); });
    STILL.addEventListener('change', () => draw(performance.now()));
    resize();
    const tick = (now) => {
      if (!document.hidden && !STILL.matches && now - lastFrame > 30) { draw(now); lastFrame = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return {
      stop: () => cancelAnimationFrame(frame),
      /** The window now shows something else: clear its area and catch toward it. */
      refresh: () => { events = []; buildRope(); draw(performance.now()); },
    };
  }

  // What the field keeps clear: the headline and the apps under it, or the sheet.
  const box = (element) => element.getBoundingClientRect();
  function zone() {
    const sheet = document.getElementById('sheet');
    if (!sheet.hidden) return box(sheet);
    return box(document.getElementById('intro-inner'));
  }
  window.lassoField = createField(document.getElementById('field'), { host: document.getElementById('stage'), zone });
})();
