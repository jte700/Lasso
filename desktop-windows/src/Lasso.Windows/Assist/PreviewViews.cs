//  The two preview surfaces inside the suggestion panel.
//
//  A spreadsheet excerpt with the cited cell marked, and a plan view of the
//  actual IFC geometry behind a model-backed suggestion. Both are drawn rather
//  than composed, for the same reason the macOS panel draws them: the content
//  is a grid of measured values, not a list of controls, and it has to fit a
//  fixed pane without reflowing.
//
//  Neither invents anything. A cell with no value stays blank, and an element
//  with no usable geometry is not replaced by a sketch.

using System.Globalization;
using System.Windows;
using System.Windows.Media;
using Lasso.Core;

namespace Lasso.Windows.Assist;

internal abstract class PreviewSurface : FrameworkElement
{
    protected FluentPalette Palette => FluentPalette.Current;

    protected double Dpi => VisualTreeHelper.GetDpi(this).PixelsPerDip;

    protected FormattedText Text(string value, double size, Brush brush,
        bool strong = false, FontFamily? family = null) =>
        new(value ?? "",
            CultureInfo.CurrentUICulture,
            FlowDirection.LeftToRight,
            new Typeface(family ?? Palette.BodyFont,
                FontStyles.Normal,
                strong ? FontWeights.SemiBold : FontWeights.Normal,
                FontStretches.Normal),
            size,
            brush,
            Dpi);

    protected void Draw(DrawingContext context, string value, double x, double y, double maxWidth,
        double size, Brush brush, bool strong = false, TextAlignment alignment = TextAlignment.Left)
    {
        if (string.IsNullOrEmpty(value)) return;
        var text = Text(value, size, brush, strong);
        text.MaxTextWidth = Math.Max(1, maxWidth);
        text.MaxLineCount = 1;
        text.Trimming = TextTrimming.CharacterEllipsis;
        text.TextAlignment = alignment;
        context.DrawText(text, new Point(x, y));
    }
}

/// A spreadsheet excerpt. The cited cell carries the only emphasis on the
/// surface, so the evidence is unambiguous.
internal sealed class TablePreviewView : PreviewSurface
{
    private AssistDocumentPreview? _preview;

    public AssistDocumentPreview? Preview
    {
        get => _preview;
        set
        {
            _preview = value;
            InvalidateVisual();
        }
    }

