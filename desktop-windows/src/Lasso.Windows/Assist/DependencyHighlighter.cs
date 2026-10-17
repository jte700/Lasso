//  Keeps local dependency highlights attached to the right words.
//
//  On every settle tick the highlighter re-reads the focused surface, relocates
//  each reference by its anchor, measures the range, and repaints. References
//  that cannot be located confidently are marked unresolved and simply not
//  drawn; nothing is ever highlighted on a guess, and a phrase the user deleted
//  takes its reference with it rather than leaving a ghost behind.

using System.Runtime.InteropServices;
using System.Windows.Threading;
using Lasso.Core;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

public sealed class DependencyHighlighter : IDisposable
{
    public static DependencyHighlighter Shared { get; } = new();

    public Uri? ServerUrl
    {
        get => _serverUrl;
        set
        {
            _serverUrl = value;
            if (value is not null) _ = MigrateStoredSourcePathsAsync();
        }
    }

    /// Raised when the user clicks a highlighted phrase.
    public Action<DependencyReference, HostRect>? OnInspect { get; set; }

    public bool IsDebugging
    {
        get => _overlay.View.Debug;
        set
        {
            _overlay.View.Debug = value;
            ScheduleRefresh();
        }
    }

    private readonly DependencyReferenceStore _store;
    private readonly OverlayWindow _overlay = new();
    private readonly Dispatcher _dispatcher;
    private readonly DispatcherTimer _settle;
    private readonly NativeMethods.HookProc _mouseCallback;
    private IntPtr _mouseHook;
    private Uri? _serverUrl;
    private HostSurface? _surface;
    private List<DependencyGeometry> _geometries = [];
    private bool _scheduled;
    private bool _refreshing;

    private DependencyHighlighter()
    {
        _dispatcher = System.Windows.Application.Current?.Dispatcher ?? Dispatcher.CurrentDispatcher;
        _store = new DependencyReferenceStore(AppPaths.References);
        _mouseCallback = MouseCallback;
        _settle = new DispatcherTimer(DispatcherPriority.Background, _dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(350),
        };
        _settle.Tick += (_, _) => ScheduleRefresh();
    }

