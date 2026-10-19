# Lasso HIG audit

This audit compares every Lasso surface with Apple's Human Interface Guidelines (HIG), read on 19 October 2026 from `developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`. Pages read: designing-for-macos, materials, color, dark-mode, typography, sf-symbols, layout, windows, panels, popovers, sidebars, toolbars, menus, the-menu-bar, context-menus, buttons, text-fields, search-fields, lists-and-tables, alerts, settings, keyboards, pointing-devices, motion, feedback, loading, accessibility, icons, writing.

Findings are ranked within each section by how strongly they make Lasso feel non-native or off-brand. Rank 1 is the strongest. The **Status** column records what the `hig-native-pass` branch did:

- **Fixed**: changed on this branch, with the commit subject listed in the PR.
- **Partly fixed**: the most visible cases were changed; the rest are listed under "Left for later".
- **Left for later**: deliberately not changed on this branch, with the reason.
- **Kept**: reviewed and kept as is, because the current design is a deliberate, defensible exception.

Before and after screenshots live in [`docs/hig-audit/before`](hig-audit/before) and [`docs/hig-audit/after`](hig-audit/after). Web surfaces were rendered in WKWebView (the engine the app uses) in light and dark mode. Native surfaces were rendered offscreen from the real AppKit classes with sample folders. The website was rendered at 375, 768 and 1440 points wide.

## What Lasso is made of

| Surface | Technology | Where |
| --- | --- | --- |
| Menu bar extra and status panel | `NSStatusItem` + `NSPopover` that mirrors an `NSMenu` | `desktop/Lasso.swift`, `desktop/StatusPopover.swift`, `desktop/DirectoryMenu.swift` |
| Notch panel | Borderless nonactivating `NSPanel` on the camera housing | `desktop/NotchPanel.swift` |
| Source inspector | Borderless `NSPanel` with `NSGlassEffectView` (macOS 26) or `NSVisualEffectView`, hosting a `WKWebView` of `/inspect` | `desktop/SourceInspectorPanel.swift`, `src/sharing/share-page.js` |
| Source chooser | Titled `NSPanel` with search field and table | `desktop/SourceChooser.swift` |
| Share composer | Custom-drawn nonactivating `NSPanel` | `desktop/ShareComposer.swift` |
| Suggestion popups and overlays | Custom-drawn panels, highlight overlays, model preview | `desktop/GlobalAssist.swift`, `desktop/AssistPopupHost.swift`, `desktop/DependencyOverlay.swift`, `desktop/ModelPreview.swift` |
| Workspace | Web UI served by the local server, opened in the default browser | `public/index.html`, `public/*.css`, `public/*.js` |
| Share page | Server-rendered HTML for recipients | `src/sharing/share-page.js` |
| Website | Static marketing pages | `website/index.html`, `website/living-archive/`, `brand/lasso-character.html` |

## App