    protected override void OnRender(DrawingContext context)
    {
        var preview = _preview;
        if (preview is null || preview.Rows.Count == 0) return;

        var area = new Rect(0, 0, ActualWidth, ActualHeight);
        var rounded = new RectangleGeometry(area, FluentPalette.ControlRadius, FluentPalette.ControlRadius);
        context.DrawGeometry(Palette.CardBackground, new Pen(Palette.ControlBorder, 1), rounded);
        context.PushClip(rounded);

        var availableColumns = Math.Max(1, preview.Rows.Max(row => row.Cells.Count));
        var count = Math.Min(4, availableColumns);
        // Keep the cited column on screen when the sheet is wider than the pane.
        var selectedColumn = preview.Rows
            .SelectMany(row => row.Cells.Select((cell, index) => (cell, index)))
            .Where(entry => entry.cell.Cited)
            .Select(entry => entry.index)
            .DefaultIfEmpty(0)
            .First();
        var windowStart = Math.Max(1, Math.Min(selectedColumn - 1, availableColumns - (count - 1)));
        var visibleColumns = availableColumns <= count
            ? Enumerable.Range(0, count).ToArray()
            : new[] { 0 }.Concat(Enumerable.Range(windowStart, count - 1)).ToArray();

        const double rowHeaderWidth = 34;
        const double rowHeight = 26;
        const double headerHeight = 44;
        var dataWidth = area.Width - rowHeaderWidth;
        var columnWidths = count == 2
            ? new[] { dataWidth * 0.56, dataWidth * 0.44 }
            : Enumerable.Repeat(dataWidth / count, count).ToArray();

        double ColumnOffset(int column) => columnWidths.Take(column).Sum();

        var maximumRows = Math.Max(1, (int)((area.Height - headerHeight) / rowHeight));
        var selectedRow = preview.Rows.ToList().FindIndex(row => row.Cells.Any(cell => cell.Cited));
        if (selectedRow < 0) selectedRow = 0;
        var rowStart = Math.Max(0, Math.Min(selectedRow - maximumRows / 2, preview.Rows.Count - maximumRows));
        var rows = preview.Rows.Skip(rowStart).Take(maximumRows).ToList();

        // Column headings.
        var header = new Rect(0, 0, area.Width, headerHeight);
        context.DrawRectangle(Palette.LayerBackground, null, header);
        for (var column = 0; column < visibleColumns.Length; column++)
        {
            var sourceColumn = visibleColumns[column];
            var letter = sourceColumn < preview.Columns.Count
                ? preview.Columns[sourceColumn]
                : PredictionParser.SpreadsheetColumn(sourceColumn);
            var heading = sourceColumn < preview.Headers.Count ? preview.Headers[sourceColumn] : "";
            var x = rowHeaderWidth + ColumnOffset(column);
            var text = Text(heading.Length > 0 ? heading : "Column " + letter,
                FluentPalette.CaptionSize, Palette.TextPrimary, strong: true);
            text.MaxTextWidth = Math.Max(1, columnWidths[column] - 12);
            text.MaxLineCount = 2;
            text.Trimming = TextTrimming.CharacterEllipsis;
            context.DrawText(text, new Point(x + 6, 7));
        }

        var citedOutlines = new List<Rect>();
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            var y = headerHeight + rowHeight * index;
            var citedColumns = visibleColumns
                .Select((sourceColumn, offset) => (sourceColumn, offset))
                .Where(entry => entry.sourceColumn < row.Cells.Count && row.Cells[entry.sourceColumn].Cited)
                .Select(entry => entry.offset)
                .ToList();
            var citedRow = citedColumns.Count > 0;

            Draw(context, row.RowNumber?.ToString() ?? "-", 0, y + 5, rowHeaderWidth - 6,
                FluentPalette.CaptionSize,
                citedRow ? Palette.CitedStroke : Palette.TextTertiary,
                alignment: TextAlignment.Right);

            for (var column = 0; column < visibleColumns.Length; column++)
            {
                var sourceColumn = visibleColumns[column];
                var cell = sourceColumn < row.Cells.Count
                    ? row.Cells[sourceColumn]
                    : new AssistPreviewCell("", false);
                var cellRect = new Rect(rowHeaderWidth + ColumnOffset(column), y, columnWidths[column], rowHeight);
                if (cell.Cited) context.DrawRectangle(Palette.CitedFill, null, cellRect);
                Draw(context, cell.Value, cellRect.X + 6, cellRect.Y + 5, cellRect.Width - 12,
                    FluentPalette.CaptionSize, Palette.TextPrimary, strong: cell.Cited,
                    alignment: column == 0 ? TextAlignment.Left : TextAlignment.Right);
            }
            if (citedColumns.Count > 0)
            {
                var outlined = citedColumns[^1];
                citedOutlines.Add(new Rect(
                    rowHeaderWidth + ColumnOffset(outlined), y, columnWidths[outlined], rowHeight));
            }
        }

        // Grid lines.
        var grid = new Pen(Palette.Divider, 1);
        for (var column = 0; column <= count; column++)
        {
            var x = Snap(rowHeaderWidth + ColumnOffset(column));
            context.DrawLine(grid, new Point(x, 0), new Point(x, area.Height));
        }
        for (var row = 0; row <= rows.Count; row++)
        {
            var y = Snap(headerHeight + rowHeight * row);
            if (y > area.Height) break;
            context.DrawLine(grid, new Point(0, y), new Point(area.Width, y));
        }

        var citedPen = new Pen(Palette.CitedStroke, 1.2);
        foreach (var outline in citedOutlines)
        {
            context.DrawRectangle(null, citedPen, Inset(outline, 0.6));
        }

