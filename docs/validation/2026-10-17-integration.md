# Repository integration and Mac notch verification

Date: 2026-10-17

## Repository preservation

- Saved the existing app fixes in local commit `5bf91aa` before integration.
- Merged fetched `origin/main` at `d02be80` into `Alpha-v0` in `6d47e44`.
- The seven upstream commits changed only `website/index.html`. The merge had no conflicts and preserved all app implementations.
- No changes were pushed or publicly deployed.

## Notch behavior

The native menu offers **Show Lasso in Notch** only when a connected built-in display has a positive top safe-area inset and a camera gap between its two auxiliary menu areas. External displays and older MacBooks do not qualify. The setting persists and defaults off. Display changes are observed so closing the lid or disconnecting the notched screen hides the panel and removes its menu option.

When closed, only a 32-point logo control appears directly left of the camera cutout, entirely within the menu-bar band. It has no visible status text, shadow or protruding lower strip. The compact backing overlaps the camera housing to fill its rounded lower-left corner. Both states share one shadow-free window above the menu bar. The expanded black silhouette has square top corners at the display edge, with no transparent shoulders, and the logo keeps its exact screen position. The expanded panel is normally 360 points wide; its content height is 138 points when idle and 198 points for source changes, with 20 extra points only when an indexing issue is shown. Controls use tighter spacing and widths relative to the panel, while wide camera housings still receive enough room for the logo. Clicking it opens the black panel, with Lasso’s system typography and native dark macOS controls below the camera. New source activity or indexing issues also open it after the initial baseline check. Repeated unchanged alerts remain quiet. Automatically opened panels close after 12 seconds unless the pointer is over them; manually opened panels remain open until dismissed. It shows indexed-file and directory counts, recent old/new source values, pinned version numbers, affected references across enabled directories, and indexing issues. Buttons pause/resume suggestions and open the browser's existing source-review workflow. Arrow buttons browse recent changes. Escape or an outside click collapses the panel. It never takes typing focus or automatically rewrites a document.

Activity is fetched every 15 seconds only while enabled, with bounded results, request cancellation, and explicit failure state. Paused directories do not contribute source activity. Disabled, disconnected, and stale-request behavior has regression coverage.

## Validation

- 417 JavaScript tests pass, including source indexing/ranking, history, cross-directory relationships, exact excerpts, immutable share versions, PDF visual redaction and protected downloads.
- 283 native checks pass, including insertion, contextual replacement, clipboard preservation, anchors, highlight geometry, PDF previews and notch eligibility/geometry.
- Signed-app browser checks pass: notch controls/lifecycle on a real notched Mac, 14 suggestion-navigation checks, 14 share-preview checks, 21 PDF-composer checks, Chrome highlight geometry, source hyperlinks, five real prediction/Tab scenarios, and 15 popup lifecycle scenarios.
- Real native notch appearance was inspected through the app screenshot API, including expanded and compact views and previous/next controls. The animated refinement has 48 live native checks covering camera clearance, menu-bar containment, icon-only content, click handling, automatic triggers, duplicate-alert suppression and cleanup. Pixel checks now verify opaque black beneath the camera’s rounded left corner and across both expanded top corners. Earlier frame-only checks missed this physical seam, which the user’s photos revealed. Open/close transitions take 180/140 milliseconds and grow/shrink a body centered on the physical camera cutout, independently of the fixed logo backing. The single window contains both shapes; content is clipped to the body throughout the transition. Checks verify its midpoint, fixed logo coordinate, and clipping. Transitions fade fixed-size content, and skip motion when Reduce Motion is enabled. Rapid reversals and disabling mid-transition are covered. The overlay uses stationary and can-join-all-applications window behavior so Show Desktop and window-management views do not shrink it into a window thumbnail.
- 10 inspector sizes/content layouts pass.
- 24 recipient layouts across light/dark and narrow/wide displays pass, with six actual file downloads and verified metre-scale drawing-mask pixels.
- Both notch browser destinations open the intended fully loaded review screens.
- The checked-in IFC, LandXML and PDF sample audit passes exact-value, unit-conversion, ambiguity and missing-evidence checks.

## Advertised-feature boundaries

Compared against the live text of https://mylasso.ca. Retrieval, source locations, version pinning, native writing controls, review, supported extraction formats, and scoped sharing have the coverage above. Zoom meetings were excluded as requested. Whiteboard/phone workflows are already labelled in development on the site.

The user excluded download buttons after the audit found unavailable release links. Windows release distribution is outside this Mac implementation pass.

Public sharing still requires a reachable running service. The default app serves links on localhost; `SHARE_BASE_URL` only configures their origin and does not create hosted infrastructure. Native host coverage depends on each editor's Accessibility support; live interaction tests used Chrome. Scanned PDFs need OCR, as the website states. These boundaries prevent a claim that every advertised scenario is universally verified or that the application has no possible bugs.
