# Human input required

The workspace contained no existing Lasso implementation or product decision log. These questions are intentionally left explicit instead of being silently encoded as product policy.

1. **Desktop directory picker** — Which host API should replace the local web shell's absolute-path field? Browser upload is not equivalent because the selected directory must remain the live source project.
2. **Authenticated actor adapter** — Define the canonical user/organization ID claims and the server-side session adapter. The reference UI identity switcher demonstrates attribution but is not an authentication boundary.
3. **Remote collaboration transport** — Choose the existing/shared synchronization backend and conflict UX. This implementation detects and rejects stale parents but does not invent a merge service in an otherwise empty repository.
4. **DOCX structure and anchors** — Approve an OOXML parser and whether paragraph/table-cell identity is derived from `w14:paraId`, document order, or a host editor's stable IDs.
5. **Provenance write authority** — Decide which runners/importers may assert Scientific State Graph relationships and which links require user approval. RFI only reads recorded edges and never guesses.
6. **Retention and deletion** — Specify whether deleting a project registration may delete immutable history, and when unreferenced proposal blobs can be garbage-collected.
7. **Watcher batching** — The reference interval is 2.5 seconds of project-wide idle time. Confirm whether save/run/project-close events from the desktop host should force an immediate boundary.
8. **Large/generated directories** — Confirm ignore rules and any per-file size policy for domain-specific caches, model checkpoints, or protected datasets. Current default ignores VCS internals, dependency trees, Lasso's own store, symlinks, and common editor/system temporaries.
9. **System attribution after unattended restart** — A watcher starts only when a session opens a project, so authorship comes from that execution context. Decide whether background startup reconciliation should be `SYSTEM`, wait for an authenticated opener, or use collaboration metadata.
10. **Production editor framework** — The dependency layer is isolated behind document/service APIs, while this dependency-free reference UI uses structured `contenteditable` Markdown blocks. Choose ProseMirror/TipTap, Lexical, or the host editor before adding comments, tables, and concurrent rich-text operations at production scale.
11. **Citation formatting policy** — Linking a project reference is implemented independently of citation insertion. Choose CSL style, citekey syntax, bibliography ownership, and whether accepting a reference may edit manuscript text.
12. **Scientific object adapters** — Confirm canonical object IDs emitted by production runners, dataset catalogs, figure builders, and literature gateways. The local indexer derives stable keys from tracked project files but never invents external papers or run lineage.
13. **Optional model reranking** — No ModelProvider existed in this codebase, so candidate ranking is deterministic. If an approved provider is introduced, define privacy, latency, and audit rules; the model may rerank retrieved project objects but must never create candidates.
