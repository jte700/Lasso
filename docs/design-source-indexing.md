# Architectural, civil, and mechanical design indexing

## Format strategy

IFC and LandXML provide semantic properties that a printed plan may not contain.
DXF provides CAD entities and units. These are the primary inputs; PDF annotation
extraction is a fallback. All processing is local and deterministic, with no model
API or remote upload. IFC visual previews use a bundled geometry engine.

- **IFC STEP:** follow `IfcRelDefinesByProperties` to `IfcElementQuantity` and
  `IfcPropertySet`; read area, length, and volume measures. Resolve a quantity's
  own unit before the project's `IfcUnitAssignment`. Support SI prefixes and
  conversion-based units, preserving the original value/unit alongside the SI
  result. Track the element GUID, STEP identifiers, property set/name, room name
  and number, and spatial hierarchy. Numeric answers read explicit quantities;
  visual preview tessellation never invents missing quantities.
- **DXF ASCII:** inspect model-space `LWPOLYLINE`, declared `$INSUNITS`, and
  unambiguous enclosed `TEXT`/`MTEXT`. Compute simple closed boundary area and
  perimeter. Preserve entity handle, layer, vertices, and measurement basis.
  Boundary area is not automatically a BIM net-floor-area quantity. Reject arcs,
  self-intersections, nondefault extrusion, wide polylines and unknown units.
- **LandXML 1.0–1.2:** read supported named parcel, alignment, pipe and structure
  attributes with explicitly declared units. Keep the full element/property path.
  Do not calculate a road's length from sparse geometry, parse terrain TINs, or
  assume a slope convention. XML parsing never resolves external entities or DTDs.
- **STEP AP203/AP214/AP242:** resolve `PRODUCT` → `PRODUCT_DEFINITION` →
  `SHAPE_DEFINITION_REPRESENTATION` to named parts, and place assembly components
  through `NEXT_ASSEMBLY_USAGE_OCCURRENCE` and `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION`
  (or mapped items). Read `MANIFOLD_SOLID_BREP`, `BREP_WITH_VOIDS`,
  `FACETED_BREP` and shell-based surface models down to their edges. Units come
  from each representation context (SI prefixes and conversion-based units such
  as inches); values are reported in the model's declared unit. See below.
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

## STEP CAD measurements

Each part (a product definition with B-rep geometry) is measured in its own
coordinates; parts placed several times are indexed once and record their
instance count. Every value is exact B-rep geometry with `measurementBasis`
`geometry`:

