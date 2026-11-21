/* The file kinds as a concave carousel, after React Bits' Concave Carousel: the cards stand on the
   inside of a cylinder, so the one in front sits furthest back and those to the sides turn in and
   come closer. Drag, swipe, the arrow keys or the buttons move it; a click on a side card brings
   that card to the front. It wraps around, and settles on a spring. */
(() => {
  'use strict';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STEP_DEG = 34;
  const GAP = 1.04; // the space between cards, as a share of a card's width
  const SHOWN = 2.6; // cards further round than this are hidden
  const STIFFNESS = 170, DAMPING = 24;
  const DRAG_CLICK_PX = 6;
  const FACE_W = 340; // the width a card is drawn at (showcase.css .fa)

  function mount(root) {
    const stage = root.querySelector('.cc-stage');
    const items = [...root.querySelectorAll('.cc-item')];
    const title = root.querySelector('[data-cc-title]');
    const sub = root.querySelector('[data-cc-sub]');
    const exts = root.querySelector('[data-cc-ext]');
    const count = root.querySelector('[data-cc-count]');
    const live = root.querySelector('[data-cc-live]');
    const n = items.length;
    let pos = 0, target = 0, velocity = 0, frame = 0, last = 0, radius = 0, shown = -1;
    let drag = null;

    const wrap = (d) => ((((d + n / 2) % n) + n) % n) - n / 2;
    const measure = () => {
      const w = items[0].offsetWidth;
      radius = ((w * GAP) / 2) / Math.tan((STEP_DEG * Math.PI) / 360);
      // each card is drawn at its widest size and scaled to fit, so narrow screens see the same card
      root.style.setProperty('--k', String(w / FACE_W));
    };

    function place() {
      for (let i = 0; i < n; i++) {
        const d = wrap(i - pos);
        const away = Math.abs(d);
        const el = items[i];
        if (away > SHOWN) { el.style.visibility = 'hidden'; continue; }
        el.style.visibility = '';
        el.style.opacity = String(Math.min(1, Math.max(0, SHOWN - away)));
        el.style.transform = `translateZ(${radius}px) rotateY(${-d * STEP_DEG}deg) translateZ(${-radius}px)`;
        el.style.zIndex = String(100 - Math.round(away * 10));
      }
      const front = ((Math.round(pos) % n) + n) % n;
      if (front !== shown) {
        shown = front;
        const el = items[front];
        title.textContent = el.dataset.title;
        sub.textContent = el.dataset.sub;
        exts.textContent = el.dataset.ext;
        count.innerHTML = `<b>${String(front + 1).padStart(2, '0')}</b> / ${String(n).padStart(2, '0')}`;
        items.forEach((item, i) => item.setAttribute('aria-hidden', String(i !== front)));
        live.textContent = `${el.dataset.title}, ${front + 1} of ${n}`;
      }
    }

    function tick(now) {
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
      last = now;
      if (!drag) {
        const force = (target - pos) * STIFFNESS - velocity * DAMPING;
        velocity += force * dt;
        pos += velocity * dt;
        if (Math.abs(target - pos) < 0.0005 && Math.abs(velocity) < 0.002) { pos = target; velocity = 0; place(); frame = 0; return; }
      }
      place();
      frame = requestAnimationFrame(tick);
    }
    const run = () => { if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); } };
    const go = (to) => {
      target = to;
      if (reducedMotion) { pos = target; velocity = 0; place(); return; }
      run();
    };
    const by = (k) => go(Math.round(target) + k);

    root.querySelector('[data-cc-prev]').addEventListener('click', () => by(-1));
    root.querySelector('[data-cc-next]').addEventListener('click', () => by(1));
    stage.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); by(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); by(-1); }
      else if (e.key === 'Home') { e.preventDefault(); go(Math.round(target) - wrap(Math.round(target))); }
    });

    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, from: pos, moved: 0, t: performance.now(), lastX: e.clientX, v: 0, decided: false };
    });
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.decided) {
        if (Math.abs(dx) < DRAG_CLICK_PX && Math.abs(dy) < DRAG_CLICK_PX) return;
        drag.decided = true;
        // a mostly vertical move is the page scrolling, not the carousel
        if (Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
        stage.setPointerCapture?.(e.pointerId);
      }
      const now = performance.now();
      drag.v = (e.clientX - drag.lastX) / Math.max(1, now - drag.t);
      drag.t = now; drag.lastX = e.clientX;
      drag.moved = Math.abs(dx);
      pos = drag.from - dx / (items[0].offsetWidth * GAP);
      place(); run();
    });
    const release = (e) => {
      if (!drag) return;
      const wasDrag = drag.moved >= DRAG_CLICK_PX;
      const fling = (-drag.v * 1000) / (items[0].offsetWidth * GAP) * 0.18;
      drag = null;
      if (wasDrag) { velocity = 0; go(Math.round(pos + Math.max(-2, Math.min(2, fling)))); return; }
      const card = e.target.closest?.('.cc-item');
      if (card) {
        const d = Math.round(wrap(items.indexOf(card) - pos));
        if (d) go(Math.round(target) + d);
      }
    };
    addEventListener('pointerup', release);
    addEventListener('pointercancel', () => { if (drag) { drag = null; go(Math.round(pos)); } });
    stage.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 2) return;
      e.preventDefault();
      clearTimeout(stage._wheel);
      pos += e.deltaX / (items[0].offsetWidth * GAP);
      target = pos; place();
      stage._wheel = setTimeout(() => go(Math.round(pos)), 120);
    }, { passive: false });

    new ResizeObserver(() => { measure(); place(); }).observe(stage);
    measure(); place();
  }

  const init = () => document.querySelectorAll('[data-carousel]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
