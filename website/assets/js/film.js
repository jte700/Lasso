/* The homepage reel: real Lasso cards, rendered by the Mac app from example files, appearing under
   the caret as a document is written. It plays itself through each example; the labels under it
   show which one is playing and jump to another when clicked, and the round control pauses it. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- the product reel ----------
     A document is written, and the real card appears under the caret: these are pictures of the
     Mac app's own card, rendered from Lasso's answers for example files. Keys are pressed on the
     card's own keycaps, and Tab puts the value in. */
  function initFilm() {
    const film = $('[data-film]');
    if (!film) return;
    const demo = $('[data-demo]', film);
    const scene = $('.demo-scene', demo);
    const tabs = $$('.film-tab', film);
    const caption = $('.film-caption', film);
    const pause = $('.film-pause', film);
    // Every caption sits hidden in the same cell, so the bar is as tall as the longest one and the
    // reel keeps its size whichever example plays.
    tabs.forEach((tab) => {
      const ghost = document.createElement('p');
      ghost.className = 'film-caption film-caption--ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.innerHTML = tab.dataset.caption; // written in this page's own markup
      caption.parentElement.append(ghost);
    });
    const title = $('.demo-title', scene);
    const status = $('.demo-status', scene);
    const head = $('.demo-head', scene);
    const typed = $('.demo-typed', scene);
    const caret = $('.demo-caret', scene);
    const card = $('.demo-card', scene);
    const shot = $('.demo-shot', scene);
    const key = $('.demo-key', scene);
    const SCENE_W = 1000, CARD_W = 760, POINTER = 84;
    // the card's keycaps, in its own points
    const KEYS = { tab: [18.5, 355.5, 25, 17.5], up: [101.5, 355.5, 23, 17.5], down: [129.5, 355.5, 23, 17.5] };
    const CASES = {
      arch: { doc: 'site-report.md', head: 'FZK-Haus · room schedule', text: 'The Schlafzimmer net floor area is 2', replace: 1, insert: '21.410325 m²', after: '.', steps: [] },
      cad: { doc: 'plate-inspection.md', head: 'NIST CTC-01 test plate · inspection notes', text: 'The Ø20 holes are 4', replace: 1, insert: '45 mm', after: ' deep.', steps: ['down', 'up'] },
      finance: { doc: 'q3-board-memo.md', head: 'Q3 board memo', text: 'Q3 actual operating revenue was 4', replace: 1, insert: '4.82', after: ' million euros.', steps: [] },
      research: { doc: 'lit-review.md', head: 'Literature review · chapter 2', text: 'Adjuvant therapy lowered the risk of recurrence', replace: 0, insert: ' across the whole cohort (HR 0.72, 95% CI 0.61–0.85), with the largest effect in patients under 65.', after: '', steps: [] },
      legal: { doc: 'advice-note.md', head: 'Advice note · Unit 4 lease renewal', text: 'The Tenant shall give the Landlord not less', replace: 0, insert: ' than six (6) months’ written notice of its intention to renew prior to expiry.', after: '', steps: [], picker: true },
    };
    // the document around the line being written, which the card's glass shows through
    const PAGE = {
      arch: { above: 'Areas below are read from plan_L2.ifc, ground floor, as issued last week.',
        below: ['The Küche and Bad keep their current finishes. Skirting is replaced throughout.', 'Doors are rehung where the new flooring raises the threshold.', 'Next visit: check the window reveals in the Wohnen before blinds are ordered.'] },
      cad: { above: 'Dimensions are read from nist_ctc_01_asme1_rd.stp, NIST test case 1.',
        below: ['The plate is 800 by 450 mm overall and 150 mm high.', 'Check the Ø25 and Ø35 holes against the same model before the CMM run.', 'Record any hole out of tolerance on the deviation sheet.'] },
      finance: { above: 'Prepared for the November board meeting.',
        below: ['Cost of goods sold rose faster than revenue, so gross margin fell from the second quarter.', 'Operating expenses stayed close to budget.', 'Cash position and hiring are covered in the appendix.'] },
      research: { above: 'Several cohort studies have looked at adjuvant therapy after resection.',
        below: ['A registry study found a smaller effect over the same period.', 'Neither study reported outcomes beyond five years.', 'Section 2.4 turns to the cost of treatment.'] },
      legal: { above: 'The renewal clause in the signed lease differs from the draft.',
        below: ['The draft circulated earlier gave three months; the signed copy governs.', 'Liability is capped separately in clause 18.1.', 'We recommend diarising the notice date now.'] },
    };
    const before = $('.demo-before', scene);
    const after = $('.demo-after', scene);
    const TYPE_MS = 42, SHOW_MS = 1800, STEP_MS = 1300, HOLD_MS = 2800;
    // Tab on a PDF passage opens the passage picker: it opens, a drag picks the words, the source is
    // switched on, and Tab inserts. PICKER_MS is how long that takes, for the label's progress fill.
    const PICKER_OPEN_MS = 1100, PICKER_CITE_MS = 600, PICKER_READ_MS = 1100, PICKER_MS = 5300;
    const picker = window.LassoFilmPicker ? window.LassoFilmPicker.mount(scene) : null;
    const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
    // AVIF where the browser reads it, the PNG otherwise
    const src = (k, state, ext = 'avif') => `/assets/img/card/${k}-${state}-${theme()}.${ext}`;
    const preload = (k) => {
      if (!k) return;
      ((CASES[k].steps || []).length ? [0, 1] : [0]).forEach((st) => { const i = new Image(); i.src = src(k, st); });
    };
    let current = tabs[0].dataset.case, state = 0, token = 0, userPaused = reducedMotion, inView = false, still = false;
    const running = () => !userPaused && inView && !document.hidden;
    const STOP = Symbol('stop');
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

    /* ---------- the scene ---------- */
    const fit = () => demo.style.setProperty('--s', String(demo.clientWidth / SCENE_W));
    new ResizeObserver(fit).observe(demo);
    fit();
    const setShot = () => { shot.src = src(current, state); };
    shot.addEventListener('error', () => { if (shot.src.endsWith('.avif')) shot.src = src(current, state, 'png'); });
    const place = () => {
      const s = demo.clientWidth / SCENE_W || 1;
      const box = scene.getBoundingClientRect();
      const c = caret.getBoundingClientRect();
      const x = (c.left - box.left) / s;
      const bottom = (c.bottom - box.top) / s;
      const left = Math.max(20, Math.min(SCENE_W - CARD_W - 20, x - POINTER));
      card.style.left = `${left}px`;
      card.style.top = `${bottom + 4}px`;
      card.style.setProperty('--px', `${Math.max(30, Math.min(CARD_W - 30, x - left))}px`);
    };
    const press = (name) => {
      const [x, y, w, h] = KEYS[name];
      Object.assign(key.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
      key.classList.remove('press'); void key.offsetWidth; key.classList.add('press');
    };
    const reset = (c) => {
      title.textContent = c.doc; head.textContent = c.head; status.textContent = 'editing';
      typed.textContent = ''; card.classList.remove('on'); state = 0;
      if (picker) picker.close();
      const page = PAGE[current];
      before.textContent = page.above;
      after.replaceChildren(...page.below.map((line) => { const p = document.createElement('p'); p.textContent = line; return p; }));
    };
    const insert = (c, words = c.insert) => {
      typed.textContent = c.text.slice(0, c.text.length - c.replace);
      const mark = document.createElement('mark');
      mark.className = 'demo-ins';
      mark.textContent = words;
      typed.append(mark);
      return mark;
    };
    const duration = (c) => 500 + c.text.length * TYPE_MS + 300 + SHOW_MS + c.steps.length * STEP_MS + 300
      + (c.picker && picker ? PICKER_MS : 0) + c.after.length * TYPE_MS + HOLD_MS;

    /* the passage picker: the page opens, a drag picks the words, the source goes on, Tab inserts */
    async function pick(t) {
      const pause = (ms) => wait(ms, t);
      picker.open();
      status.textContent = 'choosing words';
      await pause(PICKER_OPEN_MS);
      await picker.drag(pause);
      await pause(PICKER_CITE_MS);
      await picker.citeSource(pause);
      await pause(PICKER_READ_MS);
      picker.pressInsert();
      await pause(320);
      picker.close();
    }

    /* a still frame, for reduced motion and a paused reel: the sentence typed and the card up */
    function showStill(k) {
      token++; still = true;
      const c = CASES[k];
      reset(c);
      typed.textContent = c.text;
      setShot(); place(); card.classList.add('on');
      status.textContent = 'previewing';
      film.removeAttribute('data-playing');
    }

    async function play(k, t) {
      const c = CASES[k];
      still = false;
      reset(c);
      const at = tabs.findIndex((tab) => tab.dataset.case === k);
      preload(k); preload(tabs[(at + 1) % tabs.length].dataset.case);
      film.style.setProperty('--film-ms', `${duration(c)}ms`);
      film.removeAttribute('data-playing'); void film.offsetWidth; film.setAttribute('data-playing', '');
      sync();
      await wait(500, t);
      for (let i = 1; i <= c.text.length; i++) { typed.textContent = c.text.slice(0, i); await wait(TYPE_MS, t); }
      setShot(); place();
      await wait(300, t);
      card.classList.add('on'); status.textContent = 'previewing';
      await wait(SHOW_MS, t);
      for (const step of c.steps) {
        press(step);
        state += step === 'down' ? 1 : -1;
        setShot();
        await wait(STEP_MS, t);
      }
      press('tab');
      await wait(300, t);
      card.classList.remove('on');
      const usesPicker = c.picker && picker;
      if (usesPicker) await pick(t);
      const mark = insert(c, usesPicker ? picker.inserted(c.insert) : c.insert);
      status.textContent = 'linked · pinned v1';
      const tail = document.createTextNode('');
      typed.append(tail);
      for (const ch of c.after) { tail.data += ch; await wait(TYPE_MS, t); }
      setTimeout(() => mark.classList.add('settled'), 700);
      await wait(HOLD_MS, t);
      select(tabs[(at + 1) % tabs.length]);
    }
    const run = (k) => { const t = ++token; play(k, t).catch((e) => { if (e !== STOP) throw e; }); };

    /* ---------- controls ---------- */
    function sync() {
      film.toggleAttribute('data-paused', !running());
      pause.setAttribute('aria-pressed', String(userPaused));
      pause.setAttribute('aria-label', userPaused ? 'Play the examples' : 'Pause the examples');
    }
    const chosen = (tab) => {
      current = tab.dataset.case;
      film.style.setProperty('--tint', `var(--${tab.dataset.tint})`);
      caption.innerHTML = tab.dataset.caption; // written in this page's own markup
      const strip = tab.parentElement;
      strip.scrollTo({ left: tab.offsetLeft - strip.clientWidth / 2 + tab.offsetWidth / 2, behavior: reducedMotion ? 'auto' : 'smooth' });
      if (userPaused) showStill(current); else run(current);
    };
    // the labels show which example is playing, and clicking one starts that example
    const select = (tab) => { tabs.forEach((t) => t.setAttribute('aria-selected', String(t === tab))); chosen(tab); };
    tabs.forEach((tab) => tab.addEventListener('click', () => select(tab)));
    pause.addEventListener('click', () => {
      userPaused = !userPaused;
      if (!userPaused && still) run(current);
      sync();
    });
    let answered = false;
    new IntersectionObserver(([entry]) => { answered = true; inView = entry.isIntersecting; sync(); }, { threshold: 0.3 }).observe(film);
    // A browser that never reports visibility (a throttled preview, a page snapshot) still plays the reel.
    setTimeout(() => { if (!answered) { inView = true; sync(); } }, 1500);
    document.addEventListener('visibilitychange', sync);
    new MutationObserver(() => { if (shot.getAttribute('src')) setShot(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    addEventListener('resize', () => { if (card.classList.contains('on')) place(); });

    if (userPaused) showStill(current); else run(current);
  }

  const init = () => { initFilm(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
