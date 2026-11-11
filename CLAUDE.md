# Lasso: working notes for Claude

Lasso indexes local folders and suggests source-backed text while the user types in any Mac app (Tab accepts). A local Node server (`src/`) does indexing, ranking and sharing; a native AppKit menu bar app (`desktop/`) draws the suggestion card, Source Inspector, share composer and The Ranch. No language model is involved in suggestions.

Read only what a task needs. Files are split by feature and mostly under 500 lines; find the right one in the table below or with `grep -rn`, then read line ranges.

## Where things live

| Task | Server (`src/`) | Mac app (`desktop/`) |
| --- | --- | --- |
| What gets suggested while typing | `dependencies/writing-prediction.js` (`predict`, `predictionCandidates`, `namedFile`), `workspace-suggestions.js`, `study-variables.js`, `claim-candidates.js`, `linked-*.js` (after a source is accepted) | `GlobalAssistant+Prediction.swift` (request, `parse`) |
| Which typed words count as a match | `dependencies/direct-match.js`; claim spans in `claim-detection.js`; value, variable, reference matching in `*-match.js` | |
| Order of suggestions | `dependencies/ranking.js` (tier, band, usage), merged across folders in `workspace-prediction.js` `predictText` (sets `rankOrder`, `matchedWords`) with `workspace-ranking.js` (`distinctRanked`, `tag`) | `parse` sorts by `rankOrder` |
| Sentence completion | `dependencies/completion.js` | |
| Videos: transcripts, a phrase typed in quotes | `dependencies/video-extraction.js` (helper `scripts/transcribe-video.swift`, on-device Speech, macOS 26), `video-transcripts.js` (kept by content hash in `derived/transcripts`, quoted search, card preview), `quoted-phrase.js` | `VideoPreview.swift`, `AssistVideoPreviewView.swift` (AVKit player cued to the moment); QuickTime jump in `SourceOpenTarget.swift` |
| File named while typing | `dependencies/file-reference.js` | |
| Readers: PDF, Word, xlsx/csv, pptx, DXF, IFC, STEP, LandXML | Registry with per-reader versions in `dependencies/readers.js` (contract in `docs/reader-contract.md`); `dependencies/*-extraction.js`, `step-model.js`, `tabular.js`, `table-index.js`; objects per file in `file-objects.js`, `tabular-objects.js`; changed sheets only in `workbook-parts.js`, changed slides only in `deck-parts.js` (part stamps in `zip-archive.js`); at most two worker readers at once in `worker-pool.js` (a silent one is stopped, previews go first) | |
| Indexing a folder's objects | `dependencies/index-lifecycle.js`, `object-extraction.js`, `object-access.js`, `index-summaries.js` (carry-forward kept across restarts); `service.js` is only the class shell that installs these method groups | |
| When an object gets a new version, and what changed | `history/object-identity.js` (the rule), `history/object-versions.js` (writes `object_changes`), `history/passage-succession.js` (an edited passage replaces the removed one it rewords, `passage_successions`), `dependencies/object-history.js` (`objectHistory` follows those, `previewHistory`, `snapshotChanges`); table row keys in `dependencies/row-identity.js` | |
| A suggestion's recent value change, stale typed values | `dependencies/value-changes.js`, added in `workspace-prediction.js` `predictText` and `claim-candidates.js`; worksheet display ("18,400") in `dependencies/cell-display.js` | `AssistValueChange.swift` (detail text), history line and struck value in `ModelPreview.swift`, `AssistBoxView+Preview.swift`, changed words in `PassageWordDiff.swift` (text) and `PreviewWordMarks.swift` `pdfChangeMarks` (PDF); Ranch sheet tint and version menu in `RanchSheetView.swift`, passage tints in `RanchPassageChanges.swift` and `RanchViewers.swift` |
| Card preview JSON | `http/api.js` `/api/dependency-objects/:id/preview` (helpers in `http/responses.js`), `dependencies/dependency-previews.js` | `GlobalAssistant+Preview.swift` (loading), `ModelPreview.swift` (parse), `AssistBoxView+Preview.swift`, `AssistPreviewViews.swift` (text, PDF, slides), `AssistTableLayout.swift`, `PreviewWordMarks.swift` (matched-word marks) |
| Slide pictures | `sharing/document-pages.js` `slidePicture`, `scripts/render-document-pages.swift` | `SlideDeckPreview.swift` (deck, slide menu, navigator) |
| Suggestion card itself, Tab, keys | | `GlobalAssist.swift` (controller state, keys), `GlobalAssistant+Panel.swift` (showing, placement), `GlobalAssistant+Insertion.swift` (Tab, links, undo), `AssistBoxView*.swift` (the drawn card), `AssistSuggestion.swift`, `AssistSuggestionList.swift`, `KeyRouting.swift`, `AccessibilityReader.swift`, `CompletionTransaction.swift` |
| Source Inspector (web page in a panel) | `sharing/share-page.js` `renderInspectorPanel` | `SourceInspectorPanel.swift` |
| Share links and recipient pages | `sharing/object-share.js`, `share-page.js`, `share-page-style.js` (how recipient pages look), `share-preview.js`, what a link shows in `shared-content.js`, `dependencies/dependency-sharing.js` | `ShareComposerController.swift`, `ShareComposerView*.swift`, `ShareInteractivePDFView.swift`, `ShareInsertion.swift`, `ShareMarkup.swift` |
| The Ranch (library window) | `ranch/` (value changes in `history.js`, review rows in `review.js`, changed cells and versions in `sheets.js`, changed passages in `passages.js`); routes in `http/ranch-routes.js` | `Ranch*.swift`; colours and controls in `RanchTheme.swift` |
| Folder history, snapshots | `history/`; blob storage, compression and retention in `blob-store.js`, `blob-compaction.js`, `retention.js`, `idle-batches.js`; agent edits in `agent-edits.js`, actors in `actors.js`; migrations in `migrations/` (`030_passage_successions.sql` is the newest) | |
| Memory: one cache budget, collection after large edits | `cache.js` (`MemoryBudget`), `memory.js`, idle shrink in `server.js` | |
| Storage and memory benchmark | `scripts/bench-storage.mjs` (`npm run bench:storage`), results in `docs/benchmarks/storage.json` | |
| Links in documents, re-anchoring after edits | `dependencies/dependency-links.js`, `reconciliation.js`, `source-updates.js`, `document-editing.js` | `DependencyHighlighter.swift`, `DependencyReference.swift` |
| HTTP routes | `http/api.js` (the handler), route groups in `http/workspace-routes.js`, `ranch-routes.js`, `connection-routes.js`, `drive-routes.js`; reading and answering in `http/responses.js` | |
| Text passages: sentences and paragraphs of text, Markdown and decks | `sharing/markdown.js` `markdownPassages`, found in their source by `sharing/passage-locator.js` | |
| Browser workbench (older web UI) | `public/app.js` wires `public/editor-*.js`, `workspace-*.js`, `dependency-*.js` modules; shared state in `public/state.js` | |
| Terminal commands (`ask`, `find`, `index`) | `terminal/`; run across folders by `workspace-terminal.js` | |
| Menu bar panel, Settings | | `Lasso.swift` (`rebuildMenu`), `StatusPopover.swift`, `StatusHeader.swift` (name, status, Suggest While Typing switch), `DirectoryMenu.swift`, `SettingsWindow.swift`, `SettingsPanes.swift` (SwiftUI grouped forms: General with Advanced collapsed, Apps) |
| Apps Lasso stays quiet in | | `SuggestionApps.swift` (bundle IDs in UserDefaults), checked in `GlobalAssistant+Prediction.swift` `refresh` |
| Liquid Glass and system look | | `NativeMaterial.swift` (AppKit), `RanchGlass.swift` (SwiftUI), every glass call behind `#available(macOS 26.0, *)` |
| Reading text and caret from other apps | | `HostTextAdapter.swift`, `WebText.swift`, `HostGeometry.swift` |

