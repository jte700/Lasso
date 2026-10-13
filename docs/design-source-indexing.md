# Architectural and civil design indexing

## Format strategy

IFC and LandXML provide semantic properties that a printed plan may not contain.
DXF provides CAD entities and units. These are the primary inputs; PDF annotation
extraction is a fallback. All processing is local and deterministic, with no model
API, remote upload, or additional JavaScript dependency.

- **IFC STEP:** follow `IfcRelDefinesByProperties` to `IfcElementQuantity` and
  `IfcPropertySet`; read area, length, and volume measures. Resolve a quantity's
  own unit before the project's `IfcUnitAssignment`. Support SI prefixes and
  conversion-based units, preserving the original value/unit alongside the SI
  result. Track the element GUID, STEP identifiers, property set/name, room name
  and number, and spatial hierarchy. No tessellation or missing-quantity inference.
- **DXF ASCII:** inspect model-space `LWPOLYLINE`, declared `$INSUNITS`, and
  unambiguous enclosed `TEXT`/`MTEXT`. Compute simple closed boundary area and
  perimeter. Preserve entity handle, layer, vertices, and measurement basis.
  Boundary area is not automatically a BIM net-floor-area quantity. Reject arcs,
  self-intersections, nondefault extrusion, wide polylines and unknown units.
- **LandXML 1.0–1.2:** read supported named parcel, alignment, pipe and structure
  attributes with explicitly declared units. Keep the full element/property path.
  Do not calculate a road's length from sparse geometry, parse terrain TINs, or
  assume a slope convention. XML parsing never resolves external entities or DTDs.
- **PDF:** extract positioned selectable text through PDFKit or local Poppler,
  associate only supported explicit annotations with unambiguous nearby labels,
  and retain normalized top-left bounds. No pixel/scale-based area estimation.

The standards distinguish useful concepts: IFC defines
[NetFloorArea and GrossFloorArea](https://standards.buildingsmart.org/IFC/RELEASE/IFC4/FINAL/HTML/schema/ifcproductextension/qset/qto_spacebasequantities.htm)
separately, and quantities can carry their own
[measurement unit](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcQuantityArea.htm).
The DXF [LWPOLYLINE record](https://help.autodesk.com/cloudhelp/2017/ENU/AutoCAD-DXF/files/GUID-748FC305-F3F2-4F74-825A-61F04D757A50.htm)
provides closure, vertices, bulges and extrusion.
Civil 3D documents its [supported LandXML exchange objects](https://help.autodesk.com/cloudhelp/2023/ENU/Civil3D-UserGuide/files/GUID-4D10ABA5-5EA0-41A8-BB61-C3F446CE7C6B.htm).

## Index and retrieval

`drawing-objects.js` adapts readers into `DRAWING` containers and
`DRAWING_ANNOTATION` facts in Lasso's existing object/version tables. CAD property
anchors address element/property identity; PDF anchors address sheet/page/region.
Metadata records `model-property`, `geometry`, or `explicit` as the basis. IFC
keys use the element GUID and quantity/property identity so value changes keep
the same logical object. DXF keys use entity handles; LandXML keys use scoped
element paths. Renaming a LandXML identity or changing IFC GUIDs can break links
instead of silently redirecting them.

Migration 016 adds an index-version marker. Existing snapshots receive additional
drawing objects lazily, preserving historical object versions and pinned links.
Normal search, previews, writing suggestions, manual linking, provenance and
staleness all use the same index. Native source previews expose property values
with stable selectable anchors. Original source bytes remain downloadable through
the existing linked-source route.

Drawing questions match complete entity tokens and measurement kinds. They may
be scoped by file, PDF sheet or page. For IFC spaces, floor-area questions use
room-area quantities rather than ceiling/wall area. Explicit net/gross questions
select the corresponding floor-area property. Multiple matching sources require
disambiguation. Requested square feet/metres convert using the exact definition
`1 ft = 0.3048 m`; the response records the source value and conversion.

## Export guidance and bounds

DWG, RVT and DGN are retained as source files with an unsupported status and
actionable export guidance. Direct proprietary-format SDKs are not included.
For Revit, enable rooms/spaces and **Export base quantities** in
[IFC export settings](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-DocumentPresent/files/GUID-E029E3AD-1639-4446-A935-C9796BC34C95.htm).
Civil 3D users should export LandXML to preserve civil object semantics; plain DXF
does not expose proprietary Civil 3D object properties.

Readers bound input size and parsing complexity. IFC supports up to 64 MB,
500,000 STEP records and 8,000 indexed measurements. LandXML bounds XML size,
element count and nesting. DXF bounds entity and geometry association work. PDF
processing bounds size, pages, output and subprocess time. The workspace retains
its existing 10,000-object indexing limit. Partial extraction, missing units,
unsupported geometry and native-format limitations remain visible in source
metadata and `index failures`; failed measurements never become numeric answers.

## Verification

Run `npm test` for parsing, units, malformed inputs, ambiguity, conversions,
source lifecycle and migration regressions. Run
`node --disable-warning=ExperimentalWarning scripts/validate-drawing-sample.js`
for hash-checked public IFC and Civil 3D samples; append `--pdf` for the optional
real floor-plan fallback. See [sample results](drawing-sample-validation.md).
