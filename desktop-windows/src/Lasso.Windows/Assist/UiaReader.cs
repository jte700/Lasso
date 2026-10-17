//  Reading the caret and its surrounding text out of whatever application has
//  focus.
//
//  This is the Windows counterpart of the macOS Accessibility reader. The shape
//  is the same: ask the focused element for the span of text just before the
//  caret, find out where the caret is on screen, and refuse to answer rather
//  than guess. Only the mechanism differs.
//
//  Nothing is captured or stored: the text window is sent only to 127.0.0.1 and
//  discarded. Password fields and Lasso's own windows are never read.
//
//  Two routes, tried in order:
//
//    1. UI Automation's text pattern. The general case, and the only route that
//       works for a browser, Word, Electron, or anything that draws its own
//       text. Offsets come from moving a range endpoint, because UI Automation
//       deliberately exposes no integer positions.
//    2. A legacy Win32 edit control, which answers EM_GETSEL with an integer
//       caret and WM_GETTEXT with its value.
//
//  Every call is bounded by a timeout. A host that stops answering is treated
//  as unreadable, never waited on, because this runs between keystrokes.

using System.Diagnostics;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using Lasso.Core;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

public static class UiaReader
{
    /// How much text before the caret is read, matching the macOS build.
    private const int MaxContext = 1200;
    /// Ceiling on a whole-document read, for the highlighter.
    private const int MaxDocument = 400_000;
    /// How far back the reader is willing to count characters to learn the
    /// caret's absolute offset. Beyond this the host is treated as having no
    /// addressable positions rather than being walked indefinitely.
    private const int AbsoluteProbe = 2_000_000;

    private static readonly TimeSpan CallTimeout = TimeSpan.FromMilliseconds(400);
    private static readonly int OwnProcessId = Environment.ProcessId;
    private static readonly HashSet<string> Described = [];

    /// Runs a UI Automation call with a deadline. The managed client blocks on a
    /// cross-process call, so an unresponsive host would otherwise stall typing.
    private static bool Try<T>(Func<T> work, out T? result)
    {
        result = default;
        try
        {
            var task = Task.Run(work);
            if (!task.Wait(CallTimeout)) return false;
            result = task.Result;
            return true;
        }
        catch (Exception)
        {
            // ElementNotAvailable, COM failures, a host that closed mid-read.
            return false;
        }
    }

    private static T? Read<T>(Func<T> work) => Try(work, out var value) ? value : default;

    public static CaretContext? FocusedContext()
    {
        var element = Read(() => AutomationElement.FocusedElement);
        if (element is null)
        {
            AssistLog.Write("no focused element");
            return null;
        }

        var identity = Read(() => Describe(element));
        if (identity is null) return null;

        if (identity.ProcessId == OwnProcessId) return null;          // never Lasso itself
        if (identity.IsPassword)
        {
            AssistLog.Write($"{identity.Application}: secure field, skipped");
            return null;
        }

        var reading = Read(() => ReadThroughTextPattern(element, identity))
            ?? Read(() => ReadThroughLegacyEdit(element, identity));

        if (reading is null)
        {
            AssistLog.Write($"{identity.Application} role={identity.Role}: no readable text");
            DescribeUnreadable(element, identity);
            return null;
        }

        var route = reading.Route;
        var rect = reading.CaretRect;
        if (rect is null)
        {
            // The window manager's own caret, then the control's frame, so the
            // panel still lands on the text rather than under the pointer.
            rect = LegacyCaret.FromGuiThread(identity.WindowHandle);
            if (rect is not null) route += "+guiCaret";
        }
        if (rect is null)
        {
            rect = identity.Bounds;
            if (rect is not null) route += "+controlFrame";
        }

        AssistLog.Write(
            $"{identity.Application} role={identity.Role} via={route} "
            + $"caret={reading.AbsoluteCaret} chars={reading.Text.Length} "
            + $"rect={(rect is { } box ? $"{(int)box.MinX},{(int)box.MinY}" : "none")}");

        return new CaretContext(
            Text: reading.Text,
            Cursor: reading.Text.Length,
            WindowStart: reading.WindowStart,
            AbsoluteCaret: reading.AbsoluteCaret,
            CaretRect: rect,
            Element: element,
            RuntimeId: identity.RuntimeId,
            WindowHandle: identity.WindowHandle,
            ProcessId: identity.ProcessId,
            Diagnosis: $"{identity.Application}/{identity.Role}",
            Application: identity.Application,
            DocumentContext: identity.DocumentContext);
    }

