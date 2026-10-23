// The Connect 3rd Party Apps window. It opens on "Lasso with …", the app's
// name changing with a different animation each time, over the letter field,
// with each app's icon and a Connect button under it. Connect opens a sheet
// with that app's short flow: choose what Lasso reads, sign in or paste what
// the app issued, then watch its items come in. The Mac app hosts this page and answers `lasso`
// messages for what only it can do: read the Calendar app, show app icons,
// confirm, open the browser and close the window.
(() => {
  const body = document.body;
  const view = document.getElementById('view');
  const foot = document.getElementById('foot');
  const sheet = document.getElementById('sheet');
  const title = document.getElementById('sheet-title');
  const bridge = window.webkit?.messageHandlers?.lasso ?? null;
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  const apps = document.getElementById('apps');
  const state = { catalog: [], connections: [], icons: {}, screen: null, polling: null };

  // ---------- plumbing ----------

  async function api(path, { method = 'GET', body: payload } = {}) {
    const response = await fetch(path, { method, headers: payload ? { 'content-type': 'application/json' } : {},
      body: payload ? JSON.stringify(payload) : undefined });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(answer?.error?.message ?? `Lasso could not do that (HTTP ${response.status}).`);
    return answer;
  }

  /** What only the Mac app can do. Its reply is the promise's value. */
  function native(type, payload = {}) {
    if (!bridge) return Promise.reject(new Error('This needs the Lasso app for Mac.'));
    return bridge.postMessage({ type, ...payload });
  }

  function openExternal(url) {
    if (bridge) return native('openURL', { url });
    window.open(url, '_blank', 'noopener');
    return Promise.resolve();
  }

  /** A Mac alert in the app; a browser confirm elsewhere. */
  function confirmAction(titleText, message, action) {
    if (bridge) return native('confirm', { title: titleText, message, action, destructive: true }).catch(() => false);
    return Promise.resolve(window.confirm(`${titleText}\n\n${message}`));
  }

  // WebKit draws <input type=checkbox switch> as the system switch; elsewhere it is styled to match.
  const nativeSwitch = 'switch' in HTMLInputElement.prototype;

  /** Builds an element; strings become text, never markup. */
  function h(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes ?? {})) {
      if (value == null || value === false) continue;
      if (key === 'switch' && !nativeSwitch) element.classList.add('switch-fallback');
      if (key === 'class') element.className = value;
      else if (key === 'html') element.innerHTML = value;
      else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
      else if (key === 'checked' || key === 'disabled' || key === 'value') element[key] = value;
      else element.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) element.append(child instanceof Node ? child : String(child));
    return element;
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frames = (duration, step) => new Promise((resolve) => {
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      step(t);
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });

  // ---------- the headline ----------

  const WORDS = ['Calendar', 'Outlook', 'Notion', 'Google Calendar'];
  const word = document.getElementById('word');
  const letters = word.querySelector('.letters');
  const measure = h('span', { class: 'letters', style: 'position:absolute;visibility:hidden;left:0;top:0', 'aria-hidden': 'true' });
  word.append(measure);
  const SCRAMBLE = '·:;+=*<>/\\|{}[]01#%abcdefxyz';
  let cycle = { running: false, index: 0, token: 0 };

  function widthOf(text) {
    measure.textContent = text || ' ';
    return measure.getBoundingClientRect().width;
  }

  function setWidth(text) { letters.style.width = `${widthOf(text)}px`; }

  function spell(text, className = 'ch') {
    const characters = [...text].map((character) => h('span', { class: className }, character));
    letters.replaceChildren(...characters);
    return characters;
  }

  /** Each letter passes through the field's own symbols before it settles. */
  async function scramble(from, to) {
    const slots = Math.max(from.length, to.length);
    const cells = spell(from.padEnd(slots, ' '));
    let last = 0;
    letters.style.transition = 'width .9s cubic-bezier(.3,.7,.2,1)';
    setWidth(to);
    await frames(1100, (t) => {
      const fresh = performance.now() - last > 55;
      if (fresh) last = performance.now();
      cells.forEach((cell, index) => {
        const start = (index / slots) * 0.35, settle = 0.4 + (index / slots) * 0.55;
        if (t < start) return;
        if (t >= settle) {
          cell.textContent = to[index] ?? '';
          cell.className = 'ch';
        } else if (fresh) {
          cell.textContent = SCRAMBLE[(Math.random() * SCRAMBLE.length) | 0];
          cell.className = 'ch scramble';
        }
      });
    });
    spell(to);
  }

  /** A loop is thrown around the word and yanks it away; the next drops in. */
  async function lasso(from, to) {
    const loop = h('span', { html: '<svg class="loop" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true">'
      + '<path pathLength="1" d="M78 8C99 13 101 49 55 54 10 59-2 26 18 12 33 1 61 2 77 8c6 2 10-3 15-9"/></svg>' });
    const svg = loop.firstChild;
    word.append(svg);
    const path = svg.querySelector('path');
    path.style.strokeDasharray = '1';
    await path.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 650, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'forwards' }).finished;
    await wait(180);
    const yank = { duration: 380, easing: 'cubic-bezier(.5,0,.8,.4)', fill: 'forwards' };
    await Promise.all([
      letters.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(.35em,-.55em) rotate(-7deg) scale(.9)', opacity: 0 }], yank).finished,
      svg.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(.4em,-.6em) rotate(-7deg) scale(.86)', opacity: 0 }], yank).finished,
    ]);
    svg.remove();
    letters.getAnimations().forEach((animation) => animation.cancel());
    letters.style.transition = 'width .5s cubic-bezier(.3,.7,.2,1)';
    setWidth(to);
    const cells = spell(to);
    await Promise.all(cells.map((cell, index) => cell.animate(
      [{ transform: 'translateY(.5em)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 560, delay: 120 + index * 38, easing: 'cubic-bezier(.3,1.45,.5,1)', fill: 'backwards' }).finished));
  }

  /** As Lasso suggests while you type: erase, type the start, accept with Tab. */
  async function typed(from, to) {
    const caret = h('span', { class: 'caret' });
    letters.style.transition = 'width .12s linear';
    let text = from;
    spell(text); letters.append(caret);
    await wait(250);
    while (text.length) {
      text = text.slice(0, -1);
      setWidth(text); spell(text); letters.append(caret);
      await wait(55);
    }
    const typedPart = to.slice(0, 2);
    for (const character of typedPart) {
      text += character;
      setWidth(text); spell(text); letters.append(caret);
      await wait(130);
    }
    const kbd = h('kbd', {}, '⇥');
    const card = h('div', { class: 'suggest', 'aria-hidden': 'true' }, h('div', { class: 'on' }, to, kbd));
    word.append(card);
    await wait(900);
    kbd.classList.add('press');
    await wait(220);
    card.remove();
    letters.style.transition = 'width .35s cubic-bezier(.3,.7,.2,1)';
    setWidth(to);
    const cells = spell(to);
    letters.append(caret);
    cells.slice(typedPart.length).forEach((cell, index) => cell.animate(
      [{ opacity: 0, transform: 'translateX(-.15em)' }, { opacity: 1, transform: 'none' }],
      { duration: 260, delay: index * 14, easing: 'ease-out', fill: 'backwards' }));
    word.animate([{ backgroundColor: 'rgba(41,204,87,.35)' }, { backgroundColor: 'rgba(41,204,87,0)' }], { duration: 700, easing: 'ease-out' });
    await wait(650);
    caret.remove();
  }

  /** The word rolls up out of sight, blurring, and the next rolls up into place. */
  async function roll(from, to) {
    const out = spell(from);
    await Promise.all(out.map((cell, index) => cell.animate(
      [{ transform: 'none', opacity: 1, filter: 'blur(0)' }, { transform: 'translateY(-.55em)', opacity: 0, filter: 'blur(8px)' }],
      { duration: 380, delay: index * 22, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' }).finished));
    letters.style.transition = 'width .55s cubic-bezier(.3,.7,.2,1)';
    setWidth(to);
    const cells = spell(to);
    await Promise.all(cells.map((cell, index) => cell.animate(
      [{ transform: 'translateY(.6em)', opacity: 0, filter: 'blur(8px)' }, { transform: 'none', opacity: 1, filter: 'blur(0)' }],
      { duration: 520, delay: 80 + index * 32, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }).finished));
  }

  async function fade(from, to) {
    await letters.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' }).finished;
    setWidth(to); spell(to);
    letters.getAnimations().forEach((animation) => animation.cancel());
  }

  // Calendar → Outlook → Notion → Google Calendar → Calendar, each change its own.
  const TRANSITIONS = [scramble, lasso, typed, roll];

  async function runCycle(token) {
    while (cycle.token === token) {
      await wait(2300);
      if (cycle.token !== token) return;
      const from = WORDS[cycle.index], next = (cycle.index + 1) % WORDS.length, to = WORDS[next];
      try { await (still.matches ? fade : TRANSITIONS[cycle.index])(from, to); }
      catch { setWidth(to); spell(to); }
      cycle.index = next;
    }
  }

  function startCycle() {
    if (cycle.running) return;
    cycle = { ...cycle, running: true, token: cycle.token + 1 };
    runCycle(cycle.token);
  }

  function stopCycle() { cycle = { ...cycle, running: false, token: cycle.token + 1 }; }

  // ---------- screens ----------

  /** Brings up the sheet on one app's flow, or its connections. */
  function openSheet(screen) {
    stopCycle();
    body.dataset.screen = 'sheet';
    sheet.hidden = false;
    sheet.classList.remove('leaving');
    go(screen);
    requestAnimationFrame(() => window.lassoField?.refresh());
  }

  function closeSheet() {
    if (sheet.hidden) return;
    state.screen = null;
    sheet.classList.add('leaving');
    body.dataset.screen = 'intro';
    renderApps();
    setTimeout(() => {
      sheet.hidden = true;
      sheet.classList.remove('leaving');
      window.lassoField?.refresh();
      startCycle();
    }, 240);
    schedule();
  }

  // ---------- data ----------

  async function load() {
    const payload = await api(`/api/connections${bridge ? '?native=1' : ''}`);
    state.catalog = payload.catalog;
    state.connections = payload.connections;
  }

  /** Faster while something is being signed in or read, slower otherwise. */
  function schedule() {
    clearTimeout(state.polling);
    const busy = state.connections.some((entry) => ['connecting', 'syncing'].includes(entry.status) || entry.indexing);
    state.polling = setTimeout(poll, busy ? 900 : 5000);
  }

  async function poll() {
    try {
      const before = JSON.stringify([state.catalog, state.connections]);
      await load();
      // Only a change is drawn, so a refresh never lands under a click. Screens
      // with fields are left alone, so nothing typed is lost.
      const changed = before !== JSON.stringify([state.catalog, state.connections]);
      if (changed) renderApps();
      const screen = state.screen;
      if (changed && screen && (['provider', 'detail'].includes(screen.name) || ['waiting', 'syncing'].includes(screen.step))) render({ quiet: true });
      if (screen?.name === 'flow') advance();
    } catch { /* the server is restarting; try again shortly */ }
    schedule();
  }

  /** Moves a flow on when its connection changes underneath it. */
  function advance() {
    const screen = state.screen;
    const connection = screen?.connectionId && connectionOf(screen.connectionId);
    if (!connection) return;
    if (screen.step === 'waiting' && connection.status !== 'connecting') {
      go({ ...screen, step: connection.status === 'error' ? 'failed' : 'syncing', error: connection.error });
    } else if (screen.step === 'syncing' && connection.status === 'ready' && !connection.indexing) {
      go({ ...screen, step: 'done' });
      native('connected', { id: connection.id }).catch(() => {});
    } else if (screen.step === 'syncing' && connection.status === 'error') {
      go({ ...screen, step: 'failed', error: connection.error });
    }
  }

  const providerOf = (id) => state.catalog.find((entry) => entry.id === id);
  const connectionOf = (id) => state.connections.find((entry) => entry.id === id);
  const plural = (count, noun) => `${Number(count).toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;

  function since(iso) {
    const ms = Date.now() - Date.parse(iso ?? '');
    if (!Number.isFinite(ms)) return 'never';
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
    return `${Math.round(ms / 86_400_000)} days ago`;
  }

  function statusOf(connection) {
    if (connection.status === 'connecting') return { dot: 'busy', text: 'Waiting for sign-in' };
    if (connection.status === 'syncing' || connection.indexing) return { dot: 'busy', text: 'Bringing in items…' };
    if (connection.status === 'error') return { dot: 'bad', text: connection.error ?? 'Needs attention' };
    if (!connection.active) return { dot: '', text: `Off · ${plural(connection.itemCount, 'item')}` };
    return { dot: 'on', text: `${plural(connection.itemCount, 'item')} · synced ${since(connection.lastSyncedAt)}` };
  }

  // ---------- icons ----------

  // For apps not installed on this Mac: a plain symbol, as System Settings shows.
  const GLYPHS = {
    outlook: '<svg viewBox="0 0 24 24"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7 8.2 6 8.2-6"/></svg>',
    'google-calendar': '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',
    'apple-calendar': '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>',
    notion: '<svg viewBox="0 0 24 24"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19M9 12h7M9 15h7M9 18h4.5"/></svg>',
    ics: '<svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 7-7M5 12a7 7 0 0 0 7 7M8.5 12A3.5 3.5 0 0 1 12 8.5"/><circle cx="12" cy="12" r="1.2"/><path d="M15 9l4-4M19 5h-3M19 5v3"/></svg>',
  };

  function icon(provider, large = false) {
    const source = state.icons[provider];
    return h('span', { class: `icon${large ? ' large' : ''}`, 'aria-hidden': 'true' },
      source ? h('img', { src: source, alt: '' }) : h('span', { class: `glyph ${provider}`, html: GLYPHS[provider] ?? GLYPHS.ics }));
  }

  const chevron = () => h('span', { 'aria-hidden': 'true', html: '<svg class="chevron" viewBox="0 0 8 13"><path d="M1.5 1.5 6.5 6.5l-5 5"/></svg>' });

  // ---------- rendering ----------

  function go(screen, { back = false } = {}) {
    state.screen = screen;
    view.classList.toggle('back', back);
    render();
    schedule();
  }

  function render({ quiet = false } = {}) {
    const scroll = view.scrollTop;
    if (!state.screen) return;
    const { body: content, footer, heading } = state.screen.name === 'provider' ? providerScreen()
      : state.screen.name === 'detail' ? detailScreen() : flowScreen();
    title.textContent = heading;
    const wrapper = h('div', {}, content);
    view.replaceChildren(wrapper);
    foot.replaceChildren(...footer);
    if (quiet) { wrapper.style.animation = 'none'; view.scrollTop = scroll; } else view.scrollTop = 0;
  }

  const button = (label, onclick, kind = '') => h('button', { class: `btn ${kind}`.trim(), type: 'button', onclick }, label);

  /** Each app's icon and name, with Connect, or Manage once it is connected. */
  function renderApps() {
    const focused = document.activeElement?.closest?.('.app')?.dataset.provider;
    apps.replaceChildren(...state.catalog.map((entry) => {
      const mine = state.connections.filter((connection) => connection.provider === entry.id);
      const note = !entry.available ? { text: 'Mac app only' } : appNote(mine);
      const open = () => openSheet(mine.length ? { name: 'provider', provider: entry.id } : flowStart(entry.id));
      return h('div', { class: 'app', role: 'listitem', 'data-provider': entry.id },
        icon(entry.id),
        h('span', { class: 'app-name' }, entry.name),
        h('span', { class: `app-note${note?.bad ? ' bad' : ''}` }, note?.text ?? ''),
        h('button', { class: 'btn', type: 'button', disabled: !entry.available, onclick: open,
          'aria-label': `${mine.length ? 'Manage' : 'Connect'} ${entry.name}` }, mine.length ? 'Manage…' : 'Connect'));
    }));
    // They fade in the first time only; then the field keeps clear of them.
    if (state.appsShown) for (const app of apps.children) app.style.animation = 'none';
    else requestAnimationFrame(() => window.lassoField?.refresh());
    state.appsShown = true;
    if (focused) apps.querySelector(`[data-provider="${focused}"] .btn`)?.focus();
  }

  /** A word under the name only when there is something to say. */
  function appNote(mine) {
    if (mine.some((connection) => connection.status === 'error')) return { text: 'Needs attention', bad: true };
    if (mine.some((connection) => connection.status === 'connecting')) return { text: 'Signing in…' };
    if (mine.some((connection) => connection.status === 'syncing' || connection.indexing)) return { text: 'Bringing in…' };
    if (mine.length && mine.every((connection) => !connection.active)) return { text: 'Off' };
    return null;
  }

  /** One app's connections: switch each on or off, open one, or add another. */
  function providerScreen() {
    const entry = providerOf(state.screen.provider);
    const mine = state.connections.filter((connection) => connection.provider === entry.id);
    const rows = mine.map((connection) => {
      const status = statusOf(connection);
      const settled = connection.projectId && !['connecting', 'syncing'].includes(connection.status) && !connection.indexing;
      return h('div', { class: 'row link', tabindex: '0', role: 'button', 'aria-label': `${connection.name}, details`,
        onclick: (event) => { if (!event.target.closest('input')) go({ name: 'detail', id: connection.id, provider: entry.id }); },
        onkeydown: (event) => { if (event.key === 'Enter') go({ name: 'detail', id: connection.id, provider: entry.id }); } },
      h('span', { class: 'text' }, h('span', { class: 'name' }, connection.name),
        h('span', { class: `sub${status.dot === 'bad' ? ' bad' : ''}` }, h('span', { class: `dot ${status.dot}` }), status.text)),
      h('input', { type: 'checkbox', switch: true, checked: Boolean(connection.active), disabled: !settled,
        'aria-label': `Use ${connection.name} for suggestions`, onchange: (event) => toggle(connection.id, event.target.checked) }),
      chevron());
    });
    return {
      heading: entry.name,
      body: [
        h('div', { class: 'hero' }, icon(entry.id, true), h('div', {}, h('h3', {}, entry.name), h('p', {}, entry.description))),
        h('p', { class: 'section' }, 'Connected'),
        rows.length ? h('div', { class: 'group' }, rows) : h('p', { class: 'help' }, 'Nothing is connected yet.'),
        h('p', { class: 'help' }, 'Switched off, an app stays connected but Lasso leaves it out of suggestions, as it does a folder that is off.'),
      ],
      footer: [button('Add Another…', () => go(flowStart(entry.id))), button('Done', closeSheet, 'default')],
    };
  }

  function detailScreen() {
    const connection = connectionOf(state.screen.id);
    if (!connection) { state.screen = { name: 'provider', provider: state.screen.provider }; return providerScreen(); }
    const entry = providerOf(connection.provider);
    const status = statusOf(connection);
    const settled = connection.projectId && !['connecting', 'syncing'].includes(connection.status) && !connection.indexing;
    return {
      heading: entry?.name ?? connection.name,
      body: [
        h('div', { class: 'hero' }, icon(connection.provider, true),
          h('div', {}, h('h3', {}, connection.name), h('p', {}, entry?.description ?? ''))),
        h('div', { class: 'group' },
          h('div', { class: 'row compact' }, h('label', { class: 'grow', for: 'use-switch' }, 'Use for suggestions'),
            h('input', { id: 'use-switch', type: 'checkbox', switch: true, checked: Boolean(connection.active), disabled: !settled,
              onchange: (event) => toggle(connection.id, event.target.checked) })),
          h('div', { class: 'row compact' }, h('span', { class: 'label-text' }, 'Status'),
            h('span', { class: `sub${status.dot === 'bad' ? ' bad' : ''}` }, h('span', { class: `dot ${status.dot}` }),
              connection.status === 'error' ? 'Needs attention' : settled ? (connection.active ? 'On' : 'Off') : 'Bringing in items…')),
          h('div', { class: 'row compact' }, h('span', { class: 'label-text' }, 'Items'), h('span', { class: 'sub' }, plural(connection.itemCount, 'item'))),
          h('div', { class: 'row compact' }, h('span', { class: 'label-text' }, 'Last synced'), h('span', { class: 'sub' }, since(connection.lastSyncedAt)))),
        connection.status === 'error' ? h('p', { class: 'error' }, connection.error) : null,
        h('p', { class: 'help' }, connection.provider === 'apple-calendar'
          ? 'Lasso reads these calendars again whenever their events change.'
          : 'Lasso reads this app again every 30 minutes while it is switched on.'),
      ],
      footer: [
        button('Disconnect…', () => disconnect(connection), 'destructive'), h('span', { class: 'spacer' }),
        h('button', { class: 'btn', type: 'button', disabled: !settled && connection.status !== 'error', onclick: () => syncNow(connection) }, 'Sync Now'),
        button('Done', closeSheet, 'default'),
      ],
    };
  }

  async function toggle(id, active) {
    try { await api(`/api/connections/${encodeURIComponent(id)}`, { method: 'POST', body: { active } }); }
    catch (error) { alert(error.message); }
    await load(); render({ quiet: true }); native('connected', { id }).catch(() => {});
  }

  async function syncNow(connection) {
    try {
      if (connection.provider === 'apple-calendar') native('calendar.sync', { connectionId: connection.id, settings: connection.settings }).catch((error) => alert(error.message));
      else api(`/api/connections/${encodeURIComponent(connection.id)}/sync`, { method: 'POST' }).catch(() => {});
    } finally { setTimeout(poll, 200); }
  }

  async function disconnect(connection) {
    const confirmed = await confirmAction(`Disconnect ${connection.name}?`,
      'Lasso stops reading it and removes the copy of its items from this Mac. Nothing changes in the app itself, and you can connect it again any time.',
      'Disconnect');
    if (!confirmed) return;
    try { await api(`/api/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }); }
    catch (error) { alert(error.message); }
    await load();
    renderApps();
    if (state.connections.some((entry) => entry.provider === connection.provider)) go({ name: 'provider', provider: connection.provider }, { back: true });
    else closeSheet();
    native('connected', { id: connection.id }).catch(() => {});
  }

  // ---------- connect flows ----------

  const FIRST = { oauth: 'choose', token: 'secret', url: 'address', native: 'access' };

  function flowStart(providerId) {
    const entry = providerOf(providerId);
    return { name: 'flow', provider: providerId, step: FIRST[entry.auth],
      settings: { parts: entry.parts.map((part) => part.id), pastDays: 30, futureDays: 90 } };
  }

  /** Leaving a sign-in that never finished leaves nothing behind. */
  function leave() {
    const connection = state.screen?.connectionId && connectionOf(state.screen.connectionId);
    if (connection?.status === 'connecting') api(`/api/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }).catch(() => {});
    closeSheet();
    setTimeout(poll, 200);
  }

  function flowScreen() {
    const screen = state.screen, entry = providerOf(screen.provider);
    const built = ({
      choose: choose, setup: setup, waiting: waiting, secret: secret, address: address,
      access: access, denied: denied, calendars: calendars, syncing: syncing, done: done,
    })[screen.step] ?? failed;
    const { body: content, footer } = built(entry, screen);
    return { heading: entry.name, body: content, footer };
  }

  const hero = (entry, heading, text) => h('div', { class: 'hero' }, icon(entry.id, true), h('div', {}, h('h3', {}, heading), h('p', {}, text)));
  const errorNote = (message) => (message ? h('p', { class: 'error', role: 'alert' }, message) : null);
  const cancel = () => button('Cancel', leave);

  function busy(target, label) {
    target.disabled = true;
    const before = target.textContent;
    target.textContent = label;
    return () => { target.disabled = false; target.textContent = before; };
  }

  const DAY_CHOICES = [[7, '1 week'], [30, '30 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];
  function periodRows(settings, { past = 'Past', future = 'Upcoming' } = {}) {
    const select = (key, label) => h('select', { 'aria-label': label, onchange: (event) => { settings[key] = Number(event.target.value); } },
      DAY_CHOICES.map(([days, text]) => { const option = h('option', { value: String(days) }, text); option.selected = settings[key] === days; return option; }));
    return h('div', { class: 'group' },
      h('div', { class: 'row compact' }, h('span', { class: 'label-text' }, past), select('pastDays', past)),
      future ? h('div', { class: 'row compact' }, h('span', { class: 'label-text' }, future), select('futureDays', future)) : null);
  }

  // OAuth: choose what to read, then sign in through the browser.
  function choose(entry, screen) {
    const settings = screen.settings, signIn = entry.signIn;
    const primary = h('button', { class: 'btn default', type: 'button', disabled: !settings.parts.length, onclick: async (event) => {
      if (!signIn.configured) { go({ ...screen, step: 'setup', error: null }); return; }
      const restore = busy(event.currentTarget, 'Opening…');
      try {
        const { connection, authorizeUrl } = await api('/api/connections', { method: 'POST', body: { provider: entry.id, settings } });
        await openExternal(authorizeUrl);
        await load();
        go({ ...screen, step: 'waiting', connectionId: connection.id, error: null });
      } catch (error) { restore(); go({ ...screen, error: error.message }); }
    } }, signIn.configured ? `Sign In with ${signIn.appName}…` : 'Set Up Sign-In…');
    const parts = entry.parts.map((part) => h('div', { class: 'row compact' }, h('label', { class: 'grow' },
      h('input', { type: 'checkbox', checked: settings.parts.includes(part.id), onchange: (event) => {
        settings.parts = event.target.checked ? [...new Set([...settings.parts, part.id])] : settings.parts.filter((id) => id !== part.id);
        primary.disabled = !settings.parts.length;
      } }), h('span', {}, part.label, h('span', { class: 'sub' }, part.detail)))));
    const mail = entry.parts.some((part) => part.id === 'mail');
    return {
      body: [
        hero(entry, `Connect ${entry.name}`, `${entry.description} Lasso never changes or sends anything there.`),
        h('p', { class: 'section' }, 'Bring In'), h('div', { class: 'group' }, parts),
        h('p', { class: 'section' }, 'Period'), periodRows(settings, { past: mail ? 'Mail and past events' : 'Past events', future: 'Upcoming events' }),
        signIn.configured ? null : h('p', { class: 'help' }, `First, Lasso needs your ${signIn.appName} app registration.`),
        errorNote(screen.error),
      ],
      footer: [cancel(), primary],
    };
  }

  function setup(entry, screen) {
    const signIn = entry.signIn;
    const clientId = h('input', { class: 'field-input mono', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Client ID',
      placeholder: signIn.app === 'microsoft' ? '00000000-0000-0000-0000-000000000000' : '….apps.googleusercontent.com' });
    const secretInput = signIn.needsSecret ? h('input', { class: 'field-input mono', type: 'password', autocomplete: 'off', 'aria-label': 'Client secret' }) : null;
    const copy = button('Copy', async () => {
      try { await navigator.clipboard.writeText(signIn.redirectUri); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select to Copy'; }
    });
    const save = button('Save', async (event) => {
      const restore = busy(event.currentTarget, 'Saving…');
      try {
        await api(`/api/connections/apps/${signIn.app}`, { method: 'POST', body: { clientId: clientId.value, clientSecret: secretInput?.value } });
        await load();
        go({ ...screen, step: 'choose', error: null });
      } catch (error) { restore(); go({ ...screen, error: error.message }); }
    }, 'default');
    setTimeout(() => clientId.focus(), 60);
    return {
      body: [
        hero(entry, `Set Up ${signIn.appName} Sign-In`, `${signIn.appName} lets an app ask for your permission only through an app registration. Add yours once; it stays on this Mac.`),
        h('div', { class: 'group' },
          h('div', { class: 'row compact' }, h('span', { class: 'label-text', style: 'flex:none;width:96px' }, 'Client ID'), clientId),
          secretInput ? h('div', { class: 'row compact' }, h('span', { class: 'label-text', style: 'flex:none;width:96px' }, 'Client secret'), secretInput) : null,
          signIn.redirectUri ? h('div', { class: 'row compact' }, h('span', { class: 'label-text', style: 'flex:none;width:96px' }, 'Redirect URI'),
            h('span', { class: 'copy' }, h('code', {}, signIn.redirectUri), copy)) : null),
        h('p', { class: 'help' }, signIn.setup),
        errorNote(screen.error),
      ],
      footer: [button('Back', () => go({ ...screen, step: 'choose', error: null }, { back: true })), h('span', { class: 'spacer' }), cancel(), save],
    };
  }

  const spinner = () => h('span', { html: '<svg class="spinner" viewBox="0 0 28 28" aria-hidden="true">'
    + Array.from({ length: 12 }, (_, index) => `<line x1="14" y1="3" x2="14" y2="8" opacity="${(0.25 + index * 0.0625).toFixed(2)}" transform="rotate(${index * 30} 14 14)"/>`).join('') + '</svg>' });

  function waiting(entry, screen) {
    return {
      body: [h('div', { class: 'status' }, spinner(), h('h3', {}, 'Waiting for You to Sign In'),
        h('p', {}, `Finish signing in to ${entry.signIn.appName} in your browser and allow Lasso to read your account. This window continues on its own.`))],
      footer: [cancel(), button('Open Sign-In Page Again', async () => {
        try {
          const { authorizeUrl } = await api(`/api/connections/${encodeURIComponent(screen.connectionId)}/sign-in`, { method: 'POST' });
          await openExternal(authorizeUrl);
        } catch (error) { go({ ...screen, step: 'failed', error: error.message }); }
      })],
    };
  }

  // Notion: an integration's secret.
  function secret(entry, screen) {
    const input = h('input', { class: 'field-input mono', type: 'password', placeholder: 'ntn_…', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Internal integration secret' });
    const connect = button('Connect', async (event) => {
      const restore = busy(event.currentTarget, 'Checking…');
      try {
        const { connection } = await api('/api/connections', { method: 'POST', body: { provider: entry.id, token: input.value, settings: screen.settings } });
        await load();
        go({ ...screen, step: 'syncing', connectionId: connection.id, error: null });
      } catch (error) { restore(); go({ ...screen, error: error.message }); }
    }, 'default');
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect.click(); });
    return {
      body: [
        hero(entry, 'Connect Notion', 'Lasso reads only the pages you share with an integration you create in Notion.'),
        h('div', { class: 'group' }, h('ol', { class: 'steps' },
          h('li', {}, 'Open Notion’s integrations page, choose ', h('b', {}, 'New integration'), ', name it Lasso and keep the type ', h('b', {}, 'Internal'), '.',
            h('br'), button('Open Notion Integrations…', () => openExternal('https://www.notion.so/profile/integrations'))),
          h('li', {}, 'Under ', h('b', {}, 'Capabilities'), ', leave only ', h('b', {}, 'Read content'), ' on, then copy the ', h('b', {}, 'Internal Integration Secret'), '.'),
          h('li', {}, 'In Notion, open each page or database to bring in, choose ', h('b', {}, '••• › Connections'), ' and add Lasso.'))),
        h('p', { class: 'section' }, 'Integration Secret'),
        h('div', { class: 'group' }, h('div', { class: 'row compact' }, input)),
        h('p', { class: 'help' }, 'Kept on this Mac, apart from Lasso’s history, and used only to read what you shared.'),
        errorNote(screen.error),
      ],
      footer: [cancel(), connect],
    };
  }

  // A calendar feed: its iCal address.
  function address(entry, screen) {
    const input = h('input', { class: 'field-input mono', placeholder: 'webcal://… or https://….ics', autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Calendar address' });
    const connect = button('Connect', async (event) => {
      const restore = busy(event.currentTarget, 'Reading…');
      try {
        const { connection } = await api('/api/connections', { method: 'POST', body: { provider: entry.id, url: input.value, settings: screen.settings } });
        await load();
        go({ ...screen, step: 'syncing', connectionId: connection.id, error: null });
      } catch (error) { restore(); go({ ...screen, error: error.message }); }
    }, 'default');
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect.click(); });
    setTimeout(() => input.focus(), 60);
    return {
      body: [
        hero(entry, 'Connect a Calendar Feed', 'Any calendar app can publish a private iCal link. Lasso reads it again every 30 minutes.'),
        h('div', { class: 'group' }, h('div', { class: 'row compact' }, h('span', { class: 'label-text', style: 'flex:none;width:70px' }, 'Address'), input)),
        h('p', { class: 'help' }, h('b', {}, 'Outlook: '), 'Settings › Calendar › Shared calendars › Publish a calendar, then copy the ICS link.', h('br'),
          h('b', {}, 'Google Calendar: '), 'Settings › your calendar › Integrate calendar › Secret address in iCal format.', h('br'),
          h('b', {}, 'iCloud: '), 'share the calendar as a Public Calendar and copy its link.'),
        h('p', { class: 'section' }, 'Period'), periodRows(screen.settings, { past: 'Past events', future: 'Upcoming events' }),
        errorNote(screen.error),
      ],
      footer: [cancel(), connect],
    };
  }

  // Calendar on this Mac, read by the Mac app.
  function access(entry, screen) {
    return {
      body: [
        hero(entry, 'Connect Calendar', 'Lasso reads events from the Calendar app, including accounts added in System Settings › Internet Accounts, such as iCloud, Exchange and Google.'),
        h('p', { class: 'help' }, 'macOS asks once whether Lasso may read your calendars.'),
        errorNote(screen.error),
      ],
      footer: [cancel(), button('Allow Access…', async (event) => {
        const restore = busy(event.currentTarget, 'Asking…');
        try {
          const answer = await native('calendar.requestAccess');
          if (!answer?.granted) { go({ ...screen, step: 'denied', error: null }); return; }
          const list = answer.calendars ?? [];
          go({ ...screen, step: 'calendars', calendars: list, settings: { ...screen.settings, calendars: list.map((calendar) => calendar.id) }, error: null });
        } catch (error) { restore(); go({ ...screen, error: error.message }); }
      }, 'default')],
    };
  }

  function denied(entry, screen) {
    return {
      body: [h('div', { class: 'status' }, h('h3', {}, 'Lasso Can’t See Your Calendars'),
        h('p', {}, 'Switch on Lasso in System Settings › Privacy & Security › Calendars, then try again.'))],
      footer: [cancel(), button('Open Privacy Settings…', () => native('calendar.openSettings').catch(() => {})),
        button('Try Again', () => go({ ...screen, step: 'access' }, { back: true }), 'default')],
    };
  }

  function calendars(entry, screen) {
    const settings = screen.settings;
    const groups = new Map();
    for (const calendar of screen.calendars ?? []) {
      if (!groups.has(calendar.source)) groups.set(calendar.source, []);
      groups.get(calendar.source).push(calendar);
    }
    const connect = h('button', { class: 'btn default', type: 'button', disabled: !settings.calendars.length, onclick: async (event) => {
      const restore = busy(event.currentTarget, 'Reading…');
      try {
        const chosen = (screen.calendars ?? []).filter((calendar) => settings.calendars.includes(calendar.id));
        const sources = [...new Set(chosen.map((calendar) => calendar.source))];
        const { connection } = await api('/api/connections', { method: 'POST', body: { provider: entry.id, settings,
          account: sources.length === 1 ? sources[0] : 'This Mac' } });
        await load();
        go({ ...screen, step: 'syncing', connectionId: connection.id, error: null });
        await native('calendar.sync', { connectionId: connection.id, settings });
        setTimeout(poll, 100);
      } catch (error) { restore(); go({ ...screen, step: screen.connectionId ? 'failed' : screen.step, error: error.message }); }
    } }, 'Connect');
    const sections = [...groups].map(([source, list]) => [h('p', { class: 'section' }, source), h('div', { class: 'group' },
      list.map((calendar) => h('div', { class: 'row compact' }, h('label', { class: 'grow' },
        h('input', { type: 'checkbox', checked: settings.calendars.includes(calendar.id), onchange: (event) => {
          settings.calendars = event.target.checked ? [...new Set([...settings.calendars, calendar.id])] : settings.calendars.filter((id) => id !== calendar.id);
          connect.disabled = !settings.calendars.length;
        } }),
        h('span', { class: 'calendar-dot', style: `background:${/^#[0-9a-f]{6}$/i.test(calendar.color ?? '') ? calendar.color : '#888'}` }),
        calendar.title))))]);
    return {
      body: [
        hero(entry, 'Choose Calendars', (screen.calendars ?? []).length ? 'Lasso keeps these up to date as their events change.' : 'There are no calendars in the Calendar app yet.'),
        sections,
        h('p', { class: 'section' }, 'Period'), periodRows(settings, { past: 'Past events', future: 'Upcoming events' }),
        errorNote(screen.error),
      ],
      footer: [cancel(), connect],
    };
  }

  // Every flow ends here: items coming in, then done.
  function syncing(entry, screen) {
    const connection = connectionOf(screen.connectionId);
    const percent = connection?.indexing?.percent ?? 0;
    const reading = !connection?.indexing || connection.indexing.phase === 'fetching';
    const what = entry.id === 'notion' ? 'Pages' : entry.parts.length > 1 ? 'Mail and Events' : 'Events';
    const bar = reading && percent < 6 ? h('progress', { 'aria-label': 'Progress' }) : h('progress', { max: '100', value: String(percent), 'aria-label': 'Progress' });
    return {
      body: [h('div', { class: 'status' }, h('h3', {}, `Bringing In Your ${what}`),
        h('p', {}, reading ? `Reading ${entry.name}${connection?.account ? ` (${connection.account})` : ''}…` : 'Indexing on this Mac so Lasso can suggest and cite them…'), bar)],
      footer: [h('span', { class: 'note' }, 'You can close this; Lasso keeps going in the menu bar.'), h('span', { class: 'spacer' }),
        button('Close', closeSheet)],
    };
  }

  function done(entry, screen) {
    const connection = connectionOf(screen.connectionId);
    return {
      body: [h('div', { class: 'status' },
        h('span', { class: 'done-mark', html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg>' }),
        h('h3', {}, `${entry.name} Is Connected`),
        h('p', {}, `${connection?.name ?? entry.name} · ${plural(connection?.itemCount ?? 0, entry.id === 'notion' ? 'page' : 'item')}.`),
        h('p', {}, 'It’s listed under Connected Apps in the Lasso menu, where you can switch it off like a folder.'))],
      footer: [button('Done', closeSheet, 'default')],
    };
  }

  function failed(entry, screen) {
    const connection = screen.connectionId && connectionOf(screen.connectionId);
    return {
      body: [h('div', { class: 'status' }, h('h3', {}, `${entry.name} Couldn’t Be Connected`),
        h('p', {}, screen.error ?? connection?.error ?? 'Something went wrong.'))],
      footer: [cancel(), button('Try Again', async () => {
        if (connection) await api(`/api/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' }).catch(() => {});
        await load();
        go(flowStart(entry.id), { back: true });
      }, 'default')],
    };
  }

  // ---------- wiring ----------

  /** Back: from a connection to its app's list, from setting up sign-in to its choices, otherwise out of the sheet. */
  function back() {
    const screen = state.screen;
    if (!screen) return;
    if (screen.name === 'detail') go({ name: 'provider', provider: screen.provider }, { back: true });
    else if (screen.step === 'setup') go({ ...screen, step: 'choose', error: null }, { back: true });
    else if (screen.name === 'flow') leave();
    else closeSheet();
  }
  document.getElementById('back').addEventListener('click', back);
  addEventListener('keydown', (event) => { if (event.key === 'Escape' && !sheet.hidden) back(); });
  // The Mac app asks the page to show the latest state when it is brought forward.
  window.lassoConnect = { refresh: () => poll() };

  setWidth(WORDS[0]);
  startCycle();
  load().then(() => { renderApps(); schedule(); }).catch(() => schedule());
  if (bridge) native('appIcons').then((icons) => { state.icons = icons ?? {}; renderApps(); if (!sheet.hidden) render({ quiet: true }); }).catch(() => {});
})();
