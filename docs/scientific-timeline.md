# Scientific Version Timeline + RFI Provenance

## Architecture

Each selected directory is a project boundary and remains the live source. Import and reconciliation read its files. Explicit document saves, accepted source updates, and approved agent edits can write tracked files. Historical state lives separately in a SQLite event store and content-addressed blob store.

All change producers use one capture path:

```text
directory scan → compare to current snapshot → optimistic parent check
               → immutable snapshot → timeline event → file changes
```

This avoids duplicate watcher/internal events: after an authoritative agent capture, the watcher sees no content difference and emits nothing.

### Persistence entities

- `projects`: directory root and current snapshot pointer.
- `project_files`: stable identity across snapshots and detectable path changes.
- `snapshots`: immutable project version, parent pointer, manifest hash, timestamp, and the snapshot its files build on.
- `snapshot_files` / `snapshot_file_removals`: immutable path/hash/type/metadata references for the files a snapshot added or changed, and the files it removed.
- `timeline_events`: immutable transition from `previous_snapshot_id` to `resulting_snapshot_id` with actor, initiator, source, and deterministic title.
- `file_changes`: immutable added/deleted/renamed/moved/modified records and deterministic structured diff JSON. Line and block diffs are stored as runs that point into the two compared versions, and are expanded back to every line when read.
- `actors`: execution identities and one of the four actor types.
- `agent_executions`: proposal, base version, request, agent, human initiator, and approval status.
- `provenance_links`: typed Scientific State Graph edges between versioned paths/anchors, including manuscript `DEPENDS_ON` relationships.
- `scientific_objects` / `scientific_object_versions` / `scientific_object_removals` / `object_index_bases`: stable project-object identities, their immutable versions, the objects an index removed, and the index each one builds on.
- `claim_dependencies` / `claim_dependency_versions`: accepted manuscript-span links and versioned status/anchor/source state.
- `dependency_changes`: structured dependency transitions attached to ordinary timeline events.

SQLite triggers reject updates/deletes to snapshots, snapshot files, timeline events, and file changes. A new capture always creates Version N+1. The migration is [migrations/001_initial.sql](../migrations/001_initial.sql).

Unchanged files and objects are carried forward rather than copied into every version ([migrations/020_carry_forward_history.sql](../migrations/020_carry_forward_history.sql)). A snapshot stores a file row only for a file that is new or whose recorded values changed, and a removal for each file that is gone; its full file list is its parent's with those rows applied. An object index likewise stores a version only when the object itself changes: its value, label, search text, metadata or location. A cell, row, passage or slide keeps one version however often other parts of its file change; objects that stand for a whole file (a document, dataset, drawing, paper, model or code block) also get a new version when the file's bytes change. Each version keeps the snapshot that first recorded it, and the file's bytes are found through the snapshot an object is read at, never through the version row, so a preview, share or link shows the file as it was at the snapshot it names. After 2,000 such steps the next version is stored in full, which keeps reading any one version fast. The removal and base tables are immutable too, so every recorded version resolves the same way forever. Databases written before carry-forward keep their full copies, which resolve on their own, and continue with carried-forward versions from the next capture.

### Change records and value history

Each index built on an earlier one records what it changed, one row per object, in `object_changes` ([migrations/028_object_changes.sql](../migrations/028_object_changes.sql)): added, modified (its value or label changed), moved (only its place changed) or removed, with the version before and after by id. A folder's first index and an upgrade pass record none. `objectHistory` and `snapshotChanges` (`src/dependencies/object-history.js`) read them, and they feed the value history in previews, the `change` field on suggestions, and Recent Changes and Needs Review in The Ranch.

Table rows keep their identity across edits: a named row is keyed by its label (and its order among rows with the same label), a column by its name, a note by its text, and a row without a name by a token carried over from the file's previous version by matching row contents (`src/dependencies/row-identity.js`). Inserting, sorting or editing rows therefore records moves and changes, not removals.

What a later index needs to carry unchanged files forward (each file's object count, problems and the folder's data dictionary) is stored next to the index ([migrations/029_index_summaries.sql](../migrations/029_index_summaries.sql)), so the first edit after a restart reads only the file that changed.

## Snapshot model

The initial import recursively enumerates regular files, excluding version-control internals, dependency trees, `.lasso-data`, symlinks, editor temporaries, and `.DS_Store`. Each file is SHA-256 hashed while it is read 1 MB at a time, and its bytes are written once to `blobs/<prefix>/<hash>`. A text version that is no longer current in any folder is compressed later, in idle batches, to `blobs/<prefix>/<hash>.zst`; current versions always stay raw. Releasing old versions' bytes is available and off by default (see [limitations](limitations.md)). Snapshots reference the content hash, so unchanged and repeated content consumes no additional blob bytes.

