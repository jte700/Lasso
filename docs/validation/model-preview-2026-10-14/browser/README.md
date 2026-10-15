# Live browser model-preview validation

Passed against the final signed Lasso app at `http://127.0.0.1:50407`, using the existing Accounting project (`84f23556-27d7-4de2-938f-f47ee6b146f0`) and its unchanged `Duplex_A_20110907.ifc`, snapshot version 34. This run was repeated after the final build, including the asynchronous preview request guards.

The isolated Chrome session used real mouse and keyboard input to choose Accounting, search indexed properties, select each result, operate the drawing controls, and open the preserved source. No mock API, temporary Lasso project, injected application state, or replacement geometry was used. Read-only metadata requests identified each target's exact IFC entity type and GUID.

| Indexed property | IFC type | Focused preview | Preserved source |
| --- | --- | --- | --- |
| A102 Living Room area | IFCSPACE | [Room](01-room-focused.png) | [Room source](01-room-source.png) |
| Door 150173 width | IFCDOOR | [Door](02-door-focused.png) | [Door source](02-door-source.png) |
| Exterior wall 138062 area | IFCWALLSTANDARDCASE | [Wall](03-wall-focused.png) | [Wall source](03-wall-source.png) |
| Window 148607 width | IFCWINDOW | [Window](04-window-focused.png) | [Window source](04-window-source.png) |

The final run passed 14 recorded checks: focused geometry for each element in both preview surfaces, zoom/context/selection controls for all four elements, and revisiting the first element after switching types. Checks also assert visible drawing dimensions, actual polygon paths, exact selected GUIDs, preserved selection after the search debounce, snapshot requests carrying the indexed GUID, and no uncaught browser errors. Screenshots were visually inspected.

Live testing found and fixed two issues before the successful run: a generic workbench SVG rule constrained the drawing to icon width; and a pending search debounce could clear a quickly clicked source. The latter has a dedicated automated regression and the live wall selection exercises immediate clicking. The final screenshots and transcript describe the corrected implementation.

Exact targets are in [targets.json](targets.json); full interactions and assertions are in [ui-transcript.json](ui-transcript.json).

Reproduce against the current running app's port:

```sh
node scripts/validate-model-preview-ui.mjs http://127.0.0.1:50407 84f23556-27d7-4de2-938f-f47ee6b146f0 docs/validation/model-preview-2026-10-14/browser docs/validation/model-preview-2026-10-14/browser/targets.json
```