    // MARK: - Routes

    private sealed record Reading(string Text, int WindowStart, int AbsoluteCaret,
        HostRect? CaretRect, string Route);

    /// The general route. A degenerate range at the caret is cloned, its start
    /// walked back up to 1,200 characters, and its end pinned to the caret.
    private static Reading? ReadThroughTextPattern(AutomationElement element, HostIdentity identity)
    {
        if (element.GetCurrentPattern(TextPattern.Pattern) is not TextPattern pattern) return null;

        var selection = pattern.GetSelection();
        if (selection is null || selection.Length == 0) return null;
        // A live selection counts from its start, which is where an insertion
        // would land, matching the macOS reader's use of the selection origin.
        var caret = selection[0].Clone();
        caret.MoveEndpointByRange(TextPatternRangeEndpoint.End, caret, TextPatternRangeEndpoint.Start);

        var window = caret.Clone();
        window.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -MaxContext);
        window.MoveEndpointByRange(TextPatternRangeEndpoint.End, caret, TextPatternRangeEndpoint.Start);
        var text = window.GetText(MaxContext) ?? "";
        if (text.Length == 0) return null;

        var absoluteCaret = AbsoluteCaretOffset(caret);
        var windowStart = absoluteCaret >= 0 ? absoluteCaret - text.Length : -1;

