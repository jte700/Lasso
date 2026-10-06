# Scientific Version Timeline + RFI Provenance

## Architecture

The selected directory is the project boundary and remains the live source. Lasso only reads that directory during import/reconciliation; only an explicitly approved agent edit writes a project file. Historical state lives separately in a SQLite event store and content-addressed blob store.

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

The initial import recursively enumerates regular files, excluding version-control internals, dependency trees, `.colab-dry-data`, symlinks, editor temporaries, and `.DS_Store`. Each file is SHA-256 hashed and its bytes are written once to `blobs/<prefix>/<hash>`. Snapshots reference the content hash, so unchanged and repeated content consumes no additional blob bytes.

The manifest hash covers sorted `(path, content hash, size, file type)` tuples. Version 1 has no parent and its event is always `Project imported`, attributed to the current authenticated/session actor supplied by the caller. No prior history is inferred.

## Capture and batching

Opening a project reconciles the directory before starting its watcher. While open, file notifications reset a project-level 2.5-second timer. Continuous saves are grouped until the directory is idle. Explicit checkpoints, project open, and approved agent edits capture immediately. Changing session identity restarts the watcher with the new execution identity.

The batching interval is configurable with `COLAB_WATCH_DEBOUNCE_MS`. Because capture compares content hashes, noisy notifications and an internal edit plus watcher notification do not create duplicate events.

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

Actor identity is accepted only from the caller's execution/session context; it is never inferred from file content. Actor IDs cannot change type.

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

This repository has no pre-existing remote synchronization transport. The implemented boundary is therefore persistence plus conflict detection; merging or branch visualization belongs in the host product's future collaboration adapter.

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

- DOCX content is preserved but opaque; paragraph/table diffing needs an approved parser and stable OOXML anchor policy.
- YAML is currently line-compared rather than parsed semantically.
- Source code is line-based; AST-aware adapters can be added without changing event semantics.
- Notebook metadata outside cell type/source/output is not currently surfaced.
- The local web shell takes an absolute path because browsers do not expose native filesystem paths. A desktop host should replace this with its native directory picker.
- Remote synchronization/merge transport and production authentication do not exist in the previously empty workspace.
- Blob garbage collection and project deletion policy are intentionally unset because immutable-history retention is a product decision.
- Node 24's built-in SQLite module is currently marked experimental by Node; the app suppresses that warning but documents the runtime requirement.
