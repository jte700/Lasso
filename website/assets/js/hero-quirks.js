/* The moving parts of the mascot heroes on Security, Benchmarks and The Loop
   (styles in hero-quirks.css). Each page has at most one of them. */
(() => {
  'use strict';

  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  // Pressing the mascot does what a click does, from the keyboard too.
  const pressable = (el, act) => {
    el.addEventListener('click', act);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
  };
  const replay = (el, cls, ms) => {
    el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
    clearTimeout(el._quirkTimer);
    el._quirkTimer = setTimeout(() => el.classList.remove(cls), ms);
  };

  // Security: pressing the mascot makes it shake its head, and the ring shows it is locked.
  function vault(pet) {
    pressable(pet, () => replay(pet, 'nope', 1600));
  }

  // Benchmarks: real prompts from the typing test, typed a key at a time.
  const TYPE_MS = 62, OFFER_MS = 260, HOLD_MS = 2000, CLEAR_MS = 420;
  const OFFER_MAX = 22;

  function prompts(data) {
    const cases = data?.typing?.cases ?? [];
    const shown = cases
      .map((c, i) => ({ ...c, n: i + 1 }))
      .filter((c) => c.r === 1 && c.o?.[0] && c.o[0].length <= OFFER_MAX && (c.k !== 'name' || c.o[0] === c.e));
    return { shown, total: cases.length, median: data?.typing?.library?.score?.latency?.p50 };
  }

  async function clock(pet) {
    const line = document.querySelector('.clock-line');
    const typed = line?.querySelector('.clock-typed');
    const offer = line?.querySelector('.clock-offer span');
    const meta = document.querySelector('.clock-meta');
    if (!line || !typed || !offer) return;
    for (let tries = 0; !window.LASSO_DATA && tries < 40; tries++) await sleep(50);
    const { shown, total, median } = prompts(window.LASSO_DATA);
    if (!shown.length) return;

    let index = 0, skip = false, visible = true;
    pressable(pet, () => { skip = true; });
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(pet);
    const ms = median ? `${Math.round(median)} ms median a key` : '';
    const wait = async (time) => {
      const end = performance.now() + time;
      while (performance.now() < end || !visible) {
        if (skip) return;
        await sleep(40);
      }
    };
    const show = (c, chars) => {
      typed.textContent = c.t.slice(0, chars);
      pet.style.setProperty('--p', String(chars / c.t.length));
    };

    for (;;) {
      const c = shown[index % shown.length];
      index += 1;
      skip = false;
      offer.textContent = c.o[0];
      if (meta) meta.textContent = [`Prompt ${c.n} of ${total}`, 'first suggestion right', ms].filter(Boolean).join(' · ');
      line.classList.remove('has-offer');
      pet.classList.remove('is-happy');
      if (still) {
        show(c, c.t.length);
      } else {
        for (let i = 1; i <= c.t.length && !skip; i++) { show(c, i); await wait(TYPE_MS); }
        show(c, c.t.length);
        await wait(OFFER_MS);
      }
      line.classList.add('has-offer');
      pet.classList.add('is-happy');
      if (still) return;
      await wait(HOLD_MS);
      skip = false;
      line.classList.remove('has-offer');
      pet.classList.remove('is-happy');
      show(c, 0);
      await wait(CLEAR_MS);
    }
  }

  // The Loop: the herd rides round the ring, nearer and larger at the front, and stops
  // while the pointer is over it so a rider can be clicked. One hops now and then, and
  // any of them when clicked.
  const HOP_MS = 700, IDLE_HOP_MS = 3200, LAP_MS = 24000;
  // The ring as drawn in the page, in percent of the track (cx 280, cy 133, rx 246, ry 39 of 560 by 196).
  const RING = { cx: 50, cy: 67.9, rx: 43.9, ry: 19.9 };
  const NEAR = { scale: [0.68, 1], opacity: [0.5, 1] };
  const between = ([far, near], depth) => far + (near - far) * depth;

  function place(rider, turn) {
    const angle = turn * 2 * Math.PI;
    const depth = (Math.sin(angle) + 1) / 2;
    rider.style.setProperty('--x', `${RING.cx + RING.rx * Math.cos(angle)}%`);
    rider.style.setProperty('--y', `${RING.cy + RING.ry * Math.sin(angle)}%`);
    rider.style.setProperty('--s', between(NEAR.scale, depth).toFixed(3));
    rider.style.setProperty('--o', between(NEAR.opacity, depth).toFixed(3));
    rider.style.zIndex = String(Math.round(depth * 20));
  }

  function loopTrack(track) {
    const lead = track.querySelector('.rider--lead');
    const riders = [...track.querySelectorAll('.rider:not(.rider--lead)')];
    const everyone = [lead, ...riders].filter(Boolean);
    const phases = riders.map((r) => Number(r.style.getPropertyValue('--phase')) || 0);
    const hop = (rider) => replay(rider, 'hop', HOP_MS);
    everyone.forEach((rider) => rider.addEventListener('click', () => hop(rider)));
    track.style.setProperty('--lap', `${LAP_MS / 1000}s`);
    riders.forEach((rider, i) => place(rider, phases[i]));
    if (still) return;

    let held = false, visible = true, turn = 0, then = performance.now();
    track.addEventListener('pointerenter', () => { held = true; });
    track.addEventListener('pointerleave', () => { held = false; });
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }).observe(track);
    const frame = (now) => {
      const moving = !held && visible;
      track.classList.toggle('is-held', !moving);
      if (moving) turn = (turn + (now - then) / LAP_MS) % 1;
      then = now;
      riders.forEach((rider, i) => place(rider, phases[i] + turn));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    let last = -1;
    setInterval(() => {
      if (document.hidden || !visible) return;
      let next = Math.floor(Math.random() * everyone.length);
      if (next === last) next = (next + 1) % everyone.length;
      last = next;
      hop(everyone[next]);
    }, IDLE_HOP_MS);
  }

  const start = () => {
    document.querySelectorAll('.pet--vault').forEach(vault);
    document.querySelectorAll('.pet--clock').forEach((pet) => { clock(pet); });
    document.querySelectorAll('.loop-track').forEach(loopTrack);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
