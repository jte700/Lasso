# Lasso predictive provenance

A local-first implementation of **predictive provenance**: it indexes a real project directory, completes scientific writing from that corpus, and links every claim to the exact source it came from. Versioning runs underneath so links stay immutable and go stale when their source changes.

No language model generates the suggestions, the source links, or the recorded evidence.

## Run

Requirements: Node.js 24 or newer. There are no third-party runtime dependencies.

```bash
npm start
```

Open `http://127.0.0.1:4317`, enter an absolute local directory path, and create Version 1. History is stored in `.lasso-data` by default, never inside a selected project unless that directory is explicitly configured as the data directory.

Set `LASSO_DATA_DIR` to move the database and blob store. Set `LASSO_WATCH_DEBOUNCE_MS` to change the default 2.5-second watcher batching window.
An existing `.colab-dry-data` directory is still used when `.lasso-data` does not exist, so upgrading does not start an empty history.

## macOS app

```bash
npm run desktop
```

This builds `dist/Lasso.app`: a status bar application that supervises the
same local server as a background child process and shows the workspace in a
native window. There is no Dock icon — the app lives in the menu bar.

- left-click the menu bar icon to show or hide the workspace; closing the window
  leaves the server running
- right-click it for `Open in Browser`, `Reload`, `Restart Server`,
  `Reveal Server Log`, and `Quit`
- the server listens on an unused loopback port, so it never collides with
  `npm start`
- app history lives in `~/Library/Application Support/Lasso/data`; upgrades migrate
  the former app directory, and new installs can seed from `.colab-dry-data`
- the server log is at `~/Library/Logs/Lasso/server.log`
- Node 24+ must be installed; set `LASSO_NODE` to override which binary is used

Move it to `/Applications` to keep it, and add it to Login Items to have it
start automatically.

### Suggestions while typing anywhere

The menu bar item has **Suggest While Typing Anywhere**. When enabled, Lasso
watches typing in any application, reads the text just before the caret, and
draws a two-pane source card beside the cursor:

```text
┌─ matching sources ─────────┬─ document preview ─────────────┐
│ › Supplies            $400 │ Income-Statement.xlsx           │
│   Prior period        $384 │ [nearby rows, cited cell marked]│
├────────────────────────────┼─────────────────────────────────┤
│ ⇥ Insert  ⌘↩ Link  ↑↓ Esc │ ↗ Open source        □↑ Share   │
└────────────────────────────┴─────────────────────────────────┘
```

`Tab` inserts the value into whatever app is focused; `⌘↩` links the same
selection locally without publishing it. **Share** opens the privacy composer before any public token is created. Arrow keys change the selection and its live preview.
Suggestions come from the project selected in the Lasso window.

When a source-backed suggestion is accepted as plain text, the host application
still contains ordinary text. Lasso stores the source identity and a contextual
text anchor locally, then draws its own restrained wash and underline in a
transparent AppKit layer above the host. The anchor follows edits and is hidden
if it cannot be relocated confidently. Clicking the local highlight opens the
draggable source inspector; **Open source** resolves the exact indexed object and
version. None of this decoration or source metadata is added to the Gmail message
or made visible to its recipient.

The right pane previews the selected indexed document without leaving the host
application. Spreadsheet sources show nearby rows, column letters, row numbers,
and a green outline around the matched cell. Other document types show their
indexed excerpt and exact location. **Open source** resolves the immutable source
version, while **Share** asks whether to publish the whole document, only the indexed part, or a selectively redacted view.

This needs two permissions, both requested from the menu item and revocable in
System Settings → Privacy & Security:

- **Accessibility** — to read the text around the caret and insert the accepted value
- **Input Monitoring** — to know when you are typing and to capture `Tab`/arrows/`Esc`

Only the ~1200 characters before the caret are read, they are sent to
`127.0.0.1` and never stored, and password fields are skipped. Caret placement
relies on each app exposing its text through the Accessibility API: native
Cocoa apps and Word behave well, Chrome needs its accessibility tree enabled,
and apps that expose nothing fall back to positioning near the pointer.

Because the app is signed ad-hoc and has a new app identifier, macOS may ask
for Accessibility and Input Monitoring permissions again after rebuilding.

### Sharing a dependency outside the app

Inserting a suggestion never publishes anything. Sharing is a separate, explicit
action:

- `Tab` — insert the dependency as plain text. No token, no link.
- `⌘⏎` — link it locally to its indexed source without publishing.
- **Share** (or `⇧⌘⏎`) — choose the public access boundary, then create a hyperlink-backed share.

