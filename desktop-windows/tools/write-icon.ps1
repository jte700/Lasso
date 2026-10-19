# Draws the Lasso mark to a multi-resolution .ico for the executable.
#
# The same loop, rope, and knot the application draws at runtime, and the same
# geometry as the product's favicon, rendered here at build time because an
# executable's icon has to exist before the compiler runs.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputPath,
    [int[]]$Sizes = @(16, 20, 24, 32, 48, 64, 128, 256)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase

$brand = [System.Windows.Media.Color]::FromRgb(0x29, 0xCC, 0x57)
$brush = New-Object System.Windows.Media.SolidColorBrush $brand
$brush.Freeze()
$pen = New-Object System.Windows.Media.Pen $brush, 2.8
$pen.StartLineCap = [System.Windows.Media.PenLineCap]::Round
$pen.EndLineCap = [System.Windows.Media.PenLineCap]::Round
$pen.Freeze()

function New-Mark {
    # The loop, tilted ten degrees.
    $loop = New-Object System.Windows.Media.EllipseGeometry (New-Object System.Windows.Point 15, 12), 11, 7.5
    $loop.Transform = New-Object System.Windows.Media.RotateTransform -10, 15, 12

    # The rope, falling away from the knot.
    $rope = New-Object System.Windows.Media.PathGeometry
    $figure = New-Object System.Windows.Media.PathFigure
    $figure.StartPoint = New-Object System.Windows.Point 19.5, 18.6
    $segment = New-Object System.Windows.Media.BezierSegment (
        (New-Object System.Windows.Point 21.1, 21.8),
        (New-Object System.Windows.Point 24.1, 23.2),
        (New-Object System.Windows.Point 27.1, 28.0), $true)
    $figure.Segments.Add($segment) | Out-Null
    $rope.Figures.Add($figure) | Out-Null

    # The knot, where the rope meets the loop.
    $knot = New-Object System.Windows.Media.EllipseGeometry (New-Object System.Windows.Point 19.3, 18.4), 2.4, 2.4

    $group = New-Object System.Windows.Media.DrawingGroup
    $context = $group.Open()
    $context.DrawGeometry($null, $pen, $loop)
    $context.DrawGeometry($null, $pen, $rope)
    $context.DrawGeometry($brush, $null, $knot)
    $context.Close()
    $group.Freeze()
    return $group
}

$mark = New-Mark
$frames = @()
foreach ($size in $Sizes) {
    $visual = New-Object System.Windows.Media.DrawingVisual
    $context = $visual.RenderOpen()
    $scale = $size / 32.0
    $context.PushTransform((New-Object System.Windows.Media.ScaleTransform $scale, $scale))
    $context.DrawDrawing($mark)
    $context.Pop()
    $context.Close()

    $bitmap = New-Object System.Windows.Media.Imaging.RenderTargetBitmap (
        $size, $size, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $bitmap.Freeze()

    $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap)) | Out-Null
    $stream = New-Object System.IO.MemoryStream
    $encoder.Save($stream)
    $frames += , $stream.ToArray()
    $stream.Dispose()
}

# ICO container: a header, one directory entry per size, then the PNG frames.
$output = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $output
$writer.Write([uint16]0)                 # reserved
$writer.Write([uint16]1)                 # type: icon
$writer.Write([uint16]$Sizes.Length)
$offset = 6 + 16 * $Sizes.Length
for ($index = 0; $index -lt $Sizes.Length; $index++) {
    $size = $Sizes[$index]
    $dimension = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)               # palette
    $writer.Write([byte]0)               # reserved
    $writer.Write([uint16]1)             # colour planes
    $writer.Write([uint16]32)            # bits per pixel
    $writer.Write([int]$frames[$index].Length)
    $writer.Write([int]$offset)
    $offset += $frames[$index].Length
}
foreach ($frame in $frames) { $writer.Write($frame) }
$writer.Flush()

$directory = Split-Path -Parent $OutputPath
if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
[System.IO.File]::WriteAllBytes($OutputPath, $output.ToArray())
$writer.Dispose()
$output.Dispose()
Write-Host "    icon: $OutputPath ($([math]::Round((Get-Item $OutputPath).Length / 1KB, 1)) KB)"
