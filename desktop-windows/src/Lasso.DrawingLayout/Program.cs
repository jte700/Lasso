//  Windows drawing-layout extraction.
//
//  The counterpart of scripts/extract-drawing-layout.swift, emitting byte-for-byte
//  the same JSON shape so src/dependencies/drawing-extraction.js parses either
//  one without knowing which platform produced it:
//
//      { pageCount, warnings: [...], pages: [
//          { pageNumber, width, height, rotation, text,
//            words: [ { text, bbox: { x, y, width, height } } ] } ] }
//
//  Bounding boxes are normalized to the crop box and measured from the top-left,
//  because that is the convention the indexer already works in.
//
//  This helper extracts existing selectable text only. A scan must be OCR'd
//  before it can provide trustworthy dimensions; nothing is ever guessed from
//  line geometry.

using System.Text.Json;
using System.Text.Json.Nodes;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;

const int MaximumWordsPerPage = 25_000;
const int MaximumCharactersPerPage = 150_000;
const int MaximumCharacters = 1_500_000;

static int Finish(JsonObject payload, int exitCode = 0)
{
    Console.Out.Write(payload.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
    Console.Out.Flush();
    return exitCode;
}

static int Fail(string message) => Finish(new JsonObject { ["error"] = message }, 2);

if (args.Length < 1) return Fail("Missing PDF path");

var pageLimit = 80;
if (args.Length > 1 && int.TryParse(args[1], out var requested)) pageLimit = requested;
pageLimit = Math.Clamp(pageLimit, 1, 100);

PdfDocument document;
try
{
    document = PdfDocument.Open(args[0], new ParsingOptions { UseLenientParsing = true });
}
catch (Exception error)
{
    return Fail("This PDF could not be opened: " + error.Message);
}

var warnings = new JsonArray();
var pages = new JsonArray();
var remainingCharacters = MaximumCharacters;

using (document)
{
    var pageCount = document.NumberOfPages;
    for (var index = 1; index <= Math.Min(pageCount, pageLimit); index++)
    {
        Page page;
        try
        {
            page = document.GetPage(index);
        }
        catch (Exception)
        {
            // A page that cannot be parsed is skipped, not guessed at.
            continue;
        }

        var crop = page.CropBox.Bounds;
        var cropWidth = crop.Width;
        var cropHeight = crop.Height;
        if (cropWidth <= 0 || cropHeight <= 0) continue;

        var rotation = ((page.Rotation.Value % 360) + 360) % 360;
        var rotated = rotation is 90 or 270;

        var pageText = page.Text ?? "";
        var length = Math.Min(Math.Min(pageText.Length, MaximumCharactersPerPage), remainingCharacters);
        if (length < pageText.Length)
        {
            warnings.Add($"Text on page {index} exceeded the extraction limit.");
        }
        remainingCharacters -= length;
        var text = pageText[..Math.Max(0, length)];

        var words = new JsonArray();
        var wordCount = 0;
        foreach (var word in page.GetWords())
        {
            wordCount++;
            if (words.Count >= MaximumWordsPerPage) continue;
            if (string.IsNullOrWhiteSpace(word.Text)) continue;

            var box = TextBox(word);
            // Clip to the crop box; a word wholly outside it is not on the page.
            var left = Math.Max(Math.Min(box.Left, box.Right), crop.Left);
            var right = Math.Min(Math.Max(box.Left, box.Right), crop.Right);
            var bottom = Math.Max(Math.Min(box.Bottom, box.Top), crop.Bottom);
            var top = Math.Min(Math.Max(box.Bottom, box.Top), crop.Top);
            if (right <= left || top <= bottom) continue;

            // Normalize, then apply the page rotation, ending top-left based.
            var corners = new[]
            {
                Normalize(left, bottom, crop.Left, crop.Bottom, cropWidth, cropHeight, rotation),
                Normalize(right, top, crop.Left, crop.Bottom, cropWidth, cropHeight, rotation),
            };
            var x = Math.Min(corners[0].X, corners[1].X);
            var y = Math.Min(corners[0].Y, corners[1].Y);
            var width = Math.Abs(corners[1].X - corners[0].X);
            var height = Math.Abs(corners[1].Y - corners[0].Y);
            if (width <= 0 || height <= 0) continue;

            words.Add(new JsonObject
            {
                ["text"] = word.Text,
                ["bbox"] = new JsonObject
                {
                    ["x"] = Rounded(x),
                    ["y"] = Rounded(y),
                    ["width"] = Rounded(width),
                    ["height"] = Rounded(height),
                },
            });
        }
        if (wordCount > MaximumWordsPerPage)
        {
            warnings.Add($"Words on page {index} exceeded the extraction limit.");
        }

        pages.Add(new JsonObject
        {
            ["pageNumber"] = index,
            ["width"] = rotated ? cropHeight : cropWidth,
            ["height"] = rotated ? cropWidth : cropHeight,
            ["rotation"] = rotation,
            ["text"] = text,
            ["words"] = words,
        });

        if (remainingCharacters <= 0)
        {
            warnings.Add("Document text exceeded the extraction limit.");
            break;
        }
    }

    if (pageCount > pageLimit)
    {
        warnings.Add($"Only the first {pageLimit} of {pageCount} pages were indexed.");
    }

    return Finish(new JsonObject
    {
        ["pageCount"] = pageCount,
        ["pages"] = pages,
        ["warnings"] = warnings,
    });
}

/// A word's box as a text selection would report it, not as its ink covers it.
///
/// PDFKit measures a selection, so its rectangles span the line's height
/// including ascender and descender space. A glyph's ink box is shorter and
/// varies with which letters a word happens to contain — "sf" would measure
/// half the height of "SF". The indexer compares vertical gaps against these
/// heights when deciding whether a label belongs to a measurement, so the em
/// box is reconstructed from each letter's baseline and point size to keep that
/// judgement the same on both platforms.
static (double Left, double Right, double Bottom, double Top) TextBox(Word word)
{
    var ink = word.BoundingBox;
    var left = Math.Min(ink.Left, ink.Right);
    var right = Math.Max(ink.Left, ink.Right);
    double? bottom = null;
    double? top = null;

    foreach (var letter in word.Letters)
    {
        var size = letter.PointSize;
        if (double.IsNaN(size) || size <= 0)
        {
            size = Math.Abs(letter.GlyphRectangle.Height);
            if (size <= 0) continue;
        }
        var baseline = letter.StartBaseLine.Y;
        // Typical Latin metrics: the descender sits a fifth below the baseline
        // and the ascender four fifths above it.
        var letterBottom = baseline - size * 0.2;
        var letterTop = baseline + size * 0.8;
        bottom = bottom is { } currentBottom ? Math.Min(currentBottom, letterBottom) : letterBottom;
        top = top is { } currentTop ? Math.Max(currentTop, letterTop) : letterTop;
    }

    // No usable metrics: fall back to the ink box rather than inventing one.
    return (left, right,
        bottom ?? Math.Min(ink.Bottom, ink.Top),
        top ?? Math.Max(ink.Bottom, ink.Top));
}

static (double X, double Y) Normalize(double pointX, double pointY, double cropLeft, double cropBottom,
    double cropWidth, double cropHeight, int rotation)
{
    var x = (pointX - cropLeft) / cropWidth;
    var y = (pointY - cropBottom) / cropHeight;
    return rotation switch
    {
        90 => (y, x),
        180 => (1 - x, y),
        270 => (1 - y, 1 - x),
        _ => (x, 1 - y),
    };
}

static double Rounded(double value) => Math.Round(value * 1_000_000) / 1_000_000;
