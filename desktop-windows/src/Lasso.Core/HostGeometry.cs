//  Coordinate conversion and dependency geometry.
//
//  The macOS build has to reconcile two origins: the Accessibility API reports
//  rectangles from the top-left of the primary display while AppKit windows use
//  a bottom-left origin. Windows has no such split — UI Automation bounding
//  rectangles, Win32 screen coordinates, and WPF window coordinates all put the
//  origin at the top-left — so no vertical flip exists here, deliberately.
//  Porting one would offset every highlight by the height of the display.
//
//  What remains is the same as on macOS: deciding whether a rectangle is usable,
//  moving screen geometry into an overlay window's own space, and coalescing the
//  per-run rectangles a host reports for one phrase.

namespace Lasso.Core;

/// A rectangle in device-independent pixels, free of any UI framework so the
/// geometry rules can be tested without a window.
public readonly record struct HostRect(double X, double Y, double Width, double Height)
{
    public static readonly HostRect Empty = new(0, 0, 0, 0);

    public double MinX => X;
    public double MinY => Y;
    public double MaxX => X + Width;
    public double MaxY => Y + Height;
    public double MidX => X + Width / 2;
    public double MidY => Y + Height / 2;

    public static HostRect FromEdges(double left, double top, double right, double bottom) =>
        new(left, top, right - left, bottom - top);

    public HostRect InsetBy(double dx, double dy) =>
        new(X + dx, Y + dy, Width - dx * 2, Height - dy * 2);

    public HostRect OffsetBy(double dx, double dy) => new(X + dx, Y + dy, Width, Height);

    public HostRect Union(HostRect other) => FromEdges(
        Math.Min(MinX, other.MinX), Math.Min(MinY, other.MinY),
        Math.Max(MaxX, other.MaxX), Math.Max(MaxY, other.MaxY));

    public HostRect Intersection(HostRect other)
    {
        var left = Math.Max(MinX, other.MinX);
        var top = Math.Max(MinY, other.MinY);
        var right = Math.Min(MaxX, other.MaxX);
        var bottom = Math.Min(MaxY, other.MaxY);
        return right <= left || bottom <= top ? Empty : FromEdges(left, top, right, bottom);
    }

    public bool Intersects(HostRect other) =>
        other.MinX < MaxX && other.MaxX > MinX && other.MinY < MaxY && other.MaxY > MinY;

    public bool Contains(double x, double y) => x >= MinX && x < MaxX && y >= MinY && y < MaxY;

    public override string ToString() => $"({X},{Y} {Width}×{Height})";
}

public static class HostGeometryConverter
{
    /// Screen rectangle → a transparent overlay window's local space. The
    /// overlay's own origin has to come off first, exactly as on macOS.
    public static HostRect ToOverlayLocal(HostRect rect, HostRect overlayFrame) =>
        rect.OffsetBy(-overlayFrame.MinX, -overlayFrame.MinY);

    /// True when a rectangle carries usable geometry. The 400 unit ceiling
    /// rejects a host that answers with a whole-document or whole-pane box
    /// instead of a line, which would otherwise underline half the window.
    public static bool IsUsable(HostRect rect) =>
        double.IsFinite(rect.Width) && double.IsFinite(rect.Height)
        && double.IsFinite(rect.X) && double.IsFinite(rect.Y)
        && rect.Width > 0 && rect.Height > 0 && rect.Height < 400;
}

/// One dependency's drawn geometry. A wrapped phrase is several rectangles that
/// still resolve to a single reference when clicked.
public sealed record DependencyGeometry(string ReferenceId, IReadOnlyList<HostRect> Fragments)
{
    public HostRect Bounds => Fragments.Count == 0
        ? HostRect.Empty
        : Fragments.Skip(1).Aggregate(Fragments[0], (accumulated, next) => accumulated.Union(next));

    public bool Contains(double x, double y) =>
        Fragments.Any(fragment => fragment.InsetBy(-1, -2).Contains(x, y));

    /// Merges rectangles that sit on the same text line, which text providers
    /// often report per character run.
    public static DependencyGeometry Coalesce(IEnumerable<HostRect> rects, string referenceId)
    {
        var sorted = rects
            .Where(HostGeometryConverter.IsUsable)
            .OrderBy(rect => rect.MinY)
            .ThenBy(rect => rect.MinX)
            .ToList();
        var lines = new List<HostRect>();
        foreach (var rect in sorted)
        {
            if (lines.Count > 0
                && Math.Abs(lines[^1].MidY - rect.MidY) < Math.Max(2, rect.Height * 0.5))
            {
                lines[^1] = lines[^1].Union(rect);
            }
            else
            {
                lines.Add(rect);
            }
        }
        return new DependencyGeometry(referenceId, lines);
    }
}
