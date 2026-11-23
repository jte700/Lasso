/* The passage picker in the homepage reel, drawn after the Mac app's own window
   (desktop/PassagePickerView.swift): Tab on a PDF passage opens its page, the words are
   highlighted by dragging, "Insert with source" adds the file and page, and Tab inserts.
   The reel (film.js) asks it to open, drag, switch and close in turn. */
(() => {
  'use strict';

  // The lease's first page as the card shows it, with the clause the typed words found.
  const PAGE = [
    { cls: 'dp-kick', text: 'EXECUTED 14 MAR 2025' },
    { cls: 'dp-title', text: 'Lease Agreement - Unit 4' },
    { cls: 'dp-h', text: '12. Renewal' },
    { text: '12.2 The Tenant may renew this Lease for a further term of five (5) years.' },
    { text: '12.3 Notice to renew. ', clause: 'The Tenant shall give the Landlord not less than six (6) months’ written notice of its intention to renew prior to expiry.' },
    { cls: 'dp-h', text: '18. Liability' },
    { text: '18.1 The Landlord’s aggregate liability under this Lease shall not exceed €250,000.' },
    { text: '18.2 Nothing in this clause limits liability for death or personal injury caused by negligence.' },
  ];
  // The highlight a drag makes: from "not less", the typed words it begins with, to the clause's end.
  const DRAG_FROM = 6;
  const HINT_EMPTY = 'Highlight the words to insert';
  const HINT_PICKED = 'Tab inserts the highlighted words · Esc goes back';
  const CITATION = '(lease_unit4_signed.pdf, page 1)';

  function build() {
    const root = document.createElement('div');
    root.className = 'demo-picker';
    root.innerHTML = `
      <div class="dp-head">
        <span class="ficon" style="--ft:#d1453b"><i>PDF</i></span>
        <div class="dp-names"><b>lease_unit4_signed.pdf</b><small class="dp-hint"></small></div>
        <span class="dp-close" aria-hidden="true">×</span>
      </div>
      <div class="dp-body"><div class="dp-page"></div></div>
      <div class="dp-foot">
        <span class="dp-btn dp-insert"><kbd>⇥</kbd>Insert</span>
        <span class="dp-btn dp-link">Insert Link</span>
        <span class="dp-src"><span>Insert with source</span><small class="dp-cite"></small></span>
        <i class="dp-toggle"></i>
      </div>
      <svg class="dp-pointer" viewBox="0 0 20 26" aria-hidden="true"><path d="M2 1.5v19.2l4.6-4.4 3 7.2 3.4-1.4-3-7h6.4z"/></svg>`;
    const page = root.querySelector('.dp-page');
    const words = [];
    for (const line of PAGE) {
      const p = document.createElement('p');
      if (line.cls) p.className = line.cls;
      p.append(line.text);
      if (line.clause) {
        const clauseWords = line.clause.split(' ');
        clauseWords.forEach((word, i) => {
          const span = document.createElement('span');
          span.textContent = word;
          p.append(span, i < clauseWords.length - 1 ? ' ' : '');
          words.push(span);
        });
      }
      page.append(p);
    }
    return { root, words };
  }

  function mount(scene) {
    const { root, words } = build();
    scene.append(root);
    const hint = root.querySelector('.dp-hint');
    const cite = root.querySelector('.dp-cite');
    const toggle = root.querySelector('.dp-toggle');
    const insertBtn = root.querySelector('.dp-insert');
    const pointer = root.querySelector('.dp-pointer');

    const mark = (from, to) => words.forEach((w, i) => w.classList.toggle('on', i >= from && i <= to));
    const picked = (yes) => {
      hint.textContent = yes ? HINT_PICKED : HINT_EMPTY;
      cite.textContent = yes ? CITATION : '';
      insertBtn.classList.toggle('off', !yes);
    };
    // The pointer is placed in the picker's own points, at a word's start or end.
    const pointAt = (el, end = false) => {
      const box = root.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const k = box.width / root.offsetWidth || 1;
      pointer.style.left = `${((end ? r.right : r.left) - box.left) / k}px`;
      pointer.style.top = `${(r.top + r.height * 0.55 - box.top) / k}px`;
    };

    return {
      // The picker opens on the page with the passage the suggestion cited already highlighted.
      open() {
        mark(0, words.length - 1);
        picked(true);
        toggle.classList.remove('on');
        cite.classList.remove('on');
        pointer.classList.remove('on');
        root.classList.add('on');
      },
      // A drag from "not" highlights the words it passes over, one at a time.
      async drag(wait) {
        pointAt(words[DRAG_FROM]);
        pointer.classList.add('on');
        await wait(420);
        mark(-1, -2);
        picked(false);
        for (let i = DRAG_FROM; i < words.length; i++) {
          mark(DRAG_FROM, i);
          if (i === DRAG_FROM) picked(true);
          pointAt(words[i], true);
          await wait(85);
        }
      },
      // A click on the switch puts the file and page after the words.
      async citeSource(wait) {
        const box = root.getBoundingClientRect(), r = toggle.getBoundingClientRect();
        const k = box.width / root.offsetWidth || 1;
        pointer.style.left = `${(r.left + r.width * 0.6 - box.left) / k}px`;
        pointer.style.top = `${(r.top + r.height * 0.5 - box.top) / k}px`;
        await wait(520);
        toggle.classList.add('on');
        cite.classList.add('on');
      },
      pressInsert() {
        pointer.classList.remove('on');
        insertBtn.classList.remove('press'); void insertBtn.offsetWidth; insertBtn.classList.add('press');
      },
      close() { root.classList.remove('on'); pointer.classList.remove('on'); },
      // What Tab puts after the typed words: the rest of the highlight, then its citation.
      inserted: (rest) => `${rest} ${CITATION}`,
    };
  }

  window.LassoFilmPicker = { mount };
})();