The ranking rules are written up in `docs/lasso-ranking-algorithm.pdf`: a direct match (exact name, value, filename prefix) is tier 0 and always beats relevance bands, relationships and usage. Since 2026-10-30 a suggestion must share a real typed word with the source's own text (not its folder, format or extraction labels); study phrases like "we found that" name nothing.

## Build and test

```bash
npm test                         # all Node tests (about 1 minute); one file: node --test test/<name>.test.js
npm run desktop:test             # native unit checks (a subset of desktop/ files, listed in package.json)
npm run desktop                  # builds dist/Lasso.app; the user's app only changes after this and a relaunch
```

- New Swift files go in two lists: `desktop/build.sh` (the app) and, if testable without AppKit windows, the `desktop:test` script in `package.json`. Frameworks are linked in `build.sh` only.
- `npm test` has a known flaky race (`UNIQUE constraint failed: object_index_bases.snapshot_id` in `test/connections.test.js`); rerun the file alone before treating it as a regression.
- Native UI checks without launching the app: compile the `build.sh` sources minus `Lasso.swift` with `-D BROWSER_GEOMETRY_TEST` plus a scratch `main.swift` that calls a `runRegression`/`regression*` function (`GlobalAssistant.regressionSuggestionNavigation`, `AssistSlidePreviewView.runRegression`, `PreviewWordMarks.runRegression`, `ShareComposerView.run*Regression`; test-only code lives in `*+Regressions.swift`). Copy `desktop/BuildConfig.swift` to the scratchpad first: `npm run desktop` rewrites it mid-build. The first run after a build can fail timing checks; run twice before calling it a regression. Put the source list in a script file: an inline zsh `${(f)...}` array trips the shell safety check.
- To check suggestions against real files without touching the user's library: `createApplication({ dataDir: <scratch>, watchProjects: false })`, `workspace.add([...folders])`, `workspace.predict({ text, cursor })`. Test folders live in `~/Desktop/Software Tests/`.
- Relaunching: quit Lasso and `LassoLauncher` by pid, then `open dist/Lasso.app`. Several copies can run at once; check which bundle is running before keystroke tests.

## Conventions

- Comments and test names are plain sentences about behaviour ("A slide's title completes"), matching the surrounding density. No em dashes in prose written for the user.
- Tests: `node:test` + `assert/strict`, Arrange/Act/Assert, real temporary folders through `createApplication`. Write the failing test first.
- Server responses keep their existing shape; add fields, never rename them, since the Mac app and the Windows app (`desktop-windows/`) both read them.
- Commits: `type: description` (feat, fix, refactor, test, docs, chore), merged into `main` with `--no-ff` from `claude/*` branches. Commit only when asked.

## Keeping it cheap to change

- New code goes in the feature file it belongs to, or a new file of its own; split a file before it passes about 800 lines. Swift extensions in other files need members widened from `private` to internal.
- Still large, read by range: `src/dependencies/step-model.js` (1,476), `document-extraction.js` (1,307), `src/terminal/graph.js` (1,425), `desktop/Lasso.swift` (1,550), `desktop/DirectoryMenu.swift` (1,069), `public/terminal.css`, and the test files `desktop/tests/main.swift` and `test/*.test.js`.
