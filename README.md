# Lasso

Lasso indexes local work directories and suggests source-backed text while you write. Accepted suggestions keep a link to the exact source version. Directory history, source search, ranking, and provenance run locally without a language model or external AI service.

## Run

Requires **Node.js 24+**. The macOS app also requires the Xcode Command Line Tools.

```bash
npm start
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317), add absolute directory paths, and enable the directories you want to use. Sources from all enabled, available directories are searchable together. Selecting a document directory changes where you write without changing which sources are enabled. Pausing a directory stops its suggestions and watcher while preserving history.

## macOS app

```bash
npm run desktop
open dist/Lasso.app
```

The app runs in the menu bar and starts its own local server. Node.js must remain installed. The menu provides:

- **Add Work Directories…** to choose folders.
- **Work Directories** to collapse the list and switch folders on or off. Suggestions come only from folders that are switched on. The small circle sets the folder's highlight colour, used for text accepted from it.
- **Suggest While Typing** to enable suggestions in other apps.
- **Tools → Open in Browser** for writing, source browsing, and review.
- **Tools → Tab Inserts** to choose what `Tab` does: **Plain Text** (default), **Ask Each Time**, or **Share Link**.
- **Tools → Troubleshooting** for restarting the server, checking another app's text support, outlining highlight positions, and the logs.
- **Show Lasso in Notch** on Macs with a built-in camera cutout. Off by default, this remembers your choice and hides itself when the notched display is unavailable. Only the Lasso logo appears immediately to the left of the camera cutout, entirely within the menu bar. Its black backing continues beneath the camera’s curved corner so the logo joins the notch without a seam. The expanded panel forms one continuous black surface from the display edge, with its controls below the camera. Click it to see active directories, indexed files, source value changes and indexing issues. New source changes or indexing issues also open the panel automatically after the initial activity check, without repeatedly reopening unchanged alerts. Automatic panels close after 12 seconds unless the pointer is over them. Pause/resume suggestions or open source review from the panel. Escape or clicking elsewhere collapses it without taking focus from your editor. Activity refreshes every 15 seconds while enabled. No source wording changes until you review and apply it in the browser.

Interacting with the directory controls keeps the popover open. Clicking outside dismisses it. You can move the app to `/Applications` and add it to Login Items; keep one canonical copy when granting permissions.

### Signing and permissions

Use a valid code-signing certificate to preserve macOS permissions across updates. The build automatically recognizes `Lasso Local Development` or `CoLab Dry Local Development`. To choose another identity, set `LASSO_SIGN_IDENTITY` to a certificate name or SHA-1 fingerprint from:

```bash
security find-identity -v -p codesigning
```

The build compiles, signs, and verifies a temporary app before replacing `dist/Lasso.app`. If signing fails, the previous app stays intact. `LASSO_SIGN_MODE=adhoc npm run desktop` is available for temporary builds, but their Accessibility approval may stop applying after rebuilding.

Repeated Keychain prompts mean the signing tool has not been granted persistent access to the signing key. Save trusted access for Apple's `/usr/bin/codesign` on the existing Lasso signing key once. In a normal signing prompt, **Always Allow** saves access; **Allow** covers only that attempt. After setup, signing runs automatically while the login keychain is unlocked. Keep the same certificate to preserve Lasso's macOS permissions. See [Apple's Keychain access guidance](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26).

Enable **Suggest While Typing**, then follow any **Allow Accessibility…** or **Allow Input Monitoring…** action. macOS requires you to approve access in System Settings → Privacy & Security. The setting remembers your choice while approval is pending and starts automatically when access becomes available. After changing from an old ad-hoc build to certificate signing, remove the old Accessibility entry and add the signed app once.

### Using suggestions

Type near a term or value from an enabled work directory. Two letters are enough, including the first word in an empty field. A new sentence starts fresh suggestions even right after you accepted a source. A source card shows matching entries and a preview. Use `↑`/`↓` to select and scroll through ranked matches, and `Esc` to dismiss. PDF sources show their original pages and support word and excerpt completions, with matched passages highlighted in the preview.

- **Tab:** replace the detected keyword or partial phrase with the selected source, value, field name, or citation. Sentence continuations append at the caret. The panel shows **Replace** when typed text will be replaced. Field descriptions and sample values stay in the preview.
- **⌘Enter:** insert plain text. It differs from `Tab` only when **Tab Inserts** is set to **Ask Each Time** or **Share Link**, so the panel lists it only then.
- **Share link…** or **⇧⌘Enter:** choose the sharing scope, then insert a share link.
- **Open file** opens the source in its default app.

Every plain-text insertion keeps a local source reference and highlight. **Ask Each Time** and **Share Link** still open the privacy composer before creating a public token.

Plain-text acceptance stores source identity and a contextual text anchor locally. Lasso draws the colour and underline above the host app; these decorations are not part of the message sent to a recipient. Click a highlight to inspect its source. Highlights follow confidently resolved text and disappear when their position becomes ambiguous.

Typing predictions use a bounded window before the caret and the local loopback server. Secure fields are skipped. Highlight positioning depends on the host application's Accessibility support.

### Sharing

The privacy composer offers **entire document**, **indexed part only**, and **selectively redacted view**. Only whole-document shares permit downloading the original. Every token pins an immutable source version and can be revoked through the share tools or `POST /api/object-shares/:token/revoke`.

PDFs support **Select text** for words, sentences and paragraphs, and **Mark area** for drawings or other page regions. Excerpt previews and downloads contain only the selected regions. Redacted PDFs keep the page layout and remove hidden content from a newly rendered copy. Existing PDF imports automatically gain sentence and paragraph suggestions without reimporting.

Default share URLs are local to the Mac running Lasso. `SHARE_BASE_URL` changes the URL base for a separately configured reachable service; it does not deploy or expose the local server.

## Browser tools

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
| `LASSO_NODE` | Override the Node binary used by the desktop build and app. |
| `LASSO_SIGN_IDENTITY` | Desktop signing certificate name or SHA-1 fingerprint. |
| `SHARE_BASE_URL` | Base URL for generated share links. |

The macOS app stores history in `~/Library/Application Support/Lasso/data` and logs in `~/Library/Logs/Lasso`. Its build migrates the former CoLab Dry data location when needed. Enabled directories resume watching after startup; unavailable folders do not prevent other directories from loading. History is stored separately from selected directories unless you explicitly choose otherwise.

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

The source library also indexes explicit evidence from DXF, IFC, LandXML, and drawing PDFs. Supported drawing questions can be submitted with Enter in source search, such as “What is the length of Main Road?”. Measurements require recorded evidence; geometry is not guessed from an image.

Run `node --disable-warning=ExperimentalWarning scripts/validate-drawing-sample.js --pdf` to validate the hash-checked architectural, civil, and PDF samples. Optional live Chrome checks use `npm run desktop:test:browser`; this builds a test variant, so restore the regular app afterward with `npm run desktop`.

- [Design source indexing](docs/design-source-indexing.md)
- [Drawing sample validation](docs/drawing-sample-validation.md)
- [Format and deployment limitations](docs/limitations.md)
