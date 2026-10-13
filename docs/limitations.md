# Current limitations

Lasso runs a local Node.js service and offers a browser interface and a native macOS app. These are the current implementation boundaries.

- **Identity and access:** the default server listens on `127.0.0.1`. Local actor fields and the identity switcher record attribution; they are not an authentication or authorization boundary. A hosted deployment needs a separate access-control design.
- **Sharing:** generated source links depend on a reachable running server. Setting `SHARE_BASE_URL` changes link construction; it does not deploy the service or create a tunnel. Sharing selected evidence is separate from project synchronization.
- **Collaboration:** snapshots and mutations use optimistic conflict checks, but there is no remote directory synchronization or automatic merge service.
- **Project selection:** the browser accepts an absolute directory path; the macOS app provides a folder picker and multiple directory toggles. Imports read the directory in place. Markdown/plain-text saves and approved agent edits can write project files.
- **Document editing:** DOCX and PDF text can be extracted and edited as a separate versioned Lasso text layer. Their original bytes and formatting remain intact. Structured DOCX history diffs and exporting a text layer back into the original document format are not implemented.
- **Native writing assistance:** the macOS integration depends on Accessibility permissions and the capabilities of the active editor. Text insertion, caret geometry, and source-link presentation can differ between host applications.
- **Extraction and provenance:** indexing is local and bounded. Unsupported, ambiguous, or unextractable content is not a verified numeric answer. Provenance follows recorded relationships; it cannot recover lineage that was never recorded. Drawing format boundaries are documented in [design-source-indexing.md](design-source-indexing.md).
- **Watching and retention:** watchers run for enabled directories with system attribution; explicit directory actions retain the requesting actor. Automatic blob garbage collection and project-history deletion are not implemented. Large projects retain original snapshot content as well as indexed metadata; configure index exclusions for generated or unwanted files.

Implementation details are in [scientific-timeline.md](scientific-timeline.md) and [predictive-provenance-editor.md](predictive-provenance-editor.md).
