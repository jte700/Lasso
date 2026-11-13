# Building and configuration

## Requirements

Requires **Node.js 24+**. Building the macOS app also requires the Xcode Command Line Tools. The built app runs on **macOS 13.5 or later** and carries its own Node.js, so Macs that only run it need neither.

## Running the server alone

```bash
npm ci
npm start
```

`npm ci` installs the offline IFC geometry and PDF engines. Open [http://127.0.0.1:4317](http://127.0.0.1:4317), add absolute directory paths, and enable the directories you want to use. Sources from all enabled, available directories are searchable together. Selecting a document directory changes where you write without changing which sources are enabled. Pausing a directory stops its suggestions and watcher while preserving history.

## Building the macOS app

```bash
npm run desktop
open dist/Lasso.app
```

`npm run desktop` compiles, signs and verifies the app into `dist/Lasso.app`. A running copy keeps its old code until it is quit and opened again.

## Bundled Node.js

`npm run desktop` copies the Node.js it builds with (`LASSO_NODE`, or `node` on `PATH`) into `Lasso.app/Contents/MacOS/node`, puts its license in `Contents/Resources/node/LICENSE`, and signs it together with the app. It must be Node.js 24 or newer and link only macOS's own libraries, as the nodejs.org installer and nvm builds do. Homebrew's Node depends on other Homebrew packages, so the build stops and says so. Version manager shims, such as asdf's or Volta's, are followed to the real binary, and a universal Node keeps only the architecture the app is compiled for. The nodejs.org installer does not keep a license file, so the build downloads that release's `LICENSE` from the Node.js repository once and caches it in `~/Library/Caches/Lasso`; set `LASSO_NODE_LICENSE` to build offline.

The runtime brings the app from about 30 MB to 142 MB, and a compressed disk image from about 7 MB to 48 MB.

## Supported macOS

The app runs on macOS 13.5 or later, set once by `MACOS_MINIMUM` in `desktop/build.sh`. The build compiles the app and its PDF helpers for that version and writes it into `Info.plist` as `LSMinimumSystemVersion`. The Swift code itself needs macOS 13, for login items; the nodejs.org build of Node.js 24 needs 13.5. The build reads the bundled Node.js's minimum with `vtool -show-build` and stops if it is later. The app is built for the processor of the Mac that builds it, Apple silicon or Intel.

On macOS 26 the app's surfaces use Liquid Glass; earlier versions use the standard translucent material. The app icon follows the macOS of the building Mac (see `LASSO_ICON_STYLE`), so a build made on macOS 26 shows its icon without rounded corners on earlier versions.

## Signing and permissions

Use a valid code-signing certificate to preserve macOS permissions across updates. The build automatically recognizes `Lasso Local Development` or `CoLab Dry Local Development`. To choose another identity, set `LASSO_SIGN_IDENTITY` to a certificate name or SHA-1 fingerprint from:

```bash
security find-identity -v -p codesigning
```

The build compiles, signs, and verifies a temporary app before replacing `dist/Lasso.app`. One `codesign` call signs the bundled Node.js, the PDF helpers and the app, so a single Keychain approval covers them. If signing fails, or the signed Node.js does not run, the previous app stays intact. `LASSO_SIGN_MODE=adhoc npm run desktop` is available for temporary builds, but their Accessibility approval may stop applying after rebuilding.

Repeated Keychain prompts mean the signing tool has not been granted persistent access to the signing key. Save trusted access for Apple's `/usr/bin/codesign` on the existing Lasso signing key once. In a normal signing prompt, **Always Allow** saves access; **Allow** covers only that attempt. After setup, signing runs automatically while the login keychain is unlocked. Keep the same certificate to preserve Lasso's macOS permissions. See [Apple's Keychain access guidance](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26).

Enable **Suggest While Typing**, then follow any **Allow Accessibility…** or **Allow Input Monitoring…** action. macOS requires you to approve access in System Settings → Privacy & Security. The setting remembers your choice while approval is pending and starts automatically when access becomes available. After changing from an old ad-hoc build to certificate signing, remove the old Accessibility entry and add the signed app once.

## Windows companion (preview)

Two Windows hosts share the same server, indexing, provenance and sharing rules.

### Current build (`desktop/windows`)

A native Windows host offers a Fluent workspace, standard Windows controls, a system tray icon, native folder selection, and an opt-in writing assistant. It uses the same source library, editor, history, model previews, and sharing engine.

```powershell
pwsh -NoProfile -File desktop/windows/build.ps1
```

Build on Windows with PowerShell 7 and the .NET 8 SDK. The output bundles Node.js and .NET; users need only the Microsoft Edge WebView2 Runtime. Extract the complete ZIP and run `Lasso.exe`. The assistant supports verified local source highlights, five-choice suggestions, source-scoped follow-ups, and explicit shared-link insertion. See [Windows setup and validation status](../desktop/windows/README.md) before rollout; live Windows validation is still required.

### Alpha host (`desktop-windows`)

Requires Windows 10 1809 or newer, Node.js 24+, the .NET 9 SDK to build, and the
Microsoft Edge WebView2 runtime to run.

```powershell
npm run desktop:windows:alpha
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

See [the Windows companion notes](../desktop-windows/README.md) for what each
native piece replaces, how it is verified, and its current limits.

## Configuration

| Setting | Default or purpose |
|---|---|
| `LASSO_DATA_DIR` | CLI history uses `.lasso-data`; an existing `.colab-dry-data` is reused when the new location is absent. |
| `PORT` | CLI server port, `4317`. The macOS app prefers `4319`, then an available loopback port. |
| `LASSO_WATCH_DEBOUNCE_MS` | Watcher batching delay, `2500` ms. |
| `LASSO_WATCH_MAX_WAIT_MS` | Longest a file saved over and over can postpone its capture, `15000` ms. |
| `LASSO_NODE` | Node.js binary the desktop build bundles, `node` on `PATH` by default. Set when the app starts, it runs the server instead of the bundled copy. |
| `LASSO_NODE_LICENSE` | Node.js `LICENSE` file for the build to bundle, for offline builds from the nodejs.org installer, which does not keep one. |
| `LASSO_SIGN_IDENTITY` | Desktop signing certificate name or SHA-1 fingerprint. |
| `LASSO_MICROSOFT_CLIENT_ID` | Client ID of the Microsoft app registration Outlook signs in with. Without it, the Connect window asks for one. |
| `LASSO_GOOGLE_CLIENT_ID`, `LASSO_GOOGLE_CLIENT_SECRET` | The Google OAuth desktop client Google Calendar signs in with. Without them, the Connect window asks for them. |
| `LASSO_ICON_STYLE` | App icon drawn by `scripts/render-app-icon.swift`: `full-bleed` for macOS 26, which masks icons to its own shape, or `squircle` for earlier versions. Defaults to the building Mac's version. |
| `SHARE_BASE_URL` | Base URL for generated share links. |

The macOS app stores history in `~/Library/Application Support/Lasso/data` and logs in `~/Library/Logs/Lasso`. The Windows app keeps history, settings, its browser profile, and logs in `%LOCALAPPDATA%\Lasso`. Its build migrates the former CoLab Dry data location when needed. Enabled directories resume watching after startup, rereading only files whose size, modification or change time differs from the last recorded version; unavailable folders do not prevent other directories from loading. Folders are read in short slices, so the menu and suggestions stay responsive while a large folder is added or brought up to date. Text read from PDFs for search is kept by file content in the data directory's `derived` folder, and read by a worker thread the first time, so a restart does not read every PDF again; it is rebuilt if deleted. History is stored separately from selected directories unless you explicitly choose otherwise. The server log is rotated at 5 MB.

Office lock and owner files (`~$Budget.xlsx`, `.~lock.*#`), partial downloads (`.crdownload`, `.part`, `.download`), `.tmp` files and system files such as AppleDouble `._*`, `Thumbs.db` and `desktop.ini` are not tracked. Neither are folders that hold tools' files rather than your work: version control (`.git`), installed packages (`node_modules`, `site-packages`, `.venv`, and any Python virtual or conda environment whatever its name, recognised by its `pyvenv.cfg` or `conda-meta`, as well as R's `renv/library`), caches (`__pycache__`, `.pytest_cache`, `.ipynb_checkpoints`, `.next` and similar) and volume metadata (`.Trash`, `.Spotlight-V100`). A folder that held one of these before this rule keeps that history, and records the files as removed the next time it starts. A file that exists but cannot be read for a moment keeps its last recorded version rather than being recorded as deleted. Files that cannot be indexed, or are indexed only in part, are listed by `index failures`: damaged or password-protected documents and PDFs without a text layer. Supported files remain eligible throughout large folders; individual readers retain their format-specific safety limits.

Worksheets and CSV or TSV files of any size are indexed whole. A table's first 1,000 rows (and up to 1,500 of their cells) are recorded as sources, as before, and its row count is always the whole table's. Every row of a larger table whose rows have names is also kept in a table index (`derived/tables.sqlite` in the data directory), with each name stored whole and from each of its words. Typing part of a row's name, or naming a row after an accepted column ("Deaths in Manitoba district 45003 were"), looks the name up there with a bounded index range scan instead of scoring every cell, so a 500,000-row sheet answers in about 20 ms. A row or cell from the index becomes a source the first time it is offered, under the key it would have had among the first rows, and each later reading of its file records it again, so links to it are kept, follow its value and go stale when it changes. A table whose rows have no names (tidy data, where every column repeats its values) keeps only its first and last rows and its count. Previews and shares of a large table read the rows around the cited one from the index. Files whose sheets or text are larger than 5 MB are read a batch of rows at a time in a worker thread, so adding one does not hold up the menu or suggestions, and the folder's bar counts through it. The table index is derived data, rebuilt from the files if it is deleted. Excel dates and percentages are indexed as the sheet shows them, with dates written as `YYYY-MM-DD`.

The browser's identity selector provides attribution, not authentication. Remote synchronization, production authentication, and automatic history garbage collection are not implemented.

## Tests

```bash
npm test
npm run desktop:test
npm run desktop
```

The JavaScript suite covers history, source indexing, cross-directory dependencies, ranking, sharing, browser state, and the command layer using temporary workspaces. Native checks cover insertion, text anchors, highlight geometry, directory colours, and permission state. Building the desktop app compiles the complete Swift application.

Architecture and implementation references:

- [Timeline, snapshots, and recorded provenance](scientific-timeline.md)
- [Predictive dependencies, editor behaviour, and ranking](predictive-provenance-editor.md)
- [Ranking algorithm reference (PDF)](lasso-ranking-algorithm.pdf)
