# Dependency Autocomplete and Predictive Provenance

## Product boundary

The writing workspace has one predictive-dependency system. It can suggest a source for text already typed or complete a sentence from a source-backed project passage, but it never presents prose completion as a separate feature. Claim detection, candidate retrieval, scoring, persistence, staleness, and RFI are deterministic. After acceptance, the completed claim and its authoritative dependency are handled together and the UI identifies the result as a linked dependency.

No prediction can exist unless it resolves to a real versioned project object. Sentence continuation is extractive rather than generative: it uses real project sentences, including semantically equivalent scientific phrasing, and carries the canonical object identifier, immutable source snapshot, and source file required to create the dependency. No remote language model is required, and none is called by this implementation.

## Editor workflow

The writing list shows tracked documents for the selected directory. The editor renders structural text blocks inside a paper-like surface. Markdown and text saves update their tracked files; DOCX and PDF edits use a versioned text layer while preserving the binary original. Saves enter the normal document history path.

After a short cancellable quiet window, a block is checked for a predictive dependency. Sentence-level language from Markdown, text, DOCX, locally extractable PDF content/metadata, and reference records is matched to the text at the caret. Common scientific equivalents such as results/findings, showed/indicated, and increased/elevated are normalized so a continuation does not require literal word-for-word overlap. If a matching sentence and canonical source object are both available, the continuation appears as grey inline text beside a compact source card. `Tab` completes the sentence and links the completed claim to that source in one editor action. A continuation with no linkable project object is discarded.

Author prefixes after citation cues, partial gene/biomarker tokens, and incomplete result values are queried progressively against the same predictive-dependency index. A partial narrative citation such as `The paper by Moha` receives candidate-specific citation text from the indexed paper metadata; accepting `Mohammad et al., 2021` replaces the partial span with `Mohammad et al. (2021)` before the dependency is anchored. Superseded requests are aborted to prevent stale suggestions from flashing. If real project candidates exist for already-written text, the same compact source card is positioned beside the detected span.

An accepted paper citation also establishes source context for the surrounding block. When the writer continues with an attribution cue such as `the authors found that`, the predictor switches into an exclusive source mode and ranks several extractive findings from that paper's accepted immutable snapshot. Project-wide candidates are suppressed while this menu is active. Choosing a finding inserts the selected clause and records a second dependency to the same paper, so completion and provenance remain one action. A new block, a different accepted source, or the absence of an attribution cue returns prediction to normal project-wide retrieval.

Acceptance does not save or reopen the document. The editor immediately renders a pending provenance underline and keeps it available as prediction context, including for a paper citation followed by source-scoped findings. A five-minute background timer commits the current manuscript and all pending dependency links as a batch. Manual save uses the same batch path. The editor DOM is retained throughout, so the caret, selection, completion animation, and writing flow are not interrupted.

For original study results, ordinary numbers are detected when they follow a variable phrase such as `mean placental weight was 521.4 g`. CSV and XLSX dictionaries with variable/name and description/definition columns create first-class variable definitions. Matching result cells inherit that semantic context. When no dictionary is present, column names, data type, observed range, and representative values form a deterministic inferred variable profile. Exact-value candidates with a mismatched variable are demoted even when the same number occurs elsewhere.

- `Tab` or `Option + Enter`: link the selected source;
- up/down arrows: change the candidate;
- `Escape`: dismiss;
- `Cmd/Ctrl + Shift + L`: link any selected phrase with the searchable project-object picker.

`More sources` opens the searchable picker for an already-written claim. The first evidence candidate is selected by default. If there is no plausible versioned project source, the predictor stays quiet; sentence completion never appears independently.

Only the detected span receives a transient highlight. Accepted spans receive a restrained underline and open a compact inspector for RFI, source preview, relinking, historical pinning, or removal.

## Native writing assistance

