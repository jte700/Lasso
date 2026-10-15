# Installed-app drawing discovery validation

Passed against the final signed `/Applications/Lasso.app` server at `http://127.0.0.1:51682`, using the existing Accounting project and its unchanged `Duplex_A_20110907.ifc` at version 34. The final run includes the corrected whole-model overview caption; exact timestamps are recorded in the transcript.

An isolated Chrome session used actual mouse and keyboard input to select Accounting and type each phrase. No application state, source objects, API responses, or geometry was injected or mocked.

| Typed phrase | Search result | Opened overview |
| --- | --- | --- |
| `floor plan` | [Search screenshot](1-floor-plan-results.png) | [Model overview](1-floor-plan-overview.png) |
| `duplex` | [Search screenshot](2-duplex-results.png) | [Model overview](2-duplex-overview.png) |

Both searches found the same whole drawing, ID `d94345e0-774c-4365-92d0-adb6045dbc39`, labeled **Duplex A 20110907**. Its previously indexed internal title remains unchanged; the readable filename and aliases are derived when read.

Actual browser network responses confirmed `kind: model-plan`, `selected: null`, source path `Duplex_A_20110907.ifc`, and SHA-256 `b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed`. Both previews displayed 111 real geometry paths in a 942 × 340 px SVG with no arbitrary element highlight. The model opens on Level 1. The [preserved source overview](3-preserved-model-overview.png) also rendered 111 paths in a 1242 × 340 px SVG.

All three recorded checks passed, with zero uncaught browser errors. Screenshots were visually inspected. Full interactions and assertions are retained in [ui-transcript.json](ui-transcript.json).

Reproduce using the running app's current port:

```sh
node scripts/validate-drawing-discovery-ui.mjs http://127.0.0.1:51682 84f23556-27d7-4de2-938f-f47ee6b146f0 docs/validation/drawing-discovery-2026-10-14/browser
```