The manifest hash covers sorted `(path, content hash, size, file type)` tuples. Version 1 has no parent and its event is always `Project imported`, attributed to the actor supplied by the caller. Local actor selection is attribution, not authentication. No prior history is inferred.

## Capture and batching

Enabled directories reconcile and resume watching at startup with `SYSTEM` attribution. Adding or enabling a directory reconciles it with the requesting actor; pausing stops its watcher without deleting history. File notifications reset a project-level 2.5-second timer. Continuous saves are grouped until the directory is idle. Explicit checkpoints, opening an enabled project, and approved edits capture immediately.

The batching interval is configurable with `LASSO_WATCH_DEBOUNCE_MS`. Because capture compares content hashes, noisy notifications and an internal edit plus watcher notification do not create duplicate events.

On platforms where recursive `fs.watch` is unavailable, open-time and explicit reconciliation still work and a warning is logged. No daemon survives the Lasso process.

## Change and identity matching

Same-path files retain `project_file_id`. Unmatched paths are paired deterministically as rename/move candidates:

1. unique matching filesystem device/inode;
2. unique matching content hash.

If the basename is unchanged and its directory changes, the event is `MOVED`; otherwise it is `RENAMED`. Remaining pairs become deletes/adds. A rename may also contain a structured content difference if the inode remains stable while content changes.

## Deterministic diff engine

The canonical diff engine never calls an LLM.

| Format | Canonical comparison |
|---|---|
| Markdown, QMD, Rmd, RST | heading/list/code/paragraph blocks, then deterministic LCS |
| Source code | line-based deterministic LCS |
| Plain text, YAML | line-based deterministic LCS |
| CSV/TSV | parsed rows/cells; unique first column is the row key when possible |
| JSON/GeoJSON | recursively flattened key/value paths |
| Jupyter notebooks | stable cell ID (index fallback), source, type, and output hash |
| PNG | content hash plus dimensions metadata |
| DOCX, PDF, images, other binaries | content hash/metadata only |

Opaque changes display exactly: `File changed. Structured comparison unavailable.` The event UI shows changed material plus two context lines; the persisted operation record retains the complete deterministic comparison.

The LCS matrix has a bounded complexity guard. Very large line products fall back to deterministic removed/added line sets instead of exhausting memory.

## Actor attribution and agent edits

Actor identity comes from the caller's execution/session context; it is never inferred from file content. The local API currently accepts actor fields supplied by its client, and the identity switcher changes attribution rather than authenticating a user. Actor IDs cannot change type.

An agent proposal stores:

- immutable base snapshot;
- agent identity;
- initiating human identity;
- original request text;
- target path and before/after hashes;
- deterministic proposed diff;
- optional recorded provenance edges.

The project file is untouched until approval. Approval verifies both the current parent snapshot and target before-hash, writes atomically, and calls the normal capture path with `actor = AI_AGENT` and `initiatedBy = human`. If either version has changed, the execution becomes `CONFLICT` and the proposal is not applied.

## Event comparison semantics

An event persists both snapshot IDs. Event detail reads those exact snapshots:

```text
event.previous_snapshot_id → event.resulting_snapshot_id
```

It never substitutes the current project snapshot. Consequently, a Version 2 event still renders V1 → V2 after Versions 3–100 exist.

## Preview anchors

Every preview response includes the immutable `snapshotId`, `projectFileId`, path, file type, and content hash. Content selectors are structural rather than pixel-based:

- Markdown: block index + character selection/context.
- Code/text: line + character selection/context.
- Notebook: cell ID (index fallback) + character selection/context.
- Table: stable row key (row index fallback) + column name/index.
- JSON: JSON path.

A selection includes exact start/end offsets plus bounded prefix/suffix context. Exact historical resolution uses offsets; history traversal uses the stable container selector and context where available.

## RFI semantics

RFI is deterministic and separates two claims:

1. **First recorded**: the latest introduction point of the selected value in the version chain, including actor and human initiator.
2. **Upstream origin**: breadth-first traversal of recorded provenance relationships from that introduced version/path/anchor.

History follows the stable `project_file_id` across renames and resolves the same structural anchor in each ancestor snapshot. Only value transitions are returned.

