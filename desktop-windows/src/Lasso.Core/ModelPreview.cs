// Source-backed previews shared by the native suggestion panel and its tests.
// Parsing and the plan-view transform are pure, so a preview can be checked
// against a recorded server response without opening a window.

using System.Text.Json;

namespace Lasso.Core;

public readonly record struct HostPoint(double X, double Y);

public sealed record AssistPreviewCell(string Value, bool Cited);

public sealed record AssistPreviewRow(int? RowNumber, IReadOnlyList<AssistPreviewCell> Cells);

public sealed record AssistModelBounds(double MinX, double MinY, double MaxX, double MaxY)
{
    public double Width => MaxX - MinX;
    public double Height => MaxY - MinY;

    public static AssistModelBounds? Parse(JsonElement? json)
    {
        if (json is not { ValueKind: JsonValueKind.Object } element) return null;
        if (!JsonReading.TryDouble(element, "minX", out var minX)) return null;
        if (!JsonReading.TryDouble(element, "minY", out var minY)) return null;
        if (!JsonReading.TryDouble(element, "maxX", out var maxX)) return null;
        if (!JsonReading.TryDouble(element, "maxY", out var maxY)) return null;
        if (maxX <= minX || maxY <= minY) return null;
        return new AssistModelBounds(minX, minY, maxX, maxY);
    }
}

public sealed record AssistModelElement(
    int Id,
    string Guid,
    string Label,
    string EntityType,
    string Role,
    bool Selected,
    /// Actual projected IFC silhouette rings; an even-odd fill preserves holes.
    IReadOnlyList<IReadOnlyList<HostPoint>> Polygons);

public sealed record AssistModelPreview(
    AssistModelBounds Bounds,
    AssistModelBounds FocusBounds,
    IReadOnlyList<AssistModelElement> Elements,
    string SelectedLabel,
    string SelectedEntityType,
    string StoreyLabel,
    IReadOnlyList<string> Warnings)
{
    public static AssistModelPreview? Parse(JsonElement json)
    {
        if (json.ValueKind != JsonValueKind.Object) return null;
        if (JsonReading.String(json, "kind") != "model-plan") return null;
        var bounds = AssistModelBounds.Parse(JsonReading.Object(json, "bounds"));
        if (bounds is null) return null;

        var elements = new List<AssistModelElement>();
        foreach (var item in JsonReading.Array(json, "elements"))
        {
            var polygons = new List<IReadOnlyList<HostPoint>>();
            foreach (var ring in JsonReading.Array(item, "polygons"))
            {
                if (ring.ValueKind != JsonValueKind.Array) continue;
                var vertices = new List<HostPoint>();
                var usable = true;
                foreach (var vertex in ring.EnumerateArray())
                {
                    if (vertex.ValueKind != JsonValueKind.Array || vertex.GetArrayLength() != 2)
                    {
                        usable = false;
                        break;
                    }
                    var pair = vertex.EnumerateArray().ToArray();
                    if (!JsonReading.TryDouble(pair[0], out var x) || !JsonReading.TryDouble(pair[1], out var y))
                    {
                        usable = false;
                        break;
                    }
                    vertices.Add(new HostPoint(x, y));
                }
                if (usable && vertices.Count >= 3) polygons.Add(vertices);
            }
            if (polygons.Count == 0) continue;
            elements.Add(new AssistModelElement(
                Id: JsonReading.Int(item, "id") ?? 0,
                Guid: JsonReading.String(item, "guid") ?? "",
                Label: JsonReading.String(item, "label") ?? "",
                EntityType: JsonReading.String(item, "entityType") ?? "",
                Role: JsonReading.String(item, "role") ?? "context",
                Selected: JsonReading.Bool(item, "selected") ?? false,
                Polygons: polygons));
        }
        if (elements.Count == 0) return null;

        var selected = JsonReading.Object(json, "selected");
        return new AssistModelPreview(
            Bounds: bounds,
            FocusBounds: AssistModelBounds.Parse(JsonReading.Object(json, "focusBounds")) ?? bounds,
            Elements: elements,
            SelectedLabel: selected is { } chosen ? JsonReading.String(chosen, "label") ?? "" : "",
            SelectedEntityType: selected is { } typed ? JsonReading.String(typed, "entityType") ?? "" : "",
            StoreyLabel: JsonReading.Object(json, "storey") is { } storey
                ? JsonReading.String(storey, "label") ?? "" : "",
            Warnings: JsonReading.StringArray(json, "warnings"));
    }
}

/// A single uniform scale maps the model's XY coordinates into the preview
/// viewport. The server chooses the actual selected element's focus bounds.
/// Y is inverted because model coordinates grow upwards while the drawing
/// surface grows downwards.
public sealed class AssistModelTransform
{
    public double Scale { get; }
    private readonly AssistModelBounds _source;
    private readonly HostPoint _origin;

