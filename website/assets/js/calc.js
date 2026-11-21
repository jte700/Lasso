/* Savings calculators. Every figure is a measured per-question average from the live runs
   (see sources.html#calculator), multiplied by what the visitor enters. */
(() => {
  'use strict';
  const { $, $$, store, toast, tween } = window.LASSO;

  const WEEKS_PER_YEAR = 52;
  const WORKDAYS_PER_WEEK = 5;
  const MEASURED_INPUT_PRICE = 0.75; // dollars per million input tokens in the recorded runs

  const log = (min, max) => ({
    toValue: (raw) => min * (max / min) ** (raw / 100),
    toRaw: (value) => (100 * Math.log(value / min)) / Math.log(max / min),
  });
  const linear = { toValue: (raw) => raw, toRaw: (value) => value };
  const roundTo = (value, step) => Math.round(value / step) * step;
  const nicePeople = (v) => (v < 20 ? Math.round(v) : v < 100 ? roundTo(v, 5) : v < 500 ? roundTo(v, 10) : v < 2000 ? roundTo(v, 50) : roundTo(v, 100));
  const nicePrice = (v) => (v < 2 ? roundTo(v, 0.05) : v < 5 ? roundTo(v, 0.25) : roundTo(v, 0.5));

  const SLIDERS = {
    people: { ...log(2, 5000), nice: nicePeople, show: (v) => v.toLocaleString('en') },
    hours: { ...linear, nice: Math.round, show: (v) => `${v} h` },
    perHour: { ...linear, nice: Math.round, show: (v) => String(v) },
    lookups: { ...linear, nice: Math.round, show: (v) => String(v) },
    price: { ...log(0.25, 15), nice: nicePrice, show: (v) => `$${v.toFixed(2)}` },
  };
  const DEFAULTS = {
    mcp: { mode: 'me', people: 25, hours: 10, perHour: 10, mix: 'all', price: 3 },
    typing: { mode: 'me', people: 25, lookups: 20, price: 3 },
  };

  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const tokens = (v) => compact.format(Math.round(v));
  const dollars = (v) => (v < 1000 ? `$${Math.round(v).toLocaleString('en')}` : `$${compact.format(v)}`);
  const whole = (v) => Math.round(v).toLocaleString('en');

  const perQuestion = (arm) => ({ tokens: arm.tok / arm.n, cost: arm.cost / arm.n });

  /* What a year looks like, given the state and the measured averages. */
  function work(kind, state, data) {
    const people = state.mode === 'team' ? state.people : 1;
    const scale = state.price / MEASURED_INPUT_PRICE;
    if (kind === 'typing') {
      const without = perQuestion(data.mcp.groups.all.ft);
      const questions = people * state.lookups * WORKDAYS_PER_WEEK * WEEKS_PER_YEAR;
      return { questions, tokensSaved: questions * without.tokens, moneySaved: questions * without.cost * scale, share: 0, without, withLasso: { tokens: 0, cost: 0 } };
    }
    const group = data.mcp.groups[state.mix];
    const without = perQuestion(group.ft);
    const withLasso = perQuestion(group.la);
    const questions = people * state.hours * state.perHour * WEEKS_PER_YEAR;
    return {
      questions, without, withLasso, group,
      tokensSaved: questions * (without.tokens - withLasso.tokens),
      moneySaved: questions * (without.cost - withLasso.cost) * scale,
      share: withLasso.tokens / without.tokens,
    };
  }

  function bind(el) {
    const kind = el.dataset.calc;
    const slot = `lasso.calc.${kind}`;
    let state = { ...DEFAULTS[kind], ...store.get(slot, {}) };
    const out = (name) => $(`[data-out="${name}"]`, el);

    const render = () => {
      const data = window.LASSO.data;
      $$('input[type="range"]', el).forEach((input) => {
        const slider = SLIDERS[input.name];
        const raw = slider.toRaw(state[input.name]);
        if (document.activeElement !== input) input.value = raw;
        input.style.setProperty('--fill', (100 * (raw - input.min)) / (input.max - input.min));
        input.setAttribute('aria-valuetext', slider.show(state[input.name]));
        out(input.name).textContent = slider.show(state[input.name]);
      });
      $$('[data-set]', el).forEach((button) => {
        const [key, value] = button.dataset.set.split(':');
        button.setAttribute('aria-pressed', String(state[key] === value));
      });
      $$('[data-when]', el).forEach((node) => { node.hidden = node.dataset.when !== state.mode; });

      const year = work(kind, state, data);
      tween(out('tokens'), year.tokensSaved, tokens);
      tween(out('money'), year.moneySaved, dollars);
      out('questions').textContent = whole(year.questions);
      out('each').textContent = `${whole(year.without.tokens)} → ${whole(year.withLasso.tokens)}`;
      if (kind === 'typing') return;
      tween(out('pct'), 100 * (1 - year.share), (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`);
      out('right').textContent = `${year.group.ft.ok} → ${year.group.la.ok} of ${year.group.ft.n}`;
      out('tasks').textContent = String(year.group.ft.n);
      $('[data-bar="with"]', el)?.style.setProperty('--v', Math.max(1.5, 100 * year.share));
    };

    const update = (patch) => { state = { ...state, ...patch }; store.set(slot, state); render(); };

    el.addEventListener('input', (e) => {
      const slider = SLIDERS[e.target.name];
      if (slider) update({ [e.target.name]: slider.nice(slider.toValue(Number(e.target.value))) });
    });
    el.addEventListener('click', (e) => {
      const setter = e.target.closest('[data-set]');
      if (setter) { const [key, value] = setter.dataset.set.split(':'); update({ [key]: value }); return; }
      if (!e.target.closest('[data-reset]')) return;
      const before = state;
      update({ ...DEFAULTS[kind] });
      toast('Calculator reset', { undo: () => update(before) });
    });
    document.addEventListener('lasso:data', render);
    render();
  }

  $$('[data-calc]').forEach(bind);
})();
