# Lasso

**A local-first source library and writing assistant with versioned evidence.**

Lasso connects the information you use while writing to the files it came from. Index a local project folder, browse its documents and data, inspect an exact cell or passage, and insert source-backed values into your writing. Accepted links retain the original source version, so you can review what changed when the underlying file is updated.

The app includes a graphical source workspace, an integrated writing editor, and a native macOS menu bar companion for suggestions in supported external editors. Retrieval, ranking, extraction, and provenance run locally. No language model or API key is required.

## What you can do

- **Browse and search sources.** Explore indexed files and their contents, inspect nearby spreadsheet cells or document passages, open the recorded source version, and copy values with a source citation.
- **Write with evidence.** Accept suggested values, citations, and extractive sentence continuations from your project, or select a source manually. Links record the source object, location, and immutable version.
- **Use Lasso in other apps.** The macOS companion displays a source picker and preview beside your text cursor, inserts a selected value, and keeps a local source reference where the host editor supports it.
- **Review changes.** Inspect previous and current values, affected document references, and indexing failures. Review proposed wording updates before applying them, or keep a historical source version.
- **Share selected evidence.** Choose a whole document, an indexed part, or a selectively redacted view. Share records pin the source version and can be revoked.
- **Query design measurements.** Find supported quantities from IFC, DXF, LandXML, and explicit PDF annotations, with source locations and units. Ambiguous or missing measurements are not guessed.

## Run locally

Requires **Node.js 24 or newer**. There are no third-party npm runtime dependencies or frontend build steps.

```sh
git clone https://github.com/jte700/Lasso.git
cd Lasso
npm start
```

