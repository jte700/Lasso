//  Windows 11 window composition.
//
//  macOS gets its look from NSVisualEffectView and, on macOS 26, the system
//  glass material. The Windows equivalents are DWM window attributes: Mica for
//  a long-lived window, acrylic for a transient surface such as a flyout, plus
//  the rounded corners and the dark-mode caption Windows 11 draws itself.
//
//  Every call is a best effort. On Windows 10 these attributes are simply not
//  supported, the calls fail harmlessly, and the window keeps the system's
//  ordinary appearance rather than a hand-painted substitute.

using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Interop;

public enum Backdrop
{
    None,
    /// For windows that stay open: the workspace.
    Mica,
    /// For surfaces that come and go: the suggestion panel, the inspector.
    Acrylic,
    MicaAlt,
}

public enum CornerStyle
{
    Default,
    None,
    Round,
    RoundSmall,
}

public static class WindowComposition
{
    public static IntPtr HandleOf(Window window) => new WindowInteropHelper(window).Handle;

    /// Mica and acrylic are drawn by the compositor behind the window, so the
    /// window itself has to stop painting its own background first.
    public static void Apply(Window window, Backdrop backdrop, CornerStyle corner = CornerStyle.Default,
        bool? darkCaption = null)
    {
        var handle = HandleOf(window);
        if (handle == IntPtr.Zero) return;

        if (backdrop != Backdrop.None)
        {
            window.Background = Brushes.Transparent;
            var margins = new NativeMethods.MARGINS { Left = -1, Right = -1, Top = -1, Bottom = -1 };
            NativeMethods.DwmExtendFrameIntoClientArea(handle, ref margins);
        }

        SetBackdrop(handle, backdrop);
        SetCorner(handle, corner);
        SetDarkCaption(handle, darkCaption ?? IsSystemDark());
    }

    public static void SetBackdrop(IntPtr handle, Backdrop backdrop)
    {
        var value = backdrop switch
        {
            Backdrop.Mica => NativeMethods.DWMSBT_MAINWINDOW,
            Backdrop.Acrylic => NativeMethods.DWMSBT_TRANSIENTWINDOW,
            Backdrop.MicaAlt => NativeMethods.DWMSBT_TABBEDWINDOW,
            _ => NativeMethods.DWMSBT_NONE,
        };
        NativeMethods.DwmSetWindowAttribute(handle, NativeMethods.DWMWA_SYSTEMBACKDROP_TYPE, ref value, sizeof(int));
    }

    public static void SetCorner(IntPtr handle, CornerStyle corner)
    {
        var value = corner switch
        {
            CornerStyle.None => NativeMethods.DWMWCP_DONOTROUND,
            CornerStyle.Round => NativeMethods.DWMWCP_ROUND,
            CornerStyle.RoundSmall => NativeMethods.DWMWCP_ROUNDSMALL,
            _ => NativeMethods.DWMWCP_DEFAULT,
        };
        NativeMethods.DwmSetWindowAttribute(handle, NativeMethods.DWMWA_WINDOW_CORNER_PREFERENCE, ref value, sizeof(int));
    }

    public static void SetDarkCaption(IntPtr handle, bool dark)
    {
        var value = dark ? 1 : 0;
        NativeMethods.DwmSetWindowAttribute(handle, NativeMethods.DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));
    }

    /// The user's app-mode preference, which is what Windows 11 itself follows
    /// for window chrome.
    public static bool IsSystemDark()
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
            return key?.GetValue("AppsUseLightTheme") is int light && light == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }

    /// The accent colour the user chose, which selection and focus rings use so
    /// the panel agrees with the rest of the system.
    public static Color AccentColor(Color fallback)
    {
        try
        {
            using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent");
            if (key?.GetValue("AccentColorMenu") is int packed)
            {
                // Stored as ABGR.
                var bytes = BitConverter.GetBytes(packed);
                return Color.FromRgb(bytes[0], bytes[1], bytes[2]);
            }
        }
        catch (Exception)
        {
            // Fall through to the supplied default.
        }
        return fallback;
    }
}
