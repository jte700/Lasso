/* The 2D mascot, redrawn in characters. The picture is sampled cell by cell: its outline becomes
   slashes and bars by the direction of the edge, its body a ramp of denser glyphs by brightness,
   each in the colour under it, so the eyes stay as gaps. On a page, [data-ascii-mascot] shows the
   picture first, then a scan line runs down it and leaves the character version behind, which
   flickers now and then. A click plays it again. window.LassoAscii.cells is shared with the
   media scenes, which draw the same mascot in a terminal. */
(() => {
  'use strict';
  const RAMP = '.:-=+*o#%@';
  const NOISE = '01<>/\\|[]{}#%*+=-:;$&@';
  const CHAR_W = 0.6; // a monospaced glyph's width, in ems
  const SUB = 3; // samples per cell on each axis
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const loadImage = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });

  /* One cell per character: its glyph and colour, or null where the picture is empty. */
  function cells(img, cols, rows) {
    const w = cols * SUB, h = rows * SUB;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const alpha = new Float32Array(cols * rows);
    const rgb = new Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let a = 0, R = 0, G = 0, B = 0;
        for (let y = 0; y < SUB; y++) {
          for (let x = 0; x < SUB; x++) {
            const i = ((r * SUB + y) * w + c * SUB + x) * 4;
            const pa = px[i + 3] / 255;
            a += pa; R += px[i] * pa; G += px[i + 1] * pa; B += px[i + 2] * pa;
          }
        }
        const n = SUB * SUB;
        alpha[r * cols + c] = a / n;
        rgb[r * cols + c] = a > 0 ? [R / a, G / a, B / a] : [0, 0, 0];
      }
    }
    const at = (c, r) => (c < 0 || r < 0 || c >= cols || r >= rows ? 0 : alpha[r * cols + c]);
    const out = [];
    for (let r = 0; r < rows; r++) {
      const line = [];
      for (let c = 0; c < cols; c++) {
        const a = at(c, r);
        if (a < 0.12) { line.push(null); continue; }
        const [R, G, B] = rgb[r * cols + c];
        const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        const gx = at(c + 1, r) - at(c - 1, r);
        const gy = at(c, r + 1) - at(c, r - 1);
        let ch;
        if (a < 0.8 || Math.hypot(gx, gy) > 0.55) {
          // an edge: drawn across the direction the picture ends in
          const ax = Math.abs(gx), ay = Math.abs(gy);
          if (ay > ax * 2.2) ch = gy > 0 ? '_' : '-';
          else if (ax > ay * 2.2) ch = '|';
          else ch = gx * gy > 0 ? '\\' : '/';
        } else if (lum < 0.22) {
          ch = null; // the eyes and other dark marks stay as gaps
        } else {
          ch = RAMP[Math.min(RAMP.length - 1, Math.floor(lum * RAMP.length))];
        }
        line.push(ch ? { ch, color: `rgb(${R | 0} ${G | 0} ${B | 0})` } : null);
      }
      out.push(line);
    }
    return out;
  }

  /* ---------- on a page ---------- */
  const SCAN_DELAY_MS = 700;
  const SCAN_MS = 1500;
  const BAND_ROWS = 2.5;
  const FLICKER_EVERY_MS = 90;
  const FLICKER_MS = 140;

  function mount(host) {
    const img = host.querySelector('img');
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let grid = [], cols = 0, rows = 0, cellW = 0, rowH = 0, fontPx = 0, ratio = 1;
    let startedAt = -1, frame = 0, visible = false, flicker = new Map(), lastFlicker = 0;
    const accent = () => getComputedStyle(host).getPropertyValue('--scan').trim() || '#8ec5f4';
    const mono = () => getComputedStyle(document.documentElement).getPropertyValue('--mono') || 'monospace';

    async function layout() {
      const box = host.getBoundingClientRect();
      if (!box.width) return;
      ratio = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
      cols = Number(host.dataset.cols || 46);
      cellW = box.width / cols;
      fontPx = cellW / CHAR_W;
      rowH = fontPx * 0.98;
      rows = Math.floor(box.height / rowH);
      const picture = await loadImage(img.currentSrc || img.src);
      // the cells cover the box the picture fills; rows are taller than columns are wide
      grid = cells(picture, cols, rows);
    }

    function draw(now) {
      const t = startedAt < 0 ? 0 : now - startedAt;
      const progress = reducedMotion ? 1 : Math.min(1, Math.max(0, (t - SCAN_DELAY_MS) / SCAN_MS));
      const scanRow = progress * (rows + BAND_ROWS * 2) - BAND_ROWS;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = `600 ${fontPx}px ${mono()}`;
      ctx.textBaseline = 'top';
      const band = accent();
      if (progress >= 1 && !reducedMotion && now - lastFlicker > FLICKER_EVERY_MS) {
        lastFlicker = now;
        const r = Math.floor(Math.random() * rows), c = Math.floor(Math.random() * cols);
        if (grid[r]?.[c]) flicker.set(`${r}:${c}`, now);
      }
      for (let r = 0; r < rows; r++) {
        if (r > scanRow + BAND_ROWS) break;
        const inBand = r > scanRow - BAND_ROWS;
        for (let c = 0; c < cols; c++) {
          const cell = grid[r][c];
          if (!cell) continue;
          const key = `${r}:${c}`;
          const flickedAt = flicker.get(key);
          let ch = cell.ch, color = cell.color;
          if (inBand) { ch = NOISE[(Math.random() * NOISE.length) | 0]; color = band; }
          else if (flickedAt) {
            if (now - flickedAt > FLICKER_MS) flicker.delete(key);
            else { ch = NOISE[(Math.random() * NOISE.length) | 0]; color = band; }
          }
          ctx.fillStyle = color;
          ctx.fillText(ch, c * cellW, r * rowH);
        }
      }
      // the picture gives way above the scan line
      const cut = Math.max(0, Math.min(1, (scanRow + BAND_ROWS * 0.5) / rows));
      img.style.clipPath = `inset(${(cut * 100).toFixed(2)}% 0 0 0)`;
      host.classList.toggle('is-ascii', progress >= 1);
      if (visible && !document.hidden && !(reducedMotion && progress >= 1)) frame = requestAnimationFrame(draw);
    }

    const play = () => { startedAt = performance.now(); flicker.clear(); cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    const resume = () => { cancelAnimationFrame(frame); if (visible) frame = requestAnimationFrame(draw); };

    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && startedAt < 0) play(); else resume();
    }, { threshold: 0.2 }).observe(host);
    document.addEventListener('visibilitychange', resume);
    host.addEventListener('click', play);
    let resizeTimer = 0;
    new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => layout().then(resume), 80); }).observe(host);
    layout().then(resume);
  }

  window.LassoAscii = { cells, loadImage };
  const init = () => document.querySelectorAll('[data-ascii-mascot]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