| # | Finding | Where | HIG | Status |
| --- | --- | --- | --- | --- |
| A1 | **No main menu at all.** `NSApp.mainMenu` is never set, so Lasso has no Lasso, File, Edit, View, Window or Help menu. Inside Lasso's own windows Command-C, Command-V, Command-X, Command-A, Command-Z, Command-W, Command-Q, Command-H and Command-Comma do nothing, because AppKit routes those key equivalents through the main menu. This breaks copy and paste in the source chooser's search field and in the inspector's web view. | `desktop/Lasso.swift` | the-menu-bar (Anatomy, App menu, Edit menu, Window menu, Help menu); keyboards (Standard keyboard shortcuts) | Fixed |
| A2 | **No Settings window or Command-Comma.** App-level options (Suggest While Typing, Show Lasso in Notch, Open at Login, Tab Inserts) live only in the status panel and its Tools submenu. | `desktop/Lasso.swift` | settings (macOS: "Include a settings item in the App menu", Command-Comma, "App Name Settings" title); the-menu-bar (Settings…) | Fixed |
| A3 | **Pointing-hand cursor on buttons in the workspace and inspector.** About 34 rules set `cursor: pointer` on buttons, rows, tabs and cards. A later `button { cursor: default }` loses to every class selector. macOS reserves the pointing hand for links. | `public/terminal.css`, `public/macos.css`, `public/utility.css`, inspector styles in `src/sharing/share-page.js` | pointing-devices (macOS Pointers: Arrow vs Pointing hand) | Fixed |
| A4 | **Workspace colors ignore the user's accent and semantic colors.** Blue is hard-coded as `#0a84ff`/`#007aff`; labels, separators and backgrounds are fixed RGBA values. A Mac set to a graphite or purple accent still sees blue selection and buttons. | `public/utility.css`, `public/macos.css` | color (System colors, "Avoid hard-coding system color values"; App accent colors); dark-mode (Dark Mode colors) | Fixed (accent, status colors and label colors follow WebKit's `-apple-system-*` colors, with the old values as fallbacks in other browsers) |
| A5 | **Text below the macOS minimum.** Several workspace rules render 7 to 9 point text (shortcut key caps, object type badges, completion descriptions). The share composer draws 9 point captions and the model preview a 9.5 point caption. | `public/utility.css`, `public/terminal.css`, `desktop/ShareComposer.swift`, `desktop/ModelPreview.swift` | typography (macOS default 13 pt, minimum 10 pt); accessibility (Vision) | Fixed. A script walked every rendered element in the library and editor views: no visible text is under 10 points (the only smaller text is in a screen-reader-only region). |
| A6 | **App chrome text is selectable.** Dragging across the sidebar, toolbar labels, section headers and buttons selects text like a web page. | `public/utility.css` | designing-for-macos; layout | Fixed (chrome is unselectable; content, values, paths and editor text stay selectable) |
| A7 | **Reduce Motion is only partly respected in the workspace.** The loading spinner, hover transitions and popover animations in `utility.css` keep animating. | `public/utility.css` | motion ("Make motion optional"); accessibility (Cognitive: Reduce Motion) | Fixed |
| A8 | **Sentence case on buttons, menu items, window and panel titles.** Examples: "Choose a source", "Preview source", "All documents", "Pause suggestions", "Open sources", "Open source", "Share link", "Add directories", "Review changes". Alerts are titled "Lasso" or "Host text support". | `desktop/SourceChooser.swift`, `desktop/NotchPanel.swift`, `desktop/Lasso.swift`, `src/sharing/share-page.js`, `public/index.html` | menus (Labels: title-style capitalization); buttons (Content); writing (capitalization, consistent style); alerts (title describes the situation) | Fixed for native surfaces, the inspector and the workspace toolbar, sidebar and dialogs; see "Left for later" for generated workspace content |
| A9 | **Text glyphs instead of SF Symbols.** The inspector's native close button is the text "×". The inspector toolbar uses "↗" and "×" characters. The share composer draws "‹" and "›" for page arrows. | `desktop/SourceInspectorPanel.swift`, `src/sharing/share-page.js`, `desktop/ShareComposer.swift` | sf-symbols; icons (Standard icons: `xmark`, `chevron.left`/`chevron.right`) | Fixed (native close and page arrows use `xmark` and `chevron.left`/`chevron.right`; the inspector page uses SVG drawn to match the SF Symbols) |
| A10 | **Em dashes in user-visible text.** The host text support report and a share field placeholder use em dashes. | `desktop/HostCapabilityProbe.swift`, `public/app.js` | writing (clear, consistent language; project rule: no em dashes) | Fixed |
| A11 | **Status item opens a popover, not a menu.** | `desktop/Lasso.swift`, `desktop/StatusPopover.swift` | the-menu-bar (Menu bar extras: "Display a menu, not a popover… unless the functionality is too complex for a menu") | Kept. The panel holds per-folder switches, color pickers and remove badges that a menu cannot host, and it already mirrors menu metrics (menu font, checkmark column, hover highlight, shortcut column). |
| A12 | **Inspector's Tab key shares instead of moving focus.** Tab is the standard key for moving keyboard focus; in the inspector it creates a share link. | `src/sharing/share-page.js` | keyboards ("Respect standard keyboard shortcuts"); accessibility (keyboard-only use) | Left for later. Tab is Lasso's core insert-and-share gesture across the product, so changing it needs a product decision. |
| A13 | **"Work Directories" instead of "folders".** Mac users and Finder say folder. | Status panel, workspace, dialogs | writing (familiar terms); designing-for-macos | Left for later. The term is used across the server API, help text and tests, so renaming it is a separate, product-wide change. |
| A14 | **No context menus in the workspace.** Sources, files and shared links cannot be Control-clicked, although the status panel's folder rows can. | `public/source-workbench.js`, `public/app.js` | context-menus ("Support context menus consistently throughout your app") | Left for later. Needs new web UI and menu-bar equivalents for each command. |
| A15 | **The workspace imitates a window inside a browser tab.** It draws its own toolbar, sidebar material and dialogs with `backdrop-filter`, rather than living in a native window. | `public/*` | windows ("Avoid creating custom window UI"); materials | Left for later. A native workspace window (WKWebView in an `NSWindow` with a real toolbar and sidebar) is the right fix and is larger than this pass. |
| A16 | **Hard-coded highlight colors for source status.** Changed, stale and missing highlights use fixed sRGB values rather than `systemOrange`, `systemYellow` and `systemRed`. | `desktop/DependencyOverlay.swift` | color (System colors; Increase Contrast) | Left for later. These are drawn over other apps' text at low alpha; changing them needs visual checks in Word, Pages and browsers. |
| A17 | **Popover, notch and inspector dismissal.** Escape closes every transient surface through `LassoTransientUI`; the status popover is `.transient`, so clicking outside closes it; the source chooser maps Escape to Cancel and Return to Preview Source. | `desktop/TransientDismissal.swift`, `desktop/StatusPopover.swift`, `desktop/SourceChooser.swift` | popovers; panels; alerts (Escape and Command-Period) | Kept (already native) |
| A18 | **Materials.** The inspector uses `NSGlassEffectView` on macOS 26 behind `#available`, and `NSVisualEffectView` with the `.popover` material on 13.5 to 15. Both follow Reduce Transparency through the system. The suggestion box raises its opacity when Reduce Transparency is on. | `desktop/NativeMaterial.swift`, `desktop/GlobalAssist.swift` | materials (Liquid Glass, Standard materials, macOS) | Kept (already native) |
| A19 | **Notch panel motion.** The notch animation checks `accessibilityDisplayShouldReduceMotion` and jumps to its final state when it is on. | `desktop/NotchPanel.swift` | motion; accessibility | Kept (already native) |

