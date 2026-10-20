//  Where the suggestion panel goes.
//
//  Pure geometry, so the rules can be checked without a window. All values are
//  in the same units the window manager reports: physical screen pixels, with
//  the origin at the top-left.
//
//  The panel prefers to sit just below the caret with its leading edge there.
//  When it does not fit it flips, the way Windows flips a flyout: below becomes
//  above, and leading-aligned becomes trailing-aligned.
//
//  Flipping horizontally is not cosmetic. This panel is wide, so on a wide
//  display a caret anywhere past (workArea.Right - width) would otherwise
//  produce the same clamped position, and the panel would sit motionless while
//  the caret kept moving. macOS clamps in that situation and gets away with it
//  because the pointer it draws keeps sliding under the caret; this panel has
//  no pointer, by Windows convention, so it has to move itself.

namespace Lasso.Core;

public static class FlyoutPlacement
{
    /// The gap between the caret and the panel, in device-independent pixels.
    public const double DefaultGap = 6;

    public static HostRect Place(HostRect caret, double width, double height,
        HostRect workArea, double gap = DefaultGap)
    {
        var x = caret.MinX - gap;
        // Not enough room to the right: put the trailing edge at the caret.
        if (x + width > workArea.MaxX) x = caret.MaxX + gap - width;
        x = Clamp(x, workArea.MinX, workArea.MaxX - width);

        var y = caret.MaxY + gap;
        if (y + height > workArea.MaxY)
        {
            var above = caret.MinY - height - gap;
            y = above >= workArea.MinY ? above : workArea.MaxY - height;
        }
        y = Clamp(y, workArea.MinY, workArea.MaxY - height);

        return new HostRect(x, y, width, height);
    }

    /// A panel larger than the work area cannot satisfy both bounds; the
    /// leading edge wins, so its first rows stay on screen.
    private static double Clamp(double value, double low, double high) =>
        high < low ? low : Math.Max(low, Math.Min(value, high));
}
