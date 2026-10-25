# Lasso

Lasso indexes local work directories and suggests source-backed text while you write. Accepted suggestions keep a link to the exact source version. Directory history, source search, ranking, and provenance run locally without a language model or external AI service.

## Run

Requires **Node.js 24+**. Building the macOS app also requires the Xcode Command Line Tools. The built app runs on **macOS 13.5 or later** and carries its own Node.js, so Macs that only run it need neither.

```bash
npm ci
npm start
```

`npm ci` installs the offline IFC geometry and PDF engines. Open [http://127.0.0.1:4317](http://127.0.0.1:4317), add absolute directory paths, and enable the directories you want to use. Sources from all enabled, available directories are searchable together. Selecting a document directory changes where you write without changing which sources are enabled. Pausing a directory stops its suggestions and watcher while preserving history.

## macOS app

```bash
npm run desktop
open dist/Lasso.app
```

The app runs in the menu bar and starts its own local server, restarting it automatically if it stops unexpectedly. The server runs on the Node.js bundled inside the app, so the Mac does not need Node installed. If that copy cannot start, Lasso uses an installed Node.js 24 or newer instead; if it finds only an older one, the menu says which version and where. The bottom of Settings and the server log name the Node.js in use. The first time Lasso runs without any folders, its menu opens so you can add one, and opening the app again while it runs shows the menu. The menu provides:

- **Add Work Directories…** to choose folders (Command-click to add several at once), and **Remove Work Directories…** to take folders out of Lasso: click the folders to select them (Shift-click selects a range, or use **Select All**), then choose **Remove N Directories…** and confirm once. Removing never changes the folders or their files.
- **External Drives** to index a connected external drive, or folders on it, and to keep or remove what Lasso saved from a disconnected one (see below).
- **Connect 3rd Party Apps…** to bring in mail, calendars and notes (see [Connected apps](#connected-apps)). Connected apps are listed under **Connected Apps**, below the folders, each with the same switch and colour circle as a folder; right-click one to sync it now or disconnect it.
- **Work Directories** to collapse the list and switch folders on or off. Folders that are on are listed above those that are off. Suggestions come only from folders that are switched on. The small circle sets the folder's highlight colour, used for text accepted from it. Right-click a folder to show it in Finder or remove it.
- An orange **!** to the left of a folder's icon means the folder needs you: it cannot be found, macOS withheld access, Lasso could not start it, or some of its files could not be read from disk. Hover over it to see what happened. When the problem is Lasso's own, such as a folder it failed to start, the card also has a button (**Try Again**, or **Re-read Files** for a folder indexed by an older version of Lasso's reader) that fixes it. What Lasso's readers could only partly understand, such as a damaged or password-protected workbook or a CAD export without solid geometry, is not a problem with the folder and has no badge: the folder's tooltip, the notch's indexing issues and `index failures` list it.
- While a folder is added, brought up to date or re-read, its row shows a bar in the folder's colour with a percentage that counts up from 0% to 100%, in place of its switch. Folders already in use keep giving suggestions meanwhile, and a folder being brought up to date answers from its last index until its new version is ready.
- When an update to Lasso improves its file reader, folders are re-read in the background after it starts, one at a time, and their rows show the progress. Only the kinds of file the new reader reads differently are read again; the rest of each folder's recorded reading carries over. **Re-read Files** records the new reading as a new version of the folder; earlier versions, links and shares are unchanged. `index reindex` in the workspace does the same.
- **Suggest While Typing** to show or stop suggestions in other apps. This is the switch for suggestions; Lasso itself stays on.
- **Open The Ranch** (`⇧⌘R`, from any app) to look through every source, its recent changes, share links and anything that needs review, in a Mac window (see [The Ranch](#the-ranch)).
- **Settings…** (`⌘,`) for the options below.
- **Quit Lasso** to turn Lasso off.

If the server cannot be recovered, **Restart Server** appears directly under the error.

Lasso is always on: it starts when you log in and keeps running until you quit it. After quitting, press `⌘L` to start it again. A small helper inside the app, **Lasso Launcher**, does both; it holds `⌘L` only while Lasso is not running, so the rest of the time `⌘L` reaches your other apps as usual (while Lasso is quit, `⌘L` in a browser starts Lasso instead of selecting the address bar). macOS lists the helper under System Settings → General → Login Items; switching it off there stops both.

Settings holds what the menu does not:

- **Appearance**: Match System, Light or Dark, for Lasso's menu, suggestions and windows.
- **Folder colour**: the colour of folders you haven't given their own, and of the text you accept from them.
- **Tab inserts**: what `Tab` does: **Plain Text** (default), **Ask Each Time**, or **Share Link**.
- **Notch**: **Show Lasso in the notch** on Macs with a built-in camera cutout. Off by default, this remembers your choice and hides itself when the notched display is unavailable. At rest the surface matches the camera gap, without a separate logo extension. Hover over or click anywhere across the notch to open Lasso; the controls sit below the camera, and moving away closes it after a short grace. The surface expands and settles with a spring animation, respecting macOS Reduce Motion. A changed linked source opens a compact six-second popup with its file and change summary, including whole-file edits, moves and removals. Links accepted in other apps and saved browser-document links both contribute notifications. Existing history establishes a baseline when enabled, and unchanged alerts do not reopen. Activity refreshes every three seconds while enabled. Clicking the popup opens the full source details; Escape or clicking elsewhere collapses it without taking focus from your editor. Its **Open Sources** or **Review Sources** button opens The Ranch on what changed or what needs review. No source wording changes on its own.
- **Start**: whether Lasso starts at login and with `⌘L`, with **Open Login Items…** when macOS has the helper switched off. The version of Lasso and the Node.js its server runs on are listed below it.

These sit in Settings' **General** pane. Its **Shortcuts** pane lists every keyboard shortcut, grouped by where it works. On Windows the workspace's **Settings** lists the same shortcuts with their Windows keys; both read [`public/shortcuts.json`](public/shortcuts.json), so a new shortcut is added there once.

Interacting with the directory controls keeps the popover open. Clicking outside dismisses it; closing it with `Esc` or the menu bar icon returns focus to the app you were using. A folder that is switched on but could not be read shows **(needs attention)**; clicking it tries again. A folder on a drive that was not mounted when Lasso started is picked up automatically when the drive returns. You can move the app to `/Applications`; keep one canonical copy when granting permissions.

### The Ranch

**Open The Ranch** (`⇧⌘R`) opens Lasso's library as a Mac window, in place of the browser workspace. It only shows files; it never changes one. Lasso holds `⇧⌘R` in every app while it runs, so it opens The Ranch from anywhere, and Safari's Show Reader, Mail's Reply All and Chrome's hard reload don't get it then.

- **Recent Changes**: what was added, edited, renamed, moved or removed in every directory over the last two weeks, by day.
- **All Sources**: every file Lasso has read, grouped by directory, with the search field at the top of the sidebar.
- **Links**: **Shared by You** lists the share links made on this Mac, active, expired or stopped, with **Copy Link** and **Stop Sharing**. **Received** lists Lasso share links that reached you inside an indexed file, such as a note or a message from a connected mail app.
- **Needs Review**: values that changed since a document linked them, linked sources that moved or are missing, files Lasso could only partly read (with what to do about it), directories that need attention, and files that changed since you shared them. Choosing one opens the file at the place it is about (the cited cell shaded in a workbook, the cited page of a PDF, the cited line of code, or the cited element of a drawing) with a panel that quotes what Lasso recorded: the document and the words that link, the value as linked and, for a changed value, the value now. Its buttons let you resolve it yourself: **Open** the document at the linked words to change them, **Open at** the cited cell in the source's app, **Keep Linked Value** to keep citing the linked version, **Remove Link…**, **Try Again** for a directory, and **Share Again** or **Stop Sharing** for a file that changed since you shared it. Lasso never edits a document; keeping or removing a link changes only its own record. A source linked from several places steps through them with the arrows.
- **Network**: each directory as a hub with its most used and best connected files around it, and lines where files connect, in one directory or across several: a document links a value from a file, a file was accepted while writing a document, a text file names another file, or two files share a distinctive name (`Bracket.step` and `Bracket.pdf`). Files fade from grey (unused) to green (most tabbed, opened, viewed, shared and linked). Hover over a file to light up what it connects to, click it to show it beside the network, and click a directory to show only it and what it connects to. `⌘Z` goes back to every directory at the size that fits the window, however far a click narrowed the network or a pinch or drag moved it.
- **Directories** and **Connected Apps**: each directory's files. The arrow beside a directory in the sidebar opens it as an outline of its folders and files: click a folder to open or close it, and click a file to show it (the list beside goes to its directory when it isn't already showing it). `→` and `←` open and close the chosen directory, and the outline stays as you left it; while you search, every folder with a match is open. The sidebar's **Last Edited** menu orders the directories by Last Edited, Recently Used, Oldest or Newest. The sort menu above a list of files orders the files the same ways, chosen separately, and the kind menu beside it shows one kind of file: documents, spreadsheets, PDFs, presentations, 3D models, drawings, images, notes or code.

`⌘1` to `⌘5` go to Recent Changes, All Sources, Links, Needs Review and Network, `↑` and `↓` move through the list you clicked last, and the search field at the top of the sidebar (`⌘F`) narrows every list by file name and lights matching files in the network. The sidebar's button, or `⌃⌘S`, hides the sidebar to give the list and the file more room, the lines between the columns drag to resize them, and **Add Work Directories…** at the foot of the sidebar adds folders. The Ranch reopens where you left it.

Selecting a file shows it on the right, with its actions beside its name: workbooks (`.xlsx`, `.xlsm`, `.xls`) show the cells Lasso reads, as the sheet shows them, with the app's column letters, row numbers and a tab for each sheet (**Original Layout** shows Quick Look's rendering of the file instead, and a sheet too large to read opens there); PDFs open in PDFKit; documents, slides, images and text scroll in Quick Look; code is shown with its line numbers, and selecting lines says which to write to insert them (`server.js lines 10–20`); STEP models and STL, OBJ, PLY and USD meshes turn with a drag and zoom with a pinch or scroll; DXF and IFC plans pan and zoom. An IFC plan is worked out once for each version of the file and kept, so it opens at once after the first time; while a detailed model is still being read, **Show in Quick Look** shows the file without waiting, and a model clicked past is not worked out at all. **Edit in** (`⌘E`) opens the file in the app that edits it, such as Excel, Word, Numbers or Fusion, and its menu lists every other app that can open it. Double-clicking a file does the same, and files can be dragged out of the list into Mail, Finder or any app that takes files. Files kept in Google Drive also offer Google Docs, Sheets or Slides, and `.gdoc`, `.gsheet` and `.gslides` files open in Google's editor. Files show their app's own icon, as Excel, Word and PowerPoint files do; types macOS draws as plain white pages at list size get one of Lasso's: Google's files look like Google's icons, and PDF, CSV, text, code, CAD and image files show their type on a label in a colour of its own. CAD files only offer CAD software; when none is installed, The Ranch says which app edits the file. Beside it, the share button sends a copy with AirDrop, Mail, Messages and the rest of the macOS share menu, **Share Link** (`⇧⌘L`) makes a Lasso share link through the usual privacy options (code files have none: send a copy instead), and the folder button (`⌥⌘R`) shows the file in Finder. A file on a disconnected drive shows the copy Lasso saved.

Looking at a file counts toward how green it is, once per half hour; it never changes how suggestions are ranked.

### External drives

Connecting a mounted external storage drive adds a badge to the menu bar icon and a brief notice, without interrupting typing. Choose the notice's **Review** or the badged icon to open the menu on that drive under **External Drives**, then choose **Index Entire Drive**, or **Choose Folders…** to pick one or more folders on it, including nested folders. **Not Now** leaves it unindexed; it stays in the list to index later. Indexing starts only after that choice; each selected folder becomes a work directory. Lasso uses the drive's persistent volume identity, so directories follow it when its mount path changes.

On disconnection, choose **Keep Saved Index** to browse and search cached file copies and their history offline, or **Remove Saved Data…** to delete those directories, indexes, local copies, and history from Lasso. Removal leaves the original drive files untouched, preserves blobs still used by another directory, and refuses to delete sources referenced by another directory. Offline directories are marked in the workspace; editing and reindexing resume after reconnection, and folders reconcile their changes when the drive returns.

Detection covers mounted external storage, including USB-A and USB-C drives, while the Mac app is running. Internal disks, network shares, disk images, locked or unmounted volumes, and volumes without a unique persistent identity are excluded. macOS may ask for permission to read removable volumes.

### Connected apps

**Connect 3rd Party Apps…** opens a window, over the website's lasso of source text, where you connect:

- **Outlook** (Outlook.com, Hotmail or Microsoft 365): mail and calendar, read through Microsoft Graph.
- **Google Calendar**: events from the calendars in your list.
- **Calendar** on this Mac: the Calendar app's calendars you choose, including iCloud, Exchange and Google accounts added in System Settings. macOS asks once for access.
- **Notion**: the pages and databases you share with an internal integration whose secret you paste.
- **Calendar Feed**: any calendar published as an iCal (`.ics`) address.

You choose how far back and ahead Lasso reads (30 days back and 90 ahead by default). Each item is written as a record: its title, then its fields (an event's date, time, end, location, organizer and attendees; a message's sender, recipients, date and time; a page's properties), with dates and times as this Mac shows them. After you accept an item by its title, the word you write next picks its field: "I have a meeting with Dr. Lavalee **on**" offers the meeting's date, **at** its time or place, **in** its location, **with** its people, **from** a message's sender, **is** any of them. A field you accept leads on to the rest ("…on Tuesday, October 27 **at**" offers its time), and fields already written in the sentence are not offered again. Notes of your own written the same way (a level-one heading, then lines such as `- **Date:** Monday, October 19`) work the same. Lasso writes each message, event or page as a Markdown file in a folder it manages under `Application Support/Lasso/data/connected-apps`, and indexes that folder like a work directory, so its items are suggested and cited the same way. Apps are read again every 30 minutes while they are switched on (Calendar on this Mac whenever its events change), and only items that changed are rewritten. Lasso only reads; it never changes or sends anything in the app. Sign-ins, secrets and private calendar addresses are kept in `connection-credentials.json` beside the history database, readable only by your user, never in the database itself. **Disconnect…** stops reading the app, removes its folder and sign-in, and forgets the history Lasso kept of its items.

Outlook and Google Calendar sign in on the provider's own page in your browser (OAuth with PKCE), which returns to `http://localhost:<port>/connect/callback` on this Mac. They need an app registration: set `LASSO_MICROSOFT_CLIENT_ID`, or `LASSO_GOOGLE_CLIENT_ID` and `LASSO_GOOGLE_CLIENT_SECRET`, when running `npm run desktop` (the build writes them into the app), or enter yours in the Connect window the first time. For Microsoft, register a public client for personal and work accounts with the redirect URI `http://localhost/connect/callback` and the delegated permissions `Mail.Read`, `Calendars.Read` and `User.Read`; for Google, an OAuth client of type Desktop app with the Google Calendar API enabled.

### Bundled Node.js

`npm run desktop` copies the Node.js it builds with (`LASSO_NODE`, or `node` on `PATH`) into `Lasso.app/Contents/MacOS/node`, puts its license in `Contents/Resources/node/LICENSE`, and signs it together with the app. It must be Node.js 24 or newer and link only macOS's own libraries, as the nodejs.org installer and nvm builds do. Homebrew's Node depends on other Homebrew packages, so the build stops and says so. Version manager shims, such as asdf's or Volta's, are followed to the real binary, and a universal Node keeps only the architecture the app is compiled for. The nodejs.org installer does not keep a license file, so the build downloads that release's `LICENSE` from the Node.js repository once and caches it in `~/Library/Caches/Lasso`; set `LASSO_NODE_LICENSE` to build offline.

The runtime brings the app from about 30 MB to 142 MB, and a compressed disk image from about 7 MB to 48 MB.

### Supported macOS

The app runs on macOS 13.5 or later, set once by `MACOS_MINIMUM` in `desktop/build.sh`. The build compiles the app and its PDF helpers for that version and writes it into `Info.plist` as `LSMinimumSystemVersion`. The Swift code itself needs macOS 13, for login items; the nodejs.org build of Node.js 24 needs 13.5. The build reads the bundled Node.js's minimum with `vtool -show-build` and stops if it is later. The app is built for the processor of the Mac that builds it, Apple silicon or Intel.

On macOS 26 the app's surfaces use Liquid Glass; earlier versions use the standard translucent material. The app icon follows the macOS of the building Mac (see `LASSO_ICON_STYLE`), so a build made on macOS 26 shows its icon without rounded corners on earlier versions.

### Signing and permissions

Use a valid code-signing certificate to preserve macOS permissions across updates. The build automatically recognizes `Lasso Local Development` or `CoLab Dry Local Development`. To choose another identity, set `LASSO_SIGN_IDENTITY` to a certificate name or SHA-1 fingerprint from:

```bash
security find-identity -v -p codesigning
```

The build compiles, signs, and verifies a temporary app before replacing `dist/Lasso.app`. One `codesign` call signs the bundled Node.js, the PDF helpers and the app, so a single Keychain approval covers them. If signing fails, or the signed Node.js does not run, the previous app stays intact. `LASSO_SIGN_MODE=adhoc npm run desktop` is available for temporary builds, but their Accessibility approval may stop applying after rebuilding.

Repeated Keychain prompts mean the signing tool has not been granted persistent access to the signing key. Save trusted access for Apple's `/usr/bin/codesign` on the existing Lasso signing key once. In a normal signing prompt, **Always Allow** saves access; **Allow** covers only that attempt. After setup, signing runs automatically while the login keychain is unlocked. Keep the same certificate to preserve Lasso's macOS permissions. See [Apple's Keychain access guidance](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26).

Enable **Suggest While Typing**, then follow any **Allow Accessibility…** or **Allow Input Monitoring…** action. macOS requires you to approve access in System Settings → Privacy & Security. The setting remembers your choice while approval is pending and starts automatically when access becomes available. After changing from an old ad-hoc build to certificate signing, remove the old Accessibility entry and add the signed app once.

### Using suggestions

Type near a term or value from an enabled work directory. Two letters are enough, including the first word in an empty field. Any indexed file can be named: typed as it is spelled (`General-Ledger.cs`), `Tab` completes that spelling, with the extension once you start one; in plain words (`the general ledger`) it inserts the file's readable name. Each worksheet of a workbook is offered on its own. A part's name before a measurement word (`bracket length`) keeps suggestions to that part. After `Tab` accepts a source, the card offers that source's values while its sentence goes on. Values already inserted with `Tab` in the sentence are left out of the next list, so a column's values, such as every invoice date in a table, can be written out one `Tab` at a time. A new sentence, or a name from any work directory after "and", "or" or "but", starts fresh suggestions. `fn →` narrows the card one level without typing anything. It opens the highlighted row when that row has values below it: type `brac`, press `fn →` on Bracket, and the card lists the part's measurements; `Tab` on one replaces `brac` with it, such as `100 mm`. A table row opens to its cells and a column to its values. A value has nothing below it, so there `fn →` does nothing. With no such row highlighted, `fn →` takes a card showing every directory back to the source you last focused on in that field. `fn ←` steps back one level, and the list you narrowed comes back with the row you left still selected: a row chosen with `fn →` returns to the card it was chosen on, and a source accepted with `Tab` to what the card offered before that `Tab`, until your next words get suggestions from every directory, where `fn ←` does nothing. Right after `fn ←`, `fn →` returns to where you were. The card's header names where `fn ←` goes, and where `fn →` goes on a card showing every directory. A focus chosen with `fn →` stays until `fn ←`, the next `Tab`, or deleting the words typed to find it. Deleting text accepted with `Tab` steps the card back to the focus it had before that `Tab`; deleting the text that first narrowed it returns it to every directory. Right after `fn ←` or `fn →` the card stays on screen even when nothing matches, so the move can be undone. macOS sends `fn ←` and `fn →` as Home and End, so a keyboard's own Home and End keys do the same while the card is on screen. Without a card they keep their usual meaning, and `⇧←`/`⇧→` always select text. A source card shows matching entries and a preview. Use `↑`/`↓` to select and scroll through ranked matches, and `Esc` to dismiss. With no card on screen, `Esc` always reaches your app. Modified keys such as `⇧Tab`, `⌃Tab` and `⇧↑` close the card and keep their usual meaning. PDF sources show their original pages and support word and excerpt completions, with matched passages highlighted in the preview.

PowerPoint decks (`.pptx`) are read slide by slide: each slide's title, text, bullets, tables and SmartArt, never its speaker notes or review comments. A deck can be named by its file name or title, and its sentences complete like a document's; the card shows the slide a passage is on, with the passage marked, and **Open file** goes to that slide in PowerPoint or Keynote.

Programming files can be cited by line. After a code file is accepted with `Tab` (`server.js`), writing `line 42`, `lines 10-20`, `line 10 through line 20` or `lines 10 to 20` offers that code, and `Tab` inserts it after your words: one line without its indentation, or the lines on lines of their own, every line from the first through the last, indented as they are relative to each other. The lines can also come first (`line 42 of server.js`, then `Tab` on the file name), follow a file name written out without accepting it (`src/app.py line 3`), or follow a line already inserted (`and line 50`). Up to 500 lines are inserted at once, and a line number past the end of the file says how many lines it has. A linked line keeps following its line number when the file changes. Code files are never shared with a link: the card and the inspector offer no **Share link…** for them.

- **Tab:** replace the detected keyword or partial phrase with the selected source, value, field name, or citation. Sentence continuations append at the caret. The panel shows **Replace** when typed text will be replaced. Field descriptions and sample values stay in the preview.
- **⌘Enter:** insert plain text. It differs from `Tab` only when **Tab Inserts** is set to **Ask Each Time** or **Share Link**, so the panel lists it only then.
- **Share link…** or **⇧⌘Enter:** choose the sharing scope, then insert a share link.
- **Open file** opens the source in its default app at the place the preview shows: Excel and Numbers select the cited cell on its sheet, Preview and Acrobat go to the cited page, Word finds the cited passage, and VS Code, Cursor, BBEdit and TextMate open text at the cited line. The first jump into each app asks once for permission to control it. Other apps, or a declined permission, open the file as usual. The source inspector's **Open Source** does the same.

Every plain-text insertion keeps a local source reference and highlight. **Ask Each Time** and **Share Link** still open the privacy composer before creating a public token.

Plain-text acceptance stores source identity and a contextual text anchor locally. Lasso draws the colour and underline above the host app; these decorations are not part of the message sent to a recipient. Click a highlight to inspect its source. Highlights follow confidently resolved text and disappear when their position becomes ambiguous.

Typing predictions use a bounded window before the caret and the local loopback server. Secure fields are skipped. Highlight positioning depends on the host application's Accessibility support.

### Sharing

The privacy composer offers **entire document**, **indexed part only**, and **selectively redacted view**. Only whole-document shares permit downloading the original. A presentation is shared as the **entire presentation**, every slide with the original file, or as the **cited slide only**: the slide the citation is on, shown whole with the cited passage marked and downloadable as a one-slide `.pptx`. That copy holds the slide, its pictures, charts, layout and theme, and nothing of the rest of the deck: no other slides or their pictures, speaker notes, comments, section names, first-slide thumbnail or document properties. Presentations have nothing to redact. Code files cannot be shared with a link. Every token pins an immutable source version and can be revoked through the share tools or `POST /api/object-shares/:token/revoke`. Every share link stops working 48 hours after it is created; a request may choose an earlier `expiresAt`, never a later one. A text box that takes only plain text gets the suggestion as `Tab` would insert it, and the share link is copied to the clipboard instead; Lasso says so on the card.

PDFs support **Select text** for words, sentences and paragraphs, and **Mark area** for drawings or other page regions. Excerpt previews and downloads contain only the selected regions. Redacted PDFs keep the page layout and remove hidden content from a newly rendered copy. Existing PDF imports automatically gain sentence and paragraph suggestions without reimporting.

Default share URLs are local to the Mac running Lasso. `SHARE_BASE_URL` changes the URL base for a separately configured reachable service; it does not deploy or expose the local server. Only public share pages (`/d/…`) answer requests addressed to another host name; the rest of the local API answers only `127.0.0.1` and `localhost`, and refuses changes requested by other websites. Removing a source link also closes its share links. Share pages name source files without their folders.

## Windows companion (preview)

A native Windows host offers a Fluent workspace, standard Windows controls, a system tray icon, native folder selection, and an opt-in writing assistant. It uses the same source library, editor, history, model previews, and sharing engine.

```powershell
pwsh -NoProfile -File desktop/windows/build.ps1
```

Build on Windows with PowerShell 7 and the .NET 8 SDK. The output bundles Node.js and .NET; users need only the Microsoft Edge WebView2 Runtime. Extract the complete ZIP and run `Lasso.exe`. The assistant supports verified local source highlights, five-choice suggestions, source-scoped follow-ups, and explicit shared-link insertion. See [Windows setup and validation status](desktop/windows/README.md) before rollout; live Windows validation is still required.

## Windows companion from Alpha-v0

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

See [the Windows companion notes](desktop-windows/README.md) for what each
native piece replaces, how it is verified, and its current limits.

## Browser tools

The Mac app no longer links to these; The Ranch replaces them there. The local server still serves them, for the Windows companion and `npm start`.

The browser combines a source library, document editor, history, and dependency review. Markdown and text saves update their tracked files. DOCX and PDF editing uses a versioned text layer and preserves the original binary. Accepted sources are linked locally immediately, then saved with the document through manual save or the five-minute autosave.

In the editor, `Tab` or `Option+Enter` accepts a source suggestion, arrows choose alternatives, and `Esc` dismisses it. `Cmd/Ctrl+Shift+L` opens the source picker for selected text. Changes to an upstream source mark links for review; Lasso does not silently rewrite your document.

The command layer behind the source tools uses the same dependency graph:

| Purpose | Commands |
|---|---|
| Locate and inspect | `find`, `trace`, `history`, `ask` |
| Review affected references | `impact`, `changes`, `stale`, `shares` |
| Resolve source names | `conflicts`, `alias`, `aliases`, `unalias` |
| Manage indexing | `index`, `rules` |
| Revise references | `update`, `unlink` |

`update <dependency>` previews edits; `--apply` writes them and `--keep` retains the current wording. Mutating commands must identify their directory when several are active. `ask` answers only queries supported by the recorded sources.

## Data and configuration

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

Office lock and owner files (`~$Budget.xlsx`, `.~lock.*#`), partial downloads (`.crdownload`, `.part`, `.download`), `.tmp` files and system files such as AppleDouble `._*`, `Thumbs.db` and `desktop.ini` are not tracked. Neither are folders that hold tools' files rather than your work: version control (`.git`), installed packages (`node_modules`, `site-packages`, `.venv`, and any Python virtual or conda environment whatever its name, recognised by its `pyvenv.cfg` or `conda-meta`, as well as R's `renv/library`), caches (`__pycache__`, `.pytest_cache`, `.ipynb_checkpoints`, `.next` and similar) and volume metadata (`.Trash`, `.Spotlight-V100`). A folder that held one of these before this rule keeps that history, and records the files as removed the next time it starts. A file that exists but cannot be read for a moment keeps its last recorded version rather than being recorded as deleted. Files that cannot be indexed, or are indexed only in part, are listed by `index failures` and the notch's indexing issues: damaged or password-protected documents and PDFs without a text layer. Supported files remain eligible throughout large folders; individual readers retain their format-specific safety limits.

Worksheets and CSV or TSV files of any size are indexed whole. A table's first 1,000 rows (and up to 1,500 of their cells) are recorded as sources, as before, and its row count is always the whole table's. Every row of a larger table whose rows have names is also kept in a table index (`derived/tables.sqlite` in the data directory), with each name stored whole and from each of its words. Typing part of a row's name, or naming a row after an accepted column ("Deaths in Manitoba district 45003 were"), looks the name up there with a bounded index range scan instead of scoring every cell, so a 500,000-row sheet answers in about 20 ms. A row or cell from the index becomes a source the first time it is offered, under the key it would have had among the first rows, and each later reading of its file records it again, so links to it are kept, follow its value and go stale when it changes. A table whose rows have no names (tidy data, where every column repeats its values) keeps only its first and last rows and its count. Previews and shares of a large table read the rows around the cited one from the index. Files whose sheets or text are larger than 5 MB are read a batch of rows at a time in a worker thread, so adding one does not hold up the menu or suggestions, and the folder's bar counts through it. The table index is derived data, rebuilt from the files if it is deleted. Excel dates and percentages are indexed as the sheet shows them, with dates written as `YYYY-MM-DD`.

The browser's identity selector provides attribution, not authentication. Remote synchronization, production authentication, and automatic history garbage collection are not implemented.

## Development

```bash
npm test
npm run desktop:test
npm run desktop
```

The JavaScript suite covers history, source indexing, cross-directory dependencies, ranking, sharing, browser state, and the command layer using temporary workspaces. Native checks cover insertion, text anchors, highlight geometry, directory colours, and permission state. Building the desktop app compiles the complete Swift application.

Architecture and implementation references:

- [Timeline, snapshots, and recorded provenance](docs/scientific-timeline.md)
- [Predictive dependencies, editor behaviour, and ranking](docs/predictive-provenance-editor.md)
- [Ranking algorithm reference (PDF)](docs/lasso-ranking-algorithm.pdf)

## Drawing and CAD sources

The source library also indexes explicit evidence from DXF, IFC, LandXML, drawing PDFs, and STEP CAD models (AP203, AP214, AP242). Supported drawing questions can be submitted with Enter in source search, such as “What is the length of Main Road?” or “What is the diameter of the Bracket Ø8 hole?”. Measurements require recorded evidence; geometry is not guessed from an image.

For each named STEP part and assembly, Lasso indexes overall X/Y/Z extents, hole and cylinder diameters, hole depths, arc radii and arc lengths, and straight-edge lengths, measured exactly from the B-rep in the file's declared unit. An extent that curved faces could exceed is omitted rather than estimated. Previews show an isometric wireframe with the cited feature highlighted, which you can drag to rotate and zoom within limits. Native CAD files (SolidWorks, Inventor, Fusion, CATIA, Parasolid, IGES, Rhino), like DWG, RVT and DGN, are kept with guidance to export STEP, IFC, DXF or LandXML.

Run `node --disable-warning=ExperimentalWarning scripts/validate-drawing-sample.js --pdf` to validate the hash-checked architectural, civil, and PDF samples. Optional live Chrome checks use `npm run desktop:test:browser`; this builds a test variant, so restore the regular app afterward with `npm run desktop`.

- [Design source indexing](docs/design-source-indexing.md)
- [Drawing sample validation](docs/drawing-sample-validation.md)
- [Format and deployment limitations](docs/limitations.md)
