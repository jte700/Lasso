# Drawing and model sample validation

**Live Accounting verification, 2026-10-13:** a different public architectural IFC was freshly downloaded into the user's actual `/Users/adelyasin/Desktop/Accounting` folder. The running app automatically indexed it. All 42 area queries across 21 spaces matched an independent raw-file audit; actual browser interaction also confirmed the answer and source preview. See the [live validation report and evidence](validation/accounting-duplex-2026-10-13/README.md). The earlier fixture checks documented below used only a temporary project and did not validate the user's live workspace.

The primary acceptance fixtures are unmodified IFC, LandXML and STEP files downloaded from public sources. They exercise architectural, civil and mechanical engineering metadata, including stable entity identity, explicit units, quantities, measured B-rep geometry, and source relationships. The optional PDF fixture covers printed annotations.

Source URLs, original byte sizes, SHA-256 hashes, retrieval date, and exact expected facts are recorded in [`test/fixtures/drawings/sources.json`](../test/fixtures/drawings/sources.json). The validation command checks these hashes before importing the samples. It creates a temporary project and database; it never opens the user's Lasso database or edits the source models.

Run the native integration checks with:

```sh
node --disable-warning=ExperimentalWarning scripts/validate-drawing-sample.js
```

Add `--pdf` to exercise the printed-annotation fallback as well. Native validation only requires Node.js 24 or later.

## Architectural BIM: IFC

