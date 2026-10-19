# Lasso for Windows — 1.0.1 test build

This Windows desktop build uses a native WPF host, the Microsoft Edge WebView2 runtime, and the same local Lasso engine as the Mac application. It has a Windows title bar, Snap/resize controls, a system tray icon, a native folder picker, Windows keyboard shortcuts, standard Windows suggestion controls, and a compact workspace in light or dark mode.

## Run the preview

1. Extract the complete `Lasso-win-x64.zip` folder to a writable location.
2. Open `Lasso.exe`. Keep its `app`, `runtime`, and runtime library files beside it.
3. Select **Index a project**, then **Browse…** to choose a folder.
4. Close the window to keep Lasso running in the notification area. Use **Quit Lasso** in its tray menu to stop it.

Windows 11 x64 is the primary target. The host targets Windows 10 1809 or later and uses Windows 11 backdrop attributes when available. Live verification on supported Windows versions is still required. The package includes .NET and Node; users do not need developer tools. Microsoft Edge WebView2 Evergreen Runtime is required; the app offers its official installation page when missing. This preview is unsigned.

For an optional Start-menu installation, run `powershell -NoProfile -File .\install.ps1` from the extracted package. Add `-DesktopShortcut` for a desktop shortcut. Run the same installer with `-Uninstall` to remove app files and shortcuts while retaining user history. Quit the tray application first. The installer does not change execution policy, add autorun, or require administrator privileges.

## Functionality

The shared engine preserves project indexing, source browsing and search, source-backed writing, local document saves, version history, change review, model evidence, and version-pinned sharing. PDF layout extraction and figure previews use bundled PDF.js and a Windows canvas renderer; Swift and Poppler are not required.

Windows source sharing offers indexed context, the complete document, or selected cell/text redactions. No grant is created until **Create link** is selected. Links can be copied or revoked. Local links work only on the machine running Lasso unless a reachable server is explicitly configured. Port 4319 is preferred; if occupied, a private free port is selected. Earlier local URLs using a different port must be copied again from Shared links.

The desktop window retains the existing local HTTP API model. Actor identities are attribution, not authentication. Do not expose that API publicly; see the repository's deployment limitations.

## Writing in other apps

Choose a project, then enable **Writing suggestions** from the workspace or tray. Assistance is off by default. It reads bounded text near the caret only from supported editable Windows UI Automation controls; password fields and Lasso itself are excluded.

- **Tab** accepts and locally links the selected source. Exact matches become linked without adding text.
- **Ctrl+Enter** inserts plain text without a source highlight.
- **Up/Down** changes the selected result; **Escape** dismisses.
- Click an accepted, underlined phrase to open its recorded source.
- **F4** opens source evidence; **Ctrl+Shift+Enter** opens the sharing composer. After creating a share, **Insert link into document** pastes a hyperlink in rich editors or a label and URL in plain editors.
- **Recent inserted sources** in the tray opens verified source references, including their recorded version.
- **Ctrl+K** focuses workspace search; **Ctrl+Shift+P** opens commands; **Ctrl+S** saves inside Lasso.

Normal acceptance preserves the clipboard, checks the original editor/caret again, and records provenance only after verifying readback. It appends a missing suffix or replaces the exact claim range returned by the shared engine. The local ledger stores up to 250 accepted phrases, source/version IDs, application names, timestamps, and up to 32 characters of context on each side. Windows UI Automation geometry places the clickable underline over the verified text. Ambiguous, edited or unavailable text hides its underline. Reopening an editor that has a different accessibility identity may require finding its source in **Recent inserted sources**; the app does not attach a saved link to an uncertain target.

The shared-link command temporarily borrows the clipboard and restores it if no other application changed it. Failed or unverified insertion attempts revoke the created grant when the local server is reachable. Check **Shared links** if insertion reports a failure.

### Validation status

This revision fixes formatted empty Excel cells and reindexes existing spreadsheet sources without deleting pinned versions. It keeps five ranked suggestions, retains exact matches, sends accepted-source context for follow-up choices, and does not expire a popup on a transient accessibility timeout. The popup uses the Windows list-box and button controls; the shared workspace retains all existing workflows with simpler Windows styling.

The application tests, Mac regression checks, Windows logic tests, shared-workspace browser checks, and Windows cross-compilation were run on macOS. Actual Windows browser interaction has **not** been run in this environment. Full platform parity is not certified by those checks.

For repeatable checks on a Windows desktop with .NET 8, use:

```powershell
dotnet run --project desktop/windows/BrowserTests/Lasso.BrowserTests.csproj -- edge
dotnet run --project desktop/windows/BrowserTests/Lasso.BrowserTests.csproj -- chrome
```

The harness opens an isolated browser profile with synthetic sources. It checks textarea, input and contenteditable caret access, five suggestions, visibility after idle, verified acceptance, clickable geometry, source opening and follow-up context. It calls the production acceptance method directly; physical keyboard-hook delivery, IME and shared-link paste still require manual checks.

Before broad rollout, run the Windows CI build and perform live checks in Notepad, Word, and Edge/Chrome: opt-in/off, switching projects, stale caret/focus, password fields, selection cancellation, non-English input/IME, 100/150/200% DPI across monitors, keyboard navigation, title bar/Snap behavior, installer upgrade/uninstall, app/server crash cleanup, and WebView2 recovery. Sign and reputation-test a distribution build using the release owner's certificate. No certificate or publishing service is configured by this change.

## Build on Windows

Install PowerShell 7 and .NET SDK 8, then run from the repository root:

```powershell
npm run desktop:windows
# Or without requiring Node on the build machine:
pwsh -NoProfile -File desktop/windows/build.ps1
```

The script downloads SHA-256-pinned Node 24 archives from nodejs.org, installs Windows production dependencies from the npm lockfile, runs the application and assist logic tests, publishes the self-contained application, and runs `Lasso.exe --smoke-test` against isolated temporary history. The smoke test verifies the bundled engine, migrations, and HTTP startup, not desktop interaction. Output is `dist/windows/Lasso-win-x64.zip` plus its checksum. ARM64 packaging is supported by the script but is not validated by the x64 preview.

The GitHub workflow `.github/workflows/windows.yml` performs this build on Windows and uploads private workflow artifacts. It does not publish a release.

## Storage and implementation

- `%LOCALAPPDATA%\Lasso\data`: SQLite history and source snapshots.
- `%LOCALAPPDATA%\Lasso\WebView2`: local browser profile.
- `%LOCALAPPDATA%\Lasso\logs`: bounded diagnostics.
- `%LOCALAPPDATA%\Lasso\accepted-sources.json`: verified external reference ledger.
- `%LOCALAPPDATA%\Lasso\settings.json`: host preferences.

The host runs as the current user, trusts native messages only from the top-level workspace URL at its owned loopback origin, and identifies its child through a private nonce-bearing stdout handshake. Shutdown uses the private stdin pipe and a Windows job object. Project files remain in their original folders. Packaging uses an explicit source allowlist and does not include the developer's history, credentials, or project data.

Design and platform references: [Windows typography](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography), [Windows geometry](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/geometry), [WebView2 security](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).