## Share page

| # | Finding | Where | HIG | Status |
| --- | --- | --- | --- | --- |
| S1 | **Text below the minimum size.** Column letters and download format labels are 9 points; several captions are 10 points with light contrast. | `src/sharing/share-page.js` | typography (minimum 10 pt); accessibility (contrast) | Fixed |
| S2 | **Font stack only names Apple fonts.** Recipients on Windows, Android or Linux fall back to Arial or the browser default instead of their own system font. | `src/sharing/share-page.js` | typography (Using system fonts) | Fixed (adds `system-ui`, Segoe UI and Roboto after the Apple names) |
| S3 | **Em dash as the "no value" placeholder.** Missing dates render as an em dash. | `src/sharing/share-page.js` | writing; project rule | Fixed (shows "Unknown") |
| S4 | **Inspector toolbar is app chrome but behaves like a web page.** Pointing-hand cursor, sentence-case labels, text glyph icons, selectable labels. | `src/sharing/share-page.js` (`renderInspectorPanel`) | pointing-devices; buttons; sf-symbols | Fixed (see A3, A8, A9) |
| S5 | **Dark mode, focus rings, Reduce Motion.** The page follows `prefers-color-scheme`, shows a visible focus ring on links and buttons, and disables smooth scrolling under Reduce Motion. | `src/sharing/share-page.js` | dark-mode; accessibility | Kept (already correct) |
| S6 | **Fixed blue accent on the recipient page.** | `src/sharing/share-page.js` | color (App accent colors) | Kept. The recipient page is Lasso's branded public page, viewed in any browser, so it keeps Lasso's blue. The private inspector already takes the source folder's color. |

## Website

| # | Finding | Where | HIG | Status |
| --- | --- | --- | --- | --- |
| W1 | **Em dashes in page titles and demo copy.** The home page, Living Archive and Brand Character titles joined "Lasso" and the page name with an em dash, as did demo window titles such as "Inbox" and "Jordan Ellis". | `website/index.html`, `website/living-archive/index.html`, `brand/lasso-character.html` | writing; project rule | Fixed (a middle dot, as in the share page and app titles) |
| W2 | **Web fonts for interface text.** The home page loads Inter Tight for all body text and JetBrains Mono for data text, and downloads Source Serif 4 although no rule uses it any more. Apple's design language sets interface text in the system font (SF Pro, SF Mono). | `website/index.html` | typography (Using system fonts; "Minimize the number of typefaces") | Fixed (body uses the system font stack, data text uses SF Mono with fallbacks, and the unused Source Serif 4 and Inter Tight downloads are gone; Caveat stays for the hand-drawn annotations) |
| W3 | **CSS animations ignore Reduce Motion.** The scripted hero and demos check `prefers-reduced-motion`, but CSS keyframe animations (ledger rows, scan lists, popups, links) and smooth scrolling do not. | `website/index.html`, `brand/lasso-character.html` | motion; accessibility (Reduce Motion) | Fixed |
| W4 | **No visible keyboard focus.** Links, tabs, chips and buttons have no focus ring. | `website/index.html`, `website/living-archive/index.html`, `brand/lasso-character.html` | accessibility (keyboard-only use); keyboards (Full Keyboard Access) | Fixed (accent-colored `:focus-visible` rings) |
| W5 | **Font stacks without a system fallback** on the brand character page (`"Geist Mono", monospace`, `"Instrument Serif", serif`). | `brand/lasso-character.html` | typography | Fixed (falls back to SF Mono, New York and SF Pro, then Consolas, Segoe UI and Roboto). The Living Archive already had fallbacks. |
| W6 | **The Living Archive and brand character pages use editorial web fonts** (Bodoni Moda, Newsreader, IBM Plex Mono, Geist, Instrument Serif). | `website/living-archive/index.html`, `brand/lasso-character.html` | typography | Kept. Both are standalone art-directed pieces that are not linked from the home page; their typefaces are the concept. |
| W7 | **Dark mode.** The home page has a complete dark palette and keeps the app demos light like screenshots. | `website/index.html` | dark-mode | Kept (already correct) |