[AC20-FZK-Haus.ifc](https://www.ifcwiki.org/images/e/e3/AC20-FZK-Haus.ifc) is the Karlsruhe Institute of Technology sample model linked by [IfcOpenShell's introduction](https://docs.ifcopenshell.org/introduction/introduction_to_ifc.html). It is an IFC4 STEP export from ARCHICAD 20.

| Space | Room | Quantity | Source value | Source entity |
| --- | --- | --- | --- | --- |
| Schlafzimmer | 4 | NetFloorArea | 21.410325 m² | `#21093` |
| Schlafzimmer | 4 | GrossFloorArea | 22.0725 m² | `#21092` |
| Buero | 2 | NetFloorArea | 12.59545 m² | `#21819` |

These expected values were verified directly in the source STEP records. Schlafzimmer is `IfcSpace #20909`, GUID `347jFE2yX7IhCEIALmupEH`. `IfcRelDefinesByProperties #21106` connects it to `IfcElementQuantity #21104`, which includes the gross and net floor area quantities. Their unit fields are omitted, so they inherit square metres from `IfcProject #66` → `IfcUnitAssignment #49` → `IfcSIUnit #14`. Net and gross floor areas remain distinct facts.

Try asking Lasso for `the net floor area of Schlafzimmer` or `the net floor area of Buero`. Values come from model quantities; they are not inferred from a raster plan or a drawing's printed scale.

## Civil engineering: LandXML

[The LandXML road sample](https://github.com/mac999/landxml_parser/blob/main/landxml_road_sample.xml) is a public Civil 3D 2023 export from `Quantities-7.dwg`. The fixture preserves the original bytes and the manifest pins its repository revision.

The `Alignment` named `Main Road` declares `length="2455.497573251083"` and `staStart="0."`. `Units/Imperial` declares `linearUnit="foot"`, so the expected length is **2455.497573251083 ft**. This was verified with an independent XML parser. Try asking Lasso for `the length of Main Road`.

## Mechanical CAD: STEP (AP203, AP214, AP242)

**Validated 2026-10-19** against real exporter output, not just the synthetic fixtures in `test/fixtures/step-models.js`. Each sample set was downloaded into its own empty scratch directory and treated as untrusted data. Every file was run through `extractStepDocument` (`src/dependencies/step-extraction.js`) and `buildStepView` (`src/dependencies/step-geometry.js`).

| Set | Source | Writers | Licence | Use here |
| --- | --- | --- | --- | --- |
| NIST MBE PMI test models: CTC 1–5, FTC 6–11, STC 6–10 as AP203 geometry, AP203 with PMI, and AP242 e1–e3 | [`NIST-PMI-STEP-Files.zip`](https://www.nist.gov/document/nist-pmi-step-files), 13,976,599 B, SHA-256 `8fa78429…1911`; drawings in the same archive and in [`NIST_MBE_PMI_CTC_Definitions.zip`](https://www.nist.gov/document/nist-ctc-test-case-definitions) | Several CAD systems; NIST removed their names from the headers | "Can be used without any restrictions"; U.S. Government work (17 U.S.C. 105) | Three files committed as fixtures |
| AS1 assembly from four writers: `as1-ug-214`, `as1-md-214`, `as1-ec-214`, `as1_pe` | [STEP Tools sample files](https://www.steptools.com/docs/stpfiles/) | Unigraphics 16, MicroStation/J 7.1, MATRA CAS.CADE (Euclid), Pro/ENGINEER | None stated | Results only |
| Boxy test parts: `boxy_with_diamsize`, `boxy_with_linearsize` | STEP Tools AP214 samples | STEP-NC Explorer | None stated | Results only |
| `screw.step` | [OCCT `data/step`](https://github.com/Open-Cascade-SAS/OCCT/tree/master/data/step) | Euclid (MATRA-DATAVISION) | LGPL-2.1 repository | Results only |
| `as1-oc-214.stp` | [pythonocc-demos assets](https://github.com/tpaviot/pythonocc-demos/tree/master/assets/models) | Open CASCADE 6.1 via Datakit | None stated | Results only |

### Robustness

- **Reading.** All 41 distinct files read without a parse error (46 counting five near-duplicate CTC copies from the definitions archive, which gave identical results). The one rejection is intended: `nist_ftc_08_asme1_ap242-e1-tg.stp` holds only tessellated geometry (`COMPLEX_TRIANGULATED_SURFACE_SET`), and Lasso reports `No supported B-rep solids or surface models were found`.
- **Unsupported entities.** No B-rep face or edge in the corpus had an unsupported type: 3,040 plane, 4,642 cylinder, 1,248 cone, 404 torus, 362 sphere and 247 B-spline faces; 12,332 line, 9,211 circle, 1,979 B-spline and 240 ellipse edges. No model warnings were raised.
- **Structure.** The AS1 files read as 5 parts and 18 instances (12 for Pro/E; see below). FTC-09 AP242 reads as 2 parts; every other file is one part.
- **Speed and size.** On this Mac (Node 24.13), the slowest file (`nist_ftc_10_asme1_ap242-e2.stp`, 1.8 MB) took 102 ms to read and extract and 170 ms to preview. Preview JSON ranged from 5 KB to 972 KB. Files whose edges are mostly B-splines produce the largest previews; FTC-10 AP242 and FTC-07 AP242 are 972 KB and 459 KB.
- **Extents.** Of the 183 part axes, 165 got an exact extent. The other 18 were omitted, as designed, because a spherical, toroidal or B-spline face could extend past its boundary edges.

### Cross-checks against independent values

These values were not taken from Lasso's reader.

- **Extents against raw records.** A separate script read each single-solid file's records with regular expressions. It took the bounding box of the solid's `VERTEX_POINT`s plus exact bounds of its `CIRCLE` and `ELLIPSE` arcs, and did not follow related surface-model representations. On 34 files, 85 of the 88 measured axes equal Lasso's exact extent. The other three are CTC-04 Z (`_rd` and AP242) and FTC-10 AP242 X, where the extreme lies on a B-spline edge. The ellipse- or circle-based export of the same model independently gives Lasso's value (130.603934 mm and 158 mm). No Lasso extent was smaller than the raw box.
- **Diameters against AP242 semantic PMI.** Each `DIMENSIONAL_SIZE` diameter was resolved through `GEOMETRIC_ITEM_SPECIFIC_USAGE` to the `CYLINDRICAL_SURFACE` of the face it applies to, and converted to millimetres with the PMI's own unit. In all 16 AP242 B-rep models, every PMI diameter that equals twice its face's radius is an indexed hole or cylinder diameter. There are two exceptions:
  - The FTC-10 Ø5.5 bores were missing; this was a reader bug, now fixed.
  - The FTC-09/STC-09 Ø9.525 bores cover only 316° or 180° of the circle (slot ends). Lasso indexes them as R4.7625 arcs, not holes.

  STC-07's PMI is not linked to faces this way, but all 7 of its diameter values are indexed. Five PMI diameters reference no face and could not be checked: 2× Ø25.4 in FTC-06 and 3× Ø3 in FTC-10. Some PMI values disagree with the file's own geometry. For example, a 3.9624 mm (.156 in) PMI sits on a 5/32 in bore. Lasso reports the geometry.
- **Published drawings**, rendered from NIST's PDFs and read visually:
  - CTC-01: four Ø35 corner bores, Ø25 ±0.15 on four equal top-face holes, and two Ø20 side holes. Lasso: Ø35 ×4, Ø25 ×4, Ø20 ×2.
  - FTC-06 (inches): 2× Ø.562; 2× counterbore Ø.812 ↧.56; 4× Ø.415 with counterbore Ø.625 ↧.50; 4× Ø.281; 4× counterbore Ø.40 ↧.31. These match Lasso's Ø0.5625, Ø0.8125 × 0.5625, Ø0.415 and Ø0.625 × 0.5, Ø0.281, and Ø0.4 × 0.3125.
  - FTC-07: Ø.250 ↧.30 is called out 1 + 4X + 2X + 1 times. Lasso: Ø0.25 × 0.3 ×8.
- **One model from four writers (AS1).** UG, MicroStation, Euclid and Pro/E agree on:
  - plate 180 × 150 × 20 with 6× Ø10 × 20 holes
  - L-bracket 50 × 60 × 100 (axis order varies) with 4× Ø10 × 10
  - nut 20 × 15 × 3 with a Ø10 hole
  - rod Ø10 × 200

  The writers' bolts differ: 37 long with a Ø10 × 34 shank (UG, Euclid) or 40 long with a Ø10 × 37 shank (MicroStation, Pro/E). The assembly extents follow: 200 × 150 × 84 and 200 × 150 × 87. Pro/E's own NAUO structure has 3 bolts and 1 nut per bracket and no rod nuts, which is 12 instances. That file also declares `CONVERSION_BASED_UNIT('INCH')` while its coordinates match the other writers' millimetres. Lasso reports the declared unit (a 180 in plate) and does not guess a correction.
- **Boxy parts.** Lasso's 80 × 80 × 80 mm matches the published 80 mm face-to-face size. The published "Ø12.7" diameter PMI is applied to face `#2045`, whose `CYLINDRICAL_SURFACE #1935` has radius 13. Lasso reports Ø26 from the geometry, and the sample's annotation does not describe its own solid.

### Reader fixes from this validation

Each fix has a synthetic regression test (`test/step-extraction.test.js`, `test/step-geometry.test.js`) that fails without it.

1. **Reversed face bounds.** A `FACE_OUTER_BOUND(…, .F.)` loop is now traversed in reverse edge order, and the apex winding sums each edge's own sweep. Before this, a half frustum written this way counted a phantom turn: Lasso treated the cone apex as part of the face and omitted the extent. Recovered: CTC-05 `_rd` Z = 19 in and FTC-09 `_rd` Y = 0.1196 in, matching their other exports.
2. **Datum-target and split surfaces beside a solid.** A `SHELL_BASED_SURFACE_MODEL` attached to a part that has a solid is now drawn in the preview, but it is not measured as material. Previously:
   - FTC-07 and STC-07 AP242 reported Z = 10.145203 in, because two "Fill.1" target areas lie outside the solid. Correct: 8.767949192 in.
   - FTC-10 AP242 lost its Ø5.5 holes, because patches with no material side made the bore read as an unclassified cylindrical face.
   - Extent facts could cite the surface patch's record instead of the solid's.
3. **Supplemental construction geometry.** Bodies held only by a `CONSTRUCTIVE_GEOMETRY_REPRESENTATION` are no longer reported as parts. In CTC-04 `_rd`, two reference planes named "NONE" had become unitless parts, which also blocked the assembly extents.

Nothing else in the corpus changed.

### Committed fixtures

`nist_ctc_01_asme1_rd.stp`, `nist_ctc_05_asme1_rd.stp` and `nist_ftc_07_asme1_ap242-e2.stp` (about 2 MB together) are in `test/fixtures/drawings/`. `sources.json` records each file's archive path, hash, licence and expected values, and the basis of each value.

The validation command checks each file's extents and the hole diameters, counts and depths established above. It also renders a highlighted preview for each part, asks `What is the diameter of the nist_ctc_01_asme1_rd Ø35 hole?` (35 mm), and checks that `What is the length of nist_ftc_07_asme1?` offers exactly the solid's three extents.

### Known limitations and follow-ups

- **Curved faces block extents.** Spheres, tori and B-spline surfaces still omit 18 of the 183 part extents. One example is the toroidal thread run-out of `screw.step`. An exact test of whether a spherical or toroidal face contains its extreme point would recover most of these.
- **B-spline cylinders.** Open CASCADE 6.1 via Datakit (`as1-oc-214`) writes every cylinder as a rational B-spline surface, so it yields no holes and one omitted extent per part.
- **Tessellated-only parts** are rejected. The message could name tessellation specifically.
- **Product-level datum targets.** FTC-09 AP242 declares its datum-target areas as a separate unnamed product, which appears as part "Part (2)".
- **Writer round-off.** Values are indexed to ten significant digits, so writer round-off shows. For example, FTC-07 AP242 gives a 0.2999999999 in depth and STC-09 a 7.499999992 in width, while the AP203 exports give 0.3 and 7.5.
- **Preview size.** The preview samples B-spline edges at 32–256 points regardless of size, which produces the 459–972 KB previews.
- **Extent questions.** The drawing-question parser has no "extent", "height" or "width" wording. Only "length of <part>" works, and it returns all three axes as an ambiguous answer.

## Optional PDF fallback

[NC State's Office Space Kit-of-Parts](https://facilities.ofa.ncsu.edu/files/2025/10/Office-Kit-of-Parts.pdf), October 2025, page 17 shows two architectural floor-plan examples for a **Small Conference** room and labels the area **180 sf**, with dimensions `12x15`. The page was rendered with Poppler and visually inspected independently of Lasso. The value is an explicit annotation, not a measured polygon area.

PDF verification tooling available during development included the bundled Poppler `pdftoppm`, `pdfinfo`, and `pdftotext`, and the bundled Python `pypdf`/`pdfplumber`. Native IFC and LandXML validation does not depend on these tools.

## Verified integration results

On 2026-10-12, the native validation command passed against a fresh Lasso project and temporary database. Lasso indexed **3,170 model measurements** (3,169 from IFC and one from LandXML), retaining IFC GUIDs and STEP property identifiers and the LandXML source attribute path.

| Query | Verified answer |
| --- | --- |
| `What is the net floor area of Schlafzimmer?` | 21.410325 m² |
| `What is the gross floor area of Schlafzimmer?` | 22.0725 m² |
| `What is the net floor area of Buero?` | 12.59545 m² |
| `What is the net square footage of Schlafzimmer?` | 230.4588 ft² |
| `What is the length of Main Road?` | 2455.497573251083 ft |

The square-foot answer uses `m² / 0.09290304` and cites the original 21.410325 m² model property. The script checks the unrounded numeric answer in addition to the displayed value. Each answer includes a source file and a native property locator. An unqualified Schlafzimmer area question returns ambiguity, and a nonexistent room returns no answer.

On 2026-10-19, with the three NIST STEP fixtures added, the command passed again and indexed **3,329 measurements**. That is the same 3,170 plus 159 STEP B-rep measurements, which keep part names, geometry feature IDs and source record citations. The `What is the diameter of the nist_ctc_01_asme1_rd Ø35 hole?` question returned **35 mm**, citing `nist_ctc_01_asme1_rd.stp`.

The optional `--pdf` integration run also passed: the combined samples produced 3,179 measurements and `What is the square footage of Small Conference on page 17?` returned **180 ft²** with the page and annotation bounding box preserved.

The automated `test/drawing-integration.test.js` covers the full source lifecycle with a small synthetic IFC: ordinary graph search triggers indexing; the snapshot preview HTTP endpoint returns a drawing with a stable property anchor; previews show the actual STEP quantity; linking a value to a document retains its model identity; changing a quantity preserves the object GUID and marks the old link stale; historical previews and original model downloads retain the old value after restart; the property anchor resolves the complete old/new RFI history. It also exercises the additive migration from an existing index, preserves prior CSV object versions under the immutability guards, and checks that DWG/RVT files remain visible with export guidance. All three integration tests passed.