- **Overall X/Y/Z extent** of each part and of the root assembly. Lines,
  circles, ellipses and B-spline edges are bounded analytically (B-splines are
  refined to numerical precision). Planar, cylindrical and extruded faces cannot
  extend past their edges, nor can a cone frustum such as a chamfer (its oriented
  boundary does not encircle the apex). A sphere, torus, B-spline surface or
  pointed cone whose full extent could exceed the edges makes that axis
  unanswerable; it is omitted with a warning rather than estimated (for example,
  a domed or pointed pin's length).
- **Holes and cylinders.** Cylindrical faces sharing an axis and radius form one
  feature, including halves that a writer split. A complete concave cylinder is a
  hole (diameter and depth); a complete convex one is a cylinder (diameter and
  length). Concavity comes from the face orientation in a closed solid; surface
  models are not classified. Partial cylinders (rounds) are reported as arcs.
- **Arcs.** Circular edges on one circle merge into maximal arcs, so a hole rim
  split into semicircles is not reported as two arcs. Arcs are grouped by radius
  and sweep and indexed with their radius and arc length.
- **Straight edges.** Distinct straight-edge lengths, excluding seam edges that
  only close a periodic face or join halves of one cylinder.

STEP carries no persistent face or edge names, so a feature's key is its part
name and geometry (for example `hole:8:10`). Re-exports that renumber records
keep every key. Overall extents keep their identity when values change; a
resized hole is a different feature, so a link to the old size reports its
source as missing instead of silently following another hole. Groups of the same
kind on one part are capped (16 hole, cylinder and arc sizes; 12 edge lengths)
and each file indexes at most 4,000 values, keeping extents and holes first.
AP242 semantic PMI (authored dimensions and tolerances), volume, surface area
and mass are not indexed.

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

Drawing questions match complete entity tokens and measurement kinds,
including CAD radius, depth, arc length and edge length questions such as
"What is the diameter of the Bracket Ø8 hole?". They may
be scoped by file, PDF sheet or page. For IFC spaces, floor-area questions use
room-area quantities rather than ceiling/wall area. Explicit net/gross questions
select the corresponding floor-area property. Multiple matching sources require
disambiguation. Requested square feet/metres convert using the exact definition
`1 ft = 0.3048 m`; the response records the source value and conversion.

## Visual IFC previews

The native writing-suggestion panel and browser source views show the actual
geometry of the selected indexed IFC element. Selection follows its GUID and
STEP identifier, including doors, windows, walls, spaces, and other represented
products. Multiple indexed properties of one element focus the same geometry.
Spatial containers and product types can show their explicitly related products.
There is no room-name heuristic or fabricated bounding-box drawing.

`web-ifc` 0.0.78 tessellates the preserved source version in a worker thread.
`polygon-clipping` 0.15.7 unions projected mesh faces into plan silhouettes,
retaining concavity and holes. Both packages and the WASM runtime are pinned and
bundled with the desktop application for offline operation. Plan views highlight
the selected element in blue, with context from its storey. Whole-model previews
start on the lowest storey containing spaces. Browser controls offer fit selection,
show context, zoom and pan. This is a geometric plan projection, not a replacement
for every authored construction sheet or a full 3D authoring application.

The same file hash and exact property anchor drive each preview. Historical links
render historical source bytes. Geometry is cached by source hash, not filename;
switching suggestions discards stale responses. Missing or unsupported geometry
shows an explanation, while indexed quantities remain available. Public share
scope and redaction rules do not gain model-context access from these local views.

Preview work is limited to 64 MB of input, 20,000 products, two million triangles,
50,000 projected triangles per element and 400,000 plan points. Workers have a
30-second processing timeout; the cache holds at most three completed source
models and 32 MB of projected data. Preview limits are separate from indexing
limits. Run `npm ci` before building so the offline runtime can be bundled.

## Visual STEP previews

The same popup and source views draw STEP files as an isometric wireframe of
the preserved version (+Z up), with silhouette lines on cylinders. The cited
feature's edges are highlighted on every instance of its part; an extent selects
the whole part, and an assembly extent selects every component. Part and feature
identities must exist in that version: a missing one explains itself instead of
highlighting something else. Edges are sampled in a worker thread with a
30-second timeout, cached by source hash, and limited to 600,000 sampled points
per file and 120,000 drawn points per view (cited instances are always drawn).
Spherical and other doubly curved faces show only their boundary edges.

Local views can turn the model. Each element carries its edges and cylinders in
3D next to the isometric lines, with an orbit pivot at the middle of the cited
geometry, and `public/model-orbit.js` (mirrored in `desktop/ModelOrbit.swift`)
reprojects them with a turntable camera that keeps +Z up and stops short of a
straight top or bottom view. Silhouettes are recomputed for each camera. In the
browser and the source inspector, dragging rotates, shift or middle dragging
pans, and a pinch or + / − zooms; in the suggestion card, dragging rotates,
scrolling or pinching zooms and a double-click resets. Zoom stops at a tenth of
the smaller of the selection and the whole model, and at twice the larger.
Shared pages stay flat: the 3D data is only embedded in interactive local views.

## Export guidance and bounds

DWG, RVT and DGN are retained as source files with an unsupported status and
actionable export guidance, as are native mechanical CAD files (SLDPRT, SLDASM,
IPT, IAM, F3D, CATPart, CATProduct, Parasolid X_T/X_B, IGES and 3DM); export
those as STEP AP242 or AP214 with solid bodies. Direct proprietary-format SDKs are not included.
For Revit, enable rooms/spaces and **Export base quantities** in
[IFC export settings](https://help.autodesk.com/cloudhelp/2025/ENU/Revit-DocumentPresent/files/GUID-E029E3AD-1639-4446-A935-C9796BC34C95.htm).
Civil 3D users should export LandXML to preserve civil object semantics; plain DXF
does not expose proprietary Civil 3D object properties.

Readers bound input size and parsing complexity. STEP supports up to 64 MB,
1,500,000 records, 400,000 edges and 20,000 placed instances. IFC supports up to 64 MB,
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