The menu bar has a **Dependency insertion** preference controlling what `Tab`
does — `Plain text by default` (the default), `Ask before sharing`, or
`Share link by default`. A public share always presents the privacy composer first.

A share can publish the **entire document**, the **indexed part only**, or a **selectively redacted view**. In selective mode, Lasso opens the complete logical document: scroll every row or text section, switch among workbook sheets, and drag across cells or sections to Blur or Blank them. Masked values are replaced before rendering and restricted scopes never permit the original download.

A shared insertion creates a record and pastes `<a href="…/d/TOKEN">label</a>`,
so only the label is clickable and the URL is never shown. Tokens are 192 bits
of CSPRNG output encoded URL-safe; internal identifiers are never used as public
ones. The grant pins the object *version*, so a recipient always sees the source
as it was when shared even if the workbook changes afterwards.

Recipients get two routes:

- `GET /d/:token` — provenance page: label, value, workbook, sheet, cell,
  context, version and share date, with the cited row highlighted
- `GET /d/:token/download` — the original file as an attachment only for whole-document shares; indexed and redacted tokens receive `403`

Unknown, revoked and expired tokens are refused with distinct messages and never
reveal whether other tokens exist. Revocation sets `revoked_at` rather than
deleting, and takes effect immediately:

```bash
curl -X POST http://localhost:4319/api/object-shares/TOKEN/revoke
```

The link base is configurable with `SHARE_BASE_URL`, so the same share records
can later be served from a hosted origin without touching the share system. The
app claims port 4319 when it is free so links keep resolving across restarts.

If the hyperlink cannot be inserted, the share is revoked and the overlay says
so — the app never reports something as shared when the document only received
plain text.

#### Manual end-to-end check

1. Start the app and enable **Suggest While Typing Anywhere**.
2. Open Gmail in Chrome and compose a message.
3. Type `The expected cost of office sup` and wait for the overlay.
4. Press `Tab`; confirm Lasso draws a local underline/wash over the accepted text.
5. Click that local highlight; confirm the draggable inspector shows the exact source.
6. Choose **Open source**; confirm the indexed object/version opens.
7. Inspect Gmail's content or open the draft without Lasso; it is still plain text with no link.
8. Delete it, retype the trigger, and press `⌘⏎`.
9. Confirm only the label is now a real Gmail hyperlink.
10. Send the message to another account and open it on this Mac.
11. Click the link; the localhost page opens with the provenance shown.
12. Click **Download original**; the workbook downloads and opens.
13. Revoke the share, reload the page, and confirm access is refused.

### The terminal

The window's resting state is a shell over the workspace's dependency graph.
The document editor is where dependencies are created and used; the terminal is
where they are searched, inspected, traced, debugged and managed. It answers
four questions and nothing else:

```text
WHERE did this come from?      find · trace · history · ask
WHAT depends on this?          impact · shares
WHAT changed?                  changes · stale
WHAT should I do about it?     update · unlink
Manage the system              index · conflicts · alias · aliases · unalias · rules
```

```text
> changes --since yesterday

2 dependency values changed

depreciation-direct                          Aug 21, 2026, 4:33 PM
  612 → 684
  Income-Statement.xlsx · Accounting!B17
  2 references affected · 2 not yet updated

> impact depreciation-direct

2 affected references

manuscript/accounting.md
  block 1
  "The expected depreciation value is 612."
  source value  684
  status        stale

[Enter] inspect   [u] update affected   [s] show source
```

Every command reads the same tables the editor reads — indexed objects, their
immutable versions, claim dependencies and share grants. There is no second
dependency graph, so a dependency inserted in the editor is immediately
traceable, an alias created here is recognised by the editor's autocomplete,
and a dependency the terminal calls stale is the same one the editor marks.

Names are derived from the source location the indexer already recorded: a
row-oriented workbook cell takes the row's name (`office-supplies` for
`Accounting!B21`) and any further column is qualified (`office-supplies-prior-period`).
When a name genuinely belongs to several sources, the terminal reports every
candidate and refuses to choose — `conflicts <name>` compares them and `alias`
pins one:

```bash
alias q3-revenue Finance/Q3/model.xlsx:Summary!B17
```