    public void Start()
    {
        _settle.Start();
        // Observing, never consuming: the host keeps every mouse event.
        _mouseHook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_MOUSE_LL, _mouseCallback,
            Marshal.GetHINSTANCE(typeof(DependencyHighlighter).Module), 0);
        if (_mouseHook == IntPtr.Zero) AssistLog.Write("highlight: pointer hook unavailable");
    }

    public void Stop()
    {
        _settle.Stop();
        if (_mouseHook != IntPtr.Zero)
        {
            NativeMethods.UnhookWindowsHookEx(_mouseHook);
            _mouseHook = IntPtr.Zero;
        }
        Hide();
    }

    public DependencyReference? Reference(string id) => _store.Reference(id);

    public void Unlink(string id)
    {
        _store.Remove(id);
        ScheduleRefresh();
    }

    // MARK: - Recording

    /// Records a reference from an already-verified range: the caller has
    /// proved these characters are the accepted phrase, so no searching or
    /// guessing happens here.
    public void RecordVerifiedInsertion(VerifiedInsertion insertion)
    {
        var context = insertion.Context;
        var anchor = TextAnchor.Make(insertion.Document, insertion.Range, insertion.DocumentOffset);
        if (anchor is null)
        {
            AssistLog.Write("  x verified range could not be anchored");
            return;
        }

        var slot = SourceColorSlot(insertion.SourcePath, insertion.ObjectId,
            context.DocumentContext, context.Application);
        var reference = new DependencyReference
        {
            Id = "ref_" + Guid.NewGuid().ToString("N")[..8],
            ObjectId = insertion.ObjectId,
            VersionId = insertion.VersionId,
            HostBundleIdentifier = context.Application,
            HostApplication = context.Application,
            DocumentContext = context.DocumentContext,
            Anchor = anchor,
            State = DependencyVisualState.Healthy,
            Label = insertion.Label,
            ValueText = insertion.ValueText,
            SourcePath = insertion.SourcePath,
            SourceLocation = insertion.SourceLocation,
            SourceColorSlot = slot,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow,
        };
        _store.Add(reference);
        AssistLog.Write($"  ok dependency reference stored [{reference.Id}] -> \"{anchor.Text}\"");
        ScheduleRefresh();
    }

    // MARK: - Colours

    private static string SourceKey(string path, string objectId) =>
        AssistSourceIdentity.Key(path, objectId);

    private static int StableSlot(string key) =>
        AssistSourceIdentity.StableSourceColorSlot(key, DependencyStyle.SourceColorCount);

    private int SourceColorSlot(string path, string objectId, string documentContext, string application)
    {
        var key = SourceKey(path, objectId);
        var existing = _store.ReferencesFor(documentContext, application);
        var sameSource = existing.FirstOrDefault(
            reference => SourceKey(reference.SourcePath, reference.ObjectId) == key);
        if (sameSource is not null) return sameSource.SourceColorSlot ?? StableSlot(key);

        var occupied = existing
            .Select(reference => reference.SourceColorSlot
                ?? StableSlot(SourceKey(reference.SourcePath, reference.ObjectId)))
            .ToHashSet();
        for (var slot = 0; slot < DependencyStyle.SourceColorCount; slot++)
        {
            if (!occupied.Contains(slot)) return slot;
        }
        return StableSlot(key);
    }

    private void NormalizeSourceColorSlots(string documentContext, string application)
    {
        var references = _store.ReferencesFor(documentContext, application);
        var keyed = references.Select(reference =>
            (Key: SourceKey(reference.SourcePath, reference.ObjectId), Preferred: reference.SourceColorSlot));
        var assignments = AssistSourceIdentity.ColorAssignments(
            keyed, DependencyStyle.SourceColorCount, StableSlot);
        foreach (var reference in references)
        {
            var key = SourceKey(reference.SourcePath, reference.ObjectId);
            if (!assignments.TryGetValue(key, out var slot) || reference.SourceColorSlot == slot) continue;
            _store.Update(reference.Id, existing => existing.SourceColorSlot = slot);
        }
    }

    /// Pre-colour builds stored the human breadcrumb in the source path.
    /// Resolve each indexed object through the local-only API and repair it to
    /// the owning file. Nothing leaves the machine and unresolved objects stay.
    private async Task MigrateStoredSourcePathsAsync()
    {
        if (ServerUrl is not { } server) return;
        foreach (var reference in _store.References.ToList())
        {
            var path = await AssistHttp.OwningPathAsync(server, reference.ObjectId).ConfigureAwait(true);
            if (path is null || path.Trim().Length == 0) continue;
            var current = _store.Reference(reference.Id);
            if (current is null || current.SourcePath == path) continue;
            _store.Update(reference.Id, existing =>
            {
                existing.SourcePath = path;
                existing.SourceColorSlot = null;
            });
            AssistLog.Write($"highlight: repaired source identity for {reference.Id} -> {path}");
            NormalizeSourceColorSlots(current.DocumentContext, current.HostBundleIdentifier);
            ScheduleRefresh();
        }
    }

    // MARK: - Refresh

    private void ScheduleRefresh()
    {
        if (_scheduled) return;
        _scheduled = true;
        _dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
        {
            _scheduled = false;
            _ = RefreshAsync();
        }));
    }

    private async Task RefreshAsync()
    {
        if (_refreshing) return;
        _refreshing = true;
        try
        {
            var surface = await Task.Run(UiaReader.FocusedSurface).ConfigureAwait(true);
            if (surface is null)
            {
                Hide();
                return;
            }
            NormalizeSourceColorSlots(surface.DocumentContext, surface.Application);

            // Only this document's references, never another window's.
            var references = _store.ReferencesFor(surface.DocumentContext, surface.Application);
            if (references.Count == 0)
            {
                Hide();
                return;
            }

            var document = await Task.Run(() => UiaReader.WholeText(surface.Element)).ConfigureAwait(true);
            if (document is null)
            {
                Hide();
                return;
            }

            var found = new List<DependencyGeometry>();
            var states = new Dictionary<string, DependencyVisualState>();
            var slots = new Dictionary<string, int>();

            foreach (var reference in references)
            {
                var resolution = TextAnchorResolver.Resolve(reference.Anchor, document);
                if (!resolution.IsResolved)
                {
                    // The phrase is gone or cannot be told apart: never draw a guess.
                    if (resolution.Failure == AnchorFailure.TextMissing)
                    {
                        _store.Remove(reference.Id);          // no ghost highlights
                        AssistLog.Write($"highlight: {reference.Id} text deleted; reference dropped");
                    }
                    else
                    {
                        _store.Update(reference.Id, existing =>
                            existing.State = DependencyVisualState.Unresolved);
                    }
                    continue;
                }

                if (reference.State == DependencyVisualState.Unresolved)
                {
                    _store.Update(reference.Id, existing => existing.State = DependencyVisualState.Healthy);
                }
                states[reference.Id] = reference.State == DependencyVisualState.Unresolved
                    ? DependencyVisualState.Healthy
                    : reference.State;
                slots[reference.Id] = reference.SourceColorSlot
                    ?? StableSlot(SourceKey(reference.SourcePath, reference.ObjectId));

                var range = resolution.Range;
                var rects = await Task.Run(() => UiaReader.RectanglesFor(surface.Element, range))
                    .ConfigureAwait(true);
                if (rects.Count == 0) continue;
                found.Add(DependencyGeometry.Coalesce(rects, reference.Id));
            }

            if (found.Count == 0)
            {
                Hide();
                return;
            }

            _surface = surface;
            _geometries = found;
            var view = _overlay.View;
            view.Geometries = found;
            view.States = states;
            view.SourceSlots = slots;

            // The overlay covers only what it needs to.
            var union = found.Skip(1).Aggregate(found[0].Bounds, (box, next) => box.Union(next.Bounds));
            var region = union.InsetBy(-6, -6);
            if (!_overlay.IsVisible) _overlay.Show();
            _overlay.Cover(region, MonitorScale(region));
        }
        finally
        {
            _refreshing = false;
        }
    }

    private static double MonitorScale(HostRect region)
    {
        var point = new NativeMethods.POINT
        {
            X = (int)Math.Round(region.MidX),
            Y = (int)Math.Round(region.MidY),
        };
        var monitor = NativeMethods.MonitorFromPoint(point, NativeMethods.MONITOR_DEFAULTTONEAREST);
        if (monitor != IntPtr.Zero
            && NativeMethods.GetDpiForMonitor(monitor, NativeMethods.MDT_EFFECTIVE_DPI, out var dpiX, out _) == 0
            && dpiX > 0)
        {
            return dpiX / 96.0;
        }
        return 1.0;
    }

    private void Hide()
    {
        _geometries = [];
        _overlay.View.Geometries = [];
        _overlay.View.SourceSlots = [];
        if (_overlay.IsVisible) _overlay.Hide();
    }

    // MARK: - Interaction

    private IntPtr MouseCallback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != NativeMethods.HC_ACTION)
        {
            return NativeMethods.CallNextHookEx(_mouseHook, code, wParam, lParam);
        }
        var message = (int)wParam;
        if (message is NativeMethods.WM_MOUSEMOVE or NativeMethods.WM_LBUTTONDOWN)
        {
            var info = Marshal.PtrToStructure<NativeMethods.MSLLHOOKSTRUCT>(lParam);
            var x = info.pt.X;
            var y = info.pt.Y;
            // Queued, never handled here: the pointer must not wait on us.
            _dispatcher.BeginInvoke(DispatcherPriority.Background, new Action(() =>
            {
                if (message == NativeMethods.WM_MOUSEMOVE) HandleHover(x, y);
                else HandleClick(x, y);
            }));
        }
        return NativeMethods.CallNextHookEx(_mouseHook, code, wParam, lParam);
    }

    private void HandleHover(double x, double y)
    {
        if (!_overlay.IsVisible) return;
        var hovered = _geometries.FirstOrDefault(geometry => geometry.Contains(x, y))?.ReferenceId;
        if (hovered == _overlay.View.HoveredId) return;
        _overlay.View.HoveredId = hovered;
        _overlay.View.InvalidateVisual();
    }

    private void HandleClick(double x, double y)
    {
        if (!_overlay.IsVisible) return;
        var hit = _geometries.FirstOrDefault(geometry => geometry.Contains(x, y));
        if (hit is null) return;
        var reference = _store.Reference(hit.ReferenceId);
        if (reference is null) return;
        OnInspect?.Invoke(reference, hit.Bounds);
    }

    public void Dispose() => Stop();
}
