# Lasso for AI agents

AI agents can read the user's Lasso library through two on-demand interfaces:

- an **MCP server over stdio** (`lasso-agent mcp`), which an AI host starts when it connects and which exits when the host disconnects;
- a **local REST API** (`lasso-agent serve` / `ensure`), started on demand on loopback with a bearer token. It stops itself once idle and no client holds a lease.

Both call the same **evidence service** (`src/agent/evidence.js`), which reads the same snapshots, object versions, blob store and search graph the editor and terminal use. No second index, database or search engine is added. Nothing runs permanently for the integration.

There are two sets of measurements, on the same 18 tasks and the same generated library:

- **Live, provider-recorded** ([live runs](#live-model-runs-provider-recorded)). OpenAI models choose their own steps; every model call's usage is recorded. Lasso's first release was ignored by the models and, when they were told to use it, cost more tokens. Three measured iterations ([v1 → v3](#making-models-use-lasso-v1--v3)) changed that. With the current server, gpt-5.4-mini used Lasso on 23 of 32 tasks and spent **13% fewer tokens** than with file tools alone (document tasks −39%, code tasks +98%). Correctness was equal, and it answered revision questions the file tools cannot.
- **Offline, scripted** ([benchmark-results.md](benchmark-results.md), `node scripts/agent-benchmark.mjs --runs 5`). Fixed, competent call sequences, with tool definitions charged at their measured real size and everything else estimated. The current server saves 7.3% of tokens (documents 14%, code break-even), with 37% less evidence, a third fewer round trips and 60% fewer tool calls. It was correct on every task.

The savings come from document work: table rows, competing sources, absent values, long reports. On small code reads, Lasso's per-call definitions cost more than they save. Only two live runs per setting were made, on OpenAI models; see [What the benchmark does not show](#what-the-benchmark-does-not-show).

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

The server offers `lasso_search` and `lasso_read`. Add `--tools search,read,cite` to offer `lasso_cite` as well. It fills templates from recorded values, at 88 more real tokens per model call.

### REST

```bash
node src/agent/cli.js ensure --scope Finance --idle 300
```

`ensure` prints `{"url","token","pid","started"}`. It reuses a server already running for the library; otherwise it starts one in the background.

```bash
curl -s "$URL/agent/v1/inspect" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"items":[{"file":"app.py","folder":"App","lines":"5-12"}]}'
```

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
          src/agent/evidence.js EvidenceService: suggest / inspect / bind  ← src/agent/scope.js authorization
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

The desktop app may run at the same time. Both read the store in WAL mode. The agent's only writes are handle and binding rows, in short transactions; if the store is busy, handles stay in memory and the response says so.

---

## Tool contracts

Every piece of evidence has a 10-character handle that names one immutable thing: an object version, a line range of one file revision, or a cell of a large table's revision. File details are given once per answer, as sources `s1`, `s2`…, and candidates point at them.

**Formats.** The service returns the JSON shown below, and that is the contract; REST answers in it by default. Over MCP a model receives the same answer as compact text (`src/agent/render.js`), which measured 26–27% fewer real tokens. Values stay JSON-quoted so their exact characters survive, and file text is fenced exactly as the file has it. Pass `format: "json"` (MCP) or `"format": "text"` (REST) to get the other. The same search as text:

```
s1 = Finance/Planning/budget.csv @dd459a8353ec
s2 = Finance/Approved/budget.csv @a1adad958009
g1: 2 of 6; 2 exact; more: cursor "K6ST.FNTD.2"
- s2 record "North division" row 2: Revenue="11.9" #6BVEWRTB04, Scenario="Approved" #C0XAHZQPX8 (exact name)
- s1 record "North division" row 2: Revenue="12.4" #ACZK1G04AR, Scenario="Planning" #9HQZ5XW75Z (exact name)
```

**Forgiving where it costs nothing.** Tuning numbers (`limit`, `budget`, `context`) out of range are brought into range rather than refused. A citation style other than `"none"` gives numbered citations. A handle copied with its `#` is accepted. `folder: "."` means every folder, and `"Finance/Approved"` means the Finance folder under `Approved`. Identity inputs (file, revision, handle) stay strict. In live runs, refusing a model's `budget: 150` had cost it a whole turn and sent it back to grep; such refusals were 22 of the 31 failed calls across the two v2 arms.

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
- **Indexed vs disk.** Every source reports `disk: "changed"` or `"missing"` when the file on disk no longer has the indexed bytes (size and mtime, then hash). `version: "disk"` reads the current file. That works only for a file the index knows, only if its real path stays inside its folder, and the result is marked `unindexed` and gets no handle.
- **Pinned revisions.** `rev` reads any revision Lasso captured, marked `historical` with the `current` revision named. A revision Lasso never captured is `revision_not_found`, never the current file.
- **Scope.** Only folders named with `--scope` that are enabled in Lasso. Authorization runs before retrieval: files outside the scope add no names, counts or previews.
- **Credentials.** `.env*`, keys and certificates (`*.pem`, `*.key`, `id_rsa`, …), `credentials*`, `secrets*`, and anything under `.ssh`, `.aws`, `.gnupg`, `.git` and the like are never returned, even inside a shared folder.
- **The person's exclusions.** Paths excluded from autocomplete with a terminal rule are excluded for agents too.
- **REST.** Loopback is not trusted by itself. Every request needs the bearer token from `<data>/agent/rest.json`, which is mode 0600 inside a 0700 directory. Requests with an `Origin` header or a cross-site `Sec-Fetch-Site`, and requests addressed to any host other than loopback (DNS rebinding), are refused.
- **Prompt injection.** File contents are returned as JSON string values, and the MCP instructions state that result text is file content, not instructions. That reduces the risk; it doesn't remove it.

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

---

## Live model runs (provider-recorded)

`scripts/agent-benchmark-live.mjs` runs the same 18 tasks on the same generated library through OpenAI's Responses API. The arms:
- **direct:** Read, Grep and Glob.
- **lasso (v1, v2, v3):** the same plus a version of Lasso's tools and instructions, as an MCP host would add them; the model decides.
- **lasso-first:** the same, plus one instruction to prefer Lasso and fall back to the file tools.

Every model call's `usage` is recorded: input counts the whole context each call, and output includes reasoning. Tasks run in random arm order, at fixed reasoning effort `low`, with a hard spend guard. Answers are graded against the generator's truth. Total spend for all live runs and probes was about $4.05.

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

### Making models use Lasso: v1 → v3

The first runs showed that models don't pick Lasso by themselves, so the next step was getting them to pick it. Each version was changed only where the previous run's call traces showed a cause, then measured live on gpt-5.4-mini: 2 runs each, the model choosing freely (no "prefer Lasso" instruction), against direct tools in the same runs. Full tables: [v1 and v2](live-results-gpt-5.4-mini-v2.md), [v2 with forgiving inputs](live-results-gpt-5.4-mini-v2b.md), [v3](live-results-gpt-5.4-mini-v3.md).

| Server | What changed | Used Lasso on | Also used file tools on | Failed Lasso calls | Correct (direct) | Tokens vs direct | Cost vs direct |
|---|---|---|---|---|---|---|---|
| v1 | first release | 0 of 32 tasks | — | — | 29/32 (29/32) | −73.8% | $0.167 vs $0.123 |
| v2 | names, when-to-use guidance, compact text, limit 5 | 20 | 15 | 14 of 79 | 27/32 (29/32) | −158.1% | $0.208 vs $0.123 |
| v2 | + forgiving tuning inputs | 22 | 17 | 2 of 78 | 28/32 (28/32) | −74.1% | $0.173 vs $0.128 |
| v3 | + "no second check" instructions, cite on request | 23 | 8 | 0 of 75 | 28/31 (27/31) | **+13.1%** | **$0.131 vs $0.139** |

Negative means more tokens than direct. In the v3 run the spend guard stopped the last direct call, so 31 pairs. The v1 and the first v2 row come from one four-arm run, which also tried v2 with "prefer Lasso" (23 of 32 tasks, −120.6%).

In v3 the saving is concentrated:
- **Document tasks are 39% cheaper.** Proving a division absent fell from 32–36k tokens to 7–10k, now that "none matches exactly in any shared folder" is said in words.
- **Code tasks cost 98% more.** Lasso's 387 tokens per call outweigh exact reads that are already small with Read.
- **Per task, Lasso still used more tokens on 26 of 31**, typically about 800 tokens of definitions on a 1–2k-token task. The total is lower because of the large document tasks.

v3 answered the old-revision task in 2 of 2 runs and the earlier-value task in 1 of 2; direct tools managed 0 of 2 on each.

Reproduce (spends money; `--budget` caps a run):

```bash
OPENAI_API_KEY=… node scripts/agent-benchmark-live.mjs --model gpt-5.3-codex --runs 2 --effort low --budget 2.5
```

`--arms direct,lasso-v3` chooses arms (`lasso-v1`, `lasso-v2`, `lasso-v2-first`, `lasso-v3`), `--tasks id,…` limits the tasks, `--label` names the results file, and `--regrade <file.json>` reapplies the graders without calling the model. Each call's tool arguments and failures are kept in the results' `trace`. Prices are recorded in the script, and a model without a price is refused. `scripts/agent-token-probe.mjs` measures, for a few cents, the real tokens of each version's definitions and of every answer as JSON and as text ([token-probe.json](token-probe.json)). The earlier definitions are kept in `scripts/agent-tools-versions.mjs`.

## What the benchmark does not show

- **No Claude measurements, and v3 measured on one small model.** The live runs used OpenAI models, so the token counts are provider-recorded for those models and their tokenizer only. v3 was measured only on gpt-5.4-mini; Codex and gpt-5.5 runs of v3, and a Claude run with `count_tokens`, are still to do.
- **Few live runs.** Two runs per setting at one reasoning effort. The same task in the same arm varied up to 30× between runs, so the totals carry wide uncertainty.
- **Parser parity.** The corpus is text: code, CSV and Markdown, with a long Markdown report standing in for a long PDF. Direct tools read those natively. Binary formats (XLSX, PDF, DOCX, CAD), where a direct agent needs conversion scripts, are where the proposal expects the largest gains; they weren't tested.
- **Single-task conversations.** In a long session, prompt caching makes definitions cheap in dollars, though not in token volume, and earlier evidence is re-read on every later turn.
- **Two capability tasks.** Quoting a cited line range at an old revision, and a value before its last change, aren't counted in `S`: direct tools cannot do them without a version archive.

## Other limitations

- Search is lexical, matching words rather than phrases, so a query should carry the question's distinguishing words. Code symbols for search come from Lasso's existing indexer, which misses forms such as `export function`; `lasso_read {symbol}` scans definitions itself and finds them.
- Models still do not batch: the 6-fact task took 9 separate searches in v3, against the description's request.
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
| `--tools` | `search,read` | MCP tools offered; add `cite` for `lasso_cite` |
| `LASSO_AGENT_METRICS=<file>` | off | Appends one JSON line per call: operation, transport, ms, bytes, estimated tokens |

Files: `<data>/agent/rest.json` (address and token, 0600), `rest.lock`, `rest.log`. REST also serves `GET /agent/v1/status`, `GET /agent/v1/metrics` and `POST|PUT|DELETE /agent/v1/leases[/id]`.

## Tests

```bash
node --test test/agent-evidence.test.js test/agent-transports.test.js
```

They cover:
- exact inclusive ranges, with a literal-parity property test over random ranges
- duplicate names, pinned and historical revisions, and disk changes
- credential and exclusion filtering, and scope enforcement
- records and competing sources, binding with constraints, and change reporting
- paging, budgets and stale cursors, plus cross-process handles
- symbols, and large tables, including a row the app records concurrently
- MCP over a real stdio process: negotiation, cancellation, errors and exit on disconnect
- REST: token, Origin and Host checks, single instance, leases, idle shutdown, on-demand start and reuse
- identical answers over MCP, REST and in-process calls
