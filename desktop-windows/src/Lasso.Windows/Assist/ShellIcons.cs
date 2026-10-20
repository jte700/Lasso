//  File-type icons, from the shell.
//
//  The macOS panel draws NSWorkspace's icon for a file's type, so a spreadsheet
//  row looks like a spreadsheet. Windows keeps the same association in the
//  shell: asking it for the icon of a name with a given extension returns
//  whatever the user's own file associations would show in Explorer, including
//  the icon of the application they actually open that type with.

using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

public static class ShellIcons
{
    private static readonly Dictionary<string, ImageSource?> Cache = new(StringComparer.OrdinalIgnoreCase);
    private static readonly object Gate = new();

    /// The shell's icon for a path's type. The file itself need not exist: only
    /// its extension is consulted, which keeps this off the disk.
    public static ImageSource? ForPath(string path)
    {
        var extension = Path.GetExtension(path ?? "");
        if (string.IsNullOrWhiteSpace(extension)) extension = ".dat";

        lock (Gate)
        {
            if (Cache.TryGetValue(extension, out var cached)) return cached;
        }

        var icon = Load(extension);
        lock (Gate)
        {
            Cache[extension] = icon;
        }
        return icon;
    }

    private static ImageSource? Load(string extension)
    {
        var info = new NativeMethods.SHFILEINFO();
        var size = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.SHFILEINFO>();
        var result = NativeMethods.SHGetFileInfo(
            "source" + extension,
            NativeMethods.FILE_ATTRIBUTE_NORMAL,
            ref info,
            size,
            NativeMethods.SHGFI_ICON | NativeMethods.SHGFI_LARGEICON
                | NativeMethods.SHGFI_USEFILEATTRIBUTES);

        if (result == IntPtr.Zero || info.hIcon == IntPtr.Zero) return null;
        try
        {
            var image = Imaging.CreateBitmapSourceFromHIcon(
                info.hIcon, System.Windows.Int32Rect.Empty, null);
            image.Freeze();
            return image;
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            NativeMethods.DestroyIcon(info.hIcon);
        }
    }
}