A claim is identified by the text around it, not by its wording alone. Editing
the paragraph a claim sits in keeps it anchored, and the claim follows its
paragraph when that moves. Deleting the claim retires the link: the text is
gone, so the link to it is too. It is never reattached to the next sentence
that happens to repeat the same word, and two equally plausible homes are
refused rather than chosen between.

Retirement is a recorded revision, not a deletion — the version chain keeps
the whole history — but it is one-way: retyping the sentence does not restore
the link, because relinking is an explicit act. `unlink <dependency>` retires
every reference to one source on request, and `unlink --unresolved` clears any
that were left behind.

`update` never writes on its own. `update <dependency>` prints the exact text
each document would receive; `--apply` performs it and relinks the references;
`--keep` records that the current wording is intended.

`ask` is a constrained query mode, not a chat window. It maps a question to one
graph query and prints the source behind the answer; a question no indexed
source supports is refused rather than answered.

Typing draws the same completion box the writing overlay uses, above the
prompt, listing each candidate with its value and its exact source location:

```text
┌─ dependency ───────────────────────────────────────────────────────────┐
│ › office-supplies             438   Income-Statement.csv · row 3 · Cu…  │
│   office-supplies-prior-per…  310   Income-Statement.csv · row 3 · Pr…  │
│   office-supplies-row               Income-Statement.csv · row 3        │
├─────────────────────────────────────────────────────────────────────────┤
│ Tab accept   ↑↓ select   Esc close                                      │
└─────────────────────────────────────────────────────────────────────────┘
```

It completes whatever the command's next word is, and says which that is:
command names, subcommands, flag names, and then — from the index itself —
dependency names, source files, directories, source addresses, file types and
time windows.

```text
> find Income

┌─ source or dependency ──────────────────────────────────────────────────┐
│ › Income-Statement-Template.xls        211 indexed                      │
│   income-tax-expense           5200    Income-Statement-Template.xls …  │
│   income-tax-expense-prior-p…  3200    …xls · Accounting!D57            │
└─────────────────────────────────────────────────────────────────────────┘

> find revenue --directory Fin      → Finance, Finance/Q3
> changes --since                   → yesterday, today, 24h, 7d, 30d
> index remove Arch                 → Archive
> alias q3-revenue model            → Finance/Q3/model.xlsx:Summary!B17
```

Files come first, because a file is usually named after what it holds and is
the most direct handle a source has. Naming one scopes the command to it, so
`find Income-Statement.xlsx` returns what that workbook contributed rather than
everything sharing its directory. When nothing *starts* with what was typed,
the box falls back to what the index considers related and says so, so
`trace supplies` still finds `office-supplies` rather than showing an empty box.

Keys: `Tab` completes — again on an unchanged line to reopen the box — `↑ ↓`
move through the completion box while it is open, then the current result set,
then command history; `Enter` takes a chosen completion, otherwise runs or
inspects; `Esc` steps back out of each in turn; `Ctrl+L` clears; `?` is help.
Highlighting a result shows a few rows of its source, so deciding whether a
match is the right one never means opening Excel.

The command layer lives in `src/terminal/` — `TerminalCommandRegistry`,
`TerminalCommandParser`, `TerminalCommandExecutor`, one module per command, and
a `DependencyGraph` read view over the existing services. Commands return
structured results; the terminal view decides how to draw them.

### The interface

Lasso is a terminal workspace: macOS window chrome, a dense tab strip, a
sidebar of directories the user has granted access to, a hairline divider, and a
terminal panel filling the rest. There is no second, graphical interface.

The sidebar lists **accessible directories** — each row is a granted folder with
its name, a status dot, and its path or branch. Selecting one changes the active
workspace: the tab strip refills with that directory's documents (`⌘1`…`⌘9`), the
terminal shows what was indexed, and the status line follows. The divider drags
between 210px and 420px and remembers where it was left.

Shell pieces are separate modules — `WindowChrome`, `TabBar`, `DirectorySidebar`,
`DirectoryRow`, `SidebarResizeHandle`, `TerminalWorkspace`, `TerminalOutput`,
`TerminalInput`, `TerminalStatusBar` — implemented in plain modules, since the
project carries no runtime dependencies and is packaged into a native WKWebView.

Colour is spent through **eight roles** — a background, a foreground, a dim, an
accent and four states — so a theme is eight declarations rather than a
restyling. Four ship today:

| Theme | Character |
|---|---|
| `carbon` | warm near-black, bone text, amber accent (default) |
| `slate` | cool grey with a blue accent |
| `palenight` | indigo with a violet accent |
| `alabaster` | light, warm paper |

