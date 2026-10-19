//  The Windows 11 design values the suggestion panel is built from.
//
//  These are the platform's own published colours, type ramp, and geometry, not
//  an approximation of them: the panel has to read as something Windows itself
//  put on screen. They follow the user's light or dark app mode and their
//  accent colour, and they are re-read whenever the system theme changes.
//
//  References: Windows app design — colour, typography, and geometry.

using System.Windows;
using System.Windows.Media;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

public sealed class FluentPalette
{
    public static FluentPalette Current { get; private set; } = Build();

    /// Re-read after a WM_SETTINGCHANGE, so a theme switch is picked up without
    /// restarting.
    public static FluentPalette Refresh()
    {
        Current = Build();
        return Current;
    }

    public bool IsDark { get; private init; }

    // Surfaces
    public Brush FlyoutBackground { get; private init; } = Brushes.Transparent;
    public Brush LayerBackground { get; private init; } = Brushes.Transparent;
    public Brush CardBackground { get; private init; } = Brushes.Transparent;
    public Brush FlyoutBorder { get; private init; } = Brushes.Transparent;
    public Brush Divider { get; private init; } = Brushes.Transparent;
    public Brush SubtleHover { get; private init; } = Brushes.Transparent;
    public Brush ControlFill { get; private init; } = Brushes.Transparent;
    public Brush ControlBorder { get; private init; } = Brushes.Transparent;

    // Text
    public Brush TextPrimary { get; private init; } = Brushes.Black;
    public Brush TextSecondary { get; private init; } = Brushes.Gray;
    public Brush TextTertiary { get; private init; } = Brushes.Gray;

    // Accent and status
    public Color AccentColor { get; private init; }
    public Brush Accent { get; private init; } = Brushes.DodgerBlue;
    public Brush AccentSelectionFill { get; private init; } = Brushes.Transparent;
    public Brush AccentTextOnFill { get; private init; } = Brushes.White;
    public Brush CitedFill { get; private init; } = Brushes.Transparent;
    public Brush CitedStroke { get; private init; } = Brushes.Transparent;

    // Typography. Segoe UI Variable is the Windows 11 type family; Segoe UI is
    // the fallback on Windows 10, where the variable family is absent.
    public FontFamily BodyFont { get; } = new("Segoe UI Variable Text, Segoe UI");
    public FontFamily DisplayFont { get; } = new("Segoe UI Variable Display, Segoe UI");
    public FontFamily MonoFont { get; } = new("Cascadia Mono, Consolas");

    public const double CaptionSize = 12;
    public const double BodySize = 14;
    public const double BodyLargeSize = 16;

    // Geometry. Windows 11 uses an 8px radius for flyouts and menus, and 4px
    // for the controls inside them.
    public const double FlyoutRadius = 8;
    public const double ControlRadius = 4;

    private static FluentPalette Build()
    {
        var dark = WindowComposition.IsSystemDark();
        var accent = WindowComposition.AccentColor(Color.FromRgb(0x00, 0x78, 0xD4));

        static Brush Solid(byte r, byte g, byte b)
        {
            var brush = new SolidColorBrush(Color.FromRgb(r, g, b));
            brush.Freeze();
            return brush;
        }

        static Brush Alpha(byte a, byte r, byte g, byte b)
        {
            var brush = new SolidColorBrush(Color.FromArgb(a, r, g, b));
            brush.Freeze();
            return brush;
        }

        static Brush Tinted(Color color, byte alpha)
        {
            var brush = new SolidColorBrush(Color.FromArgb(alpha, color.R, color.G, color.B));
            brush.Freeze();
            return brush;
        }

        var accentBrush = new SolidColorBrush(accent);
        accentBrush.Freeze();

        return dark
            ? new FluentPalette
            {
                IsDark = true,
                // Acrylic supplies the material; this is the tint over it.
                FlyoutBackground = Alpha(0xB8, 0x20, 0x20, 0x20),
                LayerBackground = Alpha(0x0D, 0xFF, 0xFF, 0xFF),
                CardBackground = Alpha(0x0F, 0xFF, 0xFF, 0xFF),
                FlyoutBorder = Alpha(0x14, 0xFF, 0xFF, 0xFF),
                Divider = Alpha(0x16, 0xFF, 0xFF, 0xFF),
                SubtleHover = Alpha(0x0F, 0xFF, 0xFF, 0xFF),
                ControlFill = Alpha(0x12, 0xFF, 0xFF, 0xFF),
                ControlBorder = Alpha(0x18, 0xFF, 0xFF, 0xFF),
                TextPrimary = Solid(0xFF, 0xFF, 0xFF),
                TextSecondary = Alpha(0xC8, 0xFF, 0xFF, 0xFF),
                TextTertiary = Alpha(0x8B, 0xFF, 0xFF, 0xFF),
                AccentColor = accent,
                Accent = accentBrush,
                AccentSelectionFill = Tinted(accent, 0x30),
                AccentTextOnFill = Solid(0xFF, 0xFF, 0xFF),
                CitedFill = Alpha(0x24, 0x6C, 0xCB, 0x5F),
                CitedStroke = Alpha(0xA6, 0x6C, 0xCB, 0x5F),
            }
            : new FluentPalette
            {
                IsDark = false,
                FlyoutBackground = Alpha(0xC4, 0xF9, 0xF9, 0xF9),
                LayerBackground = Alpha(0x80, 0xFF, 0xFF, 0xFF),
                CardBackground = Alpha(0xB3, 0xFF, 0xFF, 0xFF),
                FlyoutBorder = Alpha(0x0F, 0x00, 0x00, 0x00),
                Divider = Alpha(0x14, 0x00, 0x00, 0x00),
                SubtleHover = Alpha(0x0A, 0x00, 0x00, 0x00),
                ControlFill = Alpha(0xB3, 0xFF, 0xFF, 0xFF),
                ControlBorder = Alpha(0x16, 0x00, 0x00, 0x00),
                TextPrimary = Alpha(0xE4, 0x00, 0x00, 0x00),
                TextSecondary = Alpha(0x9B, 0x00, 0x00, 0x00),
                TextTertiary = Alpha(0x72, 0x00, 0x00, 0x00),
                AccentColor = accent,
                Accent = accentBrush,
                AccentSelectionFill = Tinted(accent, 0x1F),
                AccentTextOnFill = Solid(0xFF, 0xFF, 0xFF),
                CitedFill = Alpha(0x1F, 0x0F, 0x7B, 0x33),
                CitedStroke = Alpha(0x8C, 0x0F, 0x7B, 0x33),
            };
    }

    public CornerRadius FlyoutCorner => new(FlyoutRadius);
    public CornerRadius ControlCorner => new(ControlRadius);
}