The macOS app uses the same prediction endpoint and project source index for suggestions in supported external editors. Source selection, host text insertion, and dependency inspection use native adapters in `desktop/`. Host capabilities and permissions affect which insertion and preview behaviors are available. The editor workflow above describes Lasso's own writing workspace; its save timer and manuscript anchors do not imply that Lasso saves an external application's document.

## Detection and retrieval

`detectClaimSpans` recognizes quantitative values, percentages, p-values, confidence intervals, fold changes, sample sizes, figure/table references, biomarkers and gene-like entities, dataset names, supported method phrases, explicit author/`et al.` citations, publication years, and literature-claim language. It also recognizes incomplete author, entity, p-value, and result-value prefixes at the caret. It returns offsets into the existing block; it never generates manuscript text.

Each immutable snapshot can be indexed into typed scientific objects:

| Source | Indexed objects |
|---|---|
| CSV/TSV | dataset plus row/cell results and tables |
| Spreadsheet | versioned table and dataset artifacts |
| Python/R/other code | code block/model, assigned symbols, functions/classes, code-line anchors, recognized methods |
| Notebook | stable notebook cells |
| JSON | leaf results and parameters |
| Images | figures |
| PDF | paper records from embedded PDF/XMP author, title, year, DOI, subject, keywords, and locally extractable text; filename metadata is only a fallback |
| DOCX | document/paper records from OOXML core properties and visible paragraph/table text |
| Markdown | paper/document records and visible text |
| BibTeX/RIS/EndNote/NBIB | individual reference records with author, title, year, DOI, and PMID where available |
| Named run artifacts | analysis runs |
| IFC, DXF, LandXML | drawing containers and supported model properties or geometry measurements |
| Drawing PDFs | positioned explicit annotations when local extraction is available |

See [architectural and civil design indexing](design-source-indexing.md) for drawing formats, units, extraction limits, and unsupported native formats.

Stable object identity uses `(project, project_file_id, structural key)`. A new snapshot creates a new immutable object version for the same identity.

Candidates are ranked by exact numeric/directional value match, equivalent percent/fold-change representation, exact or conservatively fuzzy author and publication year, entity/token overlap from nearby text and section headings, compatible object type, recorded provenance, and deterministic version/year tie-breaks. Explicit author citations never fall back to arbitrary papers. Multiple plausible matches remain visible. The searchable manual picker always overrides prediction. It searches only the open project.

When recorded lineage connects a result to code, the result remains the suggested supporting object and the originating file/version/line range is shown as secondary context. Navigation opens that immutable source version and focuses its exact line, cell, JSON path, or notebook-cell anchor. Lasso never infers an unrecorded code origin.

## File recommendation ranking

Typing predictions, sentence completions, the manual source picker, the grouped source library, and terminal search/completion use the shared `RecommendationRanking` service in `src/dependencies/ranking.js`. The priorities are direct matches, current writing/query context, existing document relationships, recent deliberate use, and repeated use. Exact filenames, names, variables, identifiers (including citation keys, DOI and PMID), and specific values beat name prefixes. Exact value checks retain signs and punctuation: `12` is not an exact match for `120` or `-12`. Names normalize underscores and alphabetic dash/dot separators, so `birth weight g` is an exact match for the column `birth_weight_g`. Meaningful punctuation remains distinct: `-12 mg`, `12 mg`, `0.5 mg`, `C++`, dates and unit expressions are not collapsed into different values or names. A file's name names only the file: a row, column, cell, passage or measurement inside it is matched by its own words, and the file part of a label such as `pressure_log · included rows` does not count, so `pres` directly matches `pressure_log.csv` but not its `Day` column. Source type, scientific value equivalence, author/year constraints, exclusions, and explicit linked-source scope still determine which candidates are eligible.

