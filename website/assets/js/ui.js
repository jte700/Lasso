/* Shared pieces for the product demos: scenes drawn at a fixed size and scaled to fit, a clock that
   only runs while a demo is on screen, file-type tiles, and the keyboard symbols for this platform. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isWindows = /^win/i.test(navigator.platform || '') || /Windows NT/.test(navigator.userAgent);
  document.documentElement.dataset.os = isWindows ? 'windows' : 'mac';

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstElementChild; };

  /* A scene is drawn at data-w by data-h and scaled to the width it is given. */
  /* On a phone a scene may be drawn narrower (data-w-sm, data-h-sm), so its words stay legible;
     the width in use is kept in data-cw for the demos that place things by it. */
  const NARROW_PX = 600;
  function fitScene(scene) {
    const inner = $(':scope > .scene-in', scene);
    const apply = () => {
      const narrow = scene.parentElement.clientWidth < NARROW_PX && scene.dataset.wSm;
      const w = Number(narrow ? scene.dataset.wSm : scene.dataset.w || 1000);
      const h = Number(narrow ? scene.dataset.hSm : scene.dataset.h || 620);
      if (scene.dataset.cw !== String(w)) {
        scene.dataset.cw = String(w);
        scene.style.aspectRatio = `${w} / ${h}`;
        if (inner) { inner.style.width = `${w}px`; inner.style.height = `${h}px`; }
      }
      scene.style.setProperty('--s', String(scene.clientWidth / w || 1));
    };
    new ResizeObserver(apply).observe(scene.parentElement);
    apply();
  }
  const sceneWidth = (scene) => Number(scene.dataset.cw || scene.dataset.w || 1000);
  const scale = (scene) => Number(getComputedStyle(scene).getPropertyValue('--s')) || 1;

  /* A demo's clock: waits count only while the demo is on screen and the tab is visible, and a
     newer run cancels an older one. */
  const STOP = Symbol('stop');
  function stage(el, { threshold = 0.25 } = {}) {
    let visible = false, answered = false, token = 0;
    const listeners = new Set();
    const io = new IntersectionObserver(([e]) => { answered = true; visible = e.isIntersecting; listeners.forEach((f) => f(visible)); }, { threshold });
    io.observe(el);
    // A browser that never reports visibility (a throttled preview, a page snapshot) still plays.
    setTimeout(() => { if (!answered) { visible = true; listeners.forEach((f) => f(true)); } }, 1500);
    const running = () => visible && !document.hidden;
    const wait = (ms, t) => new Promise((resolve, reject) => {
      let left = ms, last = performance.now();
      const tick = () => {
        if (t !== token) { reject(STOP); return; }
        const now = performance.now();
        if (running()) left -= now - last;
        last = now;
        if (left <= 0) resolve(); else setTimeout(tick, 30);
      };
      setTimeout(tick, 30);
    });
    return {
      get visible() { return running(); },
      onVisible(f) { listeners.add(f); },
      begin() { return ++token; },
      stop() { token++; },
      wait,
      run(fn) {
        const t = ++token;
        Promise.resolve().then(() => fn(t)).catch((err) => { if (err !== STOP) throw err; });
        return t;
      },
    };
  }

  /* File-type tiles, drawn like the system icons at a glance: a coloured mark on a page. */
  const KINDS = {
    xlsx: { mark: 'X', tone: '#1f8a4c', label: 'Excel' },
    xls: { mark: 'X', tone: '#1f8a4c', label: 'Excel' },
    csv: { mark: 'CSV', tone: '#2f8f5b', label: 'CSV' },
    pdf: { mark: 'PDF', tone: '#d1453b', label: 'PDF' },
    docx: { mark: 'W', tone: '#2b65c9', label: 'Word' },
    pptx: { mark: 'P', tone: '#d0612e', label: 'PowerPoint' },
    mov: { mark: '▶', tone: '#6e56cf', label: 'Video' },
    md: { mark: 'MD', tone: '#6b7280', label: 'Text' },
    usb: { mark: '', tone: '#6b7280', label: 'Drive' },
  };
  const fileIcon = (kind, size = 'md') => {
    const k = KINDS[kind] || KINDS.md;
    return `<span class="ficon ficon--${size}" style="--ft:${k.tone}" aria-hidden="true"><i>${esc(k.mark)}</i></span>`;
  };
  const kindLabel = (kind) => (KINDS[kind] || KINDS.md).label;

  /* Keys as this platform writes them. */
  const KEY = isWindows
    ? { cmd: 'Ctrl', ret: 'Enter', opt: 'Alt', shift: 'Shift' }
    : { cmd: '⌘', ret: '↵', opt: '⌥', shift: '⇧' };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* A passage line with only the words still to be written highlighted: the picker opens on the
     rest of the sentence, from where the typed words leave off. */
  function markRest(line, insert) {
    const rest = (insert || '').trim();
    const mark = line.mark || '';
    const cut = rest && mark.endsWith(rest) ? mark.length - rest.length : 0;
    return `${esc(line.before || '')}${esc(mark.slice(0, cut))}<mark>${esc(mark.slice(cut))}</mark>${esc(line.after || '')}`;
  }

  function init() { $$('[data-scene]').forEach(fitScene); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  window.LASSO_UI = { $, $$, esc, html, fitScene, scale, stage, STOP, fileIcon, kindLabel, KEY, isWindows, reducedMotion, sleep, markRest, sceneWidth };
})();
