/* Sheets: a spring-driven dialog that can be caught mid-flight and swiped away on phones.
   The waitlist lives in one; so does the phone menu. */
(() => {
  'use strict';
  const { $, $$, html, escapeHtml, toast, reducedMotion } = window.LASSO;

  /* ---------- the sheet itself ---------- */
  const STIFFNESS = 300;
  const DAMPING = 2 * Math.sqrt(STIFFNESS); // critically damped: no bounce, formal
  const DISMISS_DISTANCE = 0.3;             // share of the sheet's height
  const DISMISS_SPEED = 650;                // px per second
  const SETTLE_FALLBACK_MS = 600;
  const phone = matchMedia('(max-width: 640px)');

  function createSheet(dialog) {
    const panel = $('.sheet-panel', dialog);
    let position = 0;   // 0 closed, 1 open
    let velocity = 0;
    let target = 0;
    let frame = 0;
    let lastTick = 0;
    let drag = null;

    const apply = () => dialog.style.setProperty('--p', position.toFixed(4));
    const settle = () => {
      position = target; velocity = 0; frame = 0; apply();
      if (target === 0 && dialog.open) dialog.close();
    };
    const tick = (now) => {
      const dt = Math.min(32, now - lastTick) / 1000;
      lastTick = now;
      velocity += (-STIFFNESS * (position - target) - DAMPING * velocity) * dt;
      position += velocity * dt;
      if (Math.abs(position - target) < 0.002 && Math.abs(velocity) < 0.02) { settle(); return; }
      apply();
      frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (reducedMotion || document.hidden) { cancelAnimationFrame(frame); settle(); return; }
      if (!frame) { lastTick = performance.now(); frame = requestAnimationFrame(tick); }
      // If the browser is not drawing frames (a background or throttled view), finish without the motion.
      const aimedAt = target;
      setTimeout(() => { if (frame && target === aimedAt && Math.abs(position - target) > 0.5) { cancelAnimationFrame(frame); settle(); } }, SETTLE_FALLBACK_MS);
    };
    /* Opening a modal dialog focuses its first control. In the menu that is a link, which would wear
       a focus ring and scroll the closed sheet into view before it rises. The panel holds focus
       instead; a form field the browser chose keeps it. */
    panel.tabIndex = -1;
    const open = () => {
      if (!dialog.open) {
        dialog.showModal();
        if (!document.activeElement?.matches('input, textarea, select')) panel.focus({ preventScroll: true });
        dialog.scrollTop = 0;
      }
      target = 1; run();
    };
    const close = () => { target = 0; run(); };

    // Escape, and the back gesture on Android, ask the dialog to cancel: answer with the animated close.
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    $('.sheet-scrim', dialog).addEventListener('click', close);
    $$('[data-close]', dialog).forEach((el) => el.addEventListener('click', close));

    // Swipe to dismiss. A finger can take the sheet over while it is still animating.
    const onDown = (e) => {
      if (!phone.matches || e.target.closest('input, button, a, label')) return;
      cancelAnimationFrame(frame); frame = 0;
      const height = panel.offsetHeight;
      drag = { id: e.pointerId, height, startY: e.clientY - (1 - position) * height, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const offset = e.clientY - drag.startY;
      const pulled = offset < 0 ? offset * 0.18 : offset; // resist being dragged above its resting place
      position = 1 - pulled / drag.height;
      const dt = Math.max(1, e.timeStamp - drag.lastT);
      drag = { ...drag, speed: ((e.clientY - drag.lastY) / dt) * 1000, lastY: e.clientY, lastT: e.timeStamp };
      apply();
    };
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { speed, height } = drag;
      drag = null;
      velocity = -speed / height;
      target = (1 - position > DISMISS_DISTANCE || speed > DISMISS_SPEED) ? 0 : 1;
      run();
    };
    $$('[data-drag]', dialog).forEach((el) => {
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    });

    return { open, close, dialog };
  }

  /* ---------- waitlist ---------- */
  const ENDPOINT = '/api/waitlist';
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const CODE_LENGTH = 6;
  const PLATFORMS = { 'mac-arm': 'macOS on Apple silicon', 'mac-intel': 'macOS on Intel', windows: 'Windows' };
  const NO_BACKEND = new Set([404, 405, 501, 503]);
  let waitlist = null;

  const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  /* One key per person and platform for this visit: a retry, a double click or a flaky
     connection repeats the same request, and the server answers it once. */
  function idempotencyKey(entry) {
    const slot = `lasso.waitlist.key:${entry.email}|${entry.platform}`;
    try {
      const existing = sessionStorage.getItem(slot);
      if (existing) return existing;
      const key = newKey();
      sessionStorage.setItem(slot, key);
      return key;
    } catch (err) {
      return newKey(); // storage blocked: the key still covers this request's own retries
    }
  }

  async function send(path, body, key, method = 'POST') {
    if (location.protocol === 'file:') return { ok: true, preview: true };
    try {
      const response = await fetch(path, { method, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
      if (NO_BACKEND.has(response.status)) return { ok: true, preview: true };
      const payload = await response.json().catch(() => ({}));
      return response.ok ? { ok: true, ...payload } : { ok: false, error: payload.error || `http_${response.status}` };
    } catch (err) {
      return { ok: false, error: 'offline' };
    }
  }

  const MESSAGES = {
    offline: 'No connection. Your details are still here; try again.',
    rate_limited: 'Too many tries from this network. Give it an hour.',
    bad_email: 'That email address does not look right.',
    bad_code: 'That code did not match. Check the email and try again.',
    expired: 'That code has expired. Send a new one.',
  };
  const messageFor = (error) => MESSAGES[error] || 'Something went wrong on our side. Try again in a moment.';

  function validate(entry) {
    return {
      ...(entry.name.length < 1 ? { name: 'Tell us what to call you.' } : {}),
      ...(!EMAIL.test(entry.email) ? { email: 'Enter an email address we can reach you at.' } : {}),
    };
  }

  function buildWaitlist() {
    const dialog = html(`<dialog class="sheet" aria-labelledby="wlTitle">
      <div class="sheet-scrim"></div>
      <div class="sheet-panel glass--live">
        <div class="sheet-grip" data-drag aria-hidden="true"></div>
        <button class="icon-btn slop sheet-x" type="button" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>

        <section class="step" data-step="form" data-active>
          <div data-drag><p class="eyebrow">Early access</p>
          <h2 id="wlTitle">Get Lasso first</h2>
          <p class="sub">We let people in a few at a time. We will email you a download link when your spot opens.</p></div>
          <form class="form" novalidate>
            <div class="field"><label for="wlName">Name</label><input id="wlName" name="name" type="text" autocomplete="name" autocapitalize="words" enterkeyhint="next" maxlength="80" required><p class="err" data-err="name" role="alert"></p></div>
            <div class="field"><label for="wlEmail">Email</label><input id="wlEmail" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" enterkeyhint="send" maxlength="254" required><p class="err" data-err="email" role="alert"></p></div>
            <fieldset class="field" style="border:0;padding:0;margin:0"><legend class="label" style="padding:0;margin-bottom:8px">Platform</legend>
              <div class="radios">
                <label><input type="radio" name="platform" value="mac-arm" checked><span>macOS<small>Apple silicon</small></span></label>
                <label><input type="radio" name="platform" value="mac-intel"><span>macOS<small>Intel</small></span></label>
                <label><input type="radio" name="platform" value="windows"><span>Windows<small>10 or later</small></span></label>
              </div></fieldset>
            <label class="hp" aria-hidden="true">Company<input type="text" name="company" tabindex="-1" autocomplete="off"></label>
            <p class="err" data-err="form" role="alert"></p>
            <button class="btn btn--pop" type="submit">Join the waitlist</button>
            <p class="fine">One email when it is ready. No newsletters. See the <a href="privacy.html">privacy policy</a>.</p>
          </form>
        </section>

        <section class="step" data-step="code">
          <div data-drag><p class="eyebrow">Step 2 of 2</p>
          <h2>Enter the code</h2>
          <p class="sub">We sent a ${CODE_LENGTH}-digit code to <b data-slot="email"></b>. </p></div>
          <form class="form" novalidate>
            <div class="field"><label class="sr" for="wlCode">Code</label>
              <input class="otp" id="wlCode" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{${CODE_LENGTH}}" maxlength="${CODE_LENGTH}" enterkeyhint="done" aria-describedby="wlCodeErr">
              <p class="err" id="wlCodeErr" data-err="code" role="alert"></p></div>
            <p class="preview-note" data-slot="preview" hidden>Preview mode: this page is not connected to the waitlist service yet, so no email was sent. Any ${CODE_LENGTH} digits will do.</p>
            <button class="btn btn--pop" type="submit">Confirm</button>
            <p class="fine"><button class="link slop" type="button" data-do="resend">Send a new code</button> &nbsp;or&nbsp; <button class="link slop" type="button" data-do="edit">use a different email</button></p>
          </form>
        </section>

        <section class="step" data-step="done">
<img class="avatar avatar--done" src="/assets/img/mascot/forest-happy.svg" width="96" height="96" alt="" decoding="async" onerror="this.remove()">
          <h2>You are on the list</h2>
          <p class="sub">We will email <b data-slot="email"></b> a download link for <b data-slot="platform"></b> when your spot opens.</p>
          <button class="btn" type="button" data-close>Back to the site</button>
        </section>
      </div></dialog>`);
    document.body.appendChild(dialog);

    const sheet = createSheet(dialog);
    const [form, codeForm] = $$('form', dialog);
    let entry = null;
    let key = '';

    const show = (step) => {
      $$('.step', dialog).forEach((el) => el.toggleAttribute('data-active', el.dataset.step === step));
      const focusTarget = step === 'form' ? '#wlName' : step === 'code' ? '#wlCode' : '[data-step="done"] button';
      requestAnimationFrame(() => $(focusTarget, dialog)?.focus({ preventScroll: true }));
    };
    const setErrors = (scope, errors) => {
      $$('[data-err]', scope).forEach((el) => { el.textContent = errors[el.dataset.err] || ''; });
      $$('input[id]', scope).forEach((input) => input.setAttribute('aria-invalid', String(Boolean(errors[input.name]))));
    };
    const fill = () => {
      $$('[data-slot="email"]', dialog).forEach((el) => { el.textContent = entry.email; });
      $$('[data-slot="platform"]', dialog).forEach((el) => { el.textContent = PLATFORMS[entry.platform]; });
    };
    const finish = () => {
      show('done');
      const joined = entry, joinedKey = key;
      toast(`${joined.email} is on the waitlist`, {
        undo: async () => {
          show('form');
          const result = await send(ENDPOINT, { email: joined.email }, joinedKey, 'DELETE');
          toast(result.ok ? 'Removed from the waitlist' : 'Could not remove you just now. Email support@mylasso.ca and we will.');
        },
      });
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const next = { name: values.name.trim(), email: values.email.trim().toLowerCase(), platform: values.platform, company: values.company };
      const errors = validate(next);
      setErrors(form, errors);
      if (Object.keys(errors).length) { $(`[name="${Object.keys(errors)[0]}"]`, form).focus(); return; }

      entry = next;
      key = idempotencyKey(entry);
      fill();
      $('[data-slot="preview"]', dialog).hidden = true;
      codeForm.reset(); setErrors(codeForm, {});
      show('code'); // optimistic: the next step appears at once, the request catches up

      const result = await send(ENDPOINT, { ...entry, page: location.pathname, source: dialog.dataset.source || 'page' }, key);
      if (!result.ok) { show('form'); setErrors(form, { form: messageFor(result.error) }); return; }
      if (result.preview) { $('[data-slot="preview"]', dialog).hidden = false; return; }
      if (result.verify === false) finish(); // the service is not sending codes: the signup is already saved
    });

    const confirmCode = async () => {
      const code = codeForm.code.value.replace(/\D/g, '');
      if (code.length !== CODE_LENGTH) { setErrors(codeForm, { code: `The code has ${CODE_LENGTH} digits.` }); return; }
      setErrors(codeForm, {});
      finish(); // optimistic again; a wrong code brings this step back
      const result = await send(`${ENDPOINT}-verify`, { email: entry.email, code }, key);
      if (!result.ok) { show('code'); setErrors(codeForm, { code: messageFor(result.error) }); codeForm.code.select(); }
    };
    codeForm.addEventListener('submit', (e) => { e.preventDefault(); confirmCode(); });
    codeForm.code.addEventListener('input', () => {
      codeForm.code.value = codeForm.code.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
      if (codeForm.code.value.length === CODE_LENGTH) confirmCode(); // filled by the keyboard's code suggestion or by hand
    });
    dialog.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-do]')?.dataset.do;
      if (action === 'edit') show('form');
      if (action === 'resend') {
        const result = await send(ENDPOINT, { ...entry, resend: true }, newKey());
        toast(result.ok ? `New code sent to ${entry.email}` : messageFor(result.error));
      }
    });

    return {
      open(platform, source) {
        if ($('[data-step="done"]', dialog).hasAttribute('data-active')) { form.reset(); show('form'); }
        if (platform && form.platform) form.platform.value = platform;
        dialog.dataset.source = source || 'page';
        sheet.open();
        if (!$('[data-step="code"]', dialog).hasAttribute('data-active')) show('form');
      },
    };
  }

  const openWaitlist = (platform, source) => { waitlist = waitlist || buildWaitlist(); waitlist.open(platform, source); };

  /* ---------- phone menu ---------- */
  let menu = null;
  function openMenu() {
    if (!menu) {
      const label = (a) => (a.querySelector('b') || a.firstChild).textContent.trim();
      const link = (a, cls) => `<a${cls ? ` class="${cls}"` : ''} href="${escapeHtml(a.getAttribute('href'))}">${escapeHtml(label(a))}</a>`;
      const links = $$('.nav-links a').map((a) => link(a)).join('');
      const dialog = html(`<dialog class="sheet" aria-label="Menu"><div class="sheet-scrim"></div>
        <div class="sheet-panel glass--live"><div class="sheet-grip" data-drag aria-hidden="true"></div>
          <button class="icon-btn slop sheet-x" type="button" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
          <nav class="m-links" data-drag>${links}<a href="/product/">All features</a><a href="/download/">Download</a><a href="/contact/">Contact</a></nav>
          <button class="btn btn--pop" type="button" data-waitlist style="width:100%">Join the waitlist</button>
        </div></dialog>`);
      document.body.appendChild(dialog);
      menu = createSheet(dialog);
    }
    menu.open();
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-waitlist]');
    if (trigger) {
      e.preventDefault();
      menu?.close();
      openWaitlist(trigger.dataset.waitlist || undefined, trigger.closest('section, header, footer, nav')?.id || 'page');
      return;
    }
    if (e.target.closest('[data-action="menu"]')) openMenu();
  });
  if (location.hash === '#waitlist') openWaitlist();

  window.LASSO.waitlist = { open: openWaitlist };
  window.LASSO.createSheet = createSheet;
})();
