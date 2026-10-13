# Dependency Autocomplete and Predictive Provenance

## Product boundary

The writing workspace has one predictive-dependency system. It can suggest a source for text already typed or complete a sentence from a source-backed project passage, but it never presents prose completion as a separate feature. Claim detection, candidate retrieval, scoring, persistence, staleness, and RFI are deterministic. After acceptance, the completed claim and its authoritative dependency are handled together and the UI identifies the result as a linked dependency.

No prediction can exist unless it resolves to a real versioned project object. Sentence continuation is extractive rather than generative: it uses real project sentences, including semantically equivalent scientific phrasing, and carries the canonical object identifier, immutable source snapshot, and source file required to create the dependency. No remote language model is required, and none is called by this implementation.

## Editor workflow

Tracked Markdown, plain-text, DOCX, and PDF files appear under **Writing**. The editor renders text as structural blocks inside a paper-like surface. Markdown and plain-text saves update the source file and create a normal `DOCUMENT_CHANGE` snapshot. DOCX and PDF saves create a versioned text layer in Lasso while preserving the original source bytes; they do not rewrite the original document formatting.

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

Typing predictions, sentence completions, the manual source picker, and terminal search/completion use the shared `RecommendationRanking` service in `src/dependencies/ranking.js`. The priorities are direct matches, current writing/query context, existing document relationships, recent deliberate use, and repeated use. Exact names beat prefixes. Source type, value equivalence, author/year constraints, exclusions, and explicit linked-source scope still determine which candidates are eligible.

Within a match tier, relevance is divided into bands of 0.08. Document relationships take priority within a band, followed by relevance plus a usage boost capped at 0.06. Usage never changes the reported source confidence or makes a below-threshold candidate eligible. With no query, related sources lead, then recent use and repeated use. Remaining ties retain the deterministic source/year ordering. Each candidate exposes a short `ranking.reason` for the UI along with its relevance and usage contributions.

Automatic typing suggestions show at most five eligible choices, across all returned groups. Weak or unrelated prose stays quiet. Broad results prefer multiple files and allow at most two choices per file when alternatives exist. A single eligible file and explicitly selected source drilldowns retain their choices. Individual bibliography entries count as distinct citable works in typing suggestions even when stored together. Identical sentences in different files remain available until ranking chooses the source.

Only deliberate interactions contribute usage: successful human source acceptance or selection, and successful source/inspector opens. Passive suggestions, automatic previews, hover, arrow navigation, failed actions, and system-created links do not contribute. Browser and native clients send a stable page/process session ID; callers without one use a 30-minute server time bucket. Each file/action/session contributes frequency once. Repeated deliberate use refreshes recency, and use with additional documents retains those relationships without inflating frequency.

Acceptances have weight 1 and opens weight 0.35. Recency has a three-day half-life; session frequency has a fourteen-day half-life and saturates. The usage boost is `0.04 * recentScore + 0.02 * frequencyScore`, capped at 0.06. These initial weights are deterministic tuning values, not calibrated probabilities.

Migration `014_recommendation_usage.sql` adds local usage and document-association tables. Both are scoped to the project and use stable file identities, so history survives restart and renames. Human link/batch acceptance records usage in the same database transaction as the accepted dependency. Native insertion and deliberate UI opens call `POST /api/projects/:projectId/recommendation-usage` with `kind`, `sessionId`, an `objectId`, `dependencyId`, or indexed `path`, and optional `documentPath`. Source identities are checked against the requested project; recording usage does not create a project snapshot or publish anything.

Regression coverage includes `test/recommendation-ranking.test.js`, `test/recommendation-integration.test.js`, and the terminal recommendation tests. They cover exact-match precedence, bounded learning, decay, session deduplication, document relationships, file diversity, source exclusions, project isolation, persistence, renames, passive reads, and API validation.

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

After a document capture, migration first resolves the exact claim within its prior block. It then searches all blocks and migrates only when the text has one unambiguous location. Missing or ambiguous spans become `NEEDS_REVIEW`; they are never attached to unrelated text.

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
