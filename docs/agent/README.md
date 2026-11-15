# Lasso for AI agents

AI agents can read the user's Lasso library through two on-demand interfaces:

- an **MCP server over stdio** (`lasso-agent mcp`), which an AI host starts when it connects and which exits when the host disconnects;
- a **local REST API** (`lasso-agent serve` / `ensure`), started on demand on loopback with a bearer token. It stops itself once idle and no client holds a lease.

Both call the same **evidence service** (`src/agent/evidence.js`), which reads the same snapshots, object versions, blob store and search graph the editor and terminal use. For searching documents it keeps one derived full-text index beside the library (`derived/agent-text.sqlite`, [described below](#questions-about-documents-retrieval-uncertainty-and-evaluation)), filled from the object versions the app already records. Nothing else is added, and nothing runs permanently for the integration.

Agents ask in plain words, all of a task's questions in one call: `lasso` with `ask: ["app.py lines 5-12", "Q3 revenue for the North region", …]`. Each ask is resolved on the server to the evidence that answers it: exact lines, a whole definition, a table row's named fields, a column's total, the sentences and table rows that answer a question (with their section and page), an earlier value, or a statement that this search found nothing. Every answer says what it is: `complete` (a lookup, or a computation over every row), `ranked` (a search's selection, never all there is), `partial`, `ambiguous` or `not_found`. Where files disagree, every source is shown and none is chosen.

The measurements:

- **Live, provider-recorded** ([live runs](#live-model-runs-provider-recorded)). OpenAI models choose their own steps; every model call's usage is recorded. Lasso's first release was ignored by the models and, when they were told to use it, cost more tokens. Four measured iterations ([v1 → v4](#making-models-use-lasso-and-spend-less-v1--v4)) changed that. With the current server, gpt-5.4-mini used Lasso on **32 of 32 tasks** and spent **69% fewer tokens** than with file tools alone (code −15%, documents −80%; the median task −18%), at 45% lower cost. It answered all 32 correctly, against 29 with file tools, and answered the revision questions the file tools cannot. A first run of the document, writing, 3D and large-file tasks ([by kind of file](#live-results-by-kind-of-file-gpt-54-mini-30-october-2026)) found Lasso spending 83% fewer tokens than file tools on STEP assemblies, 98% fewer on a 5,000-row workbook (where it alone answered every question) and 84% fewer on a 40-page PDF. On 8–9-page reports it saved nothing, and attaching them was cheaper and more often right.
- **Offline, scripted** ([benchmark-results.md](benchmark-results.md), `node scripts/agent-benchmark.mjs --runs 5`). Fixed, competent call sequences, with tool definitions charged at their measured real size and everything else estimated. The current server saves 20% of tokens against a direct-tools policy that already reads exactly what it needs (code 13%, documents 27%), with half the evidence and one round per task. It was correct on every task.
- **Writing tasks, offline** ([writing-results.md](writing-results.md), `node scripts/agent-writing-benchmark.mjs`). Twelve requests such as "email the leadership team our Q4 revenue" over spreadsheets, PDF and Word reports, STEP parts and an IFC building model. Lasso's first answers gave a model everything its draft needed on 2 of 24 ask sets; after the changes [described below](#writing-tasks-spreadsheets-reports-and-3d-models), on 19 of 24 asks written afterwards and never tuned on, in about 240 tokens an answer.
- **Questions about documents, offline** ([below](#questions-about-documents-retrieval-uncertainty-and-evaluation), `node scripts/agent-eval/run.mjs`). Study reports, memos, workbooks and notes, with tasks such as "what were the trial's main findings?". Each response is graded on whether it holds every fact a correct answer needs, with that fact's qualifications and both sides of any disagreement. On two sets written independently and run once at the end, one call's response was enough for 14 of 32 and 29 of 36 ask sets, against 8 and 11 before the retrieval changes. The responses grew too: a median 699 and 1,009 tokens, from 514 and 333, against about 3,500 for the documents that state the facts. Summaries remain the weak spot, at 4 of 20 ask sets.

The savings come from fewer model calls: each call re-sends the host's prompt, the tool definitions and everything said so far, so answering in one call what took a search and a read removes most of a task's cost ([the cost model](#the-cost-model-refined-from-the-live-traces)). On a small read of a file the request already names, both take one call, and Lasso's 149-token definition makes it slightly dearer. Live runs were made on OpenAI models only; see [What the benchmark does not show](#what-the-benchmark-does-not-show).

---

## Quick start

The agent reads the library the desktop app keeps (`~/Library/Application Support/Lasso/data` on macOS, or `LASSO_DATA_DIR`). Folders must be added in Lasso first. **An agent sees only the folders you name with `--scope`** (a folder's name as Lasso shows it, its root path, or `"*"` for every enabled folder).

The first agent run applies migration 026 (two small tables, `agent_evidence` and `agent_bindings`) to the library.

### MCP (Claude Desktop, Claude Code, other MCP hosts)

From a checkout:

```json
{
  "mcpServers": {
    "lasso": {
      "command": "node",
      "args": ["/path/to/CoLabDry/src/agent/cli.js", "mcp", "--scope", "Finance", "--scope", "App"]
    }
  }
}
```

From an installed Lasso.app built with this code (`desktop/build.sh` copies `src/` into the bundle):

```json
{
  "mcpServers": {
    "lasso": {
      "command": "/Applications/Lasso.app/Contents/MacOS/node",
      "args": ["/Applications/Lasso.app/Contents/Resources/app/src/agent/cli.js", "mcp", "--scope", "Finance"]
    }
  }
}
```

With Claude Code:

```bash
claude mcp add lasso -- node /path/to/CoLabDry/src/agent/cli.js mcp --scope Finance
```

The server offers one tool, `lasso`, which takes every question of a task in one call and answers each from the index: exact lines, a whole definition, a table row's fields, a column's total, the sentences that answer a question, an earlier value. v4's definition and instructions measured 149 real tokens per model call; the current wording, which no longer says answers need no re-check and names part placements, measures 173 (gpt-5.4-mini, 30 October 2026). `--tools lasso,search,read,cite` also offers the earlier search, read and cite tools.

### REST

```bash
node src/agent/cli.js ensure --scope Finance --idle 300
```

`ensure` prints `{"url","token","pid","started"}`. It reuses a server already running for the library; otherwise it starts one in the background.

```bash
curl -s "$URL/agent/v1/ask" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"ask":["App/app.py lines 5-12","North division revenue in the approved budget"]}'
```

`/agent/v1/suggest`, `/inspect` and `/bind` take the structured requests described under [Tool contracts](#tool-contracts).

`node src/agent/cli.js status` reports whether a server is running; `stop` stops it.

### Node

```js
import { openLocal, connect } from './src/agent/client.js';

const lasso = openLocal({ scope: ['Finance'] });          // in-process: no port, no token
const shared = await connect({ scope: ['Finance'] });     // the REST server, started if needed, held by a lease
await shared.close();                                     // releases the lease; the server stops once idle
```

---

## Repository audit (verified findings)

What the integration builds on, as found in the code:

| Concern | Where | What it does |
|---|---|---|
| Runtime | Node ≥ 24 ESM, `node:sqlite`, no framework (`package.json`) | `src/server.js` `createApplication` wires every service; the macOS app (`desktop/Lasso.swift`) spawns it with `LASSO_DESKTOP_NONCE`, a stdin shutdown channel and `parent-watchdog.js`. |
| Storage | `src/db.js` | One SQLite store in WAL mode with `busy_timeout = 5000`; numbered migrations in `migrations/`. File bytes are content-addressed in `history/blob-store.js`. |
| Discovery and versions | `history/scanner.js`, `history/service.js` (`TimelineService.capture`), `history/snapshot-store.js` | Each capture writes an immutable snapshot of `snapshot_files` (path, content hash, size, mtime), carried forward from a base. |
| Extraction | `dependencies/service.js` `objectsFromFile`, `document-extraction.js`, `table-index.js`, `text-store.js` | Files become typed objects (passages, table rows and cells, code lines, drawing parts) recorded per snapshot in `scientific_object_versions` (`history/object-versions.js`). Tables over 5 MB keep their rows in a separate row-name index (`derived/tables.sqlite`) and become objects only when offered. |
| Search and ranking | `terminal/graph.js` `DependencyGraph.search`; `dependencies/ranking.js` `RecommendationRanking` | Exact name, identifier, value and prefix matches first, then term relevance; usage boost within a relevance band. The popup's 0.4 cutoff and top-8 list are UI policies in `predict`. |
| Exact code lines | `dependencies/code-lines.js` (`fileLines`, `codeOfLines`), `service.js` `linesFromCode` | "app.py lines 5-12" reads lines 5 to 12 inclusive from the file's blob at the current snapshot and inserts them with the shared indentation removed (an insertion format, so the agent path returns exact lines instead). |
| Name resolution | `terminal/graph.js` `resolve` | Never picks between equally ranked candidates. |
| Security | `http/request-guard.js` | Loopback Host and same-origin checks; no authentication, so any local process may call the app's API. Code files are never shareable. |
| Tests | `node --test`, 90+ files in `test/` | Integration tests build a real library with `createApplication` in a temporary folder. |

Things that shaped the design:

- The app's server holds per-snapshot caches and assumes it is the only process that adds objects to a snapshot. A second process must not add them. `RemovableDriveService`'s constructor resets drive state, so the agent engine cannot simply call `createApplication`.
- On the author's machine the library is about 2 GB, and whole-history reads are disk-bound. The agent path therefore answers from each folder's newest indexed snapshot and never triggers indexing.

---

## Architecture

```
local files → Lasso app (scanner, capture, extraction, index; unchanged)
                     ↓ same SQLite store + blob store + derived indexes
          src/agent/engine.js   opens the store: no HTTP server, no watchers, no connector sync, drive state untouched
                     ↓
          src/agent/ask.js      reads a plain-language ask: files, line ranges, names, revision, disk, history
                     ↓
          src/agent/evidence.js EvidenceService: ask / suggest / inspect / bind  ← src/agent/scope.js authorization
                     ↓                                      ↓
   src/agent/mcp.js (stdio JSON-RPC)        src/agent/rest.js (loopback HTTP, bearer token)
                     ↓                                      ↓
           AI hosts (Claude, …)                scripts, apps, custom agents (src/agent/client.js)
```

### Lifecycle

| | MCP | REST |
|---|---|---|
| Starts | The host spawns `lasso-agent mcp` | `ensure`/`connect` spawns `lasso-agent serve` detached, if no healthy server for the library is recorded in `<data>/agent/rest.json` |
| Concurrency | One process per host connection (stdio is one client) | One server per library (`rest.lock`); any number of clients; each may hold a renewable **lease** |
| Stops | stdin EOF or SIGTERM: closes the store and exits (exit code 0; measured ~5 ms after disconnect) | Idle: no request in flight, no live lease, and `--idle` seconds since the last request. Also `POST /agent/v1/shutdown`, refused while another client holds a lease unless `force` |
| Leaves behind | Nothing | Nothing: removes `rest.json` and `rest.lock` |

The desktop app may run at the same time. Both read the store in WAL mode. The agent's only writes to the store are handle and binding rows, in short transactions; if the store is busy, handles stay in memory and the response says so. Its search index is a separate file that the app never opens.

---

## Tool contracts

Every piece of evidence has a 10-character handle that names one immutable thing: an object version, a line range of one file revision, or a cell of a large table's revision. File details are given once per answer, as sources `s1`, `s2`…, and candidates point at them.

**Formats.** The service returns the JSON shown below, and that is the contract; REST answers in it by default. Over MCP a model receives the same answer as compact text (`src/agent/render.js`), which measured 26–27% fewer real tokens. Values stay JSON-quoted so their exact characters survive, and file text is fenced exactly as the file has it. Pass `format: "json"` (MCP) or `"format": "text"` (REST) to get the other. Over MCP the `lasso` tool's answers are also written lean ([below](#lean-answers-over-mcp-11-november-2026)): no handles unless a tool offered can take one, revisions cut to eight characters, excerpts as the file's words without quotes. REST's text is unchanged. The same search as text:

```
s1 = Finance/Planning/budget.csv @dd459a8353ec
s2 = Finance/Approved/budget.csv @a1adad958009
g1: 2 of 6; 2 exact; more: cursor "K6ST.FNTD.2"
- s2 record "North division" row 2: Revenue="11.9" #6BVEWRTB04, Scenario="Approved" #C0XAHZQPX8 (exact name)
- s1 record "North division" row 2: Revenue="12.4" #ACZK1G04AR, Scenario="Planning" #9HQZ5XW75Z (exact name)
```

**Forgiving where it costs nothing.** Tuning numbers (`limit`, `budget`, `context`) out of range are brought into range rather than refused. A citation style other than `"none"` gives numbered citations. A handle copied with its `#` is accepted. `folder: "."` means every folder, and `"Finance/Approved"` means the Finance folder under `Approved`. Identity inputs (file, revision, handle) stay strict. In live runs, refusing a model's `budget: 150` had cost it a whole turn and sent it back to grep; such refusals were 22 of the 31 failed calls across the two v2 arms.

### `lasso` / `POST /agent/v1/ask`

Every question of a task, in plain words, answered in one call. Strings are read by `src/agent/ask.js`; an enumerated string ("(a) … (b) …") is split into its parts. Objects are structured follow-ups: `{h}`, `{h, history: true}`, `{file, lines}`, `{symbol}`, or an explicit search `{text, fields}`.

```json
{ "ask": ["Api/app.py lines 5-8", "the approved North division revenue", "North division revenue", "West division revenue"] }
```

As text over MCP (from the test fixture):

````
s1 = Api/app.py @83757353
s2 = Finance/Approved/budget.csv @a1adad95
s3 = Finance/Planning/budget.csv @c0cee90b
[1] s1 lines 5-8 of 19
```
def handle(request):
    """Return every item."""
    items = load()
    return json.dumps(items)
```
[2] s2 "North division" row 2: Revenue="11.9" (matches "approved")
  other source: s3 "North division" row 2: Revenue="12.4"
[3] 2 sources differ; which is meant is not settled by the files:
  - s2 "North division" row 2: Revenue="11.9"
  - s3 "North division" row 2: Revenue="12.4"
[4] no indexed text in the 7 shared files has "west" (asked: "west division revenue"); rows labelled like it: "North division", "South division" (s2, s3).
````

REST asked for text (`"format": "text"`) writes the same answer with whole revisions (`@83757353ead4`) and a handle on each line and value (`[1] #D16826NQ4J s1 lines 5-8 of 19`, `Revenue="11.9" #ADE2V0Q3BV`).

The JSON contract is `{sources, answers: [{n, ask?, kind, …}], warnings?}`. An ask is resolved in this order:

| The ask names | `kind` | Answer |
|---|---|---|
| A file and lines (`app.py lines 5-12`, `L12-L30`, `app.py:5-12,40-48`) | `lines` | Exactly those lines, each range separately |
| A definition (`the parse_config function`, `where is TIMEOUT defined`, `normalize_sku`) | `definition` | The whole block, said to be the only one when no other shared file defines the name; a name only assigned a value (`MAX_RETRIES = 7`) is read from the line the index records |
| Only a file (`Finance/notes.md`) | `lines`, `outline` or `files` | A small text file whole; a large code file's outline, any other large file's first 12 lines (a table's header); asked where it is, its locations |
| Instances of a STEP assembly (`Pin:2 relative to Pin:1 in fixture assembly.step`, `where is Pin:2`, `{op: "pose"\|"angle", file, a, b}`) | `geometry` | Two instances: the second's distance from the first, its origin and turn in the first's frame, and the angle between their like-named axes, computed from both placements by the [structural framework's](#structural-context-what-is-integrated) operators (`complete`). One instance: where it sits in the assembly. A placement the parser could not settle is refused, never guessed |
| A table row by its label (`Account 104233`, `South division`) | `record` | The fields the ask names, in the order named, or the row. Other words (`approved`, `planning`) rank rows by their file and values, never pick: `best` puts one first and still shows the others, `agree` says they match, `differ` says the files do not settle it |
| Every word in a file's name or title, besides words for the answer's form (`the supplier review`, `Revenue 2025.xlsx`, `bracket.step`) | `digest` | What the file holds: a text file whole (or its outline); a workbook's tables; a PDF's or Word document's passages in order; a STEP model's parts with instances and sizes, and an assembly's instances with where each sits (`Pin:2 at [70, 45, 10], turned 90° about z`), or an IFC model's rooms and storeys with their areas, other elements counted |
| Several row labels (`October, November and December`, `North and South division`) | `records` | Each label's rows as a group; only rows with the same label in different sources are compared |
| An operation on a column (`total adverse events`, `average Revenue in Q4`, `the total Amount for the West region`, `{op: "sum", column, file?, where?}`; `sum`, `mean`, `max`, `min`, `count`) | `computed` | The value over every row of up to 3 tables that have the column (read from the table index when the table is larger than the cells the index keeps), `complete`: how many rows it covers, which cells were not numbers, and each row's value when there are at most 15. A period in the ask keeps a monthly table to its months; another column named with one of its values ("the West region") keeps that value's rows, and the answer says so. The ask's other words are searched for too, and what that finds comes after, `ranked` |
| Over MCP only: a query over whole tables (`SELECT Region, SUM(Net) FROM Orders GROUP BY Region`, `"Operations 2025.xlsx": SELECT …`, `{sql, file?}`), or its common cases in plain words (`total Net by quarter of 2025`, `number of orders per Customer`, `duplicate Order IDs`) | `computed` | The query's rows, worked out from every row of the tables it names, with how many rows of each it read ([below](#whole-table-operations-over-mcp-12-november-2026)). `complete`, or `partial` when the result is longer than fits and is cut. A query written from plain words is shown (`ran`). A table name two files answer to is `ambiguous` and lists them |
| Over MCP only: an operation over a whole workbook, PDF or STEP assembly (`{file, op, …}`; in plain words `Summary!B12`, `formulas in Operations 2025.xlsx`, `broken cross-references in the agreement.pdf`, `how many bolts in conveyor.step`) | `operation`, `cells` | The operation's result with what it covered ([below](#whole-file-operations-formulas-documents-and-assemblies-12-november-2026)): a cell with its formula, what a cell feeds, a recalculated copy, a document's cross-references or defined terms, an assembly's counts, bounds or interference. `complete` when exact and whole, `partial` when bounded or cut |
| A file, with words it does not have (`what does the annual review say about carbon emissions`) | `none` or `digest` | Said first. A document with none of what the ask is about shows its sections, which say what it does cover; a model or table shows what it holds, which may answer in its own terms (an IFC model's rooms are its spaces) |
| Anything else | `found` or `none` | A search of the [full-text index](#questions-about-documents-retrieval-uncertainty-and-evaluation): from at most 4 files, the sentences and table rows that answer the ask within `budget` (default 700 tokens), each with its section, page or line and a handle; a workbook's matching rows; a model's matching parts or rooms. `ranked`, saying how many matched sentences it left out and in which sections. `none` (`not_found`) says what this search did not find: words no shared file has (checked word by word against the index), that no passage has the words together, rows labelled like a label no row has ("North division" for "West division") |

Until the index has caught up with the library, and when it finds nothing, the earlier plain scan answers instead: hits with every word that says what to find, words asked together first, then those that state a figure or date; if none has them all, `none` with the words no shared file has and the closest hits.

- `at revision a1b2c3d4` / `@a1b2c3d4` reads that revision. `before the last change`, `previous value` and `history` add earlier captured values to a record's fields. `as the file is now` reads the file from disk.
- A name several files share is an `ambiguous` error listing each, unless a word of the ask names one of their folders or directories ("the Admin app.py", `Admin/app.py`).
- A file the ask names that changed on disk since indexing is read as it is now, from disk, and its source says so (`disk: "read"`, `unindexed`). An explicit `{file, lines}` read keeps the indexed revision and warns.
- Every answer has a `status`: `complete` (a lookup, or a computation over every row), `ranked` (a search's selection, never all there is), `partial` (shown in part: a digest cut short, a word no file has), `ambiguous` (sources or names the files do not settle between), `not_found` (this search found nothing, which is not proof that nothing exists). A source whose file changed since indexing says so (`disk`), a folder answering from an older snapshot is `lagging`, and up to 5 files in scope that Lasso could not read are listed as `not_searched`.
- The search matches words by their stems (`delivery` and `delivered`) and weighs each by how rare it is. It has no list of synonyms. Periods are calendar facts: `Q4` is also looked for as "fourth quarter", `H1` as "first half", "the last quarter of 2025" as Q4, and in a sheet whose rows are months, each keeps the rows to its months. The plain scan still matches plurals, stems of six letters or more, and its short list of everyday equivalents (outlook and guidance, a room and an IFC space). Words that say what form the answer takes (`summary`, `action items`, `dimensions`, `total`, `highest`) or what kind of file (`model`, `sheet`) are not required.
- `budget` (tokens, 100 to 8000, default 700) bounds a search's sentences; a value under 100 is read as a number of results, as models often mean it, and the default is used. A `ranked` answer says when a larger budget would show more. A search shows less (150 tokens) only when half or more of the words it seeks are in no file.
- A report's sections count by what they are for, from their headings: references, acknowledgements and the like are never evidence unless asked about; background sections (introduction, previous studies) count half unless the ask is about other work; a numbered section is what its top-level section is ("4.1 Nitrate" under "4 Results"). An ask for what a document found ("the main results of the School Streets pilot", "what did the evaluation find") that names one document is answered from it: the stating sentences of its findings sections and its summary are candidates even without the ask's words, and the words of its file name pick it rather than rank its sentences.
- Words that point at text rather than say what it is about ("find the relevant passage", "the section about") are not looked for.
- Within one call, an excerpt already shown for an earlier ask is sent as a pointer to it (`same`).
- Up to 16 asks per call; an ask that fails carries `kind: "error"` and doesn't fail the others.

### `lasso_search` / `POST /agent/v1/suggest`

```json
{ "queries": [
    { "id": "g1", "text": "North division", "fields": ["Revenue", "Reporting period", "Scenario"] },
    "INV-2025-00417",
    { "id": "f", "text": "app.py", "kind": "file" } ],
  "limit": 5 }
```

```json
{ "sources": { "s1": { "folder": "Finance", "path": "Planning/budget.csv", "rev": "dd459a8353ec" },
               "s2": { "folder": "Finance", "path": "Approved/budget.csv", "rev": "a1adad958009" } },
  "results": [ { "id": "g1",
      "candidates": [
        { "src": "s2", "type": "record", "row": "North division", "at": "row 2",
          "fields": { "Revenue": { "h": "6BVEWRTB04", "value": "11.9" }, "Scenario": { "h": "C0XAHZQPX8", "value": "Approved" } },
          "match": "exact name" },
        { "src": "s1", "type": "record", "row": "North division", "at": "row 2",
          "fields": { "Revenue": { "h": "ACZK1G04AR", "value": "12.4" }, "Scenario": { "h": "9HQZ5XW75Z", "value": "Planning" } },
          "match": "exact name" } ],
      "coverage": { "total": 6, "exact": 2, "more": true, "cursor": "K6ST.FNTD.2" } } ] }
```

- A query is a string, or an object with `kind`: `any` (default), `file` (names from each folder's manifest), `code`, `value` or `passage`. Filters: `folder`, `under` (directory prefix), `ext`.
- `fields` bundles the named columns of each matching table row into one record. That includes tables over 5 MB, through their row index. Field names repeated in `text` are left out when matching the row, and fields asked of a passage or file search table rows instead, with a `notes` entry saying so.
- Five candidates per query by default, which measured about 30% fewer tokens than eight where more matched.
- `coverage.total` counts authorized matches, before paging. `exact` counts exact and name-prefix matches; `0` means nothing matched exactly, only some of the words, and the text format says so in words. `more` + `cursor` page on. A cursor is tied to the index generation and fails with `stale_cursor` after the folders change. `capped` means more than 400 matched. `exhausted` means nothing else in the shared, indexed folders matched those words, which is not a claim that nothing relevant exists. `budget` (about real tokens) trims the lowest-ranked candidates and marks the result with `budget: true`.
- Values longer than `max_chars` (400) are cut and marked `trunc`. Read the handle for the whole value.
- **Lasso never selects a candidate.** Competing sources (the Planning and Approved budgets above) are both returned, with what tells them apart.

### `lasso_read` / `POST /agent/v1/inspect`

`items` is a list, answered item by item. An item that fails carries `error` and doesn't fail the others.

| Item | Returns |
|---|---|
| `{file, lines: "5-12", folder?, rev?, version?, context?, numbered?}` (also `{h, lines, rev}`) | `lines: [5, 12]`, `total`, `text` exactly as in the file (8 lines here), and a handle for the range |
| `{file, symbol}` / `{symbol}` / `{h, symbol: true}` | The definition's whole block (braces or indentation, plus decorators). Several definitions of one name return `ambiguous` with their locations |
| `{file}` | An outline: `"5 handle"`, `"11 load"`, … |
| `{h, context}` | Rows of the table, lines of the file, or neighbouring PDF passages around the evidence |
| `{h, history: true}` | Captured versions of a value, newest first |
| `{folders: true}` | Shared folders, their indexed version, and whether they lag behind the files |

Name resolution never guesses. A bare `app.py` that two folders contain is an `ambiguous` error listing both. `folder`, a longer path, or `Folder/path` settles it.

### `lasso_cite` / `POST /agent/v1/bind` (MCP: with `--tools …,cite`)

```json
{ "task": "q3-report", "bind": { "rev": "ACZK1G04AR", "period": "WZ1A7GFAWM" },
  "same_record": [["rev", "period"]],
  "template": "North division reported {{rev}} for {{period}}." }
```

```json
{ "task": "q3-report", "text": "North division reported 12.4 [1] for FY2025 [2].",
  "fields": { "rev": { "value": "12.4", "cite": 1, "now": "same" }, "period": { "value": "FY2025", "cite": 2, "now": "same" } },
  "citations": [ { "n": 1, "h": "ACZK1G04AR", "folder": "Finance", "path": "Planning/budget.csv", "rev": "dd459a8353ec" }, … ] }
```

- Every handle is re-authorized, and every constraint and placeholder is checked, before anything is recorded. An `unbound` placeholder or an `inconsistent` group rejects the whole request.
- Values are inserted as recorded: `9.10` stays `9.10`, never `9.1`.
- `now` reports whether the value at the folder's newest indexed snapshot is `same`, `changed` or `removed`. A citation is never moved to the new value.
- Bindings are recorded with the actor the transport identified (`agent:mcp:<client>` or `agent:rest:<client>`), always as `AI_AGENT`. They live in `agent_bindings`, apart from `recommendation_usage`, so an agent's choices never raise a source in the person's suggestions.

### Errors

`{ "error": { "code", "message", … } }`. Codes: `invalid_request`, `scope_not_configured`, `unauthorized`, `not_found` (often with `similar`), `ambiguous` (with `matches`), `revision_not_found`, `expired_handle`, `stale_cursor`, `out_of_range` (with `total`), `too_large`, `unsupported`, `unbound`, `inconsistent`. REST maps them to 4xx statuses. MCP returns them as tool results with `isError: true`. Protocol errors use JSON-RPC codes.

---

## Versions, freshness and authorization

- **Which version answers.** Each folder answers from its current snapshot once it is indexed, otherwise from its newest indexed snapshot, marked `lagging`. The agent never triggers indexing.
- **Indexed vs disk.** Every source reports `disk: "changed"` or `"missing"` when the file on disk no longer has the indexed bytes (size and mtime, then hash). `version: "disk"` reads the current file. That works only for a file the index knows, only if its real path stays inside its folder, and the result is marked `unindexed` and gets no handle. An ask that names a changed text file without a revision reads it this way; searches across files answer from the index and warn.
- **Pinned revisions.** `rev` reads any revision Lasso captured, marked `historical` with the `current` revision named. A revision Lasso never captured is `revision_not_found`, never the current file.
- **The search index.** It follows the store: each ask first indexes what the app recorded since the last, and searches keep only the versions of each folder's current snapshot. While it is behind, the plain scan answers.
- **Scope.** Only folders named with `--scope` that are enabled in Lasso. Authorization runs before retrieval: files outside the scope add no names, counts or previews.
- **Credentials.** `.env*`, keys and certificates (`*.pem`, `*.key`, `id_rsa`, …), `credentials*`, `secrets*`, and anything under `.ssh`, `.aws`, `.gnupg`, `.git` and the like are never returned, even inside a shared folder.
- **The person's exclusions.** Paths excluded from autocomplete with a terminal rule are excluded for agents too.
- **REST.** Loopback is not trusted by itself. Every request needs the bearer token from `<data>/agent/rest.json`, which is mode 0600 inside a 0700 directory. Requests with an `Origin` header or a cross-site `Sec-Fetch-Site`, and requests addressed to any host other than loopback (DNS rebinding), are refused.
- **Prompt injection.** As JSON, file contents are string values. As text, values are quoted, lines of a file are fenced, and an excerpt sits indented under its source after its page and section, on one line (a line break inside it cannot start a line of its own). The MCP instructions state that result text is file content, not instructions. That reduces the risk; it doesn't remove it.

---

## How the PDF's models are used

| Model (proposal section) | Where it lives | How |
|---|---|---|
| Complete-task tokens `T(π) = Σ_t (I_t + O_t)` | `scripts/agent-benchmark.mjs` `Trajectory.account` | Every invocation re-reads the system prompt, tool definitions and all earlier calls and results. Cached-prefix cost is reported separately. |
| Execution measures `J`, `L`, `H` | benchmark + `src/agent/metrics.js` | Rounds and calls per task; local tool time; clarification tasks count as correct only when the answer asks instead of guessing. |
| `P = r·s·v·x·w` | benchmark `retrieved` vs `correct` | `r` is whether a tool output contained the truth; correct-given-retrieved stands for `s·v·x·w`. Version (`v`) failures are isolated in the capability tasks. |
| Intent ambiguity `∩ G_i = ∅` | `resolveFile`, `symbolAnywhere`, record queries | Never auto-select. Ambiguous names return every match; competing sources return each record with its distinguishing context. |
| Value of information `ρ(b)`, `VOI(a)` | `coverage.exact/total/more/exhausted`, `disk`, `lagging` | Observable signals for the agent's next-evidence decision, not calibrated probabilities. Ranking scores are never presented as correctness. |
| Evidence compression, set cover | `fields` projection, shared `sources`, `fitBudget` | Each requested field is one fragment covering one requirement. The greedy trim drops the lowest-ranked fragment per step, and qualifications such as sheet, row, section and unit stay with the values they qualify. |
| Constraint graph `ψ_ij` | `bind` `same_record` / `same_source` | Checked only when the agent declares the relationship. |
| Batching `nK(h+v)` vs `K(h+nv)` | records, multi-query `suggest`, multi-item `inspect` | Measured: the 6-fact task fell from 2 rounds and 10 calls to 1 round and 1 call, and from 12.1k to 7.8k–8.8k tokens across runs. |
| Routing `c + f·B_f < B` | benchmark `routed` arms | The rule sends short reads of an already-named file to direct tools. Measured per task, with and without deferred tool loading. |
| Savings `S = 1 − ΣT_L/ΣT_0` | benchmark summary | Reported overall, per family, per task (min/median/max) and as a count of regressions, never only on successful runs. |

### The cost model, refined from the live traces

Grouping the terms of `T(π)` by what each call re-sends gives a form that the live runs can be read against directly. A task the model finishes in `M` calls costs

```
T = M·F + Σ_{r=1}^{M−1} (M − r)·e_r + O
```

- `F` is what every call re-sends: the host's system prompt `S`, the tool definitions `d` and the request.
- `e_r` is what round `r` adds to the conversation (its tool calls and results), re-read by each of the `M − r` later calls.
- `O` is all output, reasoning included.

Measured on v3's live run (gpt-5.4-mini, 31 tasks paired with direct tools; `F` is the first call's input, history is the rest):

| Arm | Calls per task `M` | `F` | `M·F` | Re-read evidence `Σ(M−r)e_r` | Output `O` | `T` per task, mean (median) |
|---|---|---|---|---|---|---|
| direct | 2.97 | 426 | 1,273 | 4,936 | 401 | 6,611 (2,328) |
| lasso-v3 | 3.42 | 809 | 2,779 | 2,567 | 395 | 5,742 (3,141) |

v3 halved the evidence term but more than doubled the fixed term: it made more calls (search, then read), and each re-sent 387 tokens of definitions. Four consequences follow from the formula, and v4 is built on them:

1. **Rounds cost `F` each, plus a re-reading of everything before them.** `n` lookups made one per round cost `(n+1)·F + ē·n(n+1)/2`, quadratic in `n`; made in one round, `2F + n·ē`. A search round followed by a read round costs `F + 2s` more than one call that resolves the question (`s` = the search results). So v4 resolves each question on the server, in one call, and takes every question of a task in that call.
2. **Expand when `p > s_c / (F + H + s_c)`.** Returning a candidate's content now costs its `s_c` tokens, re-read by later calls. Leaving it for a later call costs, with the probability `p` that the model needs it, a whole round: `F`, the history `H` so far, and `s_c`. With `F + H` in the hundreds of tokens and `s_c` tens to a few hundred, the threshold is around 0.1–0.3. In a host with a long system prompt it is near 0. So v4 returns the value, lines or definition rather than a pointer to them, and shows every competing source in full, since the model needs all of them to ask which is meant.
3. **A definition costs `d·M` on every task, whether or not the tool is used.** Only what makes a model call the tool, and call it well, earns its place: v4's tool and instructions measure 149 tokens per call, against 387 for v3.
4. **Host overhead scales with `M`.** A host whose system prompt is `S′` tokens rather than the benchmark's `S` costs `T(S′) = T + M·(S′ − S)`. Each call saved therefore saves `S′` tokens too, mostly at the provider's cached-input price. The harness's system prompt is about 100 tokens, so the live runs understate what fewer calls save in a host with a long one.

---

## Optimizations, with what was measured

| Optimization | Original inefficiency | Mechanism | Motivation | Effect on correctness | Measured | Limits |
|---|---|---|---|---|---|---|
| New protocol vs terminal `find` | `find` returns ids, ranking internals and UI actions per hit, and at most two hits per file | Compact candidates, shared `sources`, typed records | Evidence term of `I_t` | Legacy arm missed one field; Lasso arms 16/16 | Evidence ≈41.8k → ≈9.6k tokens on the 16 comparable tasks | — |
| Batching | One call and round per lookup | Multi-query `suggest`, multi-item `inspect` | `J`, `K(h+nv)` | None | Rounds 18 → 16, calls 29 → 16 (unbatched → batched) | Only when the lookups are independent |
| Symbol blocks | Grep, then read a guessed 80-line window | `{symbol}` returns the exact block; definitions cached per content hash | Evidence + `J` | Exact block | Function lookup: 2 rounds → 1, evidence 1,093 → ≈440 | Regex definitions, not a parser; unusual syntax may be missed |
| Compact tool definitions | First draft: 1,737 estimated tokens, paid on every invocation | Shorter descriptions; nested fields described once; the server validates | Fixed term of every `I_t` | Server validation unchanged | Measured afterwards at 364 real tokens per call (v1) | Hosts don't validate nested fields; in the latest live run, none of 75 Lasso calls failed |
| Response compaction | Repeated per-candidate source data, redundant fields | Shared sources; `gen`, `returned`, `type` and restated locators dropped | Evidence term | None | Evidence from −2% to parity with direct tools (offline) | — |
| Compact text answers | JSON keys, quotes and braces in every answer the model re-reads | `render.js`: the same answer as text; values JSON-quoted, file text fenced | Evidence term, re-read every later turn | Same values, handles and lines (tested) | 26–27% fewer real tokens per answer; offline evidence −2% → −37% vs direct | Over MCP; REST keeps JSON unless asked |
| Five candidates by default | Eight, mostly unread | `limit` default 5; coverage reports the rest | Evidence term | None measured; `more` and the cursor say what is left | −28% to −32% real tokens on searches with many matches | A model that needs more must page |
| Calibrated estimator | Charged JSON at up to 1.8× its real tokens | One token per short word or punctuation run | Budget accuracy | `budget` now means about real tokens | 1.10× real on average (0.92–1.28×) against provider counts | Checked on one tokenizer |
| Deferred tool loading (host feature) | Lasso definitions paid on tasks that don't use Lasso | Host loads tools on demand | `c + f·B_f < B` with `c` including definitions | None | `S`: −7.6% → −2.1% (+3.9% dense) | Lower bound: the loading call isn't counted |
| Deterministic insertion (`bind`) | Values copied by the model can be miscopied | Template filled from recorded literals | Raises `w` | Removes a copy-error channel | Costs +3.6k tokens and +1 round on a 3-field task | Prose around values is not validated |
| Immutable large-table cell references | Recording rows from two processes left the other's caches stale; rows vanished | Cells referenced by revision, sheet, row and column; nothing written | Correctness under concurrency | Fixed a reproduced miss (test added) | Warm pass 14/16 → 16/16 | Large-table cells have no captured history |
| `rev` honoured with a handle (bug fix, found live) | `inspect {h, lines, rev}` ignored `rev` and silently returned the handle's revision | A revision asked for with a file or line handle is read; on a value handle it is an error | Version stage `v` | Removes a silent wrong-version answer | Codex, stale-reference task, lasso-first: wrong in 2/2 runs before, correct after (1 run) | — |
| Disk changes said in words (found live) | `disk: "changed"` inside `sources` went unnoticed; the model quoted stale lines | A top-level `warnings` line per changed or missing file | Version stage `v` | Fewer stale quotes | Codex, modified-file task, lasso-first: wrong in 2/2 runs before, correct after (1 run) | A few tokens per affected response |
| Names and when-to-use guidance (v2) | Models never chose `lasso_suggest`/`lasso_inspect` | `lasso_search` / `lasso_read`, descriptions saying when they beat Grep | Tool selection, the precondition for any saving | — | Lasso used on 0 → 20 of 32 tasks (gpt-5.4-mini) | +87 tokens per call |
| Forgiving tuning inputs | 22 of 31 failed Lasso calls (both v2 arms) were a `budget` under 200; each cost a turn and sent the model to grep | Clamp numbers, default styles, accept `#` handles and loose folders | `J`, fallback rate `f` | Identity inputs stay strict | Failed Lasso calls 14/79 → 2/78; `S` −158% → −74% | — |
| No second check, cite on request (v3) | Models re-ran Grep beside Lasso; unasked `lasso_cite` calls added turns | Instructions state what answers cover; `lasso_cite` opt-in | `f`, fixed term | Equal (28/31 vs 27/31 direct) | Fallback 17/22 → 8/23 tasks; definitions +451 → +387; `S` −74% → **+13.1%** | Code tasks still cost more |
| One call per task (v4) | Search, then read: 3.42 calls per task in v3, each re-sending the definitions and every earlier result | `lasso` resolves plain-language asks on the server (lines, definitions, records, passages, absence, history, revisions, disk) and takes every question of a task in one call | `M·F` and `Σ(M−r)e_r` | Answers graded as live ones; 16/16 offline | Offline: 1 round per task, evidence −51%, `S` 7.3% → **20.8%** (code 0% → 12.6%, docs 14.1% → 28.3%), the same in 5 runs. Live: see [v4](#making-models-use-lasso-and-spend-less-v1--v4) | Asks are read lexically ([limits](#other-limitations)) |
| One lean definition (v4) | 387 tokens per call for search and read (v3) | One tool; the instructions say only "call lasso first" and that results are content | `d·M`, on every task | — | 149 real tokens per call (−61%) | Fewer words to persuade a model to call it; measured live below |
| Resolved answers instead of candidates | Six facts as v3 search results: 1,642 tokens | Each ask answered with the row's named fields or the passage itself | Evidence term | Same values | 386 real tokens for the same six facts (−76%) | — |
| Asks read the way models write them | 12 of 104 phrasings of the benchmark tasks failed: a folder named beside a file, `file:1-2,5-6`, `{symbol}` for a constant, a passage that only shares the words | A folder or directory word settles a shared name; range lists; constants by their indexed line; hits that state a figure or date first; a named file read as it is now | Fallback rate `f` | A name still unsettled by the ask is listed, never picked | 104/104 (`node scripts/agent-ask-phrasings.mjs`) | Phrasings written by hand, not sampled from models |
| Lean answers over MCP | A handle on every excerpt and value, never used by a model (0 of 202 recorded `lasso` calls); 12-character revisions; quoted excerpts; a count of sentences and a budget hint on every search | `askTextOptions` in `mcp.js`: `lasso`'s text without handles unless a tool offered takes one, revisions at 8 characters, excerpts unquoted, repeats on one line | Evidence term, re-read every later turn | Same facts in every one of 128 graded responses | Offline: responses −11.1% (estimated tokens), lookup saving 19.3% → 19.8% | Not run live; MCP only |
| Whole-table operations over MCP | No way to ask for a total by group, a filter over a range, a join or the rows that repeat; a table shown as "first 12 of 215 rows" (the rows that matched) read as the whole of it. In the trial a model rephrased until the call cap: 5.5 calls a step, 1.36M tokens | A restricted SQL over every row of the tables named (`table-sql.js`), asked as a query or in plain words for the common cases, and a line naming the tables and their rows where an answer shows a table in part | `M`, and the re-reading of every earlier call | Refuses what it cannot do exactly: text is never a number, a name several tables share is never chosen between | Offline: matches the trial generator's truth on five whole-workbook checks; the first recorded ask of 2 of its 6 workbook tasks is answered outright, the other 4 are told a query reads every row | Not run live; MCP only; tables in workbooks and delimited files only |

---

## Live model runs (provider-recorded)

The runs below used the lookup tasks only; the harness has since gained document, writing and assembly tasks and an upload arm ([Running the live benchmarks](#running-the-live-benchmarks)). They ran the 18 tasks on the same generated library through OpenAI's Responses API. The arms:
- **direct:** Read, Grep and Glob.
- **lasso (v1 … v4):** the same plus a version of Lasso's tools and instructions, as an MCP host would add them; the model decides.
- **lasso-first:** the same, plus one instruction to prefer Lasso and fall back to the file tools.

Every model call's `usage` is recorded: input counts the whole context each call, and output includes reasoning. Tasks run in random arm order, at fixed reasoning effort `low`, with a hard spend guard. Answers are graded against the generator's truth. Total spend for all live runs and probes was about $4.75.

The first runs, with the v1 server, paired over 16 tasks × 2 runs (the two capability tasks excluded). Full tables: [gpt-5.4-mini](live-results-gpt-5.4-mini.md), [gpt-5.3-codex](live-results-gpt-5.3-codex.md), [post-fix check](live-results-gpt-5.3-codex-fixcheck.md).

| Model | Arm | Correct | Tokens T | Cached input | Cost | Used Lasso on | S vs direct | Median per-task T/T_direct |
|---|---|---|---|---|---|---|---|---|
| gpt-5.4-mini | direct | 29/32 | 193,743 | 42% | $0.141 | — | — | — |
| | lasso | 28/32 | 792,509 | 76% | $0.244 | 1 task | −309%* | 1.64 |
| | lasso-first | 29/32 | 267,717 | 48% | $0.173 | 10 tasks (all also used file tools) | −38.2% | 1.60 |
| gpt-5.3-codex | direct | 31/32 | 219,830 | 10% | $0.498 | — | — | — |
| | lasso | 32/32 | 237,676 | 32% | $0.459 | 1 task | −8.1% | 1.58 |
| | lasso-first | 30/32 | 247,818 | 43% | $0.446 | 26 tasks (12 also used file tools) | −12.7% | 1.66 |

\* One run of one task (`doc-multi-batch`, file tools only) took 586,598 tokens; the same task took 19,170 in the direct arm of the same run.

What the runs show:

- **The per-call cost of Lasso's tools is 360 tokens** in these models' tokenizer (median first-call input 784 vs 424). The offline estimate was 838, so the estimator overcharged JSON by about 2.3×.
- **Models don't reach for Lasso by themselves.** With both toolsets available, each model used Lasso on 1 of 32 tasks. That arm is therefore the direct arm plus 360 tokens a call plus noise. Getting a model to choose Lasso is the first problem; retrieval quality comes second.
- **Told to prefer Lasso, Codex mostly did (26 of 32), and the result was mixed.**
  - Large savings: competing budgets 2.7–2.9k tokens vs 14.8–20.2k (−84%); three function definitions 3.7–3.8k vs 6.6–7.4k (−46%); the long report 3.8–3.9k vs 2.8–21k.
  - More tokens elsewhere: the per-call overhead on 1k-token lookups; one query per `suggest` call instead of batching; falling back to file tools after Lasso (12 of 26 tasks); and some fact lookups (related facts 10–17k vs 2.8–3.4k).
  - gpt-5.4-mini followed the instruction on only 10 of 32.
- **Correctness was equal across arms** (29–32 of 32). Once the two bugs above were fixed, Lasso answered the revision task the file tools cannot (one post-fix run).
- **Dollar cost fell while tokens rose.** OpenAI caches stable prompt prefixes over 1,024 tokens. Lasso's larger instructions and definitions put more of each call over that threshold (Codex cached input: 10% direct, 43% lasso-first), so the Lasso arms cost 8–10% less on Codex. That is a pricing effect, not fewer tokens.
- **Variance is large.** The same task in the same arm varied up to 30× between runs, so per-task medians are more telling than the totals. Two runs per model is too few for tight intervals.

Grading notes: `doc-missing` answers were regraded from the saved full answers after the grader was found too strict, which changed 4 Codex grades. gpt-5.4-mini answers were saved only in part, and one of its `doc-ambiguous-sources` answers was probably correct but graded wrong. On `code-duplicate-named`, every arm in several runs prefixed line numbers despite the instruction, and is graded wrong. The main live runs predate the two fixes; only the 2-task check ran after them.

### Making models use Lasso, and spend less: v1 → v4

The first runs showed that models don't pick Lasso by themselves, so the next step was getting them to pick it. Each version was changed only where the previous run's call traces showed a cause, then measured live on gpt-5.4-mini: 2 runs each, the model choosing freely (no "prefer Lasso" instruction), against direct tools in the same runs. Full tables: [v1 and v2](live-results-gpt-5.4-mini-v2.md), [v2 with forgiving inputs](live-results-gpt-5.4-mini-v2b.md), [v3](live-results-gpt-5.4-mini-v3.md), [v4](live-results-gpt-5.4-mini-v4.md).

| Server | What changed | Used Lasso on | Also used file tools on | Failed Lasso calls | Correct (direct) | Tokens vs direct | Cost vs direct |
|---|---|---|---|---|---|---|---|
| v1 | first release | 0 of 32 tasks | — | — | 29/32 (29/32) | −73.8% | $0.167 vs $0.123 |
| v2 | names, when-to-use guidance, compact text, limit 5 | 20 | 15 | 14 of 79 | 27/32 (29/32) | −158.1% | $0.208 vs $0.123 |
| v2 | + forgiving tuning inputs | 22 | 17 | 2 of 78 | 28/32 (28/32) | −74.1% | $0.173 vs $0.128 |
| v3 | + "no second check" instructions, cite on request | 23 | 8 | 0 of 75 | 28/31 (27/31) | +13.1% | $0.131 vs $0.139 |
| v4 | one `lasso` tool: plain-language asks resolved on the server, every question in one call; 149-token definition | **32** | 3 | 0 of 36 | **32/32** (29/32) | **+69.2%** | **$0.080 vs $0.145** |

Negative means more tokens than direct. In the v3 run the spend guard stopped the last direct call, so 31 pairs. The v1 and the first v2 row come from one four-arm run, which also tried v2 with "prefer Lasso" (23 of 32 tasks, −120.6%).

In v3 the saving was concentrated in document tasks (−39%); code tasks cost 98% more, because 387 tokens of definitions per call outweighed exact reads that are already small with Read, and Lasso used more tokens than direct tools on 26 of 31 tasks.

v4 changed the terms of the [cost model](#the-cost-model-refined-from-the-live-traces) it was designed against. Per task, means over the 32 paired tasks:

| Arm | Calls `M` | `F` | `M·F` | Re-read evidence | Output (reasoning) | `T` mean (median) |
|---|---|---|---|---|---|---|
| direct | 3.06 | 428 | 1,323 | 5,108 | 422 (67) | 6,853 (2,107) |
| lasso-v4 | 2.16 | 573 | 1,233 | 610 | 265 (51) | 2,107 (1,479) |

- **Every task used Lasso, and 29 of 32 needed nothing else.** The model asked once and answered (`M` = 2 on 29 of 32 tasks), so `M·F` fell even though each call carries 145 more tokens. The evidence re-read fell by 88%, and output by 37%. None of the 36 `lasso` calls failed. The model batched as the description asks: the six-fact task was one call with six asks in both runs, where v3 made 9 separate searches.
- **Code tasks are now 14.5% cheaper, documents 80.2%.** Whole functions (−48% to −51%), three definitions at once (−37% to −46%), repeated ranges (−18%), competing budgets (−77% to −82%), the long report (−75% to −83%) and the six facts (−96%) gained most.
- **Lasso still costs more on 14 of 32 tasks**: the seven that direct tools finish in one read (`M` = 2 for both), where the definitions add 2 × 145 tokens to a 1.0–1.3k-token task (ratios 1.02–1.37; 2.53 once, when the model also re-read the lines with Read). This is the floor `d·M`; a host that loads tools on demand removes it. The median task costs 18% less.
- **Correctness rose to 32/32** from direct tools' 29/32. With direct tools the model copied Read's line numbers into the duplicate-name answer (both runs) and once reported the warranty reserve as not found. Lasso answered both capability tasks in both runs (direct: 0 of 4).
- **Cost fell 45%, less than tokens.** v4's calls are short, so few cross OpenAI's 1,024-token caching threshold: 7% of input was cached, against 51% for direct tools.

The one task where the model still checked Lasso's answer was proving a division absent: it grepped and read the budgets after "no exact match … none has "west"", to list the divisions that do exist (6.6k and 8.6k tokens; direct tools 30k and 13.7k). That claim was also too strong: it was judged from the closest hit, and "west" does occur in the corpus (`REGION = "eu-west"`). Absence is now checked word by word over the shared index, and a row asked for by a label no row has comes back with the rows labelled like it:

```
[1] nothing in the 52 shared files has "west", "division", "revenue" together; no row is labelled "west division"; rows labelled like it: "Central division", "East division", "North division", "South division" (s1, s2).
```

Re-run on that task alone (2 runs, [results](live-results-gpt-5.4-mini-v4-absence.md)): one `lasso` call and an answer, 1,425 and 1,474 tokens, correct both times, naming the four divisions; direct tools took 46.0k and 36.8k.

**gpt-5.3-codex, v4, one run** ([results](live-results-gpt-5.3-codex-v4.md)), with the absence change. The spend guard stopped before direct tools' six-fact task, so 15 tasks are paired:

| Arm | Correct | Tokens T | Calls `M` | Re-read evidence | Output | Cost |
|---|---|---|---|---|---|---|
| direct | 13/15 | 127,293 | 2.80 | 6,926 per task | 374 per task | $0.211 |
| lasso-v4 | **15/15** | **29,777** | 2.07 | 533 per task | 275 per task | **$0.100** |

`S` = **76.6%** (documents −90.8%, code +3.6%); Lasso was used on all 16 tasks it ran, including the six facts in one call (2.0k tokens). Codex reads code with direct tools almost as cheaply as Lasso answers, so code is about even: the median task ratio is 1.02, and 8 of 15 tasks cost more. On documents it read whole files: 39.6k tokens for the long report (Lasso 1.4k), 46.3k to prove a division absent (1.5k). It answered the report question wrongly with direct tools, and asked whether `Admin/app.py` meant `Admin/src/app.py` rather than showing it; with Lasso both were right, as were both capability tasks (direct: 0 of 2). Its one re-check after Lasso was a grep for three definitions Lasso had just returned; answers now say when a definition is the only one in the shared folders (`(defined nowhere else in the shared folders)`), which was not measured live.

Reproduce (spends money; `--budget` caps a run):

```bash
OPENAI_API_KEY=… node scripts/agent-benchmark-live.mjs --model gpt-5.3-codex --runs 2 --effort low --budget 2.5
```

`--arms direct,lasso` chooses arms (`lasso` is the current server; `lasso-v1`, `lasso-v2`, `lasso-v2-first`, `lasso-v3` and `lasso-v4` give the earlier definitions, which reach the current server; the arm these runs called `lasso-v4` was the server of that time), `--tasks id,…` limits the tasks, `--label` names the results file, and `--regrade <file.json>` reapplies the graders without calling the model. Each call's tool arguments and failures are kept in the results' `trace`. Prices are recorded in the script, and a model without a price is refused. `scripts/agent-token-probe.mjs` measures, for a few cents, the real tokens of each version's definitions and of every answer as JSON and as text ([token-probe.json](token-probe.json)). The earlier definitions are kept in `scripts/agent-tools-versions.mjs`.

## Writing tasks: spreadsheets, reports and 3D models

The 18 benchmark tasks above are lookups. People mostly ask an assistant to write something from their files: "write a short email to the leadership team summarising our Q4 2025 revenue". `scripts/agent-writing-corpus.mjs` builds a small company's shared folders for that:
- **Spreadsheets:** monthly revenue for 2025, and a draft and a final 2026 budget that disagree.
- **Reports:** Q3 and Q4 board reports as PDFs, a supplier review and meeting notes as Word documents.
- **3D models:** a STEP bracket and fixture assembly, a NIST STEP test part, and the public KIT "FZK-Haus" IFC building model.

There are 12 writing tasks. Each lists the facts a correct draft must state, for example the Q4 total, its growth on Q3, the best month and its figure. `scripts/agent-writing-benchmark.mjs` sends each task's asks to `lasso` in one call and checks whether the answer contains every fact. No model is called and nothing is spent, so this measures whether one call gives a model what its draft needs, not the drafts themselves.

| Ask sets | Complete answers | Facts in the answers | Mean answer |
|---|---|---|---|
| Development asks, before any change | 2 of 24 | 21 of 170 | 143 tokens |
| Development asks, after the changes (Lasso was changed while looking at them) | 24 of 24 | 170 of 170 | 262 tokens |
| Held-out set 1: first run after the first changes | 15 of 24 | 140 of 170 | 201 tokens |
| Held-out set 1, after a second round of changes made while looking at its misses | 22 of 24 | 165 of 170 | 213 tokens |
| **Held-out set 2: written after all changes, run once, never tuned on** | **19 of 24** | **135 of 170** | **242 tokens** |
| After the [retrieval changes](#questions-about-documents-retrieval-uncertainty-and-evaluation): development asks / set 1 / set 2 | 23 / 24 / 21 of 24 | 158 / 170 / 154 of 170 | 278 / 228 / 280 tokens |

Held-out set 2 was the figure to trust when it was run; the others were tuned on. Its 5 misses then showed what was still missing:
- a list of periods in one ask ("Q1 Q2 Q3 Q4 2025 gross margin");
- relative periods ("guidance for next quarter");
- a word's adjective ("western" for "west");
- an ask word that is in no file ("findings"), leaving one passage where the memo was wanted;
- "room areas in the house", where the house's total area outranked its rooms.

Two misses in held-out set 1 are asks that leave part of the task out ("Q4 revenue and growth vs Q3" never asks for the best month), and stay counted.

The retrieval changes were made with all three sets' results in view, so none of them is held out any more; the [independent evaluation sets](#questions-about-documents-retrieval-uncertainty-and-evaluation) are. After them, the 4 misses are:
- "gross margin for each quarter of 2025": the margin column comes back, but a quarter's margin as a percentage also needs the revenue column, which the ask does not name;
- "what did we earn in 2025" and "guidance for next quarter": no file has "earn" or "guidance", and "next quarter" is relative to a date Lasso does not know;
- "supplier review findings and recommendation": no file has "findings", and the memo's findings don't repeat the ask's words, so only the recommendation is found.

What the first run found, and what changed:

| Found | Changed |
|---|---|
| Word documents were indexed as one record, so none of their sentences could be found | Each paragraph and sentence is a passage, cited as `para N`. Word text now keeps its paragraphs, which also fixes previews showing a Word file as one long line. The index version is 5, so libraries indexed earlier read their `.docx` files once more on the next index pass; nothing else is re-read. Citing "the file …" or "the document …" in the editor still suggests the document itself, not one of its new passages |
| A PDF's whole-file record answered "Q4 2025 revenue" with "file", and no content | Whole-file records are never answers. When the ask's words are a file's name or title, the file's digest is the answer |
| "Revenue by month", "total revenue" and "each department's budget" got a row count or a few cells | A table's matching cells come back as its rows, whole when narrow |
| "Revenue for October, November and December" was "3 sources differ" | Different row labels are each answered; only one label's sources are compared |
| "West region sales" answered with the budget's Sales row; the 4 December meeting with December's revenue row | A row named by one word is not the answer when more of the ask's words are missing from it than found |
| "Q4" found neither "fourth-quarter revenue" nor October to December; "diameters", "rooms" and "delivery" missed "diameter", spaces and "delivered" | Plurals, stems, and a short list of equivalents (above) |
| `bracket.step`, `FZK-Haus.ifc` and the Word files named alone came back as "file" | They come back as their digests |

The text of the task's files, as a file-reading agent would get it after converting them, is 91–443 tokens for the spreadsheets and documents. Lasso's answers are about the same size there, at 80–770 tokens. What a file-reading agent spends on these files is the conversion: a workbook, PDF or Word file needs a script or converter before Read can see it, which is another round and its output. For the models the difference is size: the bracket's STEP file is 8,108 tokens, the assembly's 10,205, and the IFC house about 1.04 million, which no tool result holds (60,000 characters is a common cap). Lasso answers each in 114–657 tokens.

Not yet measured: the drafts themselves. A live run would show whether a model writes correct drafts from these answers, and at what cost against file tools with a converter. That needs the live harness extended to these tasks (the facts are already patterns a draft can be checked against) and an API key.

## Questions about documents: retrieval, uncertainty and evaluation

The lookups and writing tasks above mostly name what they want: a file, a row, a column. Questions about reports often don't. "What were the trial's main findings?", "was it effective for older adults?" and "does the memo agree with the report?" have answers spread over sections, worded differently from the question, and sometimes contradicted by another file. A model given too little gets an incomplete or wrong answer; one given whole files pays for every page on every later turn. This section covers what was changed for these questions and how it was measured. **Everything in it is offline: no model was called and nothing was spent.**

### How it is measured

`scripts/agent-eval/` renders an evaluation set (one JSON file, [format](../../scripts/agent-eval/SPEC.md)) into real files and indexes them with the app: text PDFs with pages, headings and tables set as text, Word files with heading styles and tables, workbooks and Markdown. Each task states what a correct answer needs:
- **facts**, each a set of patterns that must all match in one sentence, record line, or table row read with its header, so a response with "1.7" in one place and "pain" in another does not count;
- **qualifications** that must come with a fact ("the subgroup analysis was not pre-specified");
- **conflicts** between files, both sides of which must be shown;
- **computed values** (a total, the best site), which the response must state or give every operand of;
- **absent facts**, which the response must not supply.

`node scripts/agent-eval/run.mjs` sends each task's fixed ask sets to `lasso`, one call each, renders the answer as MCP sends it, and grades whether a careful reader could do the task from that text alone. Every task has a set of short keyword asks and a natural question. Token counts are estimates of the rendered text. The reference is the text of the documents that state the task's facts, as a converter gives it: about what uploading those files, or reading them whole, puts in a model's context.

For live runs, `gradeAnswer` (`scripts/agent-eval/grade.mjs`) grades a model's answer against the same spec. It reports material facts missing, a fact stated without its qualification, a conflict reported as one value, and numbers found in no evidence; a number derived from figures the answer states, such as a percentage, is accepted. A short correct answer passes (`test/agent-eval-grade.test.js`).

| Set | Written by | Tasks (ask sets) | Files | How it was used |
|---|---|---|---|---|
| dev | while changing Lasso | 12 (24) | a trial report and a cohort study (PDF), a briefing memo that disagrees with the report (Word), the trial's site workbook, reading notes | Tuned on |
| held-out 1 | a separate agent given only the spec format | 16 (32) | a buffer-strip study and a smoking-cessation trial (PDF), a memo that disagrees (Word), a nitrate workbook, meeting notes | Run once midway, its totals seen but no task looked at; run again at the end |
| held-out 2 | a second separate agent given only the spec format, after the changes were made | 18 (36) | a school-streets pilot evaluation and a hospital discharge evaluation (PDF), a board briefing that disagrees with the latter (Word), the pilot's site workbook, monitoring notes, an unrelated ward guidance note (Word) | Run once, at the end |

The baseline is Lasso just before these changes (the last commit, `1c8a762`, plus the writing-task changes above), frozen in a copy and run with the same harness and sets.

### Results

| Set | Lasso | Sufficient | Material facts | Response tokens, median / p90 / max | The documents as text, median |
|---|---|---|---|---|---|
| dev | before | 8 of 24 | 16 of 40 | 233 / 517 / 1,481 | 1,800 |
| dev | **after** | **15 of 24** | **26 of 40** | 306 / 718 / 1,294 | 1,800 |
| held-out 1 | before | 8 of 32 | 22 of 62 | 514 / 1,489 / 2,004 | 3,412 |
| held-out 1 | **after** | **14 of 32** | **36 of 62** | 699 / 1,704 / 2,122 | 3,412 |
| held-out 2 | before | 11 of 36 | 18 of 64 | 333 / 610 / 1,724 | 3,609 |
| held-out 2 | **after** | **29 of 36** | **48 of 64** | 1,009 / 1,950 / 2,010 | 3,609 |

Full tables: [before](eval-results-baseline.md), [after](eval-results-phase1.md). An ask set is one `lasso` call with one or two asks. "The documents as text" counts only the documents that state the task's facts. Reading them whole is enough by construction, and is the upload workflow's least cost. Every other file a person would upload, and every later turn that re-reads them, comes on top.

- **What improved.** On the two independent sets, the share of ask sets with everything needed went from 8 to 14 of 32 and from 11 to 29 of 36. On held-out 2, every lookup, qualified fact, conflict, comparison and absence ask set is now enough (22 of 22, from 8). The natural question did about as well as the keyword asks there (13 of 18, against 16), but not on held-out 1 (4 of 16, against 10).
- **What it cost.** Responses are larger: the median rose by a third on held-out 1 and threefold on held-out 2. On held-out 2's 8- and 9-page reports, half the searches (27 of 53) filled 600 or more of their 700-token budget, against 1 of 29 on dev: the cut-offs, chosen on dev's shorter documents, bind less on longer ones, and the budget becomes the limit. At the median, a response is 17–28% of the documents that state the facts. The largest is 2,122 tokens, against 2,004 before.
- **What is still missing.** Summaries: 4 of 20 ask sets on the two held-out sets. Their responses hold some of a summary's facts, often about half, but rarely all. Questions worded unlike the files are also missed, on dev and on held-out 1's natural questions.
- **Worse than before.** One ask set, on dev: "What weaknesses does the BRISK report acknowledge?". Before, its words named the report, so the whole report came back (1,481 tokens). Now the response says no file has "weaknesses" and gives 264 tokens without the limitations: a model has to ask again. None on the held-out sets.
- **A grader fix, made after seeing the results.** The first grading counted three held-out-2 absence answers as misses ("did the pilot cut asthma attacks?", "did it save money?") although they show the report's own statement ("The study did not measure health outcomes, such as asthma symptoms…", "No savings have yet been calculated"): it accepted only Lasso's "no indexed text has …" wording. Absence tasks now list the sentence that says so, where a document has one (`absence` in [the spec format](../../scripts/agent-eval/SPEC.md); three tasks), and both runs were regraded from their saved responses (`run.mjs --regrade`). No response changed; the baseline gained 2 ask sets on held-out 1, the current code 2 there and 3 on held-out 2. Before the fix: held-out 1 6 → 12, held-out 2 11 → 26.
- **Faster.** A median of 4–13 ms per ask set across the three sets, against 24–133 ms for the plain scan.

### What changed, and why

| | Before | Now | Why |
|---|---|---|---|
| Finding passages | Every word of the ask in one passage, found by scanning each folder's objects | BM25 over a [full-text index](#the-search-index) of each version's text, its label, and where it is (file, title, section, sheet, column, part, room). No word is required, and rare words count for more | A question rarely shares every word with its answer: most natural questions found nothing, or one passage |
| Structure | Sentences and paragraphs with page or line | Also a PDF's headings, table captions and table rows (each read with its header), and a Word file's headings. Sentences are read in order under their section | A row means nothing without its header, and a heading says what a section's sentences are about |
| Choosing evidence | Up to 3 passages a file, best first | The fewest sentences that cover the ask within `budget` (`src/agent/select.js`). Each is scored by the ask's words it has, weighted by rarity, its heading's words at 0.8, more for the wording of a finding or a figure beside an asked word. Then: sentences that repeat one already taken are skipped; a section already used counts against the next; a sentence that adds none of the ask's words and states nothing is taken only a few times a file (3 at the default budget). Each comes with the sentence before it when it points back ("This difference…") and the one after it when that qualifies it ("…was not pre-specified"). Neighbouring sentences are one excerpt, a table's rows one table | Evidence spread over sections is found, a fact keeps the qualification that changes its meaning, and a long file's many sentences sharing a few of the ask's words don't fill the budget |
| How much | Fixed counts | Files whose best match scores under 60% of the best file's are left out, unless one of their passages has every word of the ask. Sentences scoring under 20% of the best are left out. Both were chosen on dev by trying 0.25, 0.4 and 0.6 against 0.2, 0.35 and 0.5: the median response fell 20% and the largest 23%, and one ask set was lost | Size comes from what matches, not from a count |
| Tables | A table's matching cells as their rows | Rows whose own cells match; a match on column names alone returns those columns. `total`, `average`, `highest`… or `{op, column}` compute over every row (`complete`) | "Total adverse events" over 6 sites is one line, not 6 rows for the model to add |
| Periods | `Q4` matched through a synonym list | Calendar notation: Q4 and "fourth quarter", H1 and "first half", "the last quarter of 2025"; a period's months in a monthly table | A board report writes "fourth-quarter revenue" where the ask says "Q4 revenue". This is the only equivalence the search adds |
| Saying what it is | `found` or `none` | `status`: `complete`, `ranked`, `partial`, `ambiguous`, `not_found`. A ranked answer says how many matched sentences it left out, in which sections, and that a larger budget shows more | A selection read as complete is how a model concludes "the report doesn't mention it" |
| Absence | "no indexed text has X", checked word by word | Kept. Added: "has X, Y, Z together" only after an all-words query of the index finds no passage in scope, and `not_searched`, the files in scope Lasso could not read. Words that say what form the answer takes ("total", "summary") are not looked for, so never reported missing | Only checked absence is stated, and only as this search's result |
| Repeats within a call | Sent again | An excerpt already shown for an earlier ask is a pointer to it | Batched asks about one report overlap |
| The tool description | "Answers cover every indexed file and flag changed ones, so need no re-check" | "Lookups are exact; a search is ranked, says what it left out, and can miss other wording: ask again before saying something is absent" | The old claim told models to trust a ranked selection as complete |

Kept unchanged: local indexing and the app's extraction, batched asks, compact text answers, revision-pinned sources and handles, disagreements shown and never settled, scope and credential filtering.

### The search index

`<data>/derived/agent-text.sqlite` (SQLite FTS5, Porter stemming) is built from the object versions the app records, never from the files themselves, so it answers from the same snapshots as everything else. Each ask first indexes the versions recorded since the last, for up to about 1.5 s. Until the index has caught up, asks are answered by the earlier plain scan, as before. A PDF's or Word file's headings and table rows are read once per content hash. It is derived data, like the app's other derived indexes: the app never opens it, and deleting it only means it is built again. How long it takes to catch up on a large library has not been measured: on this machine's library (about 2 GB) it would also re-read each PDF and Word file once, and it was deliberately not run there.

No step calls a model. Nothing is summarised or embedded in the cloud, and nothing is spent outside the response itself.

### What it costs

- **Response size**: the table above. Every answer is measured as the text MCP sends, not as JSON.
- **Definition**: 173 real tokens per call against v4's 149 (gpt-5.4-mini's count, [token-probe.json](token-probe.json)): 24 more on every model call of every task, whether or not Lasso is used.
- **The lookup benchmark** ([benchmark-results.md](benchmark-results.md)): 16 of 16 correct. The saving against direct tools is 19.3%. It was 20.8% before phase 1, and 20.4% after it with the definition charged at v4's size. The last step is the definition, now charged at its measured 173 tokens: 24 more than v4's, on every call.
- **Local time**: a median of 4–13 ms per ask set once the index has caught up (24–133 ms before).

### What this does not show

- **Answers from a model.** These grades say whether the evidence was enough, not whether a model answered correctly from it. `gradeAnswer` is ready for that, but live runs need an API key and a budget, and live runs on the writing tasks and long conversations were not done.
- **Other wording.** BM25 matches words and their stems, not meaning. On dev, the natural questions miss what is worded differently in the file: "side effects" for adverse events, "after six months" for the 24-week result, "weaknesses" for limitations, "older adults" for participants aged 70 and over. Lasso uses no AI to bridge them; letting the model asking bridge them over MCP did not help live and was [rolled back](#other-words-and-sections-over-mcp-tried-and-rolled-back-31-october-2026).
- **Questions that need a computation the ask doesn't name**: "which clinic had the best follow-up" needs a ratio of two columns.
- **Long conversations.** Each call returns its evidence in full; only repeats within one call are dropped. Returning "only what changed" since an earlier call would need the server to know what the model still has in context, which it can't, so it is not done. Prompt caching makes re-read context cheaper, not smaller.
- **Handles for PDF table rows.** A row read from a PDF's layout is cited by page, without a handle.
- **A study named in the ask doesn't confine the search.** "Did the School Streets evaluation report any effect on children's asthma?" also brought sentences from the hospital evaluation, which shares "evaluation", "report" and "effect".

## Structural context: what is integrated

[structural-framework.md](structural-framework.md) specifies a context compiler (`src/agent/structural/compiler.js`), typed adapters for geometry, documents and spreadsheets (`adapters.js`), and explicit refinement (`refinement.js`). Its own measurements set how it is used here: its JSON packets were 25–32% larger than direct local results carrying the same evidence, so models never receive them. They receive `lasso`'s compact text, and the framework does the part it adds: computing and checking results from typed, revision-pinned records.

| Part | Used in `lasso` | How |
|---|---|---|
| STEP bridge and geometry operators (relative transform, axis angle) | Yes | `src/agent/geometry.js` reads the assembly with `readStepModel`, and `geometryContextFromStepModel` builds the records for the two instances. `compileContext` validates their closure against the file revision, which the evidence service resolves and authorizes; the model's text cannot assert one. A placement warning, a non-rigid matrix or an unknown unit is an `unsupported` error, as the framework requires |
| Rigid-placement check | Yes | An assembly's digest shows an instance's placement only when it passes the framework's `rigidMatrix` and the parser reported no placement warning |
| Box separation | No | It needs declared occupied solid boxes; part extents are not, and the framework forbids using them as such |
| Document adapter (declared dependencies) | No | It takes hand-declared `requires` links. The search's own context rules (a sentence that points back, a qualification that follows, a row's header) are heuristic links of the same kind, kept in `select.js` |
| Spreadsheet adapter (normalized formulas) | No | Lasso indexes a workbook's cell values, not its formulas, and the framework forbids guessing a normalization. Column totals stay with `lasso`'s own operations over every row |
| Refinement (patches against a retained digest) | No | Hosts give no proof of what a model still holds, and the framework asks for retention to be capability-tested per host first. Repeats within one call are already dropped |
| Exact selection over alternatives | Only inside geometry answers | Every other answer has one alternative per requirement, where exact and greedy selection agree |

The framework's tests (`node --test test/structural-*.test.js`) and its benchmark (`node scripts/structural-context-benchmark.mjs`) run unchanged. Two of its internals are now exported for this use: `rigidMatrix`, and `STRUCTURAL_WARNING`, the warning pattern the STEP bridge already applied.

## Running the live benchmarks

`scripts/agent-benchmark-live.mjs` runs a real model on four task families, each on its own generated library:

| Family | Tasks | Graded by | Arms |
|---|---|---|---|
| `lookup` | the 18 lookup tasks above | the generator's truth | direct, lasso (and `lasso-v1` … `lasso-v4`, earlier definitions) |
| `documents` | the natural question of each task in the evaluation sets (`--sets heldout,heldout2`, or `dev`) | `gradeAnswer`: material facts, qualifications, both sides of a conflict, computed values, absence said, and numbers found in no evidence | direct, lasso, upload |
| `writing` | the 12 writing requests | every fact a correct draft needs | direct, lasso, upload |
| `geometry` | 5 questions about two STEP assemblies' instances | the placements the files were written with | direct, lasso, upload |
| `scale` | 7 questions about a 5,000-row workbook and a 40-page PDF: a lookup, two totals and a maximum; a figure stated once beside an earlier one; a comparison stated once among similar sentences; an absence | values computed from what was written | direct, lasso, upload |

- **direct:** Read, Grep and Glob. For PDF, Word and Excel files they see the extracted text, as an agent with a document converter would.
- **lasso:** the same tools plus the current `lasso` tool and instructions; the model chooses.
- **upload:** no tools. The request arrives with the files that hold its answer attached, as text, as a chat upload is. A file over 400,000 characters cannot be attached (the IFC house), and that task is skipped in this arm.

```bash
node scripts/agent-benchmark-live.mjs --model mock --families all
OPENAI_API_KEY=… node scripts/agent-benchmark-live.mjs --model gpt-5.4-mini --families all --budget 5
ANTHROPIC_API_KEY=… node scripts/agent-benchmark-live.mjs --model claude-sonnet-5-5 --families all --budget 5
node scripts/agent-benchmark-live.mjs --regrade docs/agent/live-results-gpt-5.4-mini-lookup+documents+writing+geometry.json
```

- **Dry run first.** `--model mock` is a scripted model, not a real one: it calls `lasso` with the request, or Globs and Reads the files whose names share its words, or answers from the attachment, and it repeats what came back. It spends nothing; its token counts are estimates and its grades mean nothing. It checks that every family, arm, tool, grader and report runs; all four families take about 16 s.
- **Spend.** Prices are recorded per model, and a model without one is refused. Before every call, a guard stops the run if the call's worst case could take spending past `--budget` dollars (default 4). `--task-budget` ends a task once its conversation has cost that much; it is recorded as stopped (`cost-cap`) and wrong. Results are written after every task.
- **Grading drafts.** A writing task's draft is graded on what a correct draft states: the year's total, the best months, each quarter's margin. The offline writing benchmark instead checks that evidence holds every figure a draft is worked out from. An amount is right when the truth rounds to it at the precision it is written with: "$5.89 million" passes for $5,890,250, and "$5,880,250" does not. Percentages may differ by up to 0.05 points.
- **By kind of file.** The report groups tasks by the files their answer is in (3D model, Excel, PDF, Word, notes or mixed) and gives each arm's correct answers and tokens, and Lasso's saving against direct tools and against uploading.
- **What a run records.** For every call: the provider's usage (input, cached input, output, reasoning). For every task: the answer, the tool outputs the model saw (to regrade numbers against), each tool call's arguments, and the grade with its details. `--regrade` grades a saved run again without calling a model.
- **Providers.**
  - **OpenAI:** the Responses API; `--key-file` or `OPENAI_API_KEY`.
  - **Claude:** the Messages API through the official SDK (`@anthropic-ai/sdk` 1.3.0, a dev dependency); `--anthropic-key-file`, `ANTHROPIC_API_KEY`, or the credentials the SDK finds itself (an `ant auth login` profile). Priced models: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` and `claude-fable-5-1`.

  Claude runs as a host runs it: adaptive thinking at the run's `--effort`, replies up to 16,000 tokens, automatic prompt caching, every tool result of a turn in one message, and each reply sent back whole, thinking blocks included. Cache reads and writes are recorded and priced apart, as Anthropic bills them. Server-side refusal fallbacks are off, because a fallback would answer with another model under the named one; a refusal ends its task and is recorded as one.

  `test/agent-live-harness.test.js` checks both providers' requests, results and usage against stand-ins. A full run on a Claude model has been made against a local stand-in of the Messages API (`ANTHROPIC_BASE_URL`); none against Anthropic.
- **Definitions.** `node scripts/agent-token-probe.mjs` measures, for a few cents, the real tokens of the direct tools, of each earlier Lasso definition and of the current one. Run it beside the first live run; the offline benchmark then charges the measured size. With `--model claude-…` it counts with Claude's `count_tokens`, which generates nothing, and writes `token-probe-<model>.json`.

## Live results by kind of file (gpt-5.4-mini, 30 October 2026)

One run of every family but the lookups, at reasoning effort `low`, on the final code: [live-results-gpt-5.4-mini-geometry+scale+writing+documents.md](live-results-gpt-5.4-mini-geometry+scale+writing+documents.md). It spent $1.01, of which the Lasso arm $0.26, direct tools $0.51 and uploading $0.25; no task reached the $0.20 per-task cap. Each cell gives correct answers and tokens; savings are Lasso's, over the tasks both arms ran.

| Kind of file | Size | Tasks | Lasso | Direct tools | Upload | Lasso vs direct | Lasso vs upload |
|---|---|---|---|---|---|---|---|
| 3D model | STEP part and assemblies | 7 | 7/7, 29,229 | 6/7, 167,941 | 7/7, 71,166 | **82.6%** | **58.9%** |
| 3D model | IFC building, 4 MB | 1 | 0/1, 3,040 | 0/1, 70,261 | too large to attach | 95.7% | – |
| Excel | 5,000 rows | 4 | **4/4**, 5,974 | 2/4, 369,647 | 2/4, 566,456 | **98.4%** | **98.9%** |
| Excel | 6–12 rows | 7 | 7/7, 41,632 | 4/7, 43,554 | 4/7, 4,141 | 4.4% | −905% |
| PDF | 40 pages | 3 | 3/3, 10,882 | 3/3, 69,085 | 3/3, 41,354 | **84.2%** | **73.7%** |
| PDF | 8–9 pages | 19 | 10/19, 121,491 | 9/19, 114,841 | 13/19, 74,065 | −5.8% | −64.0% |
| PDF | 1–2 pages | 2 | 1/2, 6,875 | 1/2, 6,049 | 2/2, 755 | −13.7% | −811% |

Two Word tasks and 13 tasks whose answer spans several kinds of file are in the full report, as is each task's trace.

- **Where it saves.** Large files and 3D models: one call returns the row, total, sentence or relation asked for, where file tools page through the file and an upload sends all of it on every call. On the 5,000-row workbook, only Lasso answered every question: direct tools and uploads summed a column by hand and got it wrong.
- **Where it does not.** Small files cost less to attach than one tool call: the direct tools' and Lasso's definitions alone are about 450 tokens a call. On the 8–9-page reports, the model often asked Lasso to *find* the report ("the study about Halden streams …") and then read it with Read and Grep (20 of 34 tasks), paying for both. It also missed more of what the whole text shows: a conflicting memo (wrong on 3 of 4 conflict tasks, against 0 of 4 when uploading) and a qualification on another page (2 of 5, against 0 of 5). The offline evaluation, which sends the asks its tasks list, had these at 4 of 4 and 6 of 6: a model's own asks are worded differently, so offline sufficiency did not carry over.
- **The IFC task** was graded wrong in both arms, partly by the task: Lasso's answer gave the rooms' gross floor areas where the task lists net ones (both are in the file), and the direct arm wrote "Küche" as an escaped `\u00fc`.
- **Caveats.** One run per arm, one model, generated files. The same task in the same arm varied up to 30× between earlier runs, so per-row differences are noise; the large-file and 3D differences are not. Fixes made before this run, while writing the 5,000-row and 40-page tasks: totals now cover every row of a table larger than the cells the index keeps (before, a total over the first 300 of 5,000 rows was reported as complete), a value named with its column filters the rows, and a named file without the ask's words says so. The writing drafts were first graded on the evidence checks (all 12 monthly figures in a one-line annual total); they are graded on what each draft should state, and amounts by the precision they are written with.

## The mid-size document gap: cause and fixes (30 October 2026)

The live run's 8–9-page reports were the one place Lasso did worse than attaching the files. Replaying the asks gpt-5.4-mini actually sent (`lasso` calls from the run's traces, on the same libraries, no model called) found the cause in Lasso, not the model. Its responses held what the answer needed for only 12 of 34 tasks, and 17 of the 20 times the model went on to read the report itself followed an insufficient response. The model had reason not to trust them. Four causes, each fixed in general:

| Cause | Fix |
|---|---|
| Any word of the ask in no file cut the evidence to 150 tokens. Meant for asks about something not there ("West division"), it fired on nearly every natural question ("went", "instead", "picked") | Only when half or more of the words sought are in no file |
| Models sent `budget: 5` or `8` (a count of results), read as 100 tokens | A budget under 100 is ignored; the schema says it is tokens |
| Sentences from introductions, previous-studies sections (other studies' figures, in the same words) and references outranked the report's own results | Section roles from headings: references never, background half, unless asked |
| "The main results of X" shares no word with the results themselves | For a findings question naming one document: its findings and summary sentences are candidates, and its file-name words do not rank them |
| Phrasing words ("find the relevant passage") counted as content | Not looked for |

On the replayed asks, responses now hold what the answer needs for **21 of 34** tasks (12 before). On the authored asks: dev 15 of 24 (unchanged), held-out 1 18 of 32 (14), held-out 2 30 of 36 (29). Those three sets and the replay shaped these fixes, so they no longer measure them; a fresh set does (below). Responses are larger: a median of about 1,090 tokens on the 8–9-page reports, against 700–1,010 before. The remaining misses are paraphrase ("fines" for "penalty charge notices", "under their own steam" for walking or cycling, "one-year" for "52-week"), which word matching cannot find, and summaries that need more facts than fit the model's own budget.

**On a fresh set.** Held-out 3 ([spec](../../scripts/agent-eval/heldout3/spec.json)) was written after these fixes by a separate agent that read only the format spec: not Lasso's code, its results or the other sets. Its shape was set in the brief: two 7–9-page evaluation reports with numbered sections, a previous-studies section and references; a Word briefing that disagrees with one report figure; a workbook; a Markdown note; and a distractor. It has 18 tasks, each asked twice, once in keywords and once as a person would ask. Each version of Lasso ran on it once, before anything was changed for it: [before](eval-results-heldout3-baseline.md) (the code before phase 1) and [after](eval-results-heldout3.md).

| | Before | After |
|---|---|---|
| Sufficient ask sets | 12 of 36 | **20 of 36** |
| Keyword asks | 9 of 18 | 16 of 18 |
| Natural questions | 3 of 18 | 4 of 18 |
| Material facts | 23 of 62 | 37 of 62 |
| Response tokens (median / p90 / max) | 371 / 677 / 1,508 | 864 / 1,704 / 1,958 |

By kind of task, after and before:

| Kind | After | Before | Of |
|---|---|---|---|
| Lookups | 4 | 1 | 6 |
| Qualified | 3 | 1 | 6 |
| Conflicts | 2 | 0 | 6 |
| Aggregates | 3 | 2 | 4 |
| Summaries | 3 | 3 | 8 |
| Comparisons | 1 | 1 | 2 |
| Absences | 4 | 4 | 4 |

The files that state the facts are a median of 2,494 tokens as text.

- **The gain is in asks that use the documents' words.** Natural questions barely moved. In most of their 14 misses, the sentences that state the missing facts share no word with the question beyond its subject. For example, "came back broken" is asked for damage recorded at return, "how long until the heat pump actually goes in" for the weeks between survey and installation, and "the most popular thing" for the most borrowed item. Word matching cannot connect these; letting the model asking connect them was [tried and rolled back](#other-words-and-sections-over-mcp-tried-and-rolled-back-31-october-2026). Another miss needs the difference of two columns ("got their house checked but never had a heat pump put in"), which Lasso does not compute.
- **One ask set did worse.** "What did the heat pump project's board decide when they last met?" was answered before with the 25-line board notes whole. Now it gets five sentences: two from an unrelated report, matched on "lasted" and "met", and three from the notes. The notes' other decisions share no word with the question, so they were left out. Choosing sentences (phase 1) gives a short file's matching sentences instead of its text. A short file the ask is about should come whole.
- **Found from its misses, and fixed since.** Sentences matched a word's other forms only when its stem had four letters or more: "save" never found "saving", nor "home" "homes", nor "rate" "rates", though the index matches all of them. Words with the same stem now match in sentences as in the index. A short stem is still not read as the start of other words ("savvy" for "save").
  - On held-out 3 this adds one fact (38 of 62): the household saving, without its caveat. Held-out 2 goes to 31 of 36.
  - The other sets and the replayed asks are unchanged.
  - All four sets on the final code: [eval-results-pdf-gap.md](eval-results-pdf-gap.md). Held-out 3 has now been seen, so it no longer measures what comes next.
- **Live, the fixes held up** ([below](#other-words-and-sections-over-mcp-tried-and-rolled-back-31-october-2026)). On held-out 2 the model went on to read files after asking Lasso on 1 task of 18, against 10 before the fixes, using 54% fewer tokens.

## Other words and sections over MCP: tried and rolled back (31 October 2026)

Questions worded unlike the files ("came back broken" for "damage recorded at return") can't be matched by words, and Lasso uses no AI to bridge them. The model asking is already an AI, so for one day the MCP server tried helping it bridge the wording itself:
- **Other words in one ask.** `|` between words or bracketed phrases gave alternatives for one thing (`items returned damaged | broken`), counted once. The tool description asked for "the words the files would use".
- **Sections on a weak match.** A match was weak when a word of what was asked was in no file, or no shown sentence had half of it. The answer then kept its best 300 tokens of sentences and listed the sections of up to three documents that matched best ("4.5 Condition of returned items"), to ask again in their words.

It was on for MCP only: REST, the command line and in-process callers never changed, and the desktop app does not use the agent code. **It was rolled back the same day.** The MCP server answers as before, with the earlier definition (173 tokens), and all 128 eval responses are again identical to the earlier run, apart from handles.

**Offline it looked promising** ([eval-results-mcp.md](eval-results-mcp.md); the four eval sets, all seen before, 128 ask sets):

| | Complete answers | Tokens |
|---|---|---|
| As before | 84 | 124,504 |
| With the changes, first answer | 82 | 120,084 |
| With the changes, then one ask in the words of the heading over each missing fact | 97 | +16,237 for 21 second asks |

The second ask was an oracle: a model that picks the right section. Listing the sections in place of the sentences lost 11 complete answers on the first try, because 24 of the 47 answers flagged weak had been complete anyway.

**Live it did not help.**
- **Setup:** gpt-5.4-mini at reasoning effort `low`, one run, $0.47, on held-out 3 (its first live run) and held-out 2.
- **Arms:** Lasso with the changes, Lasso without them (`lasso-v5`: the earlier definition, answering as REST still did), direct tools, and upload on held-out 3.
- **Reports:** [held-out 3](live-results-gpt-5.4-mini-documents-mcp-heldout3.md), [held-out 2](live-results-gpt-5.4-mini-documents-mcp-heldout2.md).

| Set | Arm | Correct | Tokens | Read files after asking Lasso |
|---|---|---|---|---|
| Held-out 3 | Lasso with the changes | 11/18 | 67,781 | 3 of 18 |
| | Lasso without them (`lasso-v5`) | 12/18 | 69,386 | 4 of 18 |
| | Direct tools | 9/18 | 95,249 | – |
| | Upload | **14/18** | **60,520** | – |
| Held-out 2 | Lasso with the changes | 11/18 | 123,507 | 5 of 18 |
| | Lasso without them (`lasso-v5`) | 9/18 | 68,535 | 1 of 18 |
| | Direct tools | 8/18 | 90,547 | – |
| Held-out 2, 30 October | Lasso before the mid-size fixes | 7/18 | 147,842 | 10 of 18 |
| | Direct tools | 8/18 | 111,912 | – |
| | Upload | 11/18 | 63,088 | – |

- **The mid-size fixes hold up live.** On held-out 2, Lasso without the MCP changes went on to read files on 1 task of 18, against 10 of 18 the day before. It used 54% fewer tokens (68,535 against 147,842) and got 9 right against 7. The two runs were on different days, so part of this is noise; a fall from 10 to 1 is too large for all of it to be. Against direct tools in the same run, it used 24% fewer tokens on held-out 2 and 27% fewer on held-out 3, with as many or more right.
- **The changes did not help.** Over the 36 tasks they got 22 right against 21: 3 tasks were right only with them, 2 only without. They used 39% more tokens (191,288 against 137,921). Most of the extra is three held-out-2 tasks where the model went on to read the files; ss-fines took 22,604 tokens against 4,754. Two of those three had been shown a weak-match note.
- **The model barely used them.** One of 40 asks used `|`. Of 19 answers that listed sections, two were followed by an ask in a section's words and four by reading the files. A note that little matched seems to send a model to the files, not back to Lasso. With the trim, it also had less to answer from.
- **The definition cost more on every call:** 204 tokens against 173 ([token-probe-mcp-bridge.json](token-probe-mcp-bridge.json)). Charged at that size, the offline lookup saving would have been 17.9%, not 19.3%.
- **Upload still wins on the fresh set:** 14 of 18, in the fewest tokens.

The comparison arm (`lasso-v5`) was removed with the rollback, since `lasso` is that version again.

## Lean answers over MCP (11 November 2026)

A model re-reads every answer on each later turn, so what an answer carries besides evidence is paid for again and again. The recorded live runs showed what a model does not use: none of the 202 `lasso` calls passed a handle back, and none used an object ask. The `lasso` tool's text over MCP is therefore written lean:

- **No handles**, unless something offered can take one: the server was started with `--tools …,read` or `…,cite`, or the call passes `handles: true`. A value that was cut keeps its handle, since that is how the rest of it is read. Handles are still issued and recorded, and the JSON has them, so `format: "json"` and REST are unchanged.
- **Revisions at eight characters** (`@83757353`), the fewest an ask reads as a revision, so "at revision 83757353" still works.
- **Excerpts as the file's words**, without quotes, on one line. Values and row labels stay quoted, and lines of a file stay fenced.
- **Repeats on one line.** Excerpts an earlier answer of the same call already showed are named together (`shown in [1]: p.1, p.2, p.7`).
- **A shorter first line for a search**: still `ranked`, how many matching files it shows, what no file has, how many matched sentences it left out and where, and that a larger budget shows more. The count of sentences shown is gone. The budget hint was dropped too at first, since past 1,000 tokens a larger budget shows almost nothing more (88 of 128 ask sets complete at 1,500 to 4,000, against 87 at 1,000). It was put back after the live check, where the lean arm more often went on to read files; a second run with the hint back read files as often, so it is not what decides that.

It is on for MCP only (`askTextOptions` in `src/agent/mcp.js`). REST's text, the command line and in-process callers answer as before, and `lasso_search`, `lasso_read` and `lasso_cite` keep their handles, which is what they are for.

**Measured offline** ([eval-results-lean.md](eval-results-lean.md), no model called): on the four evaluation sets, all seen before, the 128 responses fell from 124,412 to 110,626 estimated tokens (−11.1%; median 1,007 → 884), and every response grades the same in every part (84 of 128 sufficient). The writing tasks keep their facts (23 / 24 / 21 of 24 ask sets) at 261 / 229 / 267 tokens an answer, from 279 / 242 / 285. The lookup benchmark stays 16 of 16 and its saving goes from 19.3% to 19.8%; its answers are short lines and records, with little to trim. All 104 phrasings still answer correctly. `benchmark-results.md` and `writing-results.md` were not regenerated.

**Live:** [run on 12 November](#live-check-of-lean-answers-and-whole-table-operations-12-november-2026). Fewer tokens on lookups, large files, assemblies and writing. On documents the median task is 18% smaller, but the model went on to read files on 8 of 36 tasks against 4 with the old text, in two runs, and the total is about level.

## Whole-table operations over MCP (12 November 2026)

Some questions have no excerpt that answers them: net sales by quarter, the orders whose stored total disagrees with quantity times price, the customers who ordered in every quarter, the ids that appear twice. They need every row. Lasso had one operation for them, a total, mean, extreme or count of one column, so in the operation-preserving trial (`trials/operation-preserving`, kept apart from Lasso) a model given only `lasso` rephrased the same question until its call cap: 144 model calls for 26 steps and 1.36 million tokens, of which 170 thousand were new tool output and the rest the conversation re-read on every call. The same model with plain operators took 62 calls and 162 thousand tokens, and got 22 of 26 steps right against 8.

The `lasso` tool now takes those operators, over MCP:

- **A query.** An ask that is a `SELECT` is run over every row of the tables it names: `SELECT Region, SUM(Net) FROM Orders GROUP BY Region`. A file named before it, after it or with it settles which table is meant: `"Operations 2025.xlsx": SELECT …`, `SELECT … in Operations 2025.xlsx`, `FROM "Operations 2025.xlsx".Orders`, `{sql, file}`. A table is a workbook's sheet, or a delimited file by its name. A column of two words may be written without quotes (`Unit Price`), as models write it.
- **Plain words, for the common cases.** `total Net by quarter of 2025`, `sum of Net grouped by Region`, `number of orders per Customer`, `average Qty for each Product`, `duplicate Order IDs`, `distinct Region values with counts`, `Orders rows where Region is blank`, `count of Orders rows where Region = North` and `Orders sheet total of the Net column` are turned into a query, which the answer shows (`ran:`) so it can be checked and asked again otherwise. Every column must be named as its table has it, and a quarter, month or year needs the table's one date column or a named one. A sheet the ask names is the table meant; else up to three tables that have the columns are answered, and none is chosen. A short table's total, or a measure by a column with no word for what to do with it, is answered as before: the table itself says more.
- **A cell, named as a spreadsheet names it.** `Summary!B12` or `'Net sales'!B2:C4` (up to 50 cells) gives each cell's text with its column's name and its row's label, `complete`. Values are what the cells hold; formulas are not read.
- **A line that says a query can read it all.** Where an answer shows a table in part, or answers an ask that wants something worked out with rows from a table of 30 rows or more, it names the file's tables, how many rows each has and their columns: `(a query reads every row: ask "SELECT … FROM Orders", with WHERE, GROUP BY or JOIN; Orders has 2,400 rows: Order ID, Date, Customer, …; Products 12: Product, Category, List Price, Unit Cost)`. It comes right under the answer's first line, and where the ask wants something worked out, or names a file for words it does not have, a long table's rows are cut to two: enough to see how its cells are written, and not re-read on every later call. A search's "first 12 of 215 rows" counts the rows that matched, and in the trial it was read as the whole table.

As text over MCP (the trial's workbook):

```
s1 = Finance/Operations 2025.xlsx @ab3814d7
[1] s1 Orders: 4 rows, over all 2,400 rows
  ran: SELECT 'Q' || QUARTER("Date") AS quarter, SUM("Net") AS "total Net" FROM "Orders" WHERE YEAR("Date") = 2025 GROUP BY 1 ORDER BY 1
  quarter | total Net
  Q1 | 6320209.095
  Q2 | 6284041.5185
  Q3 | 7436313.6135
  Q4 | 5996477.672
[2] s1 Orders, Products: 4 rows, over all 2,400 rows of Orders and all 12 of Products
  Category | margin
  Controls | 2545320.0415
  …
```

**The query language** (`src/agent/table-sql.js`) is one `SELECT [DISTINCT] … FROM t [LEFT] JOIN u ON … | USING (…) WHERE … GROUP BY … HAVING … ORDER BY … LIMIT n OFFSET m`, with a query in parentheses as a value or a list. Its functions are `COUNT SUM AVG MIN MAX GROUP_CONCAT`, `ROUND ABS NUMBER`, `UPPER LOWER TRIM LENGTH SUBSTR CONCAT`, `COALESCE NULLIF IIF CASE`, `YEAR QUARTER MONTH DAY DATE DATE_TRUNC STRFTIME EXTRACT`, `CAST`, and `ROW()`, the row's number in its sheet. A table or column answers to its name however it is spaced: `"Unit Price"`, `unit_price`. It is not SQLite: `WITH`, `UNION`, window functions and a query in `FROM` are refused by name, with what is supported. The evaluator is the trial's, moved here with what it learned live.

**What keeps an answer from being wrong without saying so:**

- **Every row, and it says how many.** Rows are read from the stored bytes of the indexed revision, or from the table index for a file too large to read in memory, never from the cells the search index keeps.
- **Text is never a number.** `SUM`, `AVG` and arithmetic over a cell of text are an error that names the text, and so is a date function on text that is no date. `NUMBER(x)` gives no value for text, for a query that means to leave it out. In the trial a mistyped query once came back as an exact, empty result, and the model answered "none".
- **Cells are read as written** (`src/agent/table-data.js`). A column is figures only when every filled cell is one. `007` is a code, a percentage is the fraction it stands for, `1,234.50` and `(450)` are figures, and `03/04/2025` is a date only when its column settles which part is the day. A column read as it stands is shown as its cells are written (`9.10`, `12.5%`); a figure worked out is shown as a number.
- **A name is never guessed.** A table two files have is `ambiguous` and lists them; a table or column no file has is answered with the names there are.
- **Work is bounded.** A join on equal columns looks its matches up; any other compares every pair, and past 20 million pairs or rows the query is refused, never cut short. A result longer than 1,500 tokens (or the call's `budget`) or 500 rows is cut and `partial`, and says `LIMIT` and `OFFSET` give the rest.

It is on for MCP only: `ask(request, actor, { mcp: true })`, passed by `src/agent/mcp.js`. REST, the command line and in-process callers are answered as before, and the same words sent to them are searched for. A benchmark standing in for an MCP host opens `openLocal({ mcp: true })`. The tool's definition is unchanged, so it costs nothing on a task that needs none of this: a model learns of queries from the line above, from `ran:`, or from an error that lists the tables and columns.

**Measured offline** (no model called):

- **Against the trial generator's truth**, on its 2,400-order workbook: net by quarter, the 3 repeated ids, the 6 orders whose stored Net disagrees with its parts, the 7 customers in every quarter and the total all match. Seven asks took 205 ms.
- **The trial's own first asks.** Replaying the first `lasso` call a model made on each of the six workbook tasks: two (quarter totals, repeated ids) are now answered outright by a query over all 2,400 rows, in 119 and 159 tokens. The other four (set logic, a formula check, a join, a cell reference) are answered as before plus the line that a query reads every row, about 30 tokens.
- **Nothing else moved.** The four evaluation sets are unchanged (84 of 128 sufficient, 110,626 tokens), all 104 phrasings answer correctly, the writing tasks keep their facts and sizes, and the lookup benchmark stays 16 of 16 at 19.8%.

**Live:** [run on 12 November](#live-check-of-lean-answers-and-whole-table-operations-12-november-2026) with the trial's harness, whose Lasso arm now answers as the MCP server does and has a `lasso-before` arm beside it. After that day's fixes, the five single-question workbook tasks are all right in both runs at 90% fewer tokens, level with the trial's plain operators.

**Limits.** Tables in workbooks and delimited files only: a PDF's or Word document's tables are still read as rows of text. A workbook's values are what its cells hold; formulas are not recalculated, and a percentage keeps the digits its cell shows. Dates are read in ISO form, with a month's name, or in figures when the column settles the order. Plain words cover grouping, counting and repeats; a filter over a range, a ratio of two columns and a join are asked as a query.

## Live check of lean answers and whole-table operations (12 November 2026)

gpt-5.4-mini, one run of each, $2.38 in all. Three arms ran side by side on the same tasks: `lasso` as the MCP server now answers, `lasso-before` with the same definition but answering as it did before both changes (what REST still gets), and a reference without Lasso's answers. Reports: [the benchmark families](live-results-gpt-5.4-mini-lookup+scale+geometry+writing+documents-before-after-2026-11-12.md), and `trials/operation-preserving/results/live-gpt-5.4-mini-operators-2026-11-12.md` for the whole-file tasks.

**The benchmark families** (effort `low`, 76 paired tasks, $1.17):

| Family | Tasks | Before: right, tokens | Now: right, tokens | Tokens, now against before | Against file tools, before → now |
|---|---|---|---|---|---|
| Lookups | 16 | 16, 32,459 | 16, 30,481 | −6.1% | −57.4% → −60.0% |
| 5,000-row workbook and 40-page PDF | 7 | 7, 28,659 | 7, 28,323 | −1.2% | −98.0% → −98.0% |
| STEP assemblies | 5 | 5, 11,651 | 5, 9,301 | −20.2% | −62.0% → −69.7% |
| Writing | 12 | 7, 33,524 | 10, 31,856 | −5.0% | −83.2% → −84.1% |
| Documents, held-out 2 | 18 | 9, 85,949 | 11, 115,141 | +34.0% | −25.3% → 0.0% |
| Documents, held-out 3 | 18 | 11, 61,054 | 12, 70,132 | +14.9% | −28.1% → −17.4% |
| All | 76 | 55, 253,296 | 61, 285,234 | +12.6% | −86.9% → −85.3% |

- **Four families used fewer tokens, and the documents more.** One document task accounts for more than the whole increase: on "which gate had the highest and lowest NO2" the new arm went on to grep and read the report eight times (53,076 tokens against 6,050) and got it right where the old arm was wrong. Without that task, all families together are 6.1% lower (247,246 → 232,158).
- **Where both arms made the same calls, the leaner text is what was measured offline or less:** 13.3% fewer tokens on 13 tasks of held-out 2, 2.2% on 11 of held-out 3.
- **The second step moved from Lasso to the files.** On the 36 document tasks each arm answered 26 after one `lasso` call. Of the 10 that took more, the old arm asked Lasso again on 6 and read files on 4; the new arm asked again on 2 and read files on 8. The lean text at that point did not end a search with "a larger budget shows more", which looked the likeliest cause. It was not: with the hint back, the run below read files on 8 of 36 again. Earlier runs of unchanged code read files on 5 to 8 of 36, so this may be chance; if it is the lean text, it is the handles or the quotes it dropped, which only a run of each would show.
- **More answers were right: 61 of 76 against 55,** with file tools at 52. No query was written in these families: their tables are small, and none of their tasks needs one.

**The whole-file tasks** (effort `medium`, 17 tasks, 26 steps, $1.21):

| Arm | Steps right | Model calls | Tokens | Cost |
|---|---|---|---|---|
| `lasso-before` | 6 of 26 | 147 | 1,101,220 | $0.553 |
| `lasso` | 13 of 26 | 129 | 1,190,103 | $0.517 |
| Plain operators (the trial's `direct`) | 23 of 26 | 69 | 202,430 | $0.141 |

- **Twice as many steps right, and no fewer tokens.** The median task used 23% fewer, the total 8% more.
- **Where a query applies, it worked.** On the five single-question workbook tasks, 294,081 tokens became 39,409 (−87%) and 1 right became 4. Two were answered from the model's own first words (quarter totals in 2,150 tokens against 82,617; repeated ids in 1,077 against 8,993).
- **Told that a query reads every row, the model wrote one, in all 4 tasks where it was told.** But 4 of its 8 queries failed on what this SQL does not take: `DATE_TRUNC`, `JOIN … USING (…)`, column names of two words written without quotes, and a file named after the query. And it once took `"Order ID"` for the customer, because the line names the tables and their rows, not their columns.
- **The five-step workbook sequence cost more:** 254,645 tokens against 58,795. The old arm gave up at 0 of 5; the new one kept asking and got 3 of 5, re-reading three 2,800-token answers of table rows on every later call. It wrote its first query on its eleventh call.
- **The PDF and STEP tasks, 11 of the 17, are outside what was built.** Both arms mostly failed them, and their tokens moved with how long the model went on asking (broken references 127,803 → 346,829, both 1 of 3).

**Fixed the same day, from those traces:** the SQL a model writes is taken (a column of two words without quotes, `JOIN … USING`, `DATE_TRUNC`, a file named after the query); the line that offers a query names each table's columns and comes right under the answer's first line; the budget hint is back; a filter, a count of each value, a measure by a column and a named sheet's total are answered from plain words; a long table is shown as two rows where its rows are not the answer; and a cell is read by its reference (`Summary!B12`), which the model had asked for three times and been sent the whole workbook each time. Sent again offline, all 8 queries the model wrote in the run above are answered (4 failed), and 14 of its 35 plain-word asks are answered by a query (4 before).

**Run again live** (the workbook tasks twice, the two document sets once, $0.48; `results/live-gpt-5.4-mini-operators-fixed-2026-11-12.md`, [documents](live-results-gpt-5.4-mini-documents-fixed-2026-11-12.md)). The "before" columns are the morning's run, so the sessions differ:

| Workbook tasks | Before | First version | Fixed, run 1 | Fixed, run 2 | Plain operators |
|---|---|---|---|---|---|
| Five single questions: right, tokens | 1 of 5, 294,081 | 4 of 5, 39,409 | 5 of 5, 25,141 | 5 of 5, 28,430 | 5 of 5, 22,912 |
| The five-step sequence: steps right, tokens | 0 of 5, 58,795 | 3 of 5, 254,645 | 4 of 5, 124,475 | 1 of 5, 78,170 | 5 of 5, 51,945 |
| All six: steps right, tokens | 1 of 10, 352,876 | 7 of 10, 294,054 | 9 of 10, 149,616 | 6 of 10, 106,600 | 10 of 10, 74,857 |

| Documents, 36 tasks | Right | Tokens | Median task | Went on to file tools |
|---|---|---|---|---|
| Before (morning) | 20 | 147,003 | 3,247 | 4 |
| First version (morning) | 23 | 185,273 | 3,029 | 8 |
| Fixed (afternoon) | 19 | 144,684 | 2,662 | 8 |
| File tools alone (morning, afternoon) | 19, 20 | 200,072, 213,669 | 6,123, 5,642 | |

- **The single-question workbook tasks are where the plain operators are:** 5 of 5 in both runs at 25,141 and 28,430 tokens, 90% under the old Lasso.
- **The sequence is still the cost,** and the two runs differ by more than the fixes: 4 of 5 at 124,475 tokens, then 1 of 5 at 78,170. Its second step asks why a summary cell disagrees with the rows, and the answer is in the cell's formula, which Lasso does not read. The model spent 9 and 12 calls looking for it.
- **Documents are level in total and 18% lower at the median.** The answers right, 19 to 23 of 36, move as much between sessions of unchanged file tools (19 and 20) as between versions.

**Not settled:** why the lean text is followed by more file reading (above), and the PDF and STEP tasks of the trial, which nothing here addresses. Reading a workbook's formulas would answer the sequence's second step.

## Whole-file operations: formulas, documents and assemblies (12 November 2026)

The live check left three things a query over tables cannot answer: why a summary cell disagrees with its rows (the answer is in its formula), and anything about the whole of a contract or an assembly. The operation-preserving trial had operators for all three, which a model used to get 23 of 26 steps right. They are now in `src/agent/ops/`, behind the one `lasso` tool, over MCP:

| Kind of file | Operations (`{file, op, …}`) | What they read |
|---|---|---|
| Workbook (`.xlsx`) | `cells` (values and formulas of a range), `deps` (what a cell feeds or reads, transitively), `whatif` (a recalculated copy with cells or formulas changed; it gets a revision, `r2`, that other operations can read with `rev`), `formulas` (the workbook's own account: sheets, columns, formula regions and their exceptions), `sql` | Every cell with its formula; a fixed formula language, recalculated here. A formula outside it is refused, never approximated |
| PDF document | `outline`, `read` (sections by number), `find` (every sentence that matches), `refs` (cross-references to or from a section, or broken), `terms` (definitions with their scope and uses), `affected` (what a change to a term or section reaches), `related`, `tables`, `whatif` (renumber, delete, add) | Numbered sections and appendices set apart as headings, sentences, tables and footnotes, explicit cross-references, defined terms. Read by pdf.js in a worker process, once per revision (about half a second for 41 pages) |
| STEP assembly | `count` (parts over every level), `tree`, `find` (by name, definition or bounds: `where:"zmax > 900"`), `bounds`, `clash` (every pair of solids that interpenetrates), `distance`, `clearance`, `whatif` (move parts on a copy) | Occurrences by path, composed placements in mm, boxes and cylinders exactly and any other solid as bounds; a pair is called overlapping or apart only when that is certain |

- **Asked by name or in plain words.** `{file:"Operations 2025.xlsx", op:"whatif", set:{"Summary!B3":0.15}, show:["Summary!B14"]}` is an ask like any other. So are `Summary!B12` (a cell: its column, its row's label, its value and its formula, `=SUM(Orders!I2:I2100)`), `formulas in Operations 2025.xlsx`, `broken cross-references in the agreement.pdf`, `what refers to Section 5.2`, `how many bolts in conveyor.step`, `parts above z = 910` and `do any parts overlap`: only what the words say outright; a question that needs judgement goes to the search as before.
- **Written the way a model writes them** (`src/agent/op-words.js`, 13 November). After the file's name, as words: `conveyor.step: whatif move:{"Roller assembly:15":{dz:10}}; clash all; distance Motor:1 Guard end panel:1`. As one `op` holding several, or a list in `ops`. Several in one ask run in order, and each one after a what-if reads the copy it made, so "move it, then measure the gap" is one ask. A sentence that only starts with an operation's name ("count every bolt…") is still read as a sentence.
- **More plain words read as operations** (13 November): a move ("if the Drive unit is moved 20 mm in −x", "raised by 10 mm", "by dz:10") is a what-if, with any gap asked measured on the moved copy; "how far would A have to be raised so that it no longer overlaps B" is a clearance; "sections that refer by number to Section 3.3" and "sections that mention Section 5.5" are the references to them; "if the definition of “Business Day” were changed, which sections would be affected" is `affected` (two steps where the words say "or refers to a section that does"); "after renumbering Section 9.4 to 9.7 and adding Appendix E" is a what-if that lists what is then broken; and "with Roll-up!B11 corrected to =SUM(Shifts!H2:H1801) and B3 changed to 25%, what would B13 be" is a recalculation showing B13. A part is found by its path, by a tail of it only one part has (`Motor:1`), or by its name alone when only one part has it ("the Drive unit"). A cell written without its sheet takes the sheet named beside it, or the one sheet where it fits.
- **Named in answers, not in the definition.** An answer that draws on such a file, for an ask about the whole of it, ends with the file's operations in one line (`(the whole workbook, exactly: ask "Operations 2025.xlsx: op; op" with op: cells range:… · deps … · whatif …)`), and so does an answer an operation gave from plain words. The line shows the string form since 13 November: that is how a model wrote operations back. The tool's definition is unchanged, so a task that needs none of this pays nothing for it.
- **A cell is read anywhere on its sheet,** the rows above a table included (a tax rate in `B3`), and a query can ask about the cell behind a value: `FORMULA("Net")`, `KIND("Net")` (`formula` or `literal`), `CALC("Net")` (recomputed), `ADDRESS("Net")`.
- **What it will not do is said.** A PDF without numbered sections set as headings has no whole-document operations, and a STEP file that is one part no assembly operations: an operation on either is `unsupported`, with the reason, and the operations are not offered for it. A result an operation could only bound says so (`bounded`), and one cut to the budget is `partial`.
- **MCP only,** like the queries: `{file, op}` sent any other way is read as it was before.

**The sequence, on fresh workbooks.** The trial's five-step workbook task was the only one of its kind, and everything built for it was built looking at it. `scripts/agent-live/sequence-variants.mjs` writes two others, made after the code: a payroll workbook (`Shifts`, `Roll-up`, a total whose range stops at row 1500 of 1801, a site spelt `Leds`, an on-cost rate and a euro rate) and a stock workbook (`Movements`, `Totals`, other cells, a range that stops at row 1000, a zone spelt `Chiled`, a duty rate). Each has the five steps (a check, an explanation, a correction, a recheck, a what-if) with the truth worked out by the generator. `test/agent-file-ops.test.js` asks, at each step, what a model would ask and checks the answers hold what the step needs: both totals and the formula that stops short; the rows left out and their sum; the three corrected cells from a what-if; the misspelt value and what it holds; the last cell at the new rate. All five steps of both pass, and a model then took them ([below](#live-verification-13-november-2026)).

**Measured offline** (no model called): the four evaluation sets are unchanged (84 of 128 sufficient, 111,708 tokens), all 104 phrasings answer correctly, the writing tasks keep their facts, and the lookup benchmark stays 16 of 16 at 19.8%. Sent again, the asks a model made in the live check on the trial's contract and assembly tasks are now partly answered outright: the first ask of "which parts extend above z = 910" gets the 14 occurrences from `find`, and the overall size is 60 tokens where it was 647. Of the 29 asks it made about broken references, 11 are now an operation's answer.

### Live verification (13 November 2026)

gpt-5.4-mini at effort `medium`, one run, $0.55 (`node trials/operation-preserving/bench/live.mjs --variants`, and the trial's own tasks with `--tasks workbook/summary-check,contract,assembly`; reports in `trials/operation-preserving/results/live-gpt-5.4-mini-variants-2026-11-13.md` and `…-operations-2026-11-13.md`).

**The fresh sequences,** three arms in one session:

| Arm | Payroll: steps, tokens | Stock: steps, tokens | Both: steps, tokens, cost |
|---|---|---|---|
| Lasso as it answered before | 3 of 5, 156,477 | not run (the spend guard stopped it) | |
| Lasso now | 4 of 5, 31,610 | 5 of 5, 24,246 | 9 of 10, 55,856, $0.050 |
| The trial's plain operators | 4 of 5, 61,713 | 5 of 5, 41,319 | 9 of 10, 103,032, $0.058 |

On workbooks made after the code, Lasso took the same nine steps as the plain operators in 46% fewer tokens, and the payroll sequence in 80% fewer than it did before. Both arms missed the same last step, by a few units: the model worked the what-if out by hand from rounded figures.

**The trial's sequence, contract and assembly tasks** (12 tasks, 21 steps; the other columns are the run of 12 November):

| | Steps right | Model calls | Tokens | Cost |
|---|---|---|---|---|
| Lasso before | 5 of 21 | 90 | 807,139 | $0.419 |
| Lasso, first version of 12 November | 9 of 21 | 108 | 1,150,694 | $0.484 |
| Lasso now | 17 of 21 | 64 | 375,993 | $0.280 |
| Plain operators | 18 of 21 | 55 | 179,518 | $0.127 |

| Kind | Before | Now | Plain operators |
|---|---|---|---|
| The workbook sequence | 0 of 5, 58,795 | 5 of 5, 44,201 | 5 of 5, 51,945 |
| Contract (6 tasks) | 4 of 8, 424,729 | 6 of 8, 274,801 | 6 of 8, 93,057 |
| Assembly (5 tasks) | 1 of 8, 323,615 | 6 of 8, 56,991 | 7 of 8, 34,516 |

- **The workbook sequence is right in every step,** at fewer tokens than the plain operators: the cell's formula answers its second step, which no run had got before formulas were read.
- **Three times the steps of the old Lasso at under half its tokens,** and one step short of the plain operators at about twice theirs. More than half of what is left is one contract task, "which sections would a change to Business Day affect" (211,270 tokens, wrong in every arm): the model asked for the references to sixty sections one by one, in words the `refs` operation was not read from, and never asked for `affected`.
- **The model asked in plain words, not in `{file, op}`:** 1 of its 72 asks was an operation by name, 8 named a cell. What it got right it got through the plain-word routes. Where it tried the operations it had been shown, it wrote them its own way (`… whatif move:{…}; clash all; distance A B`, or several operations inside one `op`), which was not read at the time ([it is now](#routes-for-what-the-model-wrote-and-the-run-again-13-november-2026)), and the two assembly steps it missed (a clearance, a gap after a move) are those.

### Routes for what the model wrote, and the run again (13 November 2026)

The verification's traces said what to do: the model asks in plain words and writes operations its own way, so both are now read (`src/agent/op-words.js`; the bullets "Written the way a model writes them" and "More plain words read as operations" above). Sent again offline, each ask that had gone unanswered gets the trial's own truth: the 14 sections a change to “Business Day” reaches in two steps (235 tokens with the operations line, where the model had spent 211,270 asking section by section), the two references still broken after the renumbering and Appendix E, a lift of 8 mm, a gap of 14 mm after both moves, and 359,498.40 for the payroll cell. Offline nothing else moved: 84 of 128 evaluation ask sets at 111,708 tokens, 104 of 104 phrasings, the writing tasks' facts (23, 24 and 21 of 24), the lookup benchmark 16 of 16 at 19.8%.

**Live, the same 12 tasks** (gpt-5.4-mini, effort `medium`, the Lasso arm only, one run, $0.140; `…/results/live-gpt-5.4-mini-routes-2026-11-13.md`). The other rows are the earlier runs:

| | Steps right | Model calls | Tokens | Cost |
|---|---|---|---|---|
| Lasso before (12 November) | 5 of 21 | 90 | 807,139 | $0.419 |
| Lasso with operations (13 November, earlier) | 17 of 21 | 64 | 375,993 | $0.280 |
| Lasso with these routes (13 November) | 17 of 21 | 59 | 177,854 | $0.140 |
| Plain operators (12 November) | 18 of 21 | 55 | 179,518 | $0.127 |

| Kind | Earlier the same day | With the routes | Plain operators |
|---|---|---|---|
| The workbook sequence | 5 of 5, 44,201 | 4 of 5, 33,509 | 5 of 5, 51,945 |
| Contract (6 tasks) | 6 of 8, 274,801 | 7 of 8, 59,336 | 6 of 8, 93,057 |
| Assembly (5 tasks) | 6 of 8, 56,991 | 6 of 8, 85,009 | 7 of 8, 34,516 |

- **Half the tokens for the same steps:** 375,993 to 177,854, level with the plain operators' 179,518 at one step fewer, and 78% under the old Lasso with more than three times its steps.
- **The contract tasks are where it went:** 274,801 to 59,336. The renumbering sequence is right in all three steps, and the “Business Day” task cost 10,582 tokens where it had cost 211,270. It is still marked wrong, as it is for the plain operators: the first answer held the 14 sections, and the model then asked for every section that refers to an affected one, got the whole chain, and gave 73.
- **Two of the four misses were answers given without asking.** The workbook's last step (the tax rate changed) and the lift that clears the cross member were answered from what earlier steps had shown: arithmetic by hand, and the overlap's depth (8 to 8.49 mm) read as the lift (8 mm).
- **The fourth was a route still missing.** For "which parts extend above z = 910" the model wrote `zmax > 910`, copied from the operations line, in four asks; none was read, and it ran out of calls at 66,693 tokens.
- **All in plain words again:** of 55 asks, none was an object, one was written as operations, two named a cell.

**Two more fixes, each checked live on the task it came from** (so these are not one run, and the tasks were run again after their misses were seen):

- A bound written in an ask (`zmax > 910`, `where zmax > 910 and xmin < 100`, "z coordinates above 910 mm") is a `find`. The task again: right, 4,497 tokens in 3 calls ($0.006).
- An interference result now says under its pairs that depth is how deep a pair overlaps, not how far to move one clear, and names the `clearance` that answers that. The model then asked, in the operation's own words ("the clearance move needed to raise Roller assembly:15 … so that none of its parts overlaps Cross member:4"), which was not read: 3 of 4 again, 22,971 tokens ($0.014). With that read too, the four-step interference task was right in every step, for the first time in any Lasso run, at 18,248 tokens ($0.014; the plain operators had 3 of 4 at 21,091).

**The fresh sequences again** (the Lasso arm, $0.053; `…/results/live-gpt-5.4-mini-variants-routes-2026-11-13.md`): 8 of 10 steps at 49,563 tokens, against 9 of 10 at 55,856 earlier the same day and the plain operators' 9 of 10 at 103,032. The payroll what-if was again answered without a call, by hand, 12 off. The stock sequence's first step is marked wrong on form only: both figures are right and the reply says "No", but not on its `ANSWER` line. A first attempt at this run stopped after $0.028 with nothing recorded, because its spend guard was set too low.

**What is left is the model's, not a missing operation:** it answers a what-if from earlier figures instead of asking, and reads "refers to a section that does" as a chain. Neither is touched here: the tool's definition and instructions are as they were.

**Limits.** Documents need numbered sections set as headings; a Word document has no operations yet. A workbook's formulas outside the fixed language (array formulas, external references, defined names) are refused. Only boxes and right circular cylinders are exact solids. What-if revisions live as long as the connection that made them.

## Next steps

1. **More live runs:** a second run and model, a Claude model, and the lookups. Long conversations are not covered by any family yet.
2. **Retrieval, without AI in Lasso** (simulated on the eval sets, not built):
   - **Answer types** ("how long" wants a duration), to rank and to size an answer.
   - **A summary digest:** each report's abstract, its results sections' stating sentences and its conclusions.
   - **Conflicts:** other statements of the same measure with another value, shown together.
   - **A short file the ask is about**, given whole.
   - **Findings questions with a long subject**, recognized as asking for findings.
   - **Abbreviations defined in the files** ("nitrogen dioxide (NO2)").
   - **A human-made thesaurus (WordNet):** a trial, which needs a download.

## What the benchmark does not show

- **No Claude measurements, and few models.** The live runs used OpenAI models, so the token counts are provider-recorded for those models and their tokenizer only. v4 was measured on gpt-5.4-mini (2 runs) and gpt-5.3-codex (1 run); gpt-5.5 and a Claude run with `count_tokens` are still to do.
- **The live runs predate the writing-task changes.** They measured the lookup tasks with the first version of the `lasso` tool. The resolver changes for writing tasks, and then the retrieval changes, kept every lookup answer correct offline (104 of 104 phrasings, 16 of 16 tasks) and changed the offline saving from 21.2% to 20.8% and then 19.3% (most of the last step is the larger definition), but have not been run live.
- **Few live runs.** Two runs per setting at one reasoning effort. The same task in the same arm varied up to 30× between runs, so the totals carry wide uncertainty.
- **Parser parity.** The lookup corpus is text: code, CSV and Markdown, which direct tools read natively. Binary formats (XLSX, PDF, DOCX, STEP, IFC) are covered only offline, by the [writing tasks](#writing-tasks-spreadsheets-reports-and-3d-models).
- **Single-task conversations.** In a long session, prompt caching makes definitions cheap in dollars, though not in token volume, and earlier evidence is re-read on every later turn.
- **Two capability tasks.** Quoting a cited line range at an old revision, and a value before its last change, aren't counted in `S`: direct tools cannot do them without a version archive.

## Other limitations

- Search is lexical: words and their stems, ranked by rarity, without their meaning. A question worded differently from its answer is missed or half found ([examples](#what-this-does-not-show)), and the response says it is a ranked search that can miss other wording. Code symbols for `lasso_search` come from Lasso's existing indexer, which misses forms such as `export function`; `lasso_read {symbol}` scans definitions itself and finds them.
- Asks are read lexically. A question has to carry the words of what it is about: "the West division's revenue" finds rows labelled "West division", but "the region that grew most" finds nothing to compute it from. Lasso returns evidence and computes a column's total, mean, highest, lowest or count over every row; it does not compare, rank or summarize. Over MCP a query can group, filter, join and order a table's rows ([above](#whole-table-operations-over-mcp-12-november-2026)).
- A PDF's tables are read from its text layer by layout: rows of figures under a caption, until a gap. A table set as an image, or with cells wrapped onto several lines, is read as sentences.
- Row labels come from the first text column of small tables and from the row index of large ones; a table whose rows are named elsewhere is searched by its values only.
- A handle that could not be recorded because the store was busy resolves only in the process that issued it.
- One MCP process per host connection keeps its own caches: about 156 MB RSS measured here. Several hosts at once mean several processes.
- The REST server is per library and per scope. `ensure` with a different scope than the running server's is refused, not silently widened.

## Configuration reference

| Option | Default | Meaning |
|---|---|---|
| `--data-dir` / `LASSO_DATA_DIR` | the desktop app's library if present, else `./.lasso-data` | The library to read |
| `--scope` (repeatable) / `LASSO_AGENT_SCOPE` (JSON list or `;`-separated) | none: every call fails with `scope_not_configured` | Folders an agent may read; `*` shares every enabled folder |
| `--idle <seconds>` | 300 (0 never idles) | REST idle shutdown |
| `--port` | 0 (ephemeral) | REST port, always on 127.0.0.1 |
| `--tools` | `lasso` | MCP tools offered: `lasso`, `search`, `read`, `cite` |
| `LASSO_AGENT_METRICS=<file>` | off | Appends one JSON line per call: operation, transport, ms, bytes, estimated tokens |

Files: `<data>/agent/rest.json` (address and token, 0600), `rest.lock`, `rest.log`. REST also serves `GET /agent/v1/status`, `GET /agent/v1/metrics` and `POST|PUT|DELETE /agent/v1/leases[/id]`.

## Tests

```bash
node --test test/agent-*.test.js test/structural-*.test.js
node scripts/agent-ask-phrasings.mjs        # 104 phrasings of the lookup tasks
node scripts/agent-writing-benchmark.mjs    # the writing tasks
node scripts/agent-eval/run.mjs --set dev   # questions about documents; --set all adds the held-out sets
```

They cover:
- reading asks: ranges and range lists, definitions, folders, revisions, disk, history, enumerated parts
- asks answered in one call: lines, definitions, records that agree, differ or rank, absence, passages, history, revisions, the file as it is now, folder words that settle a shared name, object asks
- asks made while writing: several rows at once, a quarter's months, whole table rows, Word paragraphs in order, stems, a model's parts and holes
- searching documents: the index filled from the store and caught up after a capture, PDF headings, captions and table rows, sentences chosen across sections with what qualifies them, a tight budget, sentences that only repeat the ask's words, statuses, absence said only when checked, a column's total and highest, Q4 found as "fourth quarter", repeats within a call
- assemblies: instances placed in a digest, one instance seen from another whichever way it is asked, the object form, an unknown instance named in the error
- the live harness: OpenAI requests and usage against a stand-in, the mock model, the document converter, and assembly grading
- the structural framework's own tests: closure, exact selection, budgets, repeated instances, unsupported inputs, stale records and refinement
- the evaluation's grader: a short correct answer passes; a missing qualification, a conflict given as one value, a scrambled table and an invented number fail
- exact inclusive ranges, with a literal-parity property test over random ranges
- duplicate names, pinned and historical revisions, and disk changes
- credential and exclusion filtering, and scope enforcement
- records and competing sources, binding with constraints, and change reporting
- paging, budgets and stale cursors, plus cross-process handles
- symbols, and large tables, including a row the app records concurrently
- MCP over a real stdio process: negotiation, cancellation, errors and exit on disconnect
- REST: token, Origin and Host checks, single instance, leases, idle shutdown, on-demand start and reuse
- identical answers over MCP, REST and in-process calls, with `lasso`'s text lean over MCP only
- lean text: no handles unless a tool takes them or the call asks, short revisions, unquoted excerpts, repeats on one line, and the default text unchanged
- whole-table queries: grouping, joins, a query in parentheses, dates and quarters, text never a number, names not guessed, work bounded; cells read as written
- whole-file operations: a workbook's cells with formulas, dependents and what-ifs; the fresh sequence variants step by step; a contract's outline, cross-references, terms and renumbering; an assembly's counts, bounds and interference; plain words that mean an operation (a move, a clearance, a gap, references, what a changed definition reaches, a renumbering, a cell changed) and words that do not; operations written loosely after a file's name, in one `op` or in `ops`, run in order on a what-if's copy; MCP only
- whole-table asks: every row of a sheet, a join across sheets, plain-word totals by group, filters, value counts and repeats, a cell by its reference, the queries a model wrote live, a shared table name listed, a long result cut, a long table shown as two rows where its rows are not the answer, and MCP only
