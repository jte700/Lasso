# Lasso: working notes for Claude

Lasso indexes local folders and suggests source-backed text while the user types in any Mac app (Tab accepts). A local Node server (`src/`) does indexing, ranking and sharing; a native AppKit menu bar app (`desktop/`) draws the suggestion card, Source Inspector, share composer and The Ranch. No language model is involved in suggestions.

Read only what a task needs. Files are split by feature and mostly under 500 lines; find the right one in the table below or with `grep -rn`, then read line ranges.

## Where things live

| Task | Server (`src/`) | Mac app (`desktop/`) |
| --- | --- | --- |
| What gets suggested while typing | `dependencies/writing-prediction.js` (`predict`, `predictionCandidates`, `namedFile`), `workspace-suggestions.js`, `study-variables.js`, `claim-candidates.js`, `linked-*.js` (after a source is accepted) | `GlobalAssistant+Prediction.swift` (request, `parse`) |
| Which typed words count as a match | `dependencies/direct-match.js`; claim spans in `claim-detection.js`; value, variable, reference matching in `*-match.js` | |
| Order of suggestions | `dependencies/ranking.js` (tier, band, usage), merged across folders in `workspace.js` `predict` (sets `rankOrder`, `matchedWords`) | `parse` sorts by `rankOrder` |
| Sentence completion | `dependencies/completion.js` | |
| File named while typing | `dependencies/file-reference.js` | |
| Readers: PDF, Word, xlsx/csv, pptx, DXF, IFC, STEP, LandXML | `dependencies/*-extraction.js`, `step-model.js`, `tabular.js`, `table-index.js`; objects per file in `file-objects.js`, `tabular-objects.js` | |
| Indexing a folder's objects | `dependencies/index-lifecycle.js`, `object-extraction.js`, `object-access.js`; `service.js` is only the class shell that installs these method groups | |
| Card preview JSON | `http/api.js` `/api/dependency-objects/:id/preview`, `dependencies/dependency-previews.js` | `GlobalAssistant+Preview.swift` (loading), `ModelPreview.swift` (parse), `AssistBoxView+Preview.swift`, `AssistPreviewViews.swift` (text, PDF, slides), `AssistTableLayout.swift`, `PreviewWordMarks.swift` (matched-word marks) |
| Slide pictures | `sharing/document-pages.js` `slidePicture`, `scripts/render-document-pages.swift` | `SlideDeckPreview.swift` (deck, slide menu, navigator) |
| Suggestion card itself, Tab, keys | | `GlobalAssist.swift` (controller state, keys), `GlobalAssistant+Panel.swift` (showing, placement), `GlobalAssistant+Insertion.swift` (Tab, links, undo), `AssistBoxView*.swift` (the drawn card), `AssistSuggestion.swift`, `AssistSuggestionList.swift`, `KeyRouting.swift`, `AccessibilityReader.swift`, `CompletionTransaction.swift` |
| Source Inspector (web page in a panel) | `sharing/share-page.js` `renderInspectorPanel` | `SourceInspectorPanel.swift` |
| Share links and recipient pages | `sharing/object-share.js`, `share-page.js`, `share-preview.js`, `dependencies/dependency-sharing.js` | `ShareComposerController.swift`, `ShareComposerView*.swift`, `ShareInteractivePDFView.swift`, `ShareInsertion.swift`, `ShareMarkup.swift` |
| The Ranch (library window) | `ranch/` | `Ranch*.swift` |
| Folder history, snapshots | `history/` | |
| Links in documents, re-anchoring after edits | `dependencies/dependency-links.js`, `reconciliation.js`, `source-updates.js`, `document-editing.js` | `DependencyHighlighter.swift`, `DependencyReference.swift` |
| Browser workbench (older web UI) | `public/app.js` wires `public/editor-*.js`, `workspace-*.js`, `dependency-*.js` modules; shared state in `public/state.js` | |
| Terminal commands (`ask`, `find`, `index`) | `terminal/` | |
| Menu bar panel, Settings | | `Lasso.swift`, `StatusPopover.swift`, `DirectoryMenu.swift`, `SettingsWindow.swift` |
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
- Still large, read by range: `src/dependencies/step-model.js` (1,476), `document-extraction.js` (1,190), `src/terminal/graph.js` (1,417), `desktop/Lasso.swift` (1,529), `desktop/DirectoryMenu.swift` (1,075), `public/terminal.css`, and the test files `desktop/tests/main.swift` and `test/*.test.js`.