        return new Reading(text, windowStart, absoluteCaret, CaretRectangle(caret), "textPattern");
    }

    /// How many characters sit between the start of the document and the caret.
    ///
    /// UI Automation exposes no integer offsets, so the distance is measured by
    /// asking a cloned range to walk its start endpoint back as far as it can:
    /// the number of units it actually moved is the answer, in one call rather
    /// than by materializing the whole document.
    private static int AbsoluteCaretOffset(TextPatternRange caret)
    {
        try
        {
            var probe = caret.Clone();
            var moved = probe.MoveEndpointByUnit(
                TextPatternRangeEndpoint.Start, TextUnit.Character, -AbsoluteProbe);
            var distance = Math.Abs(moved);
            // Hitting the limit means the document is larger than we are willing
            // to count; the caret is then not addressable and an insertion will
            // be verified against the window alone.
            return distance >= AbsoluteProbe ? -1 : distance;
        }
        catch (Exception)
        {
            return -1;
        }
    }

    /// The insertion point's screen rectangle. A degenerate range often has no
    /// rectangle of its own, so the preceding character is measured instead —
    /// the same fallback the macOS reader uses.
    private static HostRect? CaretRectangle(TextPatternRange caret)
    {
        HostRect? FirstUsable(TextPatternRange range)
        {
            try
            {
                var rectangles = range.GetBoundingRectangles();
                if (rectangles is null) return null;
                foreach (var rectangle in rectangles)
                {
                    var candidate = new HostRect(rectangle.X, rectangle.Y,
                        Math.Max(1, rectangle.Width), rectangle.Height);
                    if (HostGeometryConverter.IsUsable(candidate)) return candidate;
                }
            }
            catch (Exception)
            {
                // The host declined to measure this range.
            }
            return null;
        }

        if (FirstUsable(caret) is { } atCaret) return atCaret;

        try
        {
            var preceding = caret.Clone();
            if (preceding.MoveEndpointByUnit(
                    TextPatternRangeEndpoint.Start, TextUnit.Character, -1) != 0)
            {
                // The box belongs after that character, not over it.
                if (FirstUsable(preceding) is { } previous)
                {
                    return new HostRect(previous.MaxX, previous.MinY, 1, previous.Height);
                }
            }
        }
        catch (Exception)
        {
            // Nothing measurable here.
        }
        return null;
    }

    /// A plain edit control: an integer caret from EM_GETSEL and its value from
    /// WM_GETTEXT. Only used when the host publishes no text pattern.
    private static Reading? ReadThroughLegacyEdit(AutomationElement element, HostIdentity identity)
    {
        if (identity.WindowHandle == IntPtr.Zero) return null;
        if (!identity.ClassName.Contains("Edit", StringComparison.OrdinalIgnoreCase)) return null;

        var packed = (long)NativeMethods.SendMessage(
            identity.WindowHandle, NativeMethods.EM_GETSEL, IntPtr.Zero, IntPtr.Zero);
        var caret = (int)(packed & 0xFFFF);

        var length = (int)NativeMethods.SendMessage(
            identity.WindowHandle, NativeMethods.WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
        if (length <= 0 || length > MaxDocument) return null;

        var buffer = new char[length + 1];
        var copied = (int)NativeMethods.SendMessageText(
            identity.WindowHandle, NativeMethods.WM_GETTEXT, new IntPtr(buffer.Length), buffer);
        if (copied <= 0) return null;

        var value = new string(buffer, 0, Math.Min(copied, length));
        if (caret > value.Length) return null;
        var start = Math.Max(0, caret - MaxContext);
        var text = value[start..caret];
        if (text.Length == 0) return null;

        return new Reading(text, start, caret, null, "legacyEdit");
    }

    // MARK: - Identity

    private sealed record HostIdentity(
        string Application, string Role, string ClassName, string AutomationId,
        string WindowTitle, int ProcessId, IntPtr WindowHandle, int[] RuntimeId,
        bool IsPassword, HostRect? Bounds)
    {
        /// Stable within one document or compose surface; changes when the user
        /// moves to another. The counterpart of the macOS reader's DOM
        /// identifier plus window title.
        public string DocumentContext
        {
            get
            {
                var parts = new List<string>();
                if (AutomationId.Length > 0) parts.Add(AutomationId);
                if (WindowTitle.Length > 0) parts.Add(WindowTitle);
                if (Role.Length > 0) parts.Add(Role);
                return string.Join("|", parts);
            }
        }
    }

    private static HostIdentity Describe(AutomationElement element)
    {
        var current = element.Current;
        var processId = current.ProcessId;
        var handle = new IntPtr(current.NativeWindowHandle);
        var top = handle != IntPtr.Zero ? handle : NativeMethods.GetForegroundWindow();

        var bounds = current.BoundingRectangle;
        HostRect? frame = bounds.IsEmpty || double.IsInfinity(bounds.Width)
            ? null
            : new HostRect(bounds.X, bounds.Y, bounds.Width, bounds.Height);

        return new HostIdentity(
            Application: ApplicationName(processId),
            Role: current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
            ClassName: current.ClassName ?? "",
            AutomationId: current.AutomationId ?? "",
            WindowTitle: WindowTitle(top),
            ProcessId: processId,
            WindowHandle: top,
            RuntimeId: element.GetRuntimeId() ?? [],
            IsPassword: current.IsPassword,
            Bounds: frame);
    }

    private static string ApplicationName(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return process.ProcessName;
        }
        catch (Exception)
        {
            return "?";
        }
    }

    private static string WindowTitle(IntPtr window)
    {
        if (window == IntPtr.Zero) return "";
        var buffer = new char[512];
        var length = NativeMethods.GetWindowText(window, buffer, buffer.Length);
        return length > 0 ? new string(buffer, 0, length) : "";
    }

    /// Logged once per application and control: exactly which patterns the
    /// focused element offers. This is what turns "it does not work here" into
    /// a fix.
    private static void DescribeUnreadable(AutomationElement element, HostIdentity identity)
    {
        var key = $"{identity.Application}/{identity.Role}";
        lock (Described)
        {
            if (!Described.Add(key)) return;
        }
        var patterns = Read(() => element.GetSupportedPatterns()
            .Select(pattern => pattern.ProgrammaticName.Replace("PatternIdentifiers.Pattern", ""))
            .OrderBy(name => name)
            .ToArray()) ?? [];
        AssistLog.Write($"  patterns[{key}]: {string.Join(", ", patterns)}");
        AssistLog.Write($"  class[{key}]: {identity.ClassName} automationId={identity.AutomationId}");
    }

    /// The focused editing surface, without reading any text. The highlighter
    /// needs to know which document it is looking at even when the caret has
    /// nothing before it.
    public static HostSurface? FocusedSurface()
    {
        var element = Read(() => AutomationElement.FocusedElement);
        if (element is null) return null;
        var identity = Read(() => Describe(element));
        if (identity is null || identity.ProcessId == OwnProcessId || identity.IsPassword) return null;
        return new HostSurface(element, identity.Application, identity.DocumentContext,
            identity.WindowHandle, identity.ProcessId);
    }

    // MARK: - Reads used after an insertion

    /// The whole text of an element, for verifying an edit and for relocating
    /// highlights.
    public static string? WholeText(AutomationElement element) => Read(() =>
    {
        if (element.GetCurrentPattern(TextPattern.Pattern) is TextPattern pattern)
        {
            return pattern.DocumentRange.GetText(MaxDocument);
        }
        if (element.GetCurrentPattern(ValuePattern.Pattern) is ValuePattern value)
        {
            return value.Current.Value;
        }
        return null;
    });

    /// Caret rectangle alone, without pulling any text. Cheap enough to run
    /// between keystrokes, which is what keeps the panel pinned to the caret.
    public static HostRect? CaretRectOf(AutomationElement element, IntPtr window)
    {
        var measured = Read(() =>
        {
            if (element.GetCurrentPattern(TextPattern.Pattern) is not TextPattern pattern) return null;
            var selection = pattern.GetSelection();
            if (selection is null || selection.Length == 0) return null;
            var caret = selection[0].Clone();
            caret.MoveEndpointByRange(TextPatternRangeEndpoint.End, caret, TextPatternRangeEndpoint.Start);
            return CaretRectangle(caret);
        });
        return measured ?? LegacyCaret.FromGuiThread(window);
    }

    /// Screen rectangles covering a document range, one per line. Empty when
    /// the host cannot measure it, which keeps a highlight from being drawn in
    /// the wrong place.
    public static List<HostRect> RectanglesFor(AutomationElement element, UnitRange range)
    {
        return Read(() =>
        {
            var found = new List<HostRect>();
            if (element.GetCurrentPattern(TextPattern.Pattern) is not TextPattern pattern) return found;
            var span = pattern.DocumentRange.Clone();
            // Walk the start forward to the range, then pull the end back to it.
            if (range.Start > 0)
            {
                var moved = span.MoveEndpointByUnit(
                    TextPatternRangeEndpoint.Start, TextUnit.Character, range.Start);
                if (moved != range.Start) return found;
            }
            span.MoveEndpointByRange(TextPatternRangeEndpoint.End, span, TextPatternRangeEndpoint.Start);
            if (span.MoveEndpointByUnit(
                    TextPatternRangeEndpoint.End, TextUnit.Character, range.Count) != range.Count)
            {
                return found;
            }
            foreach (var rectangle in span.GetBoundingRectangles() ?? [])
            {
                var candidate = new HostRect(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height);
                if (HostGeometryConverter.IsUsable(candidate)) found.Add(candidate);
            }
            return found;
        }) ?? [];
    }

    // MARK: - Insertion

    /// Replaces the characters the user typed towards the suggestion with the
    /// suggestion itself.
    ///
    /// UI Automation is deliberately read-only for text, so unlike macOS there
    /// is no native write to attempt first: the edit is typed. Typing is also
    /// the path the macOS build falls back to in most applications, and the
    /// result is read back and confirmed either way — a host that swallowed the
    /// keystrokes must never leave a dependency recorded behind it.
    public static void Replace(int length, string text, AutomationElement element,
        Action<bool> completion)
    {
        Task.Run(() =>
        {
            AssistLog.Write($"insert: typing (replacing {length} char(s))");
            SyntheticKeyboard.DeleteBackwards(length);
            SyntheticKeyboard.Type(text);
            // Give the host a moment to apply the keystrokes before judging it.
            Thread.Sleep(140);
            var landed = Landed(text, element);
            AssistLog.Write($"insert: typed result {(landed ? "confirmed" : "not detected")}");
            completion(landed);
        });
    }

    /// True when the text now sits immediately before the caret. Merely finding
    /// the same value elsewhere in the window is not evidence.
    public static bool Landed(string text, AutomationElement element)
    {
        var needle = text.Trim();
        if (needle.Length == 0) return false;
        var context = FocusedContext();
        if (context is null || !SameElement(context.Element, element)) return false;
        return CompletionTransaction.InsertionIsAtCaret(needle, context.Text);
    }

    /// Runtime identity, not geometry: another window can put a caret at the
    /// same coordinates.
    public static bool SameElement(AutomationElement left, AutomationElement right)
    {
        try
        {
            return Automation.Compare(left, right);
        }
        catch (Exception)
        {
            return false;
        }
    }
}

/// The focused surface, identified well enough that a highlight can never be
/// drawn over an unrelated window or document.
public sealed record HostSurface(
    System.Windows.Automation.AutomationElement Element,
    string Application,
    string DocumentContext,
    IntPtr WindowHandle,
    int ProcessId);
