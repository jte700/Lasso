# Repository integration and Mac notch verification

Date: 2026-10-17

## Repository preservation

- Saved the existing app fixes in local commit `5bf91aa` before integration.
- Merged fetched `origin/main` at `d02be80` into `Alpha-v0` in `6d47e44`.
- The seven upstream commits changed only `website/index.html`. The merge had no conflicts and preserved all app implementations.
- No changes were pushed or publicly deployed.

## Notch behavior

The native menu offers **Show Lasso in Notch** only when a connected built-in display has a positive top safe-area inset and a camera gap between its two auxiliary menu areas. External displays and older MacBooks do not qualify. The setting persists and defaults off. Display changes are observed so closing the lid or disconnecting the notched screen hides the panel and removes its menu option.

The solid-black surface reaches the display’s top edge and joins the camera cutout. Transparent shoulders preserve the adjacent menu-bar space, and all controls sit below the camera. Clicking the compact control opens a black panel with Lasso’s system typography and native dark macOS controls. It shows indexed-file and directory counts, recent old/new source values, pinned version numbers, affected references across enabled directories, and indexing issues. Buttons pause/resume suggestions and open the browser's existing source-review workflow. Arrow buttons browse recent changes. Escape or an outside click collapses the panel. It never takes typing focus or automatically rewrites a document.

Activity is fetched every 15 seconds only while enabled, with bounded results, request cancellation, and explicit failure state. Paused directories do not contribute source activity. Disabled, disconnected, and stale-request behavior has regression coverage.

## Validation

- 417 JavaScript tests pass, including source indexing/ranking, history, cross-directory relationships, exact excerpts, immutable share versions, PDF visual redaction and protected downloads.
- 276 native checks pass, including insertion, contextual replacement, clipboard preservation, anchors, highlight geometry, PDF previews and notch eligibility/geometry.
- Signed-app browser checks pass: notch controls/lifecycle on a real notched Mac, 14 suggestion-navigation checks, 14 share-preview checks, 21 PDF-composer checks, Chrome highlight geometry, source hyperlinks, five real prediction/Tab scenarios, and 15 popup lifecycle scenarios.
- Real native notch appearance was inspected through the app screenshot API, including expanded and compact views and previous/next controls. The follow-up black design was checked in both sizes, with camera clearance, top-edge alignment and cutout-width adaptation verified.
- 10 inspector sizes/content layouts pass.
- 24 recipient layouts across light/dark and narrow/wide displays pass, with six actual file downloads and verified metre-scale drawing-mask pixels.
- Both notch browser destinations open the intended fully loaded review screens.
- The checked-in IFC, LandXML and PDF sample audit passes exact-value, unit-conversion, ambiguity and missing-evidence checks.

## Advertised-feature boundaries

Compared against the live text of https://mylasso.ca. Retrieval, source locations, version pinning, native writing controls, review, supported extraction formats, and scoped sharing have the coverage above. Zoom meetings were excluded as requested. Whiteboard/phone workflows are already labelled in development on the site.

The user excluded download buttons after the audit found unavailable release links. Windows release distribution is outside this Mac implementation pass.

Public sharing still requires a reachable running service. The default app serves links on localhost; `SHARE_BASE_URL` only configures their origin and does not create hosted infrastructure. Native host coverage depends on each editor's Accessibility support; live interaction tests used Chrome. Scanned PDFs need OCR, as the website states. These boundaries prevent a claim that every advertised scenario is universally verified or that the application has no possible bugs.