Supported provenance relationships are `DEPENDS_ON`, `DERIVED_FROM`, `GENERATED_BY`, `USES_DATASET`, `USED`, `USED_IN_FIGURE`, `SUPPORTS`, `PROPOSED_BY`, `APPROVED_BY`, `REPLACED_BY`, and `IDENTIFIED_BY`. Traversal is cycle-safe and bounded to eight edges. When no applicable link exists, the exact result is:

> Lasso cannot determine the origin of this information from the recorded project history.

The system may still report where the content was first recorded; it does not mislabel that version fact as an upstream scientific source.

## Re-reading sources after the reader improves

When extraction improves, projects already indexed keep the objects the build that indexed them produced: `ensureIndex` reads a snapshot once and never re-reads it, and recorded object versions are immutable.

`POST /api/projects/:id/reindex` (also `index reindex`, and a menu item in both companions) re-reads the same files with the current reader and records the result as Version N+1:

- the new snapshot carries its parent's `snapshot_files` rows verbatim, so file identities, content hashes and blobs are shared rather than copied, and the manifest hash is unchanged;
- its timeline event has source `REINDEX` and says plainly that the files did not change, with the caller's reason appended;
- `snapshot_object_indexes.extractor_version` records which reader produced each snapshot's reading. `0` means a build that recorded none, which is what `GET /api/projects/:id/reindex` reports as stale;
- `snapshot_object_indexes.reader_versions_json` records the version of each reader in [readers.js](../src/dependencies/readers.js) that read it. An index recorded before readers had versions counts as read by version 1 of each. A reading that re-read some files and carried the rest keeps, for each reader with a carried file, the version that read it, so those files are read again while that reader is behind;
- objects whose key is unchanged keep their `scientific_objects` identity, so recorded usage and document links keep resolving;
- a claim whose source object is absent from the new reading becomes `NEEDS_REVIEW`, not `BROKEN`: its evidence is intact and still pinned, and only the current reading identifies it differently;
- an `object_share_grant` pins a version in an earlier snapshot and is untouched, so a published link keeps resolving to the evidence it was given.

Re-indexing is whole-project and always explicit. It is never performed on the user's behalf when a newer reader arrives, because it writes a version and a timeline event into their record. When the current reader reads the files exactly as the snapshot already says, nothing is recorded at all.

## Collaboration and conflicts

Collaborator actors retain their global identity when supplied by the collaboration/session layer. Each capture performs an optimistic comparison-and-swap against the expected/current parent. A stale collaborator or agent request receives HTTP 409 with both expected and current snapshot IDs. Lasso never rewrites the snapshots into a false sequential history.

The application provides local persistence and optimistic conflict detection. It does not include a remote synchronization or merge service. Shared source links expose selected evidence through the running server; they do not synchronize project directories.

## HTTP surface

Key routes are:

- `POST /api/projects/import`
- `POST /api/projects/:id/open`
- `POST /api/projects/:id/capture`
- `GET|POST /api/projects/:id/reindex`
- `GET /api/projects/:id/events?limit=100&before=N` (newest first; pass the response's `nextBefore` as `before` for the next page)
- `GET /api/events/:id`
- `GET /api/snapshots/:id/preview?path=...`
- `POST /api/projects/:id/agent-edits`
- `POST /api/agent-edits/:id/approve|reject`
- `POST /api/projects/:id/provenance`
- `POST /api/projects/:id/rfi`
- `GET /api/projects/:id/documents`
- `POST /api/projects/:id/documents/save`
- `POST /api/projects/:id/dependencies/predict`
- `GET /api/projects/:id/dependency-objects`
- `POST /api/projects/:id/dependencies`
- `GET /api/projects/:id/dependencies/audit`
- `GET /api/dependencies/:id`
- `POST /api/dependencies/:id/revise`

Production adapters should source actors from authenticated server-side context, not accept arbitrary browser-provided identities.

## Limitations

- DOCX and PDF originals are preserved. Indexing extracts available text, while binary timeline diffs compare content hashes and metadata. Editing their extracted text layer does not rewrite the original binary.
- YAML is currently line-compared rather than parsed semantically.
- Source code is line-based; AST-aware adapters can be added without changing event semantics.
- Notebook metadata outside cell type/source/output is not currently surfaced.
- The browser accepts absolute directory paths; the macOS app provides a native folder picker.
- Remote synchronization, production authentication, and concurrent rich-text editing are not implemented.
- Blob garbage collection and project deletion policy are intentionally unset because immutable-history retention is a product decision.
- Node 24's built-in SQLite module is currently marked experimental by Node; the app suppresses that warning but documents the runtime requirement.

See [current limitations](limitations.md) for deployment, native-host, and format boundaries.