    private AssistModelTransform(double scale, AssistModelBounds source, HostPoint origin)
    {
        Scale = scale;
        _source = source;
        _origin = origin;
    }

    public static AssistModelTransform? Create(AssistModelBounds bounds, HostRect viewport, double padding = 10)
    {
        var inner = viewport.InsetBy(padding, padding);
        if (inner.Width <= 0 || inner.Height <= 0) return null;
        var scale = Math.Min(inner.Width / bounds.Width, inner.Height / bounds.Height);
        if (!double.IsFinite(scale) || scale <= 0) return null;
        var origin = new HostPoint(
            inner.MidX - bounds.Width * scale / 2,
            inner.MidY - bounds.Height * scale / 2);
        return new AssistModelTransform(scale, bounds, origin);
    }

    public HostPoint Point(HostPoint point) => new(
        _origin.X + (point.X - _source.MinX) * Scale,
        _origin.Y + (_source.MaxY - point.Y) * Scale);

    /// The element's rings in viewport space, ready to stroke and fill.
    public List<List<HostPoint>> Rings(AssistModelElement element) =>
        element.Polygons
            .Select(polygon => polygon.Select(Point).ToList())
            .ToList();

    /// Whether a viewport point falls inside the element, filled even-odd so an
    /// opening stays a hole rather than being painted over.
    public bool Contains(AssistModelElement element, HostPoint point) =>
        EvenOddContains(Rings(element), point);

    /// Even-odd ray casting: a point is inside when a ray crosses the rings an
    /// odd number of times.
    public static bool EvenOddContains(IReadOnlyList<List<HostPoint>> rings, HostPoint point)
    {
        var inside = false;
        foreach (var ring in rings)
        {
            for (int current = 0, previous = ring.Count - 1; current < ring.Count; previous = current++)
            {
                var a = ring[current];
                var b = ring[previous];
                if (a.Y > point.Y == b.Y > point.Y) continue;
                var crossing = (b.X - a.X) * (point.Y - a.Y) / (b.Y - a.Y) + a.X;
                if (point.X < crossing) inside = !inside;
            }
        }
        return inside;
    }
}

public sealed record AssistDocumentPreview(
    string Filename,
    string Path,
    string Location,
    string Context,
    string? ValueText,
    string ObjectType,
    int? SnapshotVersion,
    IReadOnlyList<string> Columns,
    IReadOnlyList<string> Headers,
    IReadOnlyList<AssistPreviewRow> Rows,
    AssistModelPreview? Model = null,
    string? UnavailableReason = null)
{
    public static AssistDocumentPreview? Parse(ReadOnlySpan<byte> data)
    {
        try
        {
            using var document = JsonDocument.Parse(data.ToArray());
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (JsonReading.Object(root, "source") is not { } source) return null;
            var preview = JsonReading.Object(root, "preview");

            var rows = new List<AssistPreviewRow>();
            if (preview is { } previewElement)
            {
                foreach (var row in JsonReading.Array(previewElement, "rows"))
                {
                    var cells = JsonReading.Array(row, "cells")
                        .Select(cell => new AssistPreviewCell(
                            JsonReading.String(cell, "value") ?? "",
                            JsonReading.Bool(cell, "cited") ?? false))
                        .ToList();
                    rows.Add(new AssistPreviewRow(JsonReading.Int(row, "rowNumber"), cells));
                }
            }

            var kind = preview is { } k ? JsonReading.String(k, "kind") ?? "" : "";
            var model = preview is { } m ? AssistModelPreview.Parse(m) : null;
            string? unavailable;
            if (kind == "model-unavailable")
            {
                unavailable = (preview is { } reason ? JsonReading.String(reason, "reason") : null)
                    ?? "This indexed element has no available drawing geometry.";
            }
            else if (kind == "model-plan" && model is null)
            {
                unavailable = "The model contains no usable drawing geometry for this preview.";
            }
            else
            {
                unavailable = null;
            }

            return new AssistDocumentPreview(
                Filename: JsonReading.String(source, "filename") ?? "",
                Path: JsonReading.String(root, "path") ?? "",
                Location: JsonReading.String(source, "location") ?? "",
                Context: JsonReading.String(source, "context") ?? "",
                ValueText: JsonReading.String(source, "valueText"),
                ObjectType: JsonReading.String(source, "objectType") ?? "SOURCE",
                SnapshotVersion: JsonReading.Int(source, "snapshotVersion"),
                Columns: preview is { } c ? JsonReading.StringArray(c, "columns") : [],
                Headers: preview is { } h ? JsonReading.StringArray(h, "headers") : [],
                Rows: rows,
                Model: model,
                UnavailableReason: unavailable);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
