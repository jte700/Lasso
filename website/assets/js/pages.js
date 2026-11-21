/* Page pieces drawn from the benchmark data: the prompt replay and the charts.
   Each is registered with LASSO.hydrate, which shows a skeleton until the piece is near the viewport. */
(() => {
  'use strict';
  const { $, $$, html, escapeHtml: esc, hydrate } = window.LASSO;

  const whole = (v) => Math.round(v).toLocaleString('en');
  const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
  const bar = (value, tone = '') => `<div class="abar ${tone}" aria-hidden="true"><i style="--v:${(value > 0 ? Math.max(0.8, Math.min(100, value)) : 0).toFixed(2)}"></i></div>`;
  const segs = (name, options, chosen) => `<div class="tabs" role="group" aria-label="${esc(name)}">${options.map(([id, label]) =>
    `<button class="seg" type="button" data-pick="${id}" aria-pressed="${id === chosen}">${esc(label)}</button>`).join('')}</div>`;
  const pickIn = (node, draw) => node.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (!pick) return;
    $$('[data-pick]', node).forEach((el) => el.setAttribute('aria-pressed', String(el === pick)));
    draw(pick.dataset.pick);
  });

  /* ---------- benchmarks: replay any of the 28 prompts ---------- */
  hydrate('replay', (host, data) => {
    const cases = data.typing.cases;
    const folders = ['All', ...new Set(cases.map((c) => c.c))];
    const node = html(`<div style="display:grid;gap:18px">
      <div class="formats" style="justify-content:flex-start">${folders.map((f, i) => `<button class="chip slop" type="button" data-folder="${esc(f)}" aria-pressed="${i === 0}">${esc(f)}</button>`).join('')}</div>
      <div class="replay">
        <div class="replay-list" data-list></div>
        <div class="doc"><span class="doc-where" data-where></span><p class="doc-line"><span data-typed></span><span class="caret-bar"></span></p>
          <div class="sugg"><div data-rows></div><div class="sugg-foot" data-verdict></div></div></div>
      </div></div>`);
    const list = $('[data-list]', node);
    let folder = 'All';

    const show = (c) => {
      $$('.row', list).forEach((row) => row.toggleAttribute('data-open', row.dataset.t === c.t));
      $('[data-where]', node).textContent = `${c.c} · ${c.k}`;
      $('[data-typed]', node).textContent = c.t;
      $('[data-rows]', node).innerHTML = c.o.slice(0, 3).map((offer, i) => `<div class="sugg-row"${i === c.r - 1 ? ' data-active' : ''}><b>${esc(offer.trim())}</b><small>${i === c.r - 1 ? esc(c.e) : 'also offered'}</small><span>${i === 0 ? 'Tab' : ''}</span></div>`).join('');
      $('[data-verdict]', node).innerHTML = c.r === 1
        ? `<span class="pop">Right answer first</span><span>${c.ty} letters typed, ${c.ins} inserted</span>`
        : `<span>Right answer offered ${c.r === 2 ? 'second' : 'third'}. The one miss in the set.</span>`;
    };
    const fill = () => {
      const shown = cases.filter((c) => folder === 'All' || c.c === folder);
      list.innerHTML = shown.map((c) => `<button class="row" type="button" data-t="${esc(c.t)}"><span class="row-label">${esc(c.t)}<small>${esc(c.c)}</small></span><span class="row-val ${c.r === 1 ? '' : 'worse'}">#${c.r}</span></button>`).join('');
      show(shown[0]);
    };
    node.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-folder]');
      if (chip) { folder = chip.dataset.folder; $$('[data-folder]', node).forEach((el) => el.setAttribute('aria-pressed', String(el === chip))); fill(); return; }
      const row = e.target.closest('.row');
      if (row) show(cases.find((c) => c.t === row.dataset.t));
    });
    fill();
    return node;
  });

  /* ---------- benchmarks: latency per keystroke ---------- */
  const INSTANT_MS = 100;
  hydrate('latency', (host, data) => {
    const sets = { single: data.typing.single.latency, library: data.typing.library.score.latency };
    const node = html(`<div class="chart"><div class="chart-head"><p>${data.typing.single.latency.samples} keystrokes, replayed one at a time.</p>
      ${segs('Folders', [['single', 'One folder'], ['library', 'Ten folders']], 'library')}</div><div class="rows" data-rows></div></div>`);
    const draw = (id) => {
      const lat = sets[id];
      $('[data-rows]', node).innerHTML = [['Typical', 'the median keystroke', lat.p50], ['Slow', '1 in 20 is slower', lat.p95], ['Slower', '1 in 100 is slower', lat.p99], ['Slowest', 'the worst one', lat.max]]
        .map(([label, sub, ms]) => `<div class="row"><span class="row-label">${label}<small>${sub}</small></span>${bar((100 * ms) / INSTANT_MS, ms > INSTANT_MS ? 'dim' : 'pop')}<span class="row-val ${ms > INSTANT_MS ? 'worse' : ''}">${ms < 10 ? ms.toFixed(1) : ms.toFixed(0)} ms</span></div>`).join('');
    };
    pickIn(node, draw);
    draw('library');
    return node;
  });

  /* ---------- benchmarks: what an AI would have to read ---------- */
  hydrate('context', (host, data) => {
    const rows = [...data.typing.corpora].sort((a, b) => b.tokens - a.tokens);
    const most = rows[0].tokens;
    return html(`<div class="chart"><div class="rows">${rows.map((c) => `<div class="row"><span class="row-label">${esc(c.name)}<small>${c.files} files</small></span>
      ${bar((100 * c.tokens) / most)}<span class="row-val">${whole(c.tokens)}</span></div>`).join('')}</div>
      <div class="legend"><span>Tokens to read the folder once</span><span class="l-pop">Tokens Lasso spends: 0</span></div></div>`);
  });

  /* ---------- benchmarks: storage and memory ---------- */
  hydrate('storage', (host, data) => {
    const before = data.storage.baseline.targets, now = data.storage.final.targets;
    const size = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1000 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`);
    const ms = (v) => `${Math.round(v)} ms`;
    const rows = [
      ['History per edit', 'one cell changed', before.dbGrowthPerEditBytes, now.dbGrowthPerEditBytes, size],
      ['Rows written', 'for that one cell', before.versionRowsPerOneCellEdit, now.versionRowsPerOneCellEdit, whole],
      ['Time to record it', 'warm', before.warmEditMs, now.warmEditMs, ms],
      ['After a restart', 'first edit', before.firstEditAfterRestartMs, now.firstEditAfterRestartMs, ms],
      ['Peak memory', 'whole run', before.peakRssBytes, now.peakRssBytes, (v) => `${Math.round(v / 1e6)} MB`],
    ];
    return html(`<div class="chart"><div class="rows">${rows.map(([label, sub, was, is, show]) => `<div class="row" tabindex="0"><span class="row-label">${label}<small>${sub}</small></span>
      <div class="bars">${bar(100, 'dim')}${bar((100 * is) / was, 'pop')}</div><span class="row-val">${show(is)}</span>
      <span class="row-more">Before: ${show(was)}. Now: ${show(is)}.</span></div>`).join('')}</div>
      <div class="legend"><span class="l-dim">Before the rework</span><span class="l-pop">Now</span></div></div>`);
  });

  /* ---------- MCP: tokens by kind of file ---------- */
  hydrate('kinds', (host, data) => {
    const kinds = data.mcp.kinds;
    const node = html(`<div class="chart"><div class="chart-head"><p>Tokens with Lasso, as a share of the other way. Shorter is better. Hover a row for details.</p>
      ${segs('Compared with', [['ft', 'vs file tools'], ['up', 'vs attaching']], 'ft')}</div><div class="rows" data-rows></div></div>`);
    const draw = (against) => {
      const label = against === 'ft' ? 'file tools' : 'attached';
      $('[data-rows]', node).innerHTML = kinds.map((k) => {
        const pair = against === 'up' && k.fresh ? { la: k.fresh.la, other: k.fresh.up } : { la: k.la, other: k[against] };
        const head = `<span class="row-label">${esc(k.label)}<small>${esc(k.size)}</small></span>`;
        if (!pair.other) return `<div class="row" tabindex="0">${head}${bar(0)}<span class="row-val worse">n/a</span><span class="row-more">${k.id === 'ifc' ? 'Too large to attach.' : 'Not run with the files attached.'}</span></div>`;
        const share = (100 * pair.la.tok) / pair.other.tok;
        return `<div class="row" tabindex="0">${head}${bar(share, share > 100 ? 'dim' : 'pop')}<span class="row-val ${share > 100 ? 'worse' : ''}">${pct(share - 100)}</span>
          <span class="row-more">Lasso: ${whole(pair.la.tok)} tokens, ${pair.la.ok} of ${pair.la.n} right. ${label[0].toUpperCase() + label.slice(1)}: ${whole(pair.other.tok)} tokens, ${pair.other.ok} of ${pair.other.n} right.</span></div>`;
      }).join('');
    };
    pickIn(node, draw);
    draw('ft');
    return node;
  });
})();
