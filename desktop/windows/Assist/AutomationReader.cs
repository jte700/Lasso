using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

namespace Lasso.Windows.Assist;

/// <summary>All UIA calls and live ranges stay on one background MTA thread.</summary>
internal sealed class AutomationReader : IDisposable
{
    internal const int ContextLimit = 1200;
    private const int TailLimit = 160;
    private readonly BlockingCollection<Action> work = new(2);
    private readonly Thread thread;
    private bool disposed;

    internal sealed record Snapshot(string Before, string After, Rect CaretBounds, IntPtr Foreground,
        int[] RuntimeId, AutomationElement Element, TextPatternRange Caret);

    internal AutomationReader()
    {
        thread = new Thread(() => { foreach (var action in work.GetConsumingEnumerable()) action(); })
        { IsBackground = true, Name = "Lasso UI Automation" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
    }

    private Task<T?> Run<T>(Func<T?> action, CancellationToken token) where T : class
    {
        var result = new TaskCompletionSource<T?>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (disposed || token.IsCancellationRequested) return Task.FromResult<T?>(null);
        var added = false;
        try
        {
            added = work.TryAdd(() =>
            {
                if (token.IsCancellationRequested) { result.TrySetResult(null); return; }
                try { result.TrySetResult(action()); }
                catch (Exception error) when (error is not OutOfMemoryException and not StackOverflowException)
                { result.TrySetResult(null); }
            });
        }
        catch (InvalidOperationException) { }
        if (!added) result.TrySetResult(null);
        return result.Task;
    }

    internal Task<Snapshot?> CaptureAsync(CancellationToken token) => Run(Read, token);
    internal Task<Snapshot?> CurrentAsync(Snapshot expected, CancellationToken token) => Run(() =>
    {
        var fresh = Read();
        return fresh != null && Same(expected, fresh) ? fresh : null;
    }, token);

    internal Task<Snapshot?> InsertAsync(Snapshot expected, CompletionPlan plan, Func<bool> stillAllowed, CancellationToken token, Func<bool>? paste = null) => Run(() =>
    {
        var fresh = Read();
        if (fresh == null || !Same(expected, fresh) || fresh.Before != plan.Before || !stillAllowed() || token.IsCancellationRequested) return null;
        if (plan.RemoveLength > 0)
        {
            var replacement = fresh.Caret.Clone();
            replacement.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -plan.RemoveLength);
            // Providers count Unicode characters differently. Search the bounded
            // prefix and require the match to end exactly at the fresh caret.
            replacement = replacement.FindText(plan.Before[^plan.RemoveLength..], true, false);
            if (replacement == null || replacement.GetText(-1) != plan.Before[^plan.RemoveLength..] ||
                replacement.CompareEndpoints(TextPatternRangeEndpoint.End, fresh.Caret, TextPatternRangeEndpoint.Start) != 0 || !stillAllowed()) return null;
            replacement.Select();
            if (AssistNative.GetForegroundWindow() != fresh.Foreground || !fresh.Element.Current.HasKeyboardFocus || !stillAllowed()) return null;
        }
        if (paste != null ? !paste() : plan.Suffix.Length > 0 && !AssistNative.SendUnicode(plan.Suffix, fresh.Foreground)) return null;
        return fresh;
    }, token);

    internal Task<Snapshot?> RestoreFocusAsync(Snapshot expected, CancellationToken token) => Run(() =>
    {
        if (!expected.Element.Current.IsEnabled || expected.Element.Current.IsPassword) return null;
        if (!AssistNative.SetForegroundWindow(expected.Foreground)) return null;
        expected.Element.SetFocus();
        var fresh = Read();
        return fresh != null && Same(expected, fresh) ? fresh : null;
    }, token);

    internal Task<Snapshot?> VerifyAsync(Snapshot before, CompletionPlan plan, CancellationToken token) => Run(() =>
    {
        var after = Read();
        return after != null && SameElement(before, after) && plan.Verify(after.Before, before.After, after.After) ? after : null;
    }, token);

    internal sealed record ReferenceGeometry(AcceptedReference Reference, Rect[] Bounds);

    internal Task<ReferenceGeometry[]?> LocateReferencesAsync(AcceptedReference[] references, CancellationToken token) => Run(() =>
    {
        var foreground = AssistNative.GetForegroundWindow();
        if (foreground == IntPtr.Zero || AssistNative.IsOwnWindow(foreground)) return [];
        var element = AutomationElement.FocusedElement;
        if (element == null || element.Current.IsPassword || element.Current.IsOffscreen || !element.Current.HasKeyboardFocus) return [];
        AssistNative.GetWindowThreadProcessId(foreground, out var pid);
        if (element.Current.ProcessId != pid || !element.TryGetCurrentPattern(TextPattern.Pattern, out var raw)) return [];
        var title = AssistNative.WindowTitle(foreground);
        var editor = string.Join(":", element.GetRuntimeId());
        // Runtime IDs isolate separate text fields in a browser tab. Window title
        // additionally isolates tab navigation that reuses a provider element.
        var applicable = references.Where(r => r.Anchor != null && r.WindowTitle == title &&
            r.EditorIdentity == editor && r.HostWindow == foreground.ToInt64()).Take(80).ToArray();
        if (applicable.Length == 0) return [];
        var documentRange = ((TextPattern)raw).DocumentRange;
        var text = documentRange.GetText(100001);
        if (text.Length > 100000) return [];
        var output = new System.Collections.Generic.List<ReferenceGeometry>();
        foreach (var reference in applicable)
        {
            var anchor = reference.Anchor!;
            var index = anchor.Locate(text);
            if (index < 0) continue;
            var range = AnchoredRange(documentRange, anchor);
            if (range == null) continue;
            var bounds = range.GetBoundingRectangles().Where(rect => !rect.IsEmpty && rect.Width > 0 && rect.Height > 0 &&
                double.IsFinite(rect.X) && double.IsFinite(rect.Y)).ToArray();
            if (bounds.Length > 0) output.Add(new(reference, bounds));
        }
        return AssistNative.GetForegroundWindow() == foreground && element.Current.HasKeyboardFocus ? output.ToArray() : [];
    }, token);