Press `⌘K` (or `⌘⇧P`) for the command palette — one fuzzy field over opening a
document, switching project, changing theme or identity, and reindexing. It is
the app's navigation surface.

Type is JetBrains Mono when it is installed, falling back to the platform's own
terminal faces.

## Verify

```bash
npm test
```

The acceptance suite uses actual temporary directories and covers initial import, human and collaborator edits, sentence-level and semantic-equivalent project-language completion, dependency autocomplete and manual overrides, reference ambiguity, equivalent fold-change values, exact code origins, stable claim anchors, staleness, RFI traversal, renames, conflicts, and restart persistence. The terminal suite covers each
command family against a real indexed workspace: search filters and ambiguous
names, exact provenance, downstream references, change and staleness detection,
chronological history, alias resolution, share listing and revocation, index
status and exclusions, rule evaluation, and `ask` refusing to answer what no
source supports.

## What is implemented

- a single event path for imports, watcher reconciliation, explicit checkpoints, collaborators, and agent edits
- explicit `HUMAN_SELF`, `HUMAN_COLLABORATOR`, `AI_AGENT`, and `SYSTEM` attribution
- debounced in-session directory watching plus open-time reconciliation
- rename/move recognition using file identity first and unique content identity second
- version-pinned Markdown, code, table, JSON, and notebook preview anchors
- an in-product Markdown manuscript editor with headings, paragraphs, compact audit coverage, and versioned saves
- source-backed predictive dependencies that can complete semantically equivalent scientific sentences from versioned Markdown, text, DOCX, locally extractable PDF content/metadata, and reference records; `Tab` completes the claim and links its canonical project source in one action
- deterministic claim detection and scientific-object indexing for results, datasets, CSV/TSV and spreadsheet artifacts, code symbols/lines, methods, notebook cells, figures, JSON values, papers, BibTeX/RIS/EndNote/NBIB references, and analysis runs
- local PDF metadata/text and DOCX OOXML extraction, so opaque filenames remain searchable by embedded author, title, year, DOI, keywords, and document text
- one project-local prediction surface for both continuations and already-written claims, with canonical source details, `Tab` acceptance, arrow-key alternatives, `Esc`, and a searchable **More sources** picker
- partial narrative citations are completed from paper metadata before linking, so `The paper by Moha` becomes a full citation such as `The paper by Mohammad et al. (2021)` and the dependency anchors the completed citation
- accepted paper citations establish a local writing context: attribution phrases such as `the authors found that` open a ranked list of findings extracted only from that paper, and accepting a finding inserts it and records another dependency to the same immutable source
- dependency acceptance is immediate and local in the editor; content and selected sources are committed together by a non-blocking five-minute autosave, without reopening the manuscript or interrupting typing
- variable-aware result linking reads CSV and XLSX data dictionaries, enriches result cells with their definitions, and falls back to inferred column meaning, type, range, and sample values when no dictionary exists
- exact value, signed-percent/fold-change, author/year, entity, type, section-context, provenance, and version-aware deterministic ranking
- shared project-scoped file recommendations across search, source library, autocomplete and writing suggestions, with protected direct matches, document relationships, capped local usage preferences, file diversity and short ranking explanations
- `Cmd/Ctrl + Shift + L` manual linking for selected manuscript text
- immutable, anchor-migrating `ClaimDependency` versions connected to the Scientific State Graph with `DEPENDS_ON`
- linked-source inspection, code-line navigation through recorded provenance, RFI from manuscript spans, and explicit unlinked behavior
- upstream change detection with `STALE`, `BROKEN`, and `NEEDS_REVIEW` states; manuscript text is never silently rewritten
- immutable content-addressed snapshots underneath, so every link keeps its exact source version
- a terminal interface drawn on a character grid with Unicode box-drawing frames, docked panes, and keyboard hints — the only interface the app has
- a dependency terminal over the same graph: search with provenance, provenance tracing, impact analysis, change and staleness detection, value history, index controls, share management, conflict resolution and aliases, source-backed natural-language queries, deterministic rules, and explicit reference updates
- a native macOS status bar application that runs the local server in the background

See [docs/scientific-timeline.md](docs/scientific-timeline.md) for timeline architecture, [docs/predictive-provenance-editor.md](docs/predictive-provenance-editor.md) for the editor design, and [HUMAN_INPUT.md](HUMAN_INPUT.md) for product/integration decisions that need an owner.