Within a match tier, relevance is divided into bands of 0.08 using `floor((score + 1e-9) / 0.08)`. Exact-match specificity precedes prefix specificity, then the higher relevance band wins. A direct match that only its caller vouches for, such as a cited value or a drawing found by its type, ranks with name prefixes rather than exact names. Within a band, current-sentence context takes priority, followed by document relationships, relevance plus a usage boost capped at 0.06, then unmodified relevance. For name completions, context is the fraction of meaningful words before the active name in the current sentence that occur in the source metadata, relative path or work-directory name. It is applied before duplicate names are collapsed and is preserved when merging work directories: `The south region Rev` prefers Revenue from `south/sales.csv` over a more frequently used `north/sales.csv`. Earlier sentences and generic reporting words do not supply this tie-breaker. Usage never changes the reported source confidence or makes a below-threshold candidate eligible. With no query or supplied context, recent use leads, followed by repeated use, document relationships, and original relevance. Supplied sentence or selected-text context acts as the query when the typed query is empty. Remaining ties retain the caller's deterministic scientific/source ordering (score, publication year, snapshot version and label in the source service; name and path in the terminal). Each candidate exposes a short `ranking.reason` along with separate relevance and usage contributions.

Typing suggestions rank by the words typed before anything known about a source. A column, row or measurement name ranks by how the typed words match it: exact (relevance from 0.95), begins (0.82), contains a word that begins with them (0.74; a part's measurement 0.72), or begins each of its words in any order (0.68, columns only, so `Quebec district 30002` never offers other districts). Whether it is a column, row or line item, has a dictionary definition or a profile, or sits in a `data`/`results` folder only orders names within one of those bands. A drawing found by its type (`floor plan`, `3D model`) follows a file whose own name or title has the words. For a whole sentence, a source qualifies by the sentence's subject words found in its own text: its name, the text `Tab` inserts, its value, or a column's values, but not its path, file type or Lasso's description of a column. Reporting and data-structure words (`we found`, `results`, `rows`, `values`) are not subject words, and a non-reporting word still being typed counts once it reaches three characters. An unmatched active word remains a subject constraint, so an unknown topic does not fall back to generic data just before its trailing space. Each shared word is one relevance band, up to four, and a source must share at least a quarter of the sentence's subject words, rounded up. Surrounding paragraphs, folder and kind of data together stay under one band. A sentence that names something tries to continue its own words first; when nothing has its words, it gets no suggestions. A sentence that only reports (`Our results showed that`) is offered the project's results or methods at tier 2, after any match on words from any directory.

Automatic typing suggestions return at most twelve eligible choices, across all returned groups. Weak or unrelated prose stays quiet. These gates are applied before usage:

| Surface | Initial threshold or limit |
|---|---|
| Terminal file/name/address autocomplete | Relevance at least 0.8 with a typed fragment; at most five choices. Empty input permits recent-file browsing or supplied context. |
| Scientific typing claims | Direct matches, or match strength at least 0.4; study-variable strength at least 0.68. Existing retrieval floors remain 0.08 for literature and 0.2 for other claims, with author/year and source-type constraints. |
| Study-variable completion | Relevance at least 0.68. |
| Workspace and sentence completion | Original confidence at least 0.54; sentence alignment also requires two tokens and eight characters. Explicitly linked source drilldowns retain their source-specific evidence gates. |
| Explicit prediction (`surface: search`) | At most twelve choices; keeps the retrieval floors and constraints but skips the automatic 0.4/0.68 strength filter. |
| Explicit terminal completion (`surface: search`) | At most fourteen source choices; no automatic 0.8 cutoff. Ordinary terminal search defaults to 25 results. |
| Manual picker / source library | Picker defaults to 30; the library ranks its full matching inventory and groups it by file. |

Broad results rotate files within the same match tier, specificity and relevance band and allow at most two choices per stable file identity when alternatives exist. Diversity cannot move weaker context ahead of direct matches. A single eligible file and explicitly selected source drilldowns retain their choices. Individual bibliography entries count as distinct citable works on every surface, including identical passages in one shared bibliography. Source-library file rows preserve server rank order, retain the selected file while it remains eligible, and display a reason. Its full inventory skips per-object lineage enrichment; object inspection still retrieves authoritative provenance.

Only deliberate interactions contribute usage: successful human source acceptance or selection, successful copying with a source citation, and successful source/inspector opens. Passive suggestions, automatic previews, file selection for browsing, hover, arrow navigation, failed actions, and system-created links do not contribute. Browser and native clients send a stable page/process session ID; callers without one use a 30-minute server time bucket. Each file/action/session contributes frequency once, so a session contributes at most one acceptance and one open per file. Repeated deliberate use refreshes recency, and use with additional documents retains those relationships without inflating frequency. Asynchronous opens and copies retain the project and document captured when the action started.

Acceptances have weight 1 and opens weight 0.35; passive appearances have weight zero. Recency is the maximum action weight multiplied by `2^(-age / 3 days)`, measured from its latest deliberate use. Session frequency sums action weights multiplied by `2^(-age / 14 days)`, measured from each session's first occurrence, then saturates as `1 - exp(-decayedFrequency / 5)`. The usage boost is `0.04 * recentScore + 0.02 * frequencyScore`, capped at 0.06. These initial weights are deterministic tuning values, not calibrated probabilities. Literal exact matches and full aliases have search relevance 1, shared name prefixes 0.90, and partial alias context `0.75 * matching query terms / query terms`. Terminal basename prefixes have relevance 0.94 and path prefixes 0.90, preserving the file as a strong source choice beside its indexed contents.

Existing migration `014_recommendation_usage.sql` provides local usage and document-association tables. Both are scoped to the project and use stable file identities, so history survives restart and renames. Human link/batch acceptance records usage in the same database transaction as the accepted dependency. Native insertion and deliberate UI opens call `POST /api/projects/:projectId/recommendation-usage` with `kind`, `sessionId`, an `objectId`, `dependencyId`, or indexed `path`, and optional `documentPath`. Every supplied object/dependency identity must belong to the requested project, and combined identities must agree. An authoritative object ID can resolve a stale supplied path after a rename. Recording usage does not create a project snapshot or publish anything.

Ranking also validates candidate files and scientific object versions against their actual project and snapshot. Explicit historical sources remain eligible, while invented paths and foreign object identities are discarded. Personalization and diversity resolve the historical file's stable identity, so a renamed source keeps its usage and a new file reusing its old path does not inherit it. Popularity is applied only after these identity and retrieval checks.

Regression coverage includes the recommendation-ranking, recommendation-integration, terminal, sentence-completion and source-workbench suites, plus native source-opening checks. They cover exact-match precedence, bounded learning, decay, session deduplication, document relationships, stable file diversity, shared bibliography works, source exclusions, project isolation, persistence, historical renames and reused paths, passive reads, successful/failed deliberate actions, query-response races, and API validation.

Sentence continuations retain numeric tokens, signs and decimals during alignment. A shared suffix alone cannot transfer a result to a different subject or a negated statement; the specific context before the continuation must agree, allowing the existing deterministic concept aliases and generic reporting introductions. Exact source prefixes remain available, and insertion joins existing whitespace without adding a second space.

Browser predictions are bound to the document, paragraph text and collapsed caret offset. Moving the selection cancels pending or displayed suggestions, and acceptance rechecks the same context. Modified navigation and IME composition retain native keyboard behavior. On macOS, a changed query, caret, host or source scope resets selection to the highest-ranked suggestion; refreshing the same query preserves the selected source and insertion identity if it remains available. Explicit source-focus navigation retains its intended landing row.

## Persistence and graph integration

Migration `002_predictive_provenance.sql` adds:

- `scientific_objects` and immutable `scientific_object_versions`;
- `snapshot_object_indexes`;
- `claim_dependencies` and immutable `claim_dependency_versions`;
- `dependency_changes`, attached to normal timeline events;
- the `DEPENDS_ON`, `USED`, and `IDENTIFIED_BY` provenance relations.

Migration `003_dependency_autocomplete.sql` adds the canonical `AUTOCOMPLETE` selection method while retaining prior `PREDICTED_ACCEPTED` records for compatibility, and invalidates snapshot object indexes so the expanded adapters are rebuilt on demand.

Migration `004_document_content_index.sql` invalidates filename-only indexes so PDF, DOCX, RIS, EndNote, and NBIB content is rebuilt locally. Per-table and per-snapshot budgets keep the index lightweight, and candidate type filtering happens in SQLite before deterministic ranking.

Migration `006_variable_index.sql` invalidates prior object-index markers so variable definitions and inferred table-column profiles are added to existing project snapshots without changing immutable source versions.

Migration `005_autocomplete_lookup_indexes.sql` adds a project/object-type lookup index used by live candidate queries.

Accepting or revising a link creates a metadata-only Version N+1 with the same file manifest. Its event and dependency version are immutable. User acceptance persists `AUTOCOMPLETE` or `MANUAL`, the accepting actor, timestamp, document/version/span anchor, target type/location/version, and confidence. Every active dependency version has a `DEPENDS_ON` graph edge, so RFI works after status review, anchor migration, collaboration, and process restart.

The relationship stores the accepting actor separately from the actor responsible for its latest status transition. This preserves “linked by Maya” even when a later `SYSTEM` event marks the edge stale.

## Stable anchors

A manuscript anchor contains document version context, structural block index/type, span start/end, bounded prefix/suffix, and a normalized block fingerprint. Offsets are only local coordinates inside a structural block.

After a document capture, migration first resolves the exact claim within its prior block. It then searches all blocks and migrates only when the text has one unambiguous location. Deleted or ambiguous claims are retired with their version history preserved. Retyping the same words does not restore a retired link; linking again is explicit. A missing document keeps its reference under review.

## Upstream changes

After every real project capture, current versions of linked scientific objects are compared with their accepted source versions:

- same identity and content/value: `LINKED`;
- same identity with changed content/value: `STALE`;
- identity no longer resolvable: `BROKEN`;
- ambiguous/missing manuscript anchor: `NEEDS_REVIEW`.

Staleness creates a `DEPENDENCY_STALE` event showing accepted and current upstream values. It does not edit manuscript content. A researcher can keep the historical version, relink, update the manuscript in a normal document edit, or remove the dependency. Read-only audit and document-open operations do not create timeline events.

## RFI and history

RFI checks accepted claim dependencies before generic first-recorded history. For a linked span it starts from the dependency's `DEPENDS_ON` edge and continues through recorded graph edges such as `GENERATED_BY`, `USED`, `USES_DATASET`, and `DERIVED_FROM`. The traversal is bounded and cycle-safe.

For unlinked text, the response explicitly returns `dependencyStatus: UNLINKED` and `No dependency linked`; candidate search remains a separate user action.

The unified timeline distinguishes `DOCUMENT_CHANGE`, `DEPENDENCY_LINKED`, `DEPENDENCY_CHANGED`, `DEPENDENCY_REMOVED`, `DEPENDENCY_STALE`, and `DEPENDENCY_REVIEWED`. Event detail shows dependency metadata changes beside the canonical deterministic content diff.

## Agent-authored manuscript text

A Markdown agent proposal is scanned before approval. The review modal displays its text diff plus candidate dependencies drawn from the same real project index, or **No verified project dependency found**. Approval records the AI actor and requesting human, applies the normal file capture, and then accepts the structured dependency proposal as `SYSTEM_LINKED`.

## HTTP surface

- `GET /api/projects/:id/documents`
- `GET /api/projects/:id/documents?path=...`
- `POST /api/projects/:id/documents/save`
- `POST /api/projects/:id/dependencies/predict`
- `GET /api/projects/:id/dependency-objects?query=...`
- `POST /api/projects/:id/dependencies`
- `GET /api/projects/:id/dependencies/audit`
- `GET /api/dependencies/:id`
- `POST /api/dependencies/:id/revise`

Document and dependency mutations use the same optimistic project-snapshot checks as the rest of Lasso. Actor fields record attribution; the local API does not authenticate those identities. See [current limitations](limitations.md).
