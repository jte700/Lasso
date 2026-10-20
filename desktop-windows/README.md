# Lasso for Windows

The Windows companion. It is the same application as the macOS one: the same
local server, the same indexing, ranking, provenance, and sharing, and the same
rules about what may be inserted into a document and when a dependency is
recorded. Only the native layer differs, and only because the platform does.

Nothing here reimplements Lasso. `src/`, `public/`, and `migrations/` are shared
verbatim; this directory is the shell around them.

## What is native, and what it replaces

| macOS | Windows |
| --- | --- |
| Menu bar status item | Notification area icon with a real context menu |
| `NSWindow` + `WKWebView` | WPF window + WebView2, Mica backdrop, system caption |
| `CGEventTap` | `WH_KEYBOARD_LL` low-level keyboard hook |
| Accessibility API (`AXUIElement`) | UI Automation text pattern, with `EM_GETSEL` for legacy edit controls |
| `AXSelectedTextRange` integer offsets | Range endpoint arithmetic, since UI Automation exposes no offsets |
| `kAXBoundsForRange` | `GetBoundingRectangles`, falling back to `GetGUIThreadInfo` |
| Accessibility write, then synthetic typing | Synthetic typing only: UI Automation text is read-only |
| `CGEvent` unicode keystrokes | `SendInput` with `KEYEVENTF_UNICODE` |
| `NSPanel` + `NSVisualEffectView` | Layered window + DWM acrylic, rounded corners |
| `NSWorkspace` file-type icons | `SHGetFileInfo`, so icons match the user's own associations |
| PDFKit drawing layout | `src/Lasso.DrawingLayout`, a published helper over PdfPig |

Two differences are deliberate rather than incidental:

- **No coordinate flip.** macOS reconciles a top-left Accessibility origin with
  a bottom-left AppKit origin. Every Windows coordinate system involved here is
  top-left, so the flip does not exist. Porting it would offset every highlight
  by the height of the display.
- **No beak on the panel.** macOS draws a pointer at the caret. Windows does
  not draw one on flyouts, menus, or IME candidate lists, so the panel sits
  under the caret and flips above it when the work area runs out.

Permissions differ too. macOS requires Accessibility and Input Monitoring
approval; Windows requires neither. What Windows does enforce is integrity
level: this application runs unelevated and therefore cannot read from or type
into a window running as administrator, and the hook is suspended entirely
while a UAC prompt is on screen.

## Layout

| Path | Responsibility |
| --- | --- |
| `src/Lasso.Core/` | Host-independent logic: completion planning and verification, anchoring, source identity, geometry, preview parsing. No Windows reference, so it is testable without a window. |
| `src/Lasso.Windows/` | The shell: tray, workspace, suggestion panel, overlay, chooser, composer, and the Win32 surface they need. |
| `src/Lasso.DrawingLayout/` | PDF drawing-layout extraction, emitting the same JSON as the macOS PDFKit helper. |
| `tests/Lasso.Core.Tests/` | A direct port of `desktop/tests/main.swift`, with the same check names. |

## Build

Requires the .NET 9 SDK and Node.js 24+.

```powershell
npm run desktop:windows:alpha
```

The script records the Node executable it found, draws the application icon,
runs both test suites, publishes the application self-contained, and bundles the
server beside it. Output is `dist/windows/Lasso/`. Node must remain installed;
`LASSO_NODE` selects which executable the application uses, exactly as on macOS.

`dotnet build` on its own also works, without an icon.

## Verification

```powershell
npm run desktop:windows:alpha:test     # host logic, 125 checks
npm test                         # application tests
```

The host logic tests are the macOS regression suite ported check for check, so
a behavioural difference between the two companions shows up as the same
sentence failing on one of them. They cover the destructive-completion bug in
particular: a completion can never delete more text than it inserts, a stale
plan is refused rather than applied, a host that edits outside the intended
range is caught, a browser's moving text window still verifies, and a
content-editable swapping a no-break space for an ordinary one is not mistaken
for an edit.

Two checks are Windows-specific because the platform is: that no vertical flip
is applied, and that a differently-cased project root is the same folder rather
than an escape attempt.

For a visual check of the suggestion panel with fixed content and no server:

```powershell
$env:LASSO_OVERLAY_FIXTURE = "1"; .\dist\windows\Lasso\Lasso.exe
```

## Storage

| Location | Contents |
| --- | --- |
| `%LOCALAPPDATA%\Lasso\data` | SQLite history and content-addressed snapshots |
| `%LOCALAPPDATA%\Lasso\Logs\server.log` | Server output |
| `%LOCALAPPDATA%\Lasso\Logs\assist.log` | The typing log: every stage of every insertion |
| `%LOCALAPPDATA%\Lasso\references.json` | Local dependency references |
| `%LOCALAPPDATA%\Lasso\settings.json` | Host preferences |
| `%LOCALAPPDATA%\Lasso\WebView2` | The workspace view's own browser profile |

These are machine-local and can be large, which is why they are in
`LocalApplicationData` rather than a roaming profile.

## Known limits

- The workspace still uses the macOS visual layer (`public/macos.css`). A
  Windows skin is a separate change; the shell already marks the document with
  `data-platform="windows"` so one can key off it.
- Insertion is always typed. Where a host swallows synthetic keystrokes the
  read-back check fails and no dependency is recorded, which is the intended
  outcome, but the text is not inserted either.
- Figure previews (`src/dependencies/figure-preview.js`) remain macOS-only.
  Drawing layout extraction is not: that gap is closed by the bundled helper.
- The port has been exercised on this machine against Notepad and the bundled
  workspace. Word, Excel, Chrome, and Edge have not been checked yet.
