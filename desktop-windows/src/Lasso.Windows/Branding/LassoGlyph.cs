//  The Lasso mark, drawn rather than shipped as a bitmap.
//
//  The geometry is the same loop, rope, and knot as the product's own favicon,
//  so the tray icon, the window icon, and the suggestion panel's badge all show
//  one mark at whatever size and scale Windows asks for. Drawing it means a
//  125% or 200% display gets a crisp icon instead of a resampled 16-pixel one.

using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Branding;

public static class LassoGlyph
{
    /// The brand green, used for the tray and window icons.
    public static readonly Color BrandGreen = Color.FromRgb(0x29, 0xCC, 0x57);

    private const double DesignSize = 32;

    /// The mark on a 32x32 design grid, in the given colour.
    public static DrawingGroup Drawing(Color color)
    {
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        var pen = new Pen(brush, 2.8)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
        };
        pen.Freeze();

        // The loop: an ellipse tilted the same ten degrees as the brand mark.
        var loop = new EllipseGeometry(new Point(15, 12), 11, 7.5)
        {
            Transform = new RotateTransform(-10, 15, 12),
        };
        loop.Freeze();

        // The rope, falling away from the knot.
        var rope = new PathGeometry();
        var figure = new PathFigure { StartPoint = new Point(19.5, 18.6) };
        figure.Segments.Add(new BezierSegment(
            new Point(21.1, 21.8), new Point(24.1, 23.2), new Point(27.1, 28.0), true));
        rope.Figures.Add(figure);
        rope.Freeze();

        // The knot, where the rope meets the loop.
        var knot = new EllipseGeometry(new Point(19.3, 18.4), 2.4, 2.4);
        knot.Freeze();

        var group = new DrawingGroup();
        using (var context = group.Open())
        {
            context.DrawGeometry(null, pen, loop);
            context.DrawGeometry(null, pen, rope);
            context.DrawGeometry(brush, null, knot);
        }
        group.Freeze();
        return group;
    }

    /// The mark as an image source, for a WPF Window.Icon or an Image element.
    public static BitmapSource Image(int pixelSize, Color? color = null)
    {
        var drawing = Drawing(color ?? BrandGreen);
        var visual = new DrawingVisual();
        using (var context = visual.RenderOpen())
        {
            var scale = pixelSize / DesignSize;
            context.PushTransform(new ScaleTransform(scale, scale));
            context.DrawDrawing(drawing);
            context.Pop();
        }
        var bitmap = new RenderTargetBitmap(pixelSize, pixelSize, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return bitmap;
    }

    /// An icon handle for the tray, at the size this display asked for. The
    /// caller owns it and must destroy it.
    public static IntPtr CreateIcon(int pixelSize, Color? color = null)
    {
        var bitmap = Image(pixelSize, color);
        var stride = pixelSize * 4;
        var pixels = new byte[stride * pixelSize];
        bitmap.CopyPixels(pixels, stride, 0);

        // A 32-bit colour bitmap carries the alpha; the mask is required by
        // CreateIconIndirect but is left empty so the alpha channel decides.
        var color32 = NativeMethods.CreateBitmap(pixelSize, pixelSize, 1, 32, pixels);
        var mask = NativeMethods.CreateBitmap(pixelSize, pixelSize, 1, 1,
            new byte[((pixelSize + 31) / 32) * 4 * pixelSize]);
        try
        {
            if (color32 == IntPtr.Zero || mask == IntPtr.Zero) return IntPtr.Zero;
            var info = new NativeMethods.ICONINFO
            {
                fIcon = true,
                xHotspot = 0,
                yHotspot = 0,
                hbmMask = mask,
                hbmColor = color32,
            };
            return NativeMethods.CreateIconIndirect(ref info);
        }
        finally
        {
            if (color32 != IntPtr.Zero) NativeMethods.DeleteObject(color32);
            if (mask != IntPtr.Zero) NativeMethods.DeleteObject(mask);
        }
    }

    /// The mark as an .ico byte stream, for writing a file Windows Explorer and
    /// the taskbar can read.
    public static byte[] IconFile(params int[] sizes)
    {
        if (sizes.Length == 0) sizes = [16, 20, 24, 32, 48, 64, 128, 256];
        var frames = new List<byte[]>();
        foreach (var size in sizes)
        {
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(Image(size)));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            frames.Add(stream.ToArray());
        }

        using var file = new MemoryStream();
        using var writer = new BinaryWriter(file);
        writer.Write((ushort)0);                 // reserved
        writer.Write((ushort)1);                 // type: icon
        writer.Write((ushort)sizes.Length);
        var offset = 6 + 16 * sizes.Length;
        for (var index = 0; index < sizes.Length; index++)
        {
            var size = sizes[index];
            writer.Write((byte)(size >= 256 ? 0 : size));
            writer.Write((byte)(size >= 256 ? 0 : size));
            writer.Write((byte)0);               // palette
            writer.Write((byte)0);               // reserved
            writer.Write((ushort)1);             // colour planes
            writer.Write((ushort)32);            // bits per pixel
            writer.Write(frames[index].Length);
            writer.Write(offset);
            offset += frames[index].Length;
        }
        foreach (var frame in frames) writer.Write(frame);
        writer.Flush();
        return file.ToArray();
    }
}