Open [127.0.0.1:4317](http://127.0.0.1:4317). Choose **Index a project**, enter the absolute path to a local directory, and let Lasso create its initial snapshot. Project files remain in their original directory.

The workspace has **All sources**, **Changes**, **Shared links**, and **Review sources** views, plus a **Writing** list for project documents. Search by filename, phrase, or value. Supported questions can be entered in the search field and submitted with Enter, for example:

```text
What is the net floor area of Schlafzimmer?
What is the length of Main Road?
```

These answers require matching evidence in the indexed project; this is not a general-purpose chat service.

## macOS companion

Requires macOS 13 or newer, Node.js 24+, and the Swift compiler from Xcode or its Command Line Tools.

```sh
npm run desktop
open dist/Lasso.app
```

The build creates and locally signs `dist/Lasso.app`. It bundles the server and interface, but **Node.js must remain installed**. Set `LASSO_NODE` when building to select its executable.

The app lives in the menu bar. Click its icon to show or hide the workspace; closing the window leaves the local server running. The menu includes browser access, server controls, and writing-assistance settings. The desktop server prefers loopback port `4319` and chooses another available port if needed.

### Writing in other applications

Select a project in Lasso, then enable **Suggest While Typing Anywhere** from the menu bar. macOS Accessibility and Input Monitoring permissions are required. Suggestions use the active project's index and nearby text from the focused editor.

| Action | Behavior while suggestions are visible |
| --- | --- |
| Tab | Accept using the configured insertion preference; plain text is the default |
| ⌘Enter | Insert as plain text with local source tracking |
| ↑ / ↓ | Select another suggestion |
| Esc | Dismiss the suggestions |
| Share or ⇧⌘Enter | Open the sharing composer before creating a share |

The source preview lets you inspect evidence before accepting it. Local source highlights are drawn by Lasso and do not add hidden provenance to a recipient's document. Behavior depends on the host application's text and accessibility support; insertion, caret positioning, and highlighting are not identical in every editor. Rebuilding with ad-hoc signing may require granting permissions again.

### Writing inside Lasso

Open a document from **Writing**. The editor offers source-backed suggestions, manual source linking, and linked-source inspection. Accepted suggestions remain local to the editing session until saved; manual save and the five-minute background autosave commit document content and pending links together.

Markdown and plain-text saves update the project file. DOCX and PDF edits are stored as a separate versioned text layer in Lasso; they do not rewrite the original document's bytes or formatting.

## Windows companion

Requires Windows 10 1809 or newer, Node.js 24+, the .NET 9 SDK to build, and the
Microsoft Edge WebView2 runtime to run.

```powershell
npm run desktop:windows
.\dist\windows\Lasso\Lasso.exe
```

The same application as the macOS companion, sharing the same server, indexing,
provenance, and sharing rules. It lives in the notification area: clicking the
icon shows or hides the workspace, and closing the window leaves the local
server running. The menu holds browser access, server controls, and
writing-assistance settings. The desktop server prefers loopback port `4319`
and chooses another available port if needed.

Only the native layer differs. The suggestion panel is a Windows flyout -
acrylic, rounded, Segoe UI Variable, the system accent colour, and the shell's
own file-type icons - rather than a translation of the macOS panel. Text is
read through UI Automation instead of the Accessibility API, so no permission
prompt is involved; what Windows does enforce is integrity level, and an
application running as administrator is out of reach of an unelevated Lasso.

| Action | Behavior while suggestions are visible |
| --- | --- |
| Tab | Accept using the configured insertion preference; plain text is the default |
| Ctrl+Enter | Insert as plain text with local source tracking |
| Ctrl+Shift+Enter | Open the sharing composer before creating a share |
| Up / Down | Select another suggestion |
| F4 | Open the selected source |
| Esc | Dismiss the suggestions |

See [the Windows companion notes](desktop-windows/README.md) for what each
native piece replaces, how it is verified, and its current limits.

## Supported sources

Support varies by format and content. Files can be retained in history even when structured extraction is unavailable.

| Source | Indexed evidence |
| --- | --- |
| Markdown and plain text | Document passages, source-backed continuations, and claims |
| CSV / TSV and supported spreadsheets | Tables, rows, cells, values, and variable definitions |
| DOCX | OOXML text and document metadata |
| PDF | Locally extractable text and metadata; supported explicit drawing annotations |
| Code, JSON, and notebooks | Code locations, structured values, and notebook cells |
| BibTeX, RIS, EndNote, and NBIB | Reference records and available author, year, title, DOI, and PMID metadata |
| IFC | Supported element quantities and typed properties, with entity identity and units |
| ASCII DXF | Area and perimeter of supported closed model-space polylines with declared units |
| LandXML | Supported parcel areas, alignment and pipe lengths, diameters, and elevations |

Scanned PDFs require OCR before their text can be indexed. The desktop build includes a PDFKit extraction helper; development drawing-PDF extraction requires Swift on macOS or `pdftotext` on PATH. Native IFC, DXF, and LandXML readers require only Node.js.

DWG, RVT, and DGN require an export from their authoring application. IFC can preserve BIM properties, DXF supports selected CAD boundaries, and LandXML preserves supported civil attributes. Lasso does not infer missing BIM quantities or reconstruct rooms from arbitrary drawing geometry. See [design-source indexing](docs/design-source-indexing.md) for exact supported subsets and limits.

## Sharing and storage

Plain-text insertion and local source linking do not publish a document. Sharing opens a composer where you choose what a recipient can see:

- **Whole document:** permits the original file download.
- **Indexed part:** exposes the selected indexed evidence and its context.
- **Selective redaction:** masks chosen cells or text sections before rendering.

Restricted shares do not permit original-file downloads. Shares pin their source version, so later edits do not change the evidence behind an existing link.

**Default share links are local to the computer running Lasso.** Recipients on another computer need a reachable server. `SHARE_BASE_URL` changes generated URLs; it does not deploy the app or create a tunnel. The local API uses actor identities for attribution, not authentication. See [current limitations](docs/limitations.md) before designing a hosted deployment.

| Setting or location | Purpose |
| --- | --- |
| `LASSO_DATA_DIR` | Override the development database and blob-store directory |
| `.lasso-data/` | Default development history store in the server's working directory |
| `.colab-dry-data/` | Existing legacy store used when `.lasso-data/` is absent |
| `~/Library/Application Support/Lasso/data` | macOS app history store |
| `~/Library/Logs/Lasso/server.log` | macOS server log |
| `PORT` | Development server port; defaults to `4317` |
| `LASSO_WATCH_DEBOUNCE_MS` | Watcher batching interval; defaults to `2500` ms |
| `SHARE_BASE_URL` | Base URL used to construct shared links |

History uses SQLite and content-addressed file snapshots. The desktop build can seed a first installation from existing local history; subsequent builds retain the app's existing data. Local databases, generated app bundles, and machine-specific configuration are excluded from Git.

## Development and verification

```sh
npm test                    # Node.js unit and integration tests
npm run desktop:test        # Native anchor, text, and coordinate checks
npm run desktop             # Compile and sign the macOS app
```

The tests cover indexing, source matching, document links, migrations, history, sharing, drawing readers, and dependency queries using temporary projects and databases.

For optional live Chrome geometry checks:

```sh
npm run desktop:test:browser
npm run desktop
```

The browser check requires Chrome and Accessibility permission, opens an isolated temporary profile, and builds a test variant. The second command restores the regular app build.

For hash-checked architectural and civil sample validation:

```sh
node --disable-warning=ExperimentalWarning scripts/validate-drawing-sample.js
# Append --pdf to include the PDF annotation sample.
```

Fixture origins, hashes, and expected measurements are recorded in [the sample manifest](test/fixtures/drawings/sources.json). See [sample validation](docs/drawing-sample-validation.md) for details.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `desktop/` | Swift/AppKit wrapper, external-editor integration, native source and share panels |
| `public/` | Browser and WKWebView interface, source library, and writing workspace |
| `src/history/` | File snapshots, change detection, previews, and recorded provenance traversal |
| `src/dependencies/` | Extraction, indexing, matching, ranking, and document-source links |
| `src/terminal/` | Structured source queries, change review, aliases, and index controls |
| `src/sharing/` | Version-pinned share grants and scoped previews |
| `src/http/` | Local HTTP API |
| `migrations/` | SQLite schema migrations |
| `scripts/` | Extraction helpers and sample validation |
| `test/` | Automated tests and source fixtures |

Further implementation details: [version history and provenance](docs/scientific-timeline.md), [writing and source linking](docs/predictive-provenance-editor.md), and [current limitations](docs/limitations.md).
