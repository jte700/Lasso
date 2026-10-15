# Drawing and model sample validation

**Live Accounting verification, 2026-10-13:** a different public architectural IFC was freshly downloaded into the user's actual `/Users/adelyasin/Desktop/Accounting` folder. The running app automatically indexed it. All 42 area queries across 21 spaces matched an independent raw-file audit; actual browser interaction also confirmed the answer and source preview. See the [live validation report and evidence](validation/accounting-duplex-2026-10-13/README.md). The earlier fixture checks documented below used only a temporary project and did not validate the user's live workspace.

The primary acceptance fixtures are unmodified IFC and LandXML files downloaded from public sources. They exercise architectural and civil engineering metadata, including stable entity identity, explicit units, quantities, and source relationships. The optional PDF fixture covers printed annotations.

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

The optional `--pdf` integration run also passed: the combined samples produced 3,179 measurements and `What is the square footage of Small Conference on page 17?` returned **180 ft²** with the page and annotation bounding box preserved.

The automated `test/drawing-integration.test.js` covers the full source lifecycle with a small synthetic IFC: ordinary graph search triggers indexing; the snapshot preview HTTP endpoint returns a drawing with a stable property anchor; previews show the actual STEP quantity; linking a value to a document retains its model identity; changing a quantity preserves the object GUID and marks the old link stale; historical previews and original model downloads retain the old value after restart; the property anchor resolves the complete old/new RFI history. It also exercises the additive migration from an existing index, preserves prior CSV object versions under the immutability guards, and checks that DWG/RVT files remain visible with export guidance. All three integration tests passed.