## Left for later

- **A12** Tab shares in the inspector. Needs a product decision on the shortcut.
- **A13** "Work directories" vs "folders" across the app, server messages and docs.
- **A14** Context menus for sources, files and shared links in the workspace.
- **A15** A native workspace window with a real toolbar and sidebar instead of a browser tab.
- **A16** System colors for changed, stale and missing highlights.
- **A8 (rest)** Title case in strings generated by `public/app.js` and `public/source-workbench.js` (for example "Copy with citation", "Retry indexing"), which many tests and snapshots depend on.
- **A4 (rest)** Background and surface colors in the workspace still use Lasso's own neutral palette rather than `-apple-system-window-background`, because the workspace runs in any browser and must look the same in Chrome.
- The legacy `public/terminal.css` (about 2,300 lines) is still loaded underneath `utility.css`, which overrides it with `!important`. This branch removed its dead fake title bar, traffic lights and tab strip (56 selectors across it and `macos.css`, with byte-identical renders before and after); removing the rest requires checking every view the old layer still styles.
- **S3 (rest)** The server's internal "no location" value is still an em dash (`src/sharing/object-share.js`), which the Swift host and tests compare against. The share page and inspector hide it, but it can appear in the workspace's metadata rows. Changing it needs the server, host and tests updated together.

## Main menu added in this pass

Lasso is a menu bar extra, so the bar shows only while Settings is open; the shortcuts work whenever a Lasso window is active.

| Menu | Items |
| --- | --- |
| Lasso | About Lasso · Settings… (⌘,) · Services · Hide Lasso (⌘H) · Hide Others (⌥⌘H) · Show All · Quit Lasso (⌘Q) |
| File | Add Work Directories… · Open Workspace in Browser (⌘B) · Close (⌘W) |
| Edit | Undo (⌘Z) · Redo (⇧⌘Z) · Cut · Copy · Paste · Paste and Match Style (⌥⇧⌘V) · Delete · Select All · Find (Find…, Find Next, Find Previous, Use Selection for Find); macOS adds Start Dictation and Emoji & Symbols |
| View | Enter Full Screen (⌃⌘F) |
| Window | Minimize (⌘M) · Zoom · Bring All to Front |
| Help | Lasso Help (⌘?) |

## Verification

- `npm test`: 507 of 507 pass (507 before the branch).
- `npm run desktop:test`: 382 checks pass (370 before; 12 new main menu checks).
- `swiftc -typecheck` of the full source list in `desktop/build.sh`: passes (34 files, including the new `MainMenu.swift` and `SettingsWindow.swift`).
- `npm run desktop`: builds and signs `dist/Lasso.app`.
- `scripts/validate-inspector-layout.mjs`: 10 inspector layouts pass. `scripts/validate-share-recipient-ui.mjs`: 24 recipient layouts and 6 real downloads pass.
- Screenshots were taken against a copy of the data folder served on port 4417, never the live library.

## Screenshots

Each name exists in both `before/` and `after/` unless noted.

| Surface | Files |
| --- | --- |
| Workspace | `app-workspace-{light,dark}.png`, `app-workspace-changes-{light,dark}.png` |
| Source inspector page | `app-inspector-{light,dark}.png` |
| Status panel | `native-status-panel-{light,dark}.png` (rendered offscreen with sample folders) |
| Source chooser | `native-source-chooser-{light,dark}.png` |
| Settings window | `native-settings-{light,dark}.png` (after only; new) |
| Share page | `share-{indexed,document,redacted,unavailable}-{light,dark}.png`, `share-indexed-375-{light,dark}.png` |
| Website | `website-{375,768,1440}-{light,dark}.png`, `living-archive-{375,768,1440}-{light,dark}.png`, `brand-character-{light,dark}.png` |