        context.Pop();
    }

    private static double Snap(double value) => Math.Round(value) + 0.5;

    private static Rect Inset(Rect rect, double amount) => new(
        rect.X + amount, rect.Y + amount,
        Math.Max(0, rect.Width - amount * 2), Math.Max(0, rect.Height - amount * 2));
}

/// A plan view of the real projected geometry behind a model-backed suggestion.
/// Context elements are quiet; the cited product carries the accent.
internal sealed class ModelPlanView : PreviewSurface
{
    private AssistModelPreview? _model;

    public AssistModelPreview? Model
    {
        get => _model;
        set
        {
            _model = value;
            InvalidateVisual();
        }
    }

    protected override void OnRender(DrawingContext context)
    {
        var model = _model;
        if (model is null) return;

        var area = new Rect(0, 0, ActualWidth, ActualHeight);
        var rounded = new RectangleGeometry(area, FluentPalette.ControlRadius, FluentPalette.ControlRadius);
        context.DrawGeometry(Palette.CardBackground, new Pen(Palette.ControlBorder, 1), rounded);
        context.PushClip(rounded);

        var title = model.SelectedLabel.Length > 0 ? model.SelectedLabel : "Model plan";
        Draw(context, title, 10, 7, area.Width - 20, FluentPalette.CaptionSize,
            Palette.TextPrimary, strong: true);

        var viewport = new HostRect(1, 26, area.Width - 2, area.Height - 48);
        var transform = AssistModelTransform.Create(model.FocusBounds, viewport);
        if (transform is not null)
        {
            context.PushClip(new RectangleGeometry(
                new Rect(viewport.X, viewport.Y, viewport.Width, viewport.Height)));
            // Context first, then the exact selected product on top.
            foreach (var selected in new[] { false, true })
            {
                foreach (var element in model.Elements.Where(item => item.Selected == selected))
                {
                    var geometry = BuildGeometry(transform, element);
                    var strokeBrush = selected ? Palette.Accent : Palette.TextTertiary;
                    var fillAlpha = selected ? 0.24 : element.Role == "space" ? 0.035 : 0.10;
                    var fill = Fade(strokeBrush, fillAlpha);
                    var pen = new Pen(Fade(strokeBrush, selected ? 0.95 : 0.32), selected ? 1.7 : 0.65)
                    {
                        LineJoin = PenLineJoin.Round,
                    };
                    context.DrawGeometry(fill, pen, geometry);
                }
            }
            context.Pop();
        }

        var caption = model.Warnings.Count > 0
            ? model.Warnings[0]
            : string.Join(" - ", new[] { model.StoreyLabel, "Plan view" }.Where(part => part.Length > 0));
        Draw(context, caption, 10, area.Height - 19, area.Width - 20,
            FluentPalette.CaptionSize - 1, Palette.TextSecondary);

        context.Pop();
    }

    /// Even-odd so an opening in a wall stays a hole.
    private static Geometry BuildGeometry(AssistModelTransform transform, AssistModelElement element)
    {
        var geometry = new StreamGeometry { FillRule = FillRule.EvenOdd };
        using (var writer = geometry.Open())
        {
            foreach (var ring in transform.Rings(element))
            {
                if (ring.Count < 3) continue;
                writer.BeginFigure(new Point(ring[0].X, ring[0].Y), isFilled: true, isClosed: true);
                writer.PolyLineTo(
                    ring.Skip(1).Select(point => new Point(point.X, point.Y)).ToList(),
                    isStroked: true, isSmoothJoin: false);
            }
        }
        geometry.Freeze();
        return geometry;
    }

    private static Brush Fade(Brush source, double opacity)
    {
        var color = source is SolidColorBrush solid ? solid.Color : Colors.Gray;
        var brush = new SolidColorBrush(Color.FromArgb((byte)(opacity * 255), color.R, color.G, color.B));
        brush.Freeze();
        return brush;
    }
}