    private static TextPatternRange? AnchoredRange(TextPatternRange document, TextAnchor anchor)
    {
        var context = document.FindText(anchor.Prefix + anchor.Text + anchor.Suffix, false, false);
        if (context == null) return null;
        var search = context.Clone();
        while (true)
        {
            var phrase = search.FindText(anchor.Text, false, false);
            if (phrase == null) return null;
            var prefix = context.Clone();
            prefix.MoveEndpointByRange(TextPatternRangeEndpoint.End, phrase, TextPatternRangeEndpoint.Start);
            if (prefix.GetText(-1) == anchor.Prefix && phrase.GetText(-1) == anchor.Text) return phrase;
            if (phrase.CompareEndpoints(TextPatternRangeEndpoint.End, search, TextPatternRangeEndpoint.End) >= 0) return null;
            search.MoveEndpointByRange(TextPatternRangeEndpoint.Start, phrase, TextPatternRangeEndpoint.End);
        }
    }

    internal static bool SameElement(Snapshot left, Snapshot right) =>
        left.Foreground == right.Foreground && left.RuntimeId.SequenceEqual(right.RuntimeId);

    internal static bool Same(Snapshot left, Snapshot right) =>
        SameElement(left, right) && left.Before == right.Before && left.After == right.After &&
        Math.Abs(left.CaretBounds.X - right.CaretBounds.X) < 3 && Math.Abs(left.CaretBounds.Y - right.CaretBounds.Y) < 3;

    private static Snapshot? Read()
    {
        var foreground = AssistNative.GetForegroundWindow();
        if (foreground == IntPtr.Zero || AssistNative.IsOwnWindow(foreground)) return null;
        AssistNative.GetWindowThreadProcessId(foreground, out var foregroundProcess);
        var element = AutomationElement.FocusedElement;
        if (element == null) return null;
        var properties = element.Current;
        if (properties.ProcessId == Environment.ProcessId || properties.ProcessId != foregroundProcess ||
            !properties.HasKeyboardFocus || !properties.IsEnabled || properties.IsPassword || properties.IsOffscreen) return null;
        // A focused child may omit IsPassword while its containing edit exposes it.
        var parent = element;
        for (var depth = 0; depth < 5 && parent != null; depth++)
        {
            if (parent.Current.IsPassword) return null;
            parent = TreeWalker.ControlViewWalker.GetParent(parent);
            if (parent != null && parent.Current.ProcessId != foregroundProcess) break;
        }
        if (!element.TryGetCurrentPattern(TextPattern.Pattern, out var rawPattern)) return null;
        var pattern = (TextPattern)rawPattern;
        var selected = pattern.GetSelection();
        if (selected.Length != 1) return null;
        var caret = selected[0];
        if (caret.CompareEndpoints(TextPatternRangeEndpoint.Start, caret, TextPatternRangeEndpoint.End) != 0) return null;

        var readOnly = caret.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
        var editable = readOnly is bool isReadOnly && !isReadOnly;
        if (element.TryGetCurrentPattern(ValuePattern.Pattern, out var rawValue))
        {
            if (((ValuePattern)rawValue).Current.IsReadOnly) return null;
            editable = true;
        }
        // Absence of a read-only attribute is not proof that a document is editable.
        if (!editable) return null;

        var prefix = caret.Clone();
        prefix.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -ContextLimit);
        var before = prefix.GetText(ContextLimit * 4 + 1);
        if (before.Length > ContextLimit * 4) return null;
        if (before.Length > ContextLimit)
        {
            var start = before.Length - ContextLimit;
            if (char.IsLowSurrogate(before[start])) start++;
            before = before[start..];
        }
        var tailRange = caret.Clone();
        tailRange.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, TailLimit);
        var tail = tailRange.GetText(TailLimit);
        var bounds = CaretBounds(caret, properties.BoundingRectangle);
        if (bounds.IsEmpty || !double.IsFinite(bounds.X) || !double.IsFinite(bounds.Y)) return null;
        // Focus may move while a provider is answering; never deliver that stale read.
        if (AssistNative.GetForegroundWindow() != foreground || !element.Current.HasKeyboardFocus) return null;
        return new(before, tail, bounds, foreground, element.GetRuntimeId(), element, caret.Clone());
    }

    private static Rect CaretBounds(TextPatternRange caret, Rect fallback)
    {
        var bounds = caret.GetBoundingRectangles();
        if (bounds.Length > 0 && bounds[^1].Height > 0) return bounds[^1];
        var previous = caret.Clone();
        previous.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, -1);
        bounds = previous.GetBoundingRectangles();
        if (bounds.Length > 0 && bounds[^1].Height > 0)
        {
            var last = bounds[^1];
            return new Rect(last.Right, last.Top, 1, last.Height);
        }
        return fallback.IsEmpty ? Rect.Empty : new Rect(fallback.Left + 8, fallback.Top + Math.Min(24, fallback.Height), 1, 18);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        work.CompleteAdding();
        // A third-party accessibility provider may block. Never join it on the UI thread.
        // Its background thread exits when the in-flight call returns.
    }
}
