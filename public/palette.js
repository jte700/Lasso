// Command palette.
//
// One fuzzy field over everything the workspace can do: open a document, switch
// project, change theme, change identity. It is the only navigation surface, so
// it opens on the first keystroke and remembers nothing the user did not ask it
// to remember.

const ROWS = 8;

/// Subsequence match with a bias toward word starts and dense runs.
function score(query, text) {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  let total = 0;
  let streak = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, index);
    if (found === -1) return -1;
    const startsWord = found === 0 || /[\s/._·-]/.test(haystack[found - 1]);
    streak = found === index ? streak + 1 : 0;
    total += 10 + streak * 6 + (startsWord ? 8 : 0) - Math.min(found - index, 12);
    index = found + 1;
  }
  return total - haystack.length * 0.05;
}

export function createCommandPalette({ getCommands, onStatus }) {
  const host = document.createElement('div');
  host.className = 'cmd-palette';
  host.hidden = true;
  host.innerHTML = `
    <div class="cmd-box" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="t-cap" aria-hidden="true"><span>┌─ palette </span><span class="t-hfill"></span><span>┐</span></div>
      <label class="cmd-input-row">
        <span class="cmd-prompt" aria-hidden="true">❯</span>
        <input id="cmd-input" type="text" autocomplete="off" spellcheck="false"
               aria-label="Run a command" placeholder="open a document, switch project, change theme…" />
      </label>
      <div class="t-cap" aria-hidden="true"><span>├</span><span class="t-hfill"></span><span>┤</span></div>
      <div class="cmd-list" id="cmd-list" role="listbox"></div>
      <div class="t-cap" aria-hidden="true"><span>├</span><span class="t-hfill"></span><span>┤</span></div>
      <div class="cmd-hints"><span><kbd>↑↓</kbd> select</span><span><kbd>⏎</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
      <div class="t-cap" aria-hidden="true"><span>└</span><span class="t-hfill"></span><span>┘</span></div>
    </div>`;
  document.body.append(host);

  const input = host.querySelector('#cmd-input');
  const list = host.querySelector('#cmd-list');
  let commands = [];
  let matches = [];
  let selected = 0;

  function render() {
    const query = input.value.trim();
    matches = commands
      .map((command) => ({ command, rank: query ? score(query, `${command.title} ${command.hint ?? ''}`) : 0 }))
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => right.rank - left.rank)
      .slice(0, ROWS * 3)
      .map((entry) => entry.command);
    selected = Math.min(selected, Math.max(0, matches.length - 1));

    if (!matches.length) {
      list.innerHTML = '<p class="cmd-empty">No matching command.</p>';
      return;
    }
    list.innerHTML = matches.map((command, index) => `
      <button class="cmd-row ${index === selected ? 'selected' : ''}" role="option"
              aria-selected="${index === selected}" data-index="${index}">
        <span class="cmd-marker" aria-hidden="true">${index === selected ? '›' : ' '}</span>
        <span class="cmd-title">${escapeHtml(command.title)}</span>
        <span class="cmd-hint">${escapeHtml(command.hint ?? '')}</span>
      </button>`).join('');
    list.querySelectorAll('[data-index]').forEach((row) => {
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        selected = Number(row.dataset.index);
        run();
      });
    });
    list.querySelector('.cmd-row.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  }

  function move(delta) {
    if (!matches.length) return;
    selected = (selected + delta + matches.length) % matches.length;
    render();
  }

  async function run() {
    const command = matches[selected];
    if (!command) return;
    close();
    try {
      await command.run();
    } catch (error) {
      onStatus?.(error.message ?? 'That command failed.');
    }
  }

  function open(seed = '') {
    commands = getCommands();
    input.value = seed;
    selected = 0;
    host.hidden = false;
    render();
    input.focus();
  }

  function close() {
    host.hidden = true;
    input.value = '';
  }

  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); run(); }
    else if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  host.addEventListener('mousedown', (event) => { if (event.target === host) close(); });

  return {
    open,
    close,
    toggle() { host.hidden ? open() : close(); },
    get isOpen() { return !host.hidden; },
  };
}
