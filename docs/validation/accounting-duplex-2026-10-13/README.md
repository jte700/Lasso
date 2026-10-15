# Live Accounting architectural IFC validation — 2026-10-13

Passed against the user's running Lasso application and existing Accounting project. A fresh public model was downloaded directly into the real watched directory. No temporary Lasso project, seeded database records, mocked query responses, or modified source quantities were used.

The earlier AC20-FZK-Haus fixture was a real, unmodified download, but its validation ran in a temporary project/database. It did not establish that the user's live Accounting workflow worked. This run closes that specific gap.

## Download and live project

- Actual file: `/Users/adelyasin/Desktop/Accounting/Duplex_A_20110907.ifc`
- Source: [buildingSMART Duplex Apartment dataset](https://github.com/buildingsmart-community/Community-Sample-Test-Files/tree/7ddf57a201f88a0c213d5322b02ed15e94a60a40/IFC%202.3.0.1%20%28IFC%202x3%29/Duplex%20Apartment).
- [Immutable model download](https://media.githubusercontent.com/media/buildingsmart-community/Community-Sample-Test-Files/7ddf57a201f88a0c213d5322b02ed15e94a60a40/IFC%202.3.0.1%20%28IFC%202x3%29/Duplex%20Apartment/Duplex_A_20110907.ifc), retrieved on 2026-10-13. This media URL returns the IFC, rather than the repository's Git LFS pointer.
- Format: IFC2X3 STEP, exported from Revit Architecture 2011; a two-storey duplex architectural sample with 21 spaces.
- Size: **2,380,763 bytes**.
- SHA-256: `b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed`.
- Existing project: `84f23556-27d7-4de2-938f-f47ee6b146f0` (Accounting).
- Running desktop application PID: `92487`; its server PID: `92491`; endpoint during validation: `http://127.0.0.1:56857`.
- The normal directory watcher created version **34**, snapshot `35cf0557-0077-4176-83bd-37b22e6d66b5`, from version 33. Accounting now has three files, including its two existing accounting documents.
- The model produced **1,794 indexed objects**: one model and **1,793 measurements**. No application source change or restart was needed for this run.

Attribution: **BSI (2020) "Duplex Apartment Test Files," buildingSMART International**, linked above. Dataset license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The downloaded model bytes were not modified.

## Independent comparison and results

[audit-ifc-rooms.py](audit-ifc-rooms.py) independently reads the actual file's STEP records using Python's standard library, without importing Lasso or reading its fixture expectations. It follows `IFCSPACE` → `IFCRELDEFINESBYPROPERTIES` → property/quantity set → typed area measure. It verifies project units from `IFCPROJECT #34` → `IFCUNITASSIGNMENT #23` → `IFCSIUNIT #16` (`SQUARE_METRE`). It calculates square feet with decimal arithmetic: m² / 0.09290304.

[source-audit.json](source-audit.json) retains all 21 Revit `Area` properties and the separate 21 `GSA BIM Area` quantities, including exact values, GUIDs, STEP identifiers, relation chains, and original line numbers. These two area sets differ in their final decimal digits for five spaces, so the actual answer was compared against the exact property cited by Lasso.

[verify-live.py](verify-live.py) queried the running server through the same HTTP endpoints used by the app. [live-results.json](live-results.json) stores the actual answers, indexed object metadata, and previews. Checks passed:

- **42 answers:** area in m² and square footage in ft² for every one of the 21 spaces, scoped to the downloaded file.
- Each answer's unrounded numeric value, unit, room identity, property-set name, STEP property identifier, project ID, source hash, and raw source-preview text matched the independent audit.
- All **21 GSA BIM Area quantities** were also present in the live index and matched their independent source records.
- An unqualified `Living Room` request returned two candidates rather than silently selecting an apartment.
- A nonexistent room returned no supported measurement.
- A request for A102's **net** floor area returned no supported measurement: this file supplies a generic Revit `Area`, not a property explicitly declaring net floor area.

Examples of verified live answers:

| Space | Revit source area | Lasso square feet | Cited property |
| --- | ---: | ---: | --- |
| A102 Living Room | 30.14164524999992 m² | 324.442 ft² | `#170` |
| A103 Kitchen | 13.8975009999999 m² | 149.5915 ft² | `#315` |
| A203 Bedroom 2 | 26.17799424999997 m² | 281.7776 ft² | `#1392` |

The quantities come from explicit source properties. This validates extraction and conversion for this model; it does not independently certify the designer's geometric area calculation or establish coverage of every IFC exporter.

## Actual interface check

An isolated Chrome browser loaded the existing desktop server, clicked the project picker and Accounting, typed **What is the square footage of A102?**, and pressed Enter. The interface displayed **324.442 ft²**. Clicking its returned source showed the exact property `#170=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(30.14164524999992),$);`.

The browser check used mouse/keyboard input and inspected the rendered page; it did not inject application results or call internal application functions. Its temporary Chrome profile was removed after completion. Screenshots were visually inspected.

- [Rendered answer screenshot](02-a102-square-footage-answer.png)
- [Rendered source-property screenshot](03-a102-source-property.png)
- [Actual answer/source DOM and interactions](ui-transcript.json)
- [Browser check harness](validate-ui.mjs)

The initial library DOM/screenshot was excluded from the archive because it included unrelated accounting content. The answer and source evidence are unchanged.

## Repeat

Select **Accounting** in Lasso and type `What is the square footage of A102?` into the search field, then press Enter. Select the result to inspect its IFC source. The downloaded IFC remains in Accounting.

To rerun the complete comparison, use the running app's current local server port and execute from the repository root:

```sh
python3 docs/validation/accounting-duplex-2026-10-13/audit-ifc-rooms.py /Users/adelyasin/Desktop/Accounting/Duplex_A_20110907.ifc > docs/validation/accounting-duplex-2026-10-13/source-audit.json
python3 docs/validation/accounting-duplex-2026-10-13/verify-live.py http://127.0.0.1:56857 84f23556-27d7-4de2-938f-f47ee6b146f0
```

The browser harness records the endpoint/project used during this run; update its `url` if the app's port changes, create its `/tmp/lasso-live-duplex-ui` output directory, and run it with Node 24+ and Google Chrome installed.
