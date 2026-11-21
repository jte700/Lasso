/* Lasso site core: theme, toasts with undo, command menu, shortcuts, the product menu's
   safe triangle, skeleton hydration, stale-while-revalidate data, BlurHash placeholders. */
(() => {
  'use strict';

  const root = document.documentElement;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = isMac ? '⌘' : 'Ctrl';
  const SUPPORT_EMAIL = 'support@mylasso.ca';

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const html = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstElementChild; };

  /* Storage can be blocked (private windows, file pages in some browsers); the site works without it. */
  const store = {
    get(key, fallback) {
      try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch (err) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (err) { return false; }
    },
  };

  /* Same-document view transition where the browser has them. */
  /* A transition the browser skips (a hidden tab, a second one starting) is not an error: the change still lands. */
  const quiet = (transition) => { transition?.ready?.catch(() => {}); transition?.finished?.catch(() => {}); };
  function morph(change) {
    if (!document.startViewTransition || reducedMotion) { change(); return; }
    quiet(document.startViewTransition(change));
  }


  /* ---------- toasts, with undo ---------- */
  const TOAST_LIFE_MS = 6000;
  let liveToast = null;

  function toastHost() {
    const host = $('.toasts') || document.body.appendChild(html('<div class="toasts" role="status" aria-live="polite"></div>'));
    // A modal dialog makes the rest of the page inert, so the toast moves inside the open one.
    const parent = $$('dialog[open]').pop() || document.body;
    if (host.parentElement !== parent) parent.appendChild(host);
    return host;
  }

  function dismissToast() {
    if (!liveToast) return;
    const { node, timer } = liveToast;
    liveToast = null;
    clearTimeout(timer);
    node.removeAttribute('data-show');
    setTimeout(() => node.remove(), 320);
  }

  function toast(message, { undo, life = TOAST_LIFE_MS } = {}) {
    dismissToast();
    const node = html(`<div class="toast glass--live" style="--life:${life}ms"><span>${escapeHtml(message)}</span>${undo ? `<button class="btn btn--sm" type="button">Undo <kbd>${MOD}Z</kbd></button>` : ''}<i></i></div>`);
    const runUndo = () => { dismissToast(); undo(); };
    if (undo) $('button', node).addEventListener('click', runUndo);
    toastHost().appendChild(node);
    requestAnimationFrame(() => requestAnimationFrame(() => node.setAttribute('data-show', '')));
    liveToast = { node, undo: undo ? runUndo : null, timer: setTimeout(dismissToast, life) };
  }

  /* ---------- theme ---------- */
  const currentTheme = () => (root.dataset.theme === 'light' ? 'light' : 'dark');

  function setTheme(next, { announce = true } = {}) {
    const previous = currentTheme();
    if (previous === next) return;
    // The event fires inside the change, so listeners read the new colours even when a view transition defers it.
    morph(() => {
      root.dataset.theme = next;
      document.dispatchEvent(new CustomEvent('lasso:theme', { detail: next }));
    });
    $('meta[name="theme-color"]')?.setAttribute('content', next === 'light' ? '#e4eef6' : '#131517');
    if (announce) toast(next === 'light' ? 'Light theme on' : 'Dark theme on', { undo: () => setTheme(previous, { announce: false }) });
  }
  // The page follows the system's light or dark setting; there is no switch of its own.

  /* ---------- copy, optimistically ---------- */
  async function copyText(text, button) {
    const label = button?.textContent;
    if (button) button.textContent = 'Copied';
    try {
      await navigator.clipboard.writeText(text);
      if (!button) toast(`Copied ${text}`);
    } catch (err) {
      if (button) button.textContent = label;
      toast('Copying is blocked here. Select the text and copy it by hand.');
      return;
    }
    if (button) setTimeout(() => { button.textContent = label; }, 1600);
  }

  /* ---------- command menu ---------- */
  const PAGES = [
    { label: 'Home', href: '/', keys: ['G', 'H'], icon: '~' },
    { label: 'All features', href: '/product/', keys: ['G', 'F'], icon: '+' },
    { label: 'Autocomplete', href: '/product/autocomplete/', icon: '+' },
    { label: 'Cell and passage picker', href: '/product/picker/', icon: '+' },
    { label: 'AI writer', href: '/product/ai-writer/', icon: '+' },
    { label: 'Provenance and source changes', href: '/product/provenance/', icon: '+' },
    { label: 'Sharing', href: '/product/sharing/', icon: '+' },
    { label: 'Dictation', href: '/product/#dictation', icon: '+' },
    { label: 'USB drives', href: '/product/#usb', icon: '+' },
    { label: 'Lasso for finance', href: '/finance/', keys: ['G', 'N'], icon: '$' },
    { label: 'Security', href: '/security/', keys: ['G', 'Y'], icon: '-' },
    { label: 'Benchmarks', href: '/benchmarks/', keys: ['G', 'B'], icon: '#' },
    { label: 'Lasso MCP', href: '/mcp/', keys: ['G', 'M'], icon: '>' },
    { label: 'The Ranch', href: '/ranch/', keys: ['G', 'R'], icon: '~' },
    { label: 'Savings calculator', href: '/mcp/#calc', keys: ['G', 'A'], icon: '$' },
    { label: 'Download', href: '/download/', keys: ['G', 'D'], icon: '!' },
    { label: 'Sources', href: '/sources/', keys: ['G', 'S'], icon: '*' },
    { label: 'Contact', href: '/contact/', keys: ['G', 'C'], icon: '@' },
    { label: 'Privacy policy', href: '/privacy/', keys: ['G', 'P'], icon: '-' },
    { label: 'Terms of service', href: '/terms/', keys: ['G', 'T'], icon: '-' },
  ];
  const ACTIONS = [
    { label: 'Join the waitlist', keys: ['W'], icon: '!', run: () => window.LASSO.waitlist?.open() },
    { label: `Copy ${SUPPORT_EMAIL}`, icon: '@', run: () => copyText(SUPPORT_EMAIL) },
    { label: 'Open @typelasso on X', icon: 'x', href: 'https://x.com/typelasso' },
  ];
  let palette = null;

  const matches = (label, query) => query.split(/\s+/).every((word) => label.toLowerCase().includes(word));

  function paletteGroups(query) {
    const here = $$('[data-cmd]').map((el) => ({ label: el.dataset.cmd, href: `#${el.id}`, icon: '.' }));
    return [['Go to', PAGES], ['Do', ACTIONS], ['On this page', here]]
      .map(([title, items]) => [title, items.filter((item) => matches(item.label, query))])
      .filter(([, items]) => items.length);
  }

  function buildPalette() {
    const dialog = html(`<dialog class="cmd" aria-label="Command menu">
      <div class="cmd-scrim"></div>
      <div class="cmd-panel glass--live">
        <label class="cmd-input"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg><input type="text" placeholder="Search pages and actions" autocomplete="off" spellcheck="false" aria-controls="cmdList"></label>
        <div class="cmd-list" id="cmdList" role="listbox"></div>
        <div class="cmd-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
      </div></dialog>`);
    document.body.appendChild(dialog);
    const input = $('input', dialog);
    const list = $('.cmd-list', dialog);
    let items = [];
    let index = 0;

    const select = (next) => {
      index = (next + items.length) % Math.max(items.length, 1);
      $$('.cmd-item', list).forEach((el, i) => {
        el.setAttribute('aria-selected', String(i === index));
        if (i === index) el.scrollIntoView({ block: 'nearest' });
      });
    };
    const render = () => {
      const groups = paletteGroups(input.value.trim().toLowerCase());
      items = groups.flatMap(([, entries]) => entries);
      let n = 0;
      list.innerHTML = groups.map(([title, entries]) => `<div class="cmd-group">${title}</div>${entries.map((item) =>
        `<button class="cmd-item" type="button" role="option" data-i="${n++}"><i>${escapeHtml(item.icon)}</i><span>${escapeHtml(item.label)}</span>${(item.keys || []).map((k) => `<kbd>${k}</kbd>`).join('')}</button>`).join('')}`).join('')
        || '<div class="cmd-empty">Nothing by that name.<br>Try "benchmarks" or "waitlist".</div>';
      select(0);
    };
    const run = (item) => {
      if (!item) return;
      dialog.close();
      if (item.run) item.run();
      else if (/^https?:/.test(item.href)) window.open(item.href, '_blank', 'noopener');
      else location.href = item.href;
    };

    input.addEventListener('input', render);
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); select(index + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); select(index - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); run(items[index]); }
    });
    list.addEventListener('click', (e) => { const el = e.target.closest('.cmd-item'); if (el) run(items[Number(el.dataset.i)]); });
    list.addEventListener('pointermove', (e) => { const el = e.target.closest('.cmd-item'); if (el && Number(el.dataset.i) !== index) select(Number(el.dataset.i)); });
    $('.cmd-scrim', dialog).addEventListener('click', () => dialog.close());
    return { dialog, open: () => { input.value = ''; render(); dialog.showModal(); input.focus(); } };
  }

  function togglePalette() {
    palette = palette || buildPalette();
    if (palette.dialog.open) palette.dialog.close(); else palette.open();
  }

  /* ---------- keyboard shortcuts ---------- */
  const GO_WINDOW_MS = 900;
  const NEVER = -Infinity;
  let goArmedAt = NEVER; // not zero: a key pressed in a page's first second must not count as following G

  function onKeydown(e) {
    const key = e.key.toLowerCase();
    if ((e.metaKey || e.ctrlKey) && key === 'k') { e.preventDefault(); togglePalette(); return; }
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
    if ((e.metaKey || e.ctrlKey) && key === 'z' && liveToast?.undo && !typing) { e.preventDefault(); liveToast.undo(); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || $('dialog[open]')) return;

    if (performance.now() - goArmedAt < GO_WINDOW_MS) {
      goArmedAt = NEVER;
      const page = PAGES.find((p) => p.keys && p.keys[1].toLowerCase() === key);
      if (page) { e.preventDefault(); location.href = page.href; }
      return;
    }
    if (key === 'g') goArmedAt = performance.now();
    else if (key === '/' || key === '?') { e.preventDefault(); togglePalette(); }
    else if (key === 'w') window.LASSO.waitlist?.open();
  }

  /* ---------- product menu: the pane stays put while the pointer travels to it ---------- */
  const TRIANGLE_PATIENCE_MS = 280;
  const MENU_CLOSE_MS = 180;
  const HOVER_CLICK_MS = 400;

  const side = (p, a, b) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
  function insideTriangle(p, a, b, c) {
    const d = [side(p, a, b), side(p, b, c), side(p, c, a)];
    return !(d.some((v) => v < 0) && d.some((v) => v > 0));
  }

  function initProductMenu() {
    const trigger = $('#productBtn');
    const menu = $('#productMenu');
    if (!trigger || !menu) return;
    const pane = $('.menu-pane', menu);
    let trail = [];
    let pending = 0;
    let closing = 0;
    let openedAt = 0;

    const activate = (item) => {
      clearTimeout(pending); pending = 0;
      $$('.menu-item', menu).forEach((el) => el.toggleAttribute('data-active', el === item));
      $$('.menu-view', menu).forEach((el) => el.toggleAttribute('data-active', el.dataset.view === item.dataset.view));
    };
    const open = () => {
      clearTimeout(closing);
      const box = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(box.left - 12, innerWidth - menu.offsetWidth - 12))}px`;
      if (!menu.hasAttribute('data-open')) openedAt = performance.now();
      menu.setAttribute('data-open', '');
      trigger.setAttribute('aria-expanded', 'true');
    };
    const close = () => { menu.removeAttribute('data-open'); trigger.setAttribute('aria-expanded', 'false'); trail = []; };
    const closeSoon = () => { clearTimeout(closing); closing = setTimeout(close, MENU_CLOSE_MS); };

    trigger.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') open(); });
    trigger.addEventListener('pointerleave', closeSoon);
    // A click right after the hover that opened the menu is the same gesture, not a request to close it.
    trigger.addEventListener('click', () => (menu.hasAttribute('data-open') && performance.now() - openedAt > HOVER_CLICK_MS ? close() : open()));
    menu.addEventListener('pointerenter', () => clearTimeout(closing));
    menu.addEventListener('pointerleave', closeSoon);
    menu.addEventListener('focusin', (e) => { const item = e.target.closest('.menu-item'); if (item) activate(item); });
    menu.addEventListener('focusout', (e) => { if (!menu.contains(e.relatedTarget) && e.relatedTarget !== trigger) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menu.hasAttribute('data-open')) { close(); trigger.focus(); } });
    document.addEventListener('pointerdown', (e) => { if (!menu.contains(e.target) && !trigger.contains(e.target)) close(); });

    menu.addEventListener('pointermove', (e) => {
      const here = { x: e.clientX, y: e.clientY };
      const origin = trail[0] || here;
      trail = [...trail.slice(-3), here];
      const item = e.target.closest('.menu-item');
      if (!item || item.hasAttribute('data-active')) { clearTimeout(pending); pending = 0; return; }
      if (!pane) { activate(item); return; }
      const box = pane.getBoundingClientRect();
      const heading = insideTriangle(here, origin, { x: box.left, y: box.top }, { x: box.left, y: box.bottom }) && here.x > origin.x;
      if (!heading) { activate(item); return; }
      // Moving toward the pane: wait, and switch only if the pointer settles on this row.
      if (!pending) pending = setTimeout(() => activate(item), TRIANGLE_PATIENCE_MS);
    });
  }

  /* ---------- hydration behind skeletons ---------- */
  const renderers = new Map();
  let data = window.LASSO_DATA;

  const whenIdle = (work) => ('requestIdleCallback' in window ? requestIdleCallback(work, { timeout: 600 }) : setTimeout(work, 60));

  function paint(el) {
    const render = renderers.get(el.dataset.hydrate);
    if (!render) return;
    try {
      const node = render(el, data);
      el.querySelector(':scope > .hydrated')?.remove();
      if (node) { node.classList.add('hydrated'); el.appendChild(node); initTabIndicators(node); }
      el.classList.add('ready');
    } catch (err) {
      console.error(`Lasso site: could not draw "${el.dataset.hydrate}"`, err);
      el.classList.add('ready');
      el.appendChild(html('<p class="note hydrated">This chart could not be drawn. The numbers are on the sources page.</p>'));
    }
  }

  const nearView = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      nearView.unobserve(entry.target);
      whenIdle(() => paint(entry.target));
    }), { rootMargin: '320px 0px' })
    : null;

  function hydrate(name, render) {
    renderers.set(name, render);
    $$(`[data-hydrate="${name}"]`).forEach((el) => (nearView ? nearView.observe(el) : paint(el)));
  }

  /* Stale while revalidate: draw with the copy on hand, fetch a fresh one, redraw only if it changed. */
  async function revalidateData() {
    const cached = store.get('lasso.data', null);
    if (cached && cached.version > data.version) data = cached;
    if (location.protocol === 'file:') return;
    try {
      const response = await fetch('/assets/data/benchmarks.json', { cache: 'no-cache' });
      if (!response.ok) return;
      const fresh = await response.json();
      if (!fresh.version || fresh.version === data.version) return;
      data = fresh;
      store.set('lasso.data', fresh);
      $$('[data-hydrate].ready').forEach(paint);
      document.dispatchEvent(new CustomEvent('lasso:data', { detail: fresh }));
    } catch (err) {
      console.warn('Lasso site: keeping the benchmark data it shipped with', err);
    }
  }

  /* ---------- BlurHash placeholders ---------- */
  const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  const decode83 = (text) => [...text].reduce((value, c) => value * 83 + B83.indexOf(c), 0);
  const toLinear = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const toSrgb = (v) => { const c = Math.max(0, Math.min(1, v)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255); };
  const signedSquare = (v) => Math.sign(v) * v * v;

  function decodeBlurHash(hash, width, height) {
    const sizeFlag = decode83(hash[0]);
    const nx = (sizeFlag % 9) + 1;
    const ny = Math.floor(sizeFlag / 9) + 1;
    const maxAc = (decode83(hash[1]) + 1) / 166;
    const colours = Array.from({ length: nx * ny }, (_, i) => {
      if (i === 0) { const v = decode83(hash.slice(2, 6)); return [toLinear(v >> 16), toLinear((v >> 8) & 255), toLinear(v & 255)]; }
      const v = decode83(hash.slice(4 + i * 2, 6 + i * 2));
      return [Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19].map((q) => signedSquare((q - 9) / 9) * maxAc);
    });
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0;
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            const basis = Math.cos((Math.PI * x * i) / width) * Math.cos((Math.PI * y * j) / height);
            const c = colours[i + j * nx];
            r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
          }
        }
        pixels.set([toSrgb(r), toSrgb(g), toSrgb(b), 255], 4 * (x + y * width));
      }
    }
    return pixels;
  }

  function initShots() {
    $$('canvas[data-blurhash]').forEach((canvas) => {
      try {
        const image = new ImageData(decodeBlurHash(canvas.dataset.blurhash, canvas.width, canvas.height), canvas.width, canvas.height);
        canvas.getContext('2d').putImageData(image, 0, 0);
      } catch (err) {
        console.warn('Lasso site: placeholder not drawn', err);
      }
    });
    $$('.shot img').forEach((img) => {
      // once the picture is in, its blurred placeholder steps aside (the picture has transparent corners)
      const done = () => { img.classList.add('loaded'); img.closest('.shot')?.classList.add('loaded'); };
      if (img.complete && img.naturalWidth) done(); else img.addEventListener('load', done, { once: true });
    });
  }

  /* ---------- small behaviours ---------- */
  const OBSERVER_FALLBACK_MS = 2500;
  const COUNT_MS = 1400;

  /* Figures count up from zero the first time they arrive. The page's own text already holds the
     final value, so anything that never runs this still shows the right number. */
  function countUp(scope) {
    $$('[data-count]', scope).forEach((el) => {
      const to = Number(el.dataset.count);
      if (!Number.isFinite(to) || to < 2) return;
      el._shown = 0;
      tween(el, to, (v) => Math.round(v).toLocaleString('en'), COUNT_MS);
    });
  }

  function reveal(el) {
    el.classList.add('in');
    countUp(el);
  }

  function initReveal() {
    if (!('IntersectionObserver' in window)) { $$('.rv').forEach((el) => el.classList.add('in')); return; }
    let answered = false;
    const seen = new IntersectionObserver((entries) => entries.forEach((entry) => {
      answered = true;
      if (entry.isIntersecting) { reveal(entry.target); seen.unobserve(entry.target); }
    }), { rootMargin: '0px 0px -8% 0px' });
    $$('.rv').forEach((el) => seen.observe(el));
    // A browser that never reports visibility (a throttled preview, a page snapshot) still gets the whole page.
    setTimeout(() => {
      if (answered) return;
      seen.disconnect();
      $$('.rv').forEach(reveal);
      $$('[data-hydrate]:not(.ready)').forEach(paint);
    }, OBSERVER_FALLBACK_MS);
  }

  const GLASS = '.panel, .calc, .card, .values, .filecard, details.ex';
  const SCROLLED_PX = 8;

  /* The bar firms up once the page scrolls under it. */
  function initNavScroll() {
    const bar = $('.nav');
    if (!bar) return;
    let frame = 0;
    const update = () => { frame = 0; bar.classList.toggle('scrolled', window.scrollY > SCROLLED_PX); };
    window.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
    update();
  }

  /* One pill slides between the options of every segmented control. */
  function initTabIndicators(scope = document) {
    $$('.tabs', scope).forEach((tabs) => {
      if (tabs.classList.contains('has-ind')) return;
      const pill = document.createElement('span');
      pill.className = 'tabs-ind';
      pill.setAttribute('aria-hidden', 'true');
      tabs.prepend(pill);
      tabs.classList.add('has-ind');
      const place = () => {
        const on = $('.seg:is([aria-selected="true"], [aria-pressed="true"])', tabs);
        pill.style.opacity = on ? '1' : '0';
        if (!on) return;
        pill.style.width = `${on.offsetWidth}px`;
        pill.style.height = `${on.offsetHeight}px`;
        pill.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
      };
      pill.style.transition = 'none';
      place();
      requestAnimationFrame(() => requestAnimationFrame(() => { pill.style.transition = ''; }));
      new MutationObserver(place).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-pressed'] });
      new ResizeObserver(place).observe(tabs);
    });
  }

  function initSheen() {
    let frame = 0;
    document.addEventListener('pointermove', (e) => {
      if (frame || e.pointerType !== 'mouse') return;
      const panel = e.target.closest?.(GLASS);
      if (!panel) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const box = panel.getBoundingClientRect();
        panel.style.setProperty('--mx', `${e.clientX - box.left}px`);
        panel.style.setProperty('--my', `${e.clientY - box.top}px`);
      });
    }, { passive: true });
  }

  function initTabs() {
    $$('[role="tablist"]').forEach((tablist) => {
      const tabs = $$('[role="tab"]', tablist);
      // The pill slides and the new panel fades in (see [role="tabpanel"] in the stylesheet).
      const show = (tab) => tabs.forEach((t) => {
        t.setAttribute('aria-selected', String(t === tab));
        t.tabIndex = t === tab ? 0 : -1;
        const panel = document.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = t !== tab;
      });
      tablist.addEventListener('click', (e) => { const tab = e.target.closest('[role="tab"]'); if (tab) show(tab); });
      tablist.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(tabs.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.focus(); show(next);
      });
    });
  }

  /* Browsers without speculation rules still get the next page fetched on intent. */
  function initPrefetch() {
    if (location.protocol === 'file:' || HTMLScriptElement.supports?.('speculationrules')) return;
    const fetched = new Set();
    const warm = (e) => {
      const link = e.target.closest?.('a[href]');
      if (!link || link.origin !== location.origin || link.pathname === location.pathname || fetched.has(link.pathname)) return;
      fetched.add(link.pathname);
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'prefetch', href: link.pathname }));
    };
    document.addEventListener('pointerenter', warm, { capture: true, passive: true });
    document.addEventListener('touchstart', warm, { capture: true, passive: true });
    document.addEventListener('focusin', warm);
  }

  function initServiceWorker() {
    const secure = location.protocol === 'https:'; // the trial copy skips the offline cache on localhost
    if (!secure || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('Lasso site: offline cache not installed', err));
  }

  /* A number that eases to its new value from wherever it is, so dragging a slider never queues animations. */
  const TWEEN_MS = 420;
  function tween(el, to, format, duration = TWEEN_MS) {
    const from = Number.isFinite(el._shown) ? el._shown : to;
    cancelAnimationFrame(el._frame);
    if (reducedMotion || from === to) { el._shown = to; el.textContent = format(to); return; }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      el._shown = from + (to - from) * (1 - (1 - t) ** 3);
      el.textContent = format(el._shown);
      if (t < 1) el._frame = requestAnimationFrame(step); else el._shown = to;
    };
    el._frame = requestAnimationFrame(step);
  }

  function init() {
    root.classList.remove('no-js');
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action], [data-copy]');
      if (!el) return;
      if (el.dataset.copy) { copyText(el.dataset.copy === 'prev' ? el.closest('.code-wrap').querySelector('pre').textContent : el.dataset.copy, el); return; }
      if (el.dataset.action === 'palette') togglePalette();
    });
    $$('[data-mod]').forEach((el) => { el.textContent = MOD; });
    initProductMenu(); initReveal(); initSheen(); initTabs(); initTabIndicators(); initNavScroll(); initShots(); initPrefetch(); initServiceWorker();
    revalidateData();
  }

  window.LASSO = {
    $, $$, html, escapeHtml, store, toast, morph, tween, hydrate, copyText, reducedMotion, reveal,
    get data() { return data; },
    setTheme, currentTheme,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
