# Accounting IFC visual-preview verification — 2026-10-14

The native document-preview panel and browser source views render actual IFC
geometry, focused on the indexed element's GUID. This covers geometric elements
beyond rooms: doors, walls, windows and other represented model products. The
property value still comes from the indexed source property, not from estimating
the displayed drawing.

The real source remains at `/Users/adelyasin/Desktop/Accounting/Duplex_A_20110907.ifc`.
Its provenance and unmodified download are recorded in the
[original live validation report](../accounting-duplex-2026-10-13/README.md).
SHA-256: `b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed`.
The existing Accounting project is `84f23556-27d7-4de2-938f-f47ee6b146f0`,
version 34, snapshot `35cf0557-0077-4176-83bd-37b22e6d66b5`.

## What was checked

- The running rebuilt desktop app used its existing Application Support database,
  watched Accounting directory and preserved source bytes.
- The final signed app was rebuilt and restarted, then both the 14-check browser
  workflow and all four native captures were repeated against its server at
  `http://127.0.0.1:50407`. The Accounting source hash and version 34 remained unchanged.
- Actual `/api/dependency-objects/:id/preview?version=...` responses contained
  geometry matching each indexed element's GUID and IFC type, with exactly one
  selected product and the correct surrounding storey.
- A102 and the door/wall references use Level 1 context; the fixed window uses
  Level 2. No geometry warnings were returned for these selections.
- The cold live preview took about 0.8 seconds; cached selections took 4–6 ms
  on this machine. These are observations from this run, not performance guarantees.
- The browser check navigates real rendered controls with keyboard/mouse input;
  it checks selection, source opening, zoom, context fitting and stale selections.
- The native screenshots use the production `AssistBoxView` and parser, with the
  unmodified live API responses as input to a test-only screenshot helper. This
  verifies panel rendering; it does not pretend to be an end-to-end host typing test.

## Native evidence

| Element | IFC identity | Preview |
| --- | --- | --- |
| A102 Living Room, Area | `0BTBFw6f90Nfh9rP1dlXr2` | [Screenshot](native/room.png) |
| Single-Flush Door, Width | `1hOSvn6df7F8_7GcBWlS8Z` | [Screenshot](native/door.png) |
| Exterior Wall, Area | `2O2Fr$t4X7Zf8NOew3FNtn` | [Screenshot](native/wall.png) |
| Fixed Window, Width | `1hOSvn6df7F8_7GcBWlSXO` | [Screenshot](native/window.png) |

The matching JSON responses, source hashes and target IDs are in [native/targets.json](native/targets.json).
Native capture results are in [native/capture-results.json](native/capture-results.json).
Browser results and screenshots are in [browser/ui-transcript.json](browser/ui-transcript.json).

## Regression coverage

- Full server suite after the final changes: **241 checks passed**.
- Native suite: **106 checks passed**.
- Focused route/UI/sharing regressions passed after the final location-label fix.
- Geometry tests include a concave shape with a hole, millimetre conversion,
  translated upper-storey geometry, non-room products, unknown element IDs,
  geometry-free properties, source-hash caching and pinned historical previews.
- Real public IFC route tests exercise rooms, doors, walls and windows. Local
  geometry previews do not expose context through restricted public share links.
- Delayed geometry responses cannot replace a newer source selection, overwrite
  another workspace, or reopen a closed source viewer with stale content.

Visual verification also found and fixed a browser style rule that reduced the
plan SVG to icon size. The component now controls its own drawing dimensions.
A pending search also used to clear a source clicked before the debounce fired;
explicit selection now cancels that pending search. Both automated and live
browser checks cover the immediate-click case.

## Repeating the browser check

Use the current app's server URL (its port can change on restart):

```sh
node scripts/validate-model-preview-ui.mjs http://127.0.0.1:PORT 84f23556-27d7-4de2-938f-f47ee6b146f0 /tmp/lasso-model-preview-check docs/validation/model-preview-2026-10-14/browser/targets.json
```

In Lasso, select Accounting, search for an indexed model property, and select it.
The preview highlights its geometric element. Open source retains that element's
focus. Fit selection and Show context switch between detail and surroundings.
Properties without supported geometry show an explanation instead of an unrelated
shape. The display is a plan projection of model geometry, not an authored sheet
or a full 3D model editor.
