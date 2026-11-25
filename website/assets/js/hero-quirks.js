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

  // The Loop: one of the herd hops now and then, and any of them when clicked.
  const HOP_MS = 700, IDLE_HOP_MS = 3200;
  function paddock(field) {
    const cows = [...field.querySelectorAll('.cow')];
    const hop = (cow) => replay(cow, 'hop', HOP_MS);
    cows.forEach((cow) => cow.addEventListener('click', () => hop(cow)));
    if (still) return;
    let last = -1;
    setInterval(() => {
      if (document.hidden) return;
      let next = Math.floor(Math.random() * cows.length);
      if (next === last) next = (next + 1) % cows.length;
      last = next;
      hop(cows[next]);
    }, IDLE_HOP_MS);
  }

  const start = () => {
    document.querySelectorAll('.pet--vault').forEach(vault);
    document.querySelectorAll('.pet--clock').forEach((pet) => { clock(pet); });
    document.querySelectorAll('.paddock').forEach(paddock);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
