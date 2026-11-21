/* Dictation, played live: words arrive in the document as they are said, and a coloured glow rises
   from the foot of the card with the voice, after Libraries.dev's Voice Glow. While Lasso looks the
   sentence up the glow sweeps from side to side; the card offers the figure; a spoken "tab" puts
   it in, linked to its source. It plays by itself while on screen and stops when it scrolls away.
   With reduced motion it shows the finished sentence and a still glow. */
(() => {
  'use strict';
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COLOURS = ['#5b8cff', '#9a6bff', '#ff5fa2', '#ff9f43', '#3fd68a', '#4fc8ff'];
  const LOOP_MS = 12500;
  const SAID = ['Income', 'tax', 'expense', 'for', 'the', 'current', 'period', 'was'];
  const WORD_AT = 900, WORD_GAP = 360;
  const SPEECH_END = WORD_AT + SAID.length * WORD_GAP;
  const LOOK_END = SPEECH_END + 1100; // the glow sweeps while Lasso looks it up
  const TAB_AT = LOOK_END + 1500, INSERT_AT = TAB_AT + 520, FADE_AT = LOOP_MS - 900;
  const GLOW_W = 200, GLOW_H = 124; // drawn small, scaled up soft

  /* a repeatable wobble, so each word has its own loudness */
  const wobble = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };

  function mount(root) {
    const canvas = root.querySelector('.vg-glow');
    const ctx = canvas.getContext('2d');
    canvas.width = GLOW_W; canvas.height = GLOW_H;
    const line = root.querySelector('[data-line]');
    const card = root.querySelector('.vg-card');
    const status = root.querySelector('[data-status]');
    const said = root.querySelector('.vg-said');
    const docStatus = root.querySelector('[data-doc-status]');
    let level = 0, sweep = 0, start = performance.now(), frame = 0, visible = false, pausedAt = 0, lastState = '';

    function loudness(t) {
      if (t > WORD_AT - 200 && t < SPEECH_END + 100) {
        const i = Math.floor((t - WORD_AT) / WORD_GAP);
        const into = ((t - WORD_AT) % WORD_GAP) / WORD_GAP;
        const body = i >= 0 ? Math.sin(Math.PI * Math.min(1, into * 1.25)) ** 0.7 : 0;
        return 0.22 + body * (0.55 + 0.45 * wobble(i + 1)) + 0.08 * Math.sin(t / 37);
      }
      if (t > TAB_AT - 60 && t < TAB_AT + 380) return 0.25 + 0.8 * Math.sin(Math.PI * (t - TAB_AT + 60) / 440);
      return 0.1 + 0.03 * Math.sin(t / 400);
    }

    function draw(t) {
      const dark = document.documentElement.dataset.theme !== 'light';
      const fadeOut = t > FADE_AT ? Math.min(1, (t - FADE_AT) / 600) : 0;
      const looking = t > SPEECH_END && t < LOOK_END ? 1 : 0;
      level += (loudness(t) * (1 - fadeOut) - level) * 0.16;
      sweep += (looking - sweep) * 0.08;
      ctx.clearRect(0, 0, GLOW_W, GLOW_H);
      ctx.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      const n = COLOURS.length;
      for (let i = 0; i < n; i++) {
        const drift = t / 1000 * (0.5 + i * 0.13) + i * 1.7;
        let x = GLOW_W * (0.08 + (0.84 * i) / (n - 1)) + Math.sin(drift) * GLOW_W * 0.05;
        const sweepX = GLOW_W * (0.5 + 0.4 * Math.sin(t / 420 + i * 0.35));
        x += (sweepX - x) * sweep * 0.85;
        const swell = level * (0.75 + 0.25 * Math.sin(drift * 2.1));
        const r = GLOW_W * (0.2 + 0.32 * swell + 0.08 * sweep);
        const y = GLOW_H + r * 0.42 - GLOW_H * 0.55 * swell;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const a = (dark ? 0.62 : 0.5) * (0.55 + 0.45 * Math.min(1, level * 1.6 + sweep * 0.6));
        g.addColorStop(0, hexA(COLOURS[i], a));
        g.addColorStop(0.55, hexA(COLOURS[i], a * 0.45));
        g.addColorStop(1, hexA(COLOURS[i], 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, GLOW_W, GLOW_H);
      }
    }

    function words(t) {
      const n = Math.max(0, Math.min(SAID.length, Math.floor((t - WORD_AT) / WORD_GAP) + 1));
      const freshFrom = (t - WORD_AT) % WORD_GAP < 220 && t < SPEECH_END ? n - 1 : n;
      const inserted = t > INSERT_AT;
      const state = `${n}:${freshFrom}:${inserted}`;
      if (state !== lastState) {
        lastState = state;
        line.innerHTML = SAID.slice(0, n).map((w, i) => `<span class="vg-word${i >= freshFrom ? ' fresh' : ''}">${w}</span>`).join(' ')
          + (inserted ? ' <span class="vg-ins">5,200</span>.' : '') + '<span class="vg-caret"></span>';
      }
      line.style.opacity = t > FADE_AT ? String(1 - Math.min(1, (t - FADE_AT) / 500)) : '1';
      card.classList.toggle('on', t > LOOK_END && t < INSERT_AT);
      said.classList.toggle('on', t > TAB_AT && t < INSERT_AT + 700);
      const text = t < WORD_AT ? 'Listening' : t < SPEECH_END ? 'Listening' : t < LOOK_END ? 'Looking it up' : t < INSERT_AT ? 'Say “tab” to insert' : t < FADE_AT ? 'Inserted, with its source' : 'Listening';
      if (status.textContent !== text) status.textContent = text;
      const doc = t < INSERT_AT ? 'dictating' : 'linked · pinned v1';
      if (docStatus.textContent !== doc) docStatus.textContent = doc;
    }

    function loop(now) {
      const t = (now - start) % LOOP_MS;
      words(t); draw(t);
      frame = requestAnimationFrame(loop);
    }
    const sync = () => {
      const run = visible && !document.hidden && !reducedMotion;
      if (run && !frame) { start += performance.now() - (pausedAt || performance.now()); frame = requestAnimationFrame(loop); }
      if (!run && frame) { cancelAnimationFrame(frame); frame = 0; pausedAt = performance.now(); }
    };
    if (reducedMotion) {
      level = 0.35; words(INSERT_AT + 800); for (let i = 0; i < 30; i++) draw(INSERT_AT + 800);
      return;
    }
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; sync(); }, { threshold: 0.15 }).observe(root);
    document.addEventListener('visibilitychange', sync);
  }

  function hexA(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgb(${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255} / ${a.toFixed(3)})`;
  }

  const init = () => document.querySelectorAll('[data-voice-demo]').forEach(mount);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
