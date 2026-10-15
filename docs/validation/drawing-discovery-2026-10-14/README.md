# Drawing discovery in the installed Lasso app

The real file remains at
`/Users/adelyasin/Desktop/Accounting/Duplex_A_20110907.ifc` (2,380,763 bytes).
Its SHA-256 is unchanged:
`b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed`.
Accounting remains version 34, snapshot
`35cf0557-0077-4176-83bd-37b22e6d66b5`.

Two problems caused the missing suggestions:

- The running `/Applications/Lasso.app` was an older build without drawing
  support. Previous preview validation had launched the new build from `dist`.
  The signed current build is now installed in Applications and running there.
- Whole drawings were not offered for ordinary filename/topic phrases. Discovery
  now recognizes filename tokens and supported model terms such as “floor plan,”
  separately from individual element measurements. Existing immutable records
  gain these discovery names at read time; source bytes and version IDs stay intact.

## Actual installed-app checks

[Live prediction responses](live-predictions.json) record 13 passing cases using
the actual Accounting project and the installed app's prediction endpoint:

- “floor plan,” “duplex,” “floorplan,” “architectural drawing,” and sentence
  variants return the whole Duplex drawing as the first suggestion.
- A previously linked Supplies spreadsheet reference does not suppress a new
  explicit Duplex reference.
- “Living Room A102 Area” still returns the indexed element measurement.
- Unrelated phrases (“health plan,” “travel plan,” “duplexer,” “the floor,” and
  ordinary prose) do not trigger whole-drawing suggestions.
- Both search phrases rank the model above incidental matches in its properties.
- The pinned model preview uses the original source hash, with 111 elements in
  the Level 1 overview and no falsely selected element.

The [browser evidence](browser/ui-transcript.json) uses real keyboard and mouse
input for both phrases, selects the whole drawing, and opens its preserved model
overview. Screenshots were visually inspected. These checks use no temporary
Lasso project, seeded source objects, or mocked geometry.

Full server regression suite: **246 checks passed**. Focused coverage includes
source identity preservation, drawing-first ranking, old index compatibility,
autocomplete exclusions, linked spreadsheet context, and ordinary prose staying
quiet.

[Final installed-app verification](final-installed-app.json) records the restarted
Applications copy, matching source hashes, and both successful typing queries
after the last overview-caption correction.

The source file's download provenance is in the
[original Accounting validation](../accounting-duplex-2026-10-13/README.md).
