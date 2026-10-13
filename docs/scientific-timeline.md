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
- `snapshots`: immutable project version, parent pointer, manifest hash, timestamp.
- `snapshot_files`: immutable path/hash/type/metadata references for one snapshot.
- `timeline_events`: immutable transition from `previous_snapshot_id` to `resulting_snapshot_id` with actor, initiator, source, and deterministic title.
- `file_changes`: immutable added/deleted/renamed/moved/modified records and deterministic structured diff JSON.
- `actors`: execution identities and one of the four actor types.
- `agent_executions`: proposal, base version, request, agent, human initiator, and approval status.
- `provenance_links`: typed Scientific State Graph edges between versioned paths/anchors, including manuscript `DEPENDS_ON` relationships.
- `scientific_objects` / `scientific_object_versions`: stable project-object identities and their immutable snapshot representations.
- `claim_dependencies` / `claim_dependency_versions`: accepted manuscript-span links and versioned status/anchor/source state.
- `dependency_changes`: structured dependency transitions attached to ordinary timeline events.

SQLite triggers reject updates/deletes to snapshots, snapshot files, timeline events, and file changes. A new capture always creates Version N+1. The migration is [migrations/001_initial.sql](../migrations/001_initial.sql).

## Snapshot model

The initial import recursively enumerates regular files, excluding version-control internals, dependency trees, `.lasso-data`, symlinks, editor temporaries, and `.DS_Store`. Each file is SHA-256 hashed and its bytes are written once to `blobs/<prefix>/<hash>`. Snapshots reference the content hash, so unchanged and repeated content consumes no additional blob bytes.

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

## Collaboration and conflicts

Collaborator actors retain their global identity when supplied by the collaboration/session layer. Each capture performs an optimistic comparison-and-swap against the expected/current parent. A stale collaborator or agent request receives HTTP 409 with both expected and current snapshot IDs. Lasso never rewrites the snapshots into a false sequential history.

The application provides local persistence and optimistic conflict detection. It does not include a remote synchronization or merge service. Shared source links expose selected evidence through the running server; they do not synchronize project directories.

## HTTP surface

Key routes are:

- `POST /api/projects/import`
- `POST /api/projects/:id/open`
- `POST /api/projects/:id/capture`
- `GET /api/projects/:id/events`
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
