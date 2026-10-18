//  System-wide predictive provenance.
//
//  Watches typing in any application, reads the text around the caret through
//  UI Automation, asks the local Lasso server for source-backed suggestions,
//  and shows a native Windows flyout next to the caret. Tab inserts the
//  suggestion into whatever application is focused.
//
//  Nothing is captured or stored: the focused text window is sent only to
//  127.0.0.1 and discarded. Accepted source identities and deliberate opens are
//  recorded locally for ranking.
//
//  The order of operations is the part that matters, and it is the same as the
//  macOS companion's. An edit is planned, re-validated against a fresh read,
//  applied, then read back and proved to have changed only the interval it was
//  allowed to change. A dependency is recorded only after that proof. A
//  suggestion that cannot be verified leaves no record behind.

using System.Windows.Automation;
using System.Windows.Threading;
using Lasso.Core;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

public sealed class GlobalAssistant
{
    public static GlobalAssistant Shared { get; } = new();

    public Uri? ServerUrl { get; set; }
    public string? ProjectId { get; set; }
    public bool IsEnabled { get; private set; }
    public Action? OnStateChange { get; set; }

    /// Raised when the user asks to browse sources, which the shell answers by
    /// showing the source chooser.
    public Func<string?, Task<SourceChoice?>>? ChooseSourceAsync { get; set; }
    /// Raised before a share is created, so the shell can show the composer.
    public Func<AssistSuggestion, Task<ShareConfiguration?>>? ComposeShareAsync { get; set; }
    /// Raised after a verified insertion, so the highlighter can record it.
    public Action<VerifiedInsertion>? OnVerifiedInsertion { get; set; }

    private readonly Dispatcher _dispatcher;
    private readonly KeyboardHook _hook;
    private readonly AssistFlyout _flyout;
    private readonly DispatcherTimer _debounce;
    private readonly DispatcherTimer _hostTimer;
    private readonly DispatcherTimer _flashTimer;

    private CancellationTokenSource? _prediction;
    private CancellationTokenSource? _previewRequest;
    private readonly Dictionary<string, AssistDocumentPreview> _previewCache = [];
    private readonly List<string> _previewOrder = [];
    private string? _previewKey;
    private int _generation;
    private int _previewGeneration;
    private CaretContext? _context;
    private HostRect? _popupCaret;
    private bool _tracking;
    private int _trackingInFlight;
    private long _lastTrack;
    private int _caretMisses;

    /// How often the caret is re-measured while the user types, matching the
    /// macOS build's throttle.
    private const int TrackIntervalMs = 30;
    /// How many consecutive unreadable measurements mean the caret is gone,
    /// rather than the host simply being busy.
    private const int MaximumCaretMisses = 3;
    private AssistSuggestion? _pendingShare;
    private string? _linkedContext;

    /// Sources linked in the current surface, newest last. Reported to the
    /// server so it can offer their values instead of matching the same phrase.
    private sealed record LinkedSource(string ObjectId, string SnapshotId, string Text);
    private readonly List<LinkedSource> _linkedSources = [];

    private GlobalAssistant()
    {
        _dispatcher = System.Windows.Application.Current?.Dispatcher ?? Dispatcher.CurrentDispatcher;
        _hook = new KeyboardHook(_dispatcher) { OnKey = HandleKey };
        _flyout = new AssistFlyout();
        WireFlyout();

        _debounce = new DispatcherTimer(DispatcherPriority.Input, _dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(160),
        };
        _debounce.Tick += (_, _) =>
        {
            _debounce.Stop();
            _ = RefreshAsync();
        };

        // Follows the caret between refreshes, so the panel does not lag behind
        // continuous typing or a window the user is dragging.
        _hostTimer = new DispatcherTimer(DispatcherPriority.Normal, _dispatcher)
        {
            Interval = TimeSpan.FromMilliseconds(100),
        };
        _hostTimer.Tick += (_, _) => _ = UpdateHostPositionAsync();

        _flashTimer = new DispatcherTimer(DispatcherPriority.Background, _dispatcher);
        _flashTimer.Tick += (_, _) =>
        {
            _flashTimer.Stop();
            Hide();
        };
    }

    private void WireFlyout()
    {
        var panel = _flyout.Panel;
        panel.OnSelectRow = SelectRow;
        panel.OnInsert = ActivateSelection;
        panel.OnLocalLink = AcceptPlain;
        panel.OnShare = AcceptShared;
        panel.OnOpenSource = () => _ = OpenCurrentSourceAsync();
        panel.OnChooseSource = () => _ = BrowseSourcesAsync(allDocuments: false);
        panel.OnAllSources = () => _ = BrowseSourcesAsync(allDocuments: true);
        panel.OnDismiss = () => Hide("dismissed from the panel");
    }

    // MARK: - Lifecycle

    /// Returns null on success, or a message explaining what the user must do.
    public string? Enable()
    {
        if (IsEnabled) return null;
        if (_hook.Install() is { } problem) return problem;
        IsEnabled = true;
        OnStateChange?.Invoke();
        return null;
    }

    public void Disable()
    {
        Hide();
        _hook.Remove();
        IsEnabled = false;
        OnStateChange?.Invoke();
    }

    public void ApplySystemTheme() => _flyout.ApplySystemTheme();

    // MARK: - Keys

    /// Runs on the UI thread from inside the keyboard hook, so it only ever
    /// inspects state and queues work.
    private KeyDisposition HandleKey(AssistKey key)
    {
        var visible = _flyout.IsVisible;
        var panel = _flyout.Panel;

        // Escape always dismisses, including a prediction that has not arrived.
        if (key.VirtualKey == KeyboardHook.VK_ESCAPE && (visible || _tracking || _debounce.IsEnabled))
        {
            _dispatcher.BeginInvoke(() => Hide("Escape"));
            return KeyDisposition.Swallow;
        }

        if (visible)
        {
            switch (key.VirtualKey)
            {
                case KeyboardHook.VK_TAB:
                    _dispatcher.BeginInvoke(ActivateSelection);
                    return KeyDisposition.Swallow;           // never insert a tab
                case KeyboardHook.VK_RETURN when key.Control:
                    if (key.Shift) _dispatcher.BeginInvoke(AcceptShared);
                    else _dispatcher.BeginInvoke(AcceptPlain);
                    return KeyDisposition.Swallow;
                case KeyboardHook.VK_RETURN when panel.Mode == AssistMode.ConfirmShare:
                    _dispatcher.BeginInvoke(ResolveConfirmation);
                    return KeyDisposition.Swallow;
                case KeyboardHook.VK_UP:
                    _dispatcher.BeginInvoke(() => Move(-1));
                    return KeyDisposition.Swallow;
                case KeyboardHook.VK_DOWN:
                    _dispatcher.BeginInvoke(() => Move(1));
                    return KeyDisposition.Swallow;
                case KeyboardHook.VK_F4:
                    _dispatcher.BeginInvoke(() => _ = OpenCurrentSourceAsync());
                    return KeyDisposition.Swallow;
            }
        }

        // Other modifier chords are shortcuts, not typing.
        if (key.Control || key.Alt || key.Windows)
        {
            _dispatcher.BeginInvoke(() => Hide("a shortcut was pressed"));
            return KeyDisposition.PassThrough;
        }

        _dispatcher.BeginInvoke(() =>
        {
            // The debounce only fires once typing pauses, so the panel is moved
            // here instead; otherwise it lags behind continuous typing.
            if (visible) TrackCaret();
            ScheduleRefresh();
        });
        return KeyDisposition.PassThrough;
    }

    private void ScheduleRefresh()
    {
        if (_flyout.Panel.Mode != AssistMode.Suggestions) return;
        // Invalidate the previous response now, not after the debounce: a late
        // answer must not dismiss the next refresh while the user is typing.
        _generation++;
        _prediction?.Cancel();
        _prediction = null;
        _debounce.Stop();
        _debounce.Start();
    }

    // MARK: - Suggestions

    private async Task RefreshAsync()
    {
        if (!IsEnabled || ServerUrl is not { } server || ProjectId is not { } projectId) return;

        var captured = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (captured is null)
        {
            Hide("no readable caret");
            return;
        }
        if (captured.Text.Trim().Length < 4)
        {
            Hide("fewer than four characters typed");
            return;
        }
        if (_context is { } previous && !UiaReader.SameElement(previous.Element, captured.Element)) Hide();

        // Linked sources belong to one surface only.
        if (_linkedContext != captured.Diagnosis)
        {
            _linkedContext = captured.Diagnosis;
            _linkedSources.Clear();
        }
        _context = captured;
        if (!StartTrackingHost(captured))
        {
            Hide("host reported no caret rectangle");
            return;
        }
        // Track the caret straight away; waiting for the response would leave
        // the panel behind whenever fast typing cancels requests.
        if (_flyout.IsVisible && _flyout.Panel.Mode == AssistMode.Suggestions) Reposition(_popupCaret);

        _generation++;
        var token = _generation;
        _prediction?.Cancel();
        var cancellation = new CancellationTokenSource();
        _prediction = cancellation;

        // Locate each linked phrase inside the window actually being sent, so
        // the offsets the server receives match the text it is given.
        var pending = new List<AssistHttp.PendingDependency>();
        foreach (var link in _linkedSources)
        {
            var occurrences = TextAnchorResolver.Indices(link.Text, captured.Text);
            if (occurrences.Count == 0) continue;
            var start = occurrences[^1];
            pending.Add(new AssistHttp.PendingDependency(
                0, start, start + link.Text.Length, link.ObjectId, link.SnapshotId));
        }
        var sourceScoped = pending.Count > 0;

        var data = await AssistHttp.PredictAsync(
            server, projectId, captured.Text, captured.Cursor, pending, cancellation.Token)
            .ConfigureAwait(true);

        if (token != _generation) return;
        if (data is null)
        {
            Hide("the prediction request did not complete");
            return;
        }

        var suggestions = PredictionParser.Parse(data, captured.Text.Length, projectId);
        var heading = PredictionParser.Heading(data);
        await DeliverPredictionAsync(suggestions, heading, sourceScoped, captured, token)
            .ConfigureAwait(true);
    }

    /// A response may arrive after Escape, an edit, or a window closing. Only
    /// deliver to the same still-current editor, using its current caret.
    private async Task DeliverPredictionAsync(List<AssistSuggestion> suggestions, string? heading,
        bool sourceScoped, CaretContext captured, int token)
    {
        if (token != _generation || !IsEnabled) return;
        if (suggestions.Count == 0)
        {
            Hide("no matching indexed source");
            return;
        }

        var fresh = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (token != _generation) return;
        if (fresh is null
            || !UiaReader.SameElement(fresh.Element, captured.Element)
            || fresh.Text != captured.Text
            || fresh.AbsoluteCaret != captured.AbsoluteCaret
            || fresh.WindowStart != captured.WindowStart)
        {
            Hide("the text moved on before the answer arrived");
            return;
        }

        _context = fresh;
        var panel = _flyout.Panel;
        panel.SourceScoped = sourceScoped;
        panel.Title = heading ?? "dependency";
        Show(suggestions, fresh.CaretRect);
    }

    private void Show(IReadOnlyList<AssistSuggestion> suggestions, HostRect? caret)
    {
        var panel = _flyout.Panel;
        if (panel.Mode != AssistMode.Suggestions) return;
        if (_context is not { } context || !StartTrackingHost(context, caret) || _popupCaret is not { } live)
        {
            Hide("no caret to anchor to");
            return;
        }
        panel.Suggestions = suggestions;
        panel.Selected = Math.Min(panel.Selected, Math.Max(0, suggestions.Count - 1));
        _ = LoadPreviewAsync();
        _flyout.Present(live);
    }

    /// Dismisses the panel. The reason is written to the typing log, because
    /// "it disappeared while I was typing" is otherwise impossible to tell
    /// apart from "there was nothing to suggest".
    public void Hide(string? reason = null)
    {
        if (reason is not null && _flyout.IsVisible) AssistLog.Write($"dismissed: {reason}");
        _generation++;
        StopTrackingHost();
        _debounce.Stop();
        _flashTimer.Stop();
        _prediction?.Cancel();
        _prediction = null;
        _previewRequest?.Cancel();
        _previewGeneration++;
        _previewKey = null;

        var panel = _flyout.Panel;
        panel.Selected = 0;
        panel.Mode = AssistMode.Suggestions;
        panel.Title = "dependency";
        panel.Preview = null;
        panel.PreviewError = null;
        panel.IsPreviewLoading = false;
        panel.SourceScoped = false;
        _pendingShare = null;
        _flyout.Dismiss();
    }

    // MARK: - Following the caret
    //
    // Measuring the caret is a cross-process call, and a busy host - a browser
    // with a large document, most of all - can take a long time to answer it.
    // So nothing here blocks the UI thread: that thread also runs the keyboard
    // hook, and Windows removes a hook whose thread stops servicing it. A
    // measurement that is still running is never queued behind another, and a
    // single slow answer never dismisses the panel.

    /// Begins following a caret that has already been measured. The rectangle
    /// comes from the read that produced the context, so showing the panel
    /// costs no extra cross-process call.
    private bool StartTrackingHost(CaretContext context, HostRect? knownCaret = null)
    {
        var caret = knownCaret ?? context.CaretRect;
        if (caret is not { } rect || !HostGeometryConverter.IsUsable(rect)) return false;
        _popupCaret = rect;
        _caretMisses = 0;
        if (!_tracking)
        {
            _tracking = true;
            _hostTimer.Start();
        }
        return true;
    }

    private void StopTrackingHost()
    {
        _hostTimer.Stop();
        _tracking = false;
        _popupCaret = null;
        _caretMisses = 0;
    }

    /// Throttled to the same interval the macOS build uses, so a burst of
    /// keystrokes asks the host for its caret once rather than once per key.
    private void TrackCaret()
    {
        if (!_tracking) return;
        var now = Environment.TickCount64;
        if (now - _lastTrack < TrackIntervalMs) return;
        _lastTrack = now;
        _ = UpdateHostPositionAsync();
    }

    private async Task UpdateHostPositionAsync()
    {
        if (_context is not { } context) return;
        // One measurement at a time; a tick that arrives while the host is
        // still answering is dropped rather than piling up behind it.
        if (Interlocked.Exchange(ref _trackingInFlight, 1) == 1) return;
        try
        {
            // The cheap checks first, so a host that is genuinely gone
            // dismisses the panel at once without a cross-process call.
            if (!HostOwnsFocus(context))
            {
                Hide("host no longer focused");
                return;
            }

            var caret = await Task.Run(
                () => UiaReader.CaretRectOf(context.Element, context.WindowHandle)).ConfigureAwait(true);

            // The world may have moved on while the host was answering.
            if (!ReferenceEquals(_context, context) || !_tracking) return;

            if (caret is not { } rect || !HostGeometryConverter.IsUsable(rect))
            {
                // A host under load can miss one measurement. Only a run of
                // them means the caret is really gone; dismissing on the first
                // would make the panel vanish mid-sentence.
                if (++_caretMisses >= MaximumCaretMisses) Hide("caret unreadable");
                return;
            }

            _caretMisses = 0;
            _popupCaret = rect;
            Reposition(rect);
        }
        finally
        {
            Interlocked.Exchange(ref _trackingInFlight, 0);
        }
    }

    /// Geometry alone is not an identity: another window can put a caret at the
    /// same coordinates. The owning process must still be in front and its
    /// window must not be minimized. Both are local calls.
    private static bool HostOwnsFocus(CaretContext context)
    {
        var foreground = Interop.NativeMethods.GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        Interop.NativeMethods.GetWindowThreadProcessId(foreground, out var processId);
        if (processId != context.ProcessId) return false;
        return context.WindowHandle == IntPtr.Zero
            || !Interop.NativeMethods.IsIconic(context.WindowHandle);
    }

    private void Reposition(HostRect? caret)
    {
        if (!_flyout.IsVisible) return;
        _flyout.PlaceNear(caret);
    }

    // MARK: - Selection and previews

    private void SelectRow(int index)
    {
        var panel = _flyout.Panel;
        if (index < 0 || index >= panel.Suggestions.Count) return;
        if (panel.Preview?.UnavailableReason is not null) _previewKey = null;
        panel.Selected = index;
        _ = LoadPreviewAsync();
        _flyout.PlaceNear(_popupCaret);
    }

    private void Move(int delta)
    {
        var panel = _flyout.Panel;
        if (panel.Mode == AssistMode.ConfirmShare)
        {
            if (panel.ConfirmChoices.Count == 0) return;
            panel.Selected = (panel.Selected + delta + panel.ConfirmChoices.Count) % panel.ConfirmChoices.Count;
            _flyout.PlaceNear(_popupCaret);
            return;
        }
        if (panel.Suggestions.Count == 0) return;
        SelectRow((panel.Selected + delta + panel.Suggestions.Count) % panel.Suggestions.Count);
    }

    private AssistSuggestion? CurrentSuggestion
    {
        get
        {
            var panel = _flyout.Panel;
            return panel.Selected < panel.Suggestions.Count ? panel.Suggestions[panel.Selected] : null;
        }
    }

    private async Task LoadPreviewAsync()
    {
        var panel = _flyout.Panel;
        if (panel.Mode != AssistMode.Suggestions
            || CurrentSuggestion is not { ObjectId: { } objectId } suggestion
            || ServerUrl is not { } server)
        {
            _previewRequest?.Cancel();
            _previewGeneration++;
            _previewKey = null;
            panel.Preview = null;
            panel.PreviewError = null;
            panel.IsPreviewLoading = false;
            _flyout.PlaceNear(_popupCaret);
            return;
        }

        var key = objectId + "|" + (suggestion.VersionId ?? "");
        if (_previewKey == key && (panel.Preview is not null || panel.IsPreviewLoading)) return;

        _previewRequest?.Cancel();
        _previewGeneration++;
        var token = _previewGeneration;
        _previewKey = key;
        panel.PreviewError = null;

        if (_previewCache.TryGetValue(key, out var cached))
        {
            _previewOrder.Remove(key);
            _previewOrder.Add(key);
            panel.Preview = cached;
            panel.IsPreviewLoading = false;
            _flyout.PlaceNear(_popupCaret);
            return;
        }

        panel.Preview = null;
        panel.IsPreviewLoading = true;
        _flyout.PlaceNear(_popupCaret);

        var cancellation = new CancellationTokenSource();
        _previewRequest = cancellation;
        var isModel = Path.GetExtension(suggestion.Path).Equals(".ifc", StringComparison.OrdinalIgnoreCase);
        var data = await AssistHttp.PreviewAsync(
            server, objectId, suggestion.VersionId, isModel, cancellation.Token).ConfigureAwait(true);

        if (token != _previewGeneration || _previewKey != key) return;
        var parsed = data is null ? null : AssistDocumentPreview.Parse(data);
        if (parsed is null)
        {
            panel.IsPreviewLoading = false;
            panel.PreviewError = "The document preview could not be loaded. Select this result again to retry.";
            _flyout.PlaceNear(_popupCaret);
            return;
        }

        // Geometry worker errors come back as informative previews, but a
        // transient busy or timeout result must stay retryable.
        if (parsed.UnavailableReason is null)
        {
            _previewCache[key] = parsed;
            _previewOrder.Remove(key);
            _previewOrder.Add(key);
            while (_previewOrder.Count > 8)
            {
                _previewCache.Remove(_previewOrder[0]);
                _previewOrder.RemoveAt(0);
            }
        }
        panel.Preview = parsed;
        panel.IsPreviewLoading = false;
        _flyout.PlaceNear(_popupCaret);
    }

    // MARK: - Accepting

    /// Tab. Follows the insertion preference; sharing is never implicit.
    private void ActivateSelection()
    {
        if (_flyout.Panel.Mode != AssistMode.Suggestions || CurrentSuggestion is not { } suggestion)
        {
            Hide();
            return;
        }
        switch (AppSettings.Current.InsertionMode)
        {
            case InsertionMode.Plain:
                AcceptPlain();
                break;
            case InsertionMode.Share:
                if (suggestion.IsShareable) AcceptShared(); else AcceptPlain();
                break;
            case InsertionMode.Ask:
                if (suggestion.IsShareable) AskBeforeSharing(); else AcceptPlain();
                break;
        }
    }

    private void AskBeforeSharing()
    {
        _pendingShare = CurrentSuggestion;
        var panel = _flyout.Panel;
        panel.Mode = AssistMode.ConfirmShare;
        panel.Title = "share this dependency?";
        panel.ConfirmChoices = ["insert as plain text", "insert as shared link"];
        panel.Selected = 0;
        _flyout.PlaceNear(_popupCaret);
    }

    private void ResolveConfirmation()
    {
        var shareIt = _flyout.Panel.Selected == 1;
        if (_pendingShare is not { } suggestion)
        {
            Hide();
            return;
        }
        _pendingShare = null;
        _flyout.Panel.Mode = AssistMode.Suggestions;
        if (shareIt) _ = BeginShareAsync(suggestion);
        else _ = InsertPlainAsync(suggestion);
    }

    private void AcceptPlain()
    {
        if (CurrentSuggestion is not { } suggestion)
        {
            Hide();
            return;
        }
        _ = InsertPlainAsync(suggestion);
    }

    /// The explicit Share action, never reached by the local-link shortcut.
    private void AcceptShared()
    {
        if (_flyout.Panel.Mode != AssistMode.Suggestions || CurrentSuggestion is not { } suggestion) return;
        if (!suggestion.IsShareable)
        {
            Flash(["This suggestion has no linkable source."]);
            return;
        }
        _ = BeginShareAsync(suggestion);
    }

    /// Builds the smallest edit that turns what the user typed into the
    /// suggestion, refusing anything that would touch text it should not.
    private static Outcome<CompletionPlan> PlanInsertion(AssistSuggestion suggestion, CaretContext context)
    {
        var window = context.Text;
        // The captured window ends at the caret, so the caret is its length.
        var cased = AssistCasing.MatchCasing(
            suggestion.InsertText, AssistCasing.TrailingWord(window), window, window.Length);
        return CompletionTransaction.Plan(window, window.Length, cased);
    }

    private async Task InsertPlainAsync(AssistSuggestion suggestion)
    {
        if (_context is not { } context)
        {
            Hide();
            return;
        }
        AssistLog.Write($"TAB ACCEPT  {context.Diagnosis}");

        var planned = PlanInsertion(suggestion, context);
        if (!planned.IsSuccess)
        {
            AssistLog.Write("  x could not plan an edit - aborting");
            Hide();
            Flash(["Could not insert here.", "Nothing was changed."]);
            return;
        }
        var plan = planned.Value;

        // Confirm the plan is still current against a fresh read.
        var fresh = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (fresh is null || !UiaReader.SameElement(fresh.Element, context.Element))
        {
            AssistLog.Write("  x focus moved before insertion - aborting");
            Hide();
            return;
        }
        var before = new CompletionSnapshot(fresh.WindowStart, fresh.Text);
        if (CompletionTransaction.Validate(plan, fresh.Text, fresh.Text.Length) is { } failure)
        {
            AssistLog.Write($"  x plan is stale ({failure.Name()}) - aborting, nothing changed");
            Hide();
            return;
        }
        AssistLog.Write(
            $"  ok plan: replace {plan.Range.Count} char(s) \"{plan.ExpectedPrefix}\" with \"{plan.InsertText}\"");

        Hide();
        _hook.IsInserting = true;
        UiaReader.Replace(plan.Range.Count, plan.InsertText, context.Element, applied =>
        {
            _dispatcher.BeginInvoke(() =>
            {
                _hook.IsInserting = false;
                _ = CompleteInsertionAsync(suggestion, plan, before, context, applied);
            });
        });
    }

    /// Reads the host back, proves only the intended interval changed, and only
    /// then records a dependency.
    private async Task CompleteInsertionAsync(AssistSuggestion suggestion, CompletionPlan plan,
        CompletionSnapshot before, CaretContext context, bool applied)
    {
        if (!applied)
        {
            AssistLog.Write("  x insertion verification failed - aborting reference creation");
            Flash(["Could not insert here.", "Nothing was changed."]);
            return;
        }

        var after = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (after is null || !UiaReader.SameElement(after.Element, context.Element))
        {
            AssistLog.Write("  x host lost after insertion - no reference created");
            Flash(["Text inserted, but its source could not be anchored here."]);
            return;
        }

        var afterSnapshot = new CompletionSnapshot(after.WindowStart, after.Text);
        var verified = CompletionTransaction.Verify(before, afterSnapshot, plan);
        if (!verified.IsSuccess)
        {
            AssistLog.Write(
                $"  x insertion verification failed ({verified.Failure!.Value.Name()}) - no reference created");
            if (verified.Failure == CompletionFailure.OutsideRangeModified)
            {
                Flash(["Insertion touched other text.", "No dependency was recorded."]);
            }
            return;
        }

        var result = verified.Value;
        AssistLog.Write(
            $"  ok insertion verified - document range {result.DocumentRange.Start}..<{result.DocumentRange.End}");
        RecordAcceptedUsage(suggestion);

        // The next suggestion should offer this source's values, not the same
        // phrase again.
        if (suggestion.ObjectId is { } linkedObject && suggestion.SnapshotId is { } snapshot)
        {
            _linkedSources.Add(new LinkedSource(linkedObject, snapshot, plan.InsertText));
            if (_linkedSources.Count > 8) _linkedSources.RemoveAt(0);
            AssistLog.Write($"  . source context: {suggestion.Label}");
        }

        if (suggestion.ObjectId is not { } objectId)
        {
            AssistLog.Write("  . no linkable source; nothing to record");
            return;
        }

        // The reference starts from the verified range, never from a fresh
        // search of the document.
        OnVerifiedInsertion?.Invoke(new VerifiedInsertion(
            ObjectId: objectId,
            VersionId: suggestion.VersionId,
            Label: suggestion.Label,
            ValueText: suggestion.Detail,
            SourcePath: suggestion.Path,
            SourceLocation: suggestion.Detail,
            Document: after.Text,
            Range: result.SnapshotRange,
            DocumentOffset: after.WindowStart,
            Context: after));
    }

    private void RecordAcceptedUsage(AssistSuggestion suggestion)
    {
        if (ServerUrl is not { } server) return;
        AssistHttp.RecordUsage(server, suggestion.ProjectId, suggestion.UsageObjectId,
            suggestion.Path, "accept");
    }

    // MARK: - Sharing

    private async Task BeginShareAsync(AssistSuggestion suggestion)
    {
        if (ServerUrl is not { } server || ProjectId is null || suggestion.ObjectId is not { } objectId)
        {
            Flash(["Sharing is unavailable right now."]);
            return;
        }
        if (ComposeShareAsync is not { } compose)
        {
            Flash(["Sharing is unavailable right now."]);
            return;
        }

        var panel = _flyout.Panel;
        var savedSelection = panel.Selected;
        var savedScope = panel.SourceScoped;
        var savedSuggestions = panel.Suggestions;
        var savedContext = _context;
        Hide();

        var configuration = await compose(suggestion).ConfigureAwait(true);
        if (configuration is null)
        {
            // Cancelled: put the panel back exactly as it was.
            _context = savedContext;
            panel.Mode = AssistMode.Suggestions;
            panel.Selected = savedSelection;
            panel.SourceScoped = savedScope;
            Show(savedSuggestions, savedContext?.CaretRect);
            return;
        }

        _context = savedContext;
        await InsertSharedAsync(suggestion, configuration, server, objectId).ConfigureAwait(true);
    }

    /// Create the record, build the URL, insert the link, verify it landed, and
    /// revoke the record if it did not.
    private async Task InsertSharedAsync(AssistSuggestion suggestion, ShareConfiguration configuration,
        Uri server, string objectId)
    {
        if (_context is not { } context || ProjectId is not { } projectId)
        {
            Flash(["Sharing is unavailable right now."]);
            return;
        }
        var planned = PlanInsertion(suggestion, context);
        if (!planned.IsSuccess)
        {
            Flash(["Could not insert here.", "Nothing was changed."]);
            return;
        }
        var plan = planned.Value;

        var fresh = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (fresh is null || !UiaReader.SameElement(fresh.Element, context.Element)
            || fresh.AbsoluteCaret != context.AbsoluteCaret
            || !CompletionTransaction.EquivalentHostText(fresh.Text, context.Text))
        {
            Flash(["The insertion point changed. Choose the source again."]);
            return;
        }
        var before = new CompletionSnapshot(fresh.WindowStart, fresh.Text);

        Flash(["Creating share link..."]);
        var share = await AssistHttp.CreateShareAsync(
            server, projectId, objectId, suggestion.VersionId, configuration).ConfigureAwait(true);
        if (share is null)
        {
            AssistLog.Write("share creation failed");
            // No record, so nothing was inserted and nothing to clean up.
            Flash(["Could not create the share link.", "Nothing was inserted."]);
            return;
        }

        var current = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
        if (current is null || !UiaReader.SameElement(current.Element, context.Element)
            || !CompletionTransaction.EquivalentHostText(current.Text, before.Text))
        {
            AssistHttp.RevokeShare(server, share.Token);
            Flash(["The insertion point changed. Nothing was inserted."]);
            return;
        }

        Hide();
        _hook.IsInserting = true;
        var pasted = await RichTextInserter.InsertLinkAsync(
            _dispatcher, plan.InsertText, share.Url, plan.Range.Count).ConfigureAwait(true);
        _hook.IsInserting = false;

        var fallback = ShareFormats.PlainText(plan.InsertText, share.Url);
        CompletionPlan? verifiedPlan = null;
        if (pasted)
        {
            var afterContext = await Task.Run(UiaReader.FocusedContext).ConfigureAwait(true);
            if (afterContext is not null && UiaReader.SameElement(afterContext.Element, context.Element))
            {
                var snapshot = new CompletionSnapshot(afterContext.WindowStart, afterContext.Text);
                foreach (var candidate in new[] { plan.InsertText, fallback })
                {
                    var attempt = plan with { InsertText = candidate };
                    if (CompletionTransaction.Verify(before, snapshot, attempt).IsSuccess)
                    {
                        verifiedPlan = attempt;
                        break;
                    }
                }
                if (verifiedPlan is { } confirmed)
                {
                    await CompleteInsertionAsync(suggestion, confirmed, before, context, applied: true)
                        .ConfigureAwait(true);
                }
            }
        }

        if (verifiedPlan is { } landed)
        {
            var local = share.Url.Host is "localhost" or "127.0.0.1" or "::1" or "[::1]";
            Flash([
                landed.InsertText == fallback ? "Link inserted as text" : "Hyperlink inserted",
                local ? "Available only on this PC" : "Source access is set by your sharing choice",
            ]);
        }
        else
        {
            AssistHttp.RevokeShare(server, share.Token);
            Flash(["The link could not be verified.", "Its access link was revoked."]);
        }
    }

    // MARK: - Browsing and opening

    /// Browse without editing the host document or removing existing links.
    private async Task BrowseSourcesAsync(bool allDocuments)
    {
        if (ChooseSourceAsync is not { } choose) return;
        if (ServerUrl is null || ProjectId is null || _context is not { } savedContext) return;

        var panel = _flyout.Panel;
        var previous = panel.Suggestions;
        var previousSelection = panel.Selected;
        var previousScope = panel.SourceScoped;
        var path = allDocuments ? null : CurrentSuggestion?.Path;
        Hide();

        var chosen = await choose(path).ConfigureAwait(true);
        _context = savedContext;
        if (chosen is null)
        {
            panel.Selected = previousSelection;
            panel.SourceScoped = previousScope;
            Show(previous, savedContext.CaretRect);
            return;
        }

        _linkedSources.Clear();
        var suggestion = new AssistSuggestion(
            InsertText: chosen.ObjectType == "DATASET_VALUE" ? chosen.ValueText ?? chosen.Label : chosen.Label,
            Label: chosen.Label,
            Detail: chosen.ValueText ?? "",
            Path: chosen.Path,
            Location: chosen.Location,
            ReplaceFrom: null,
            ObjectId: chosen.Id,
            VersionId: chosen.VersionId,
            SnapshotId: chosen.SnapshotId,
            UsageObjectId: chosen.Id,
            ProjectId: ProjectId!,
            RankingReason: null);
        panel.Selected = 0;
        panel.SourceScoped = true;
        Show([suggestion], savedContext.CaretRect);
    }

    private async Task OpenCurrentSourceAsync()
    {
        if (CurrentSuggestion is not { } suggestion || ProjectId is not { } projectId
            || ServerUrl is not { } server)
        {
            Flash(["The local source is unavailable right now."]);
            return;
        }
        var previewPath = _flyout.Panel.Preview?.Path.Trim() ?? "";
        var sourcePath = previewPath.Length > 0 ? previewPath : suggestion.Path;

        var root = await AssistHttp.ProjectRootAsync(server, projectId, CancellationToken.None)
            .ConfigureAwait(true);
        if (root is null)
        {
            Flash(["Lasso could not locate the project folder."]);
            return;
        }

        var file = AssistSourceIdentity.LocalFilePath(root, sourcePath);
        if (file is null)
        {
            Flash(["The source file is no longer available locally."]);
            return;
        }
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(file)
            {
                UseShellExecute = true,
            });
            if (suggestion.ObjectId is { } objectId)
            {
                _ = AssistHttp.RecordResolvedOpenAsync(server, objectId);
            }
            Hide();
        }
        catch (Exception)
        {
            Flash([$"Windows could not open {Path.GetFileName(file)}."]);
        }
    }

    // MARK: - Feedback

    /// Brief, non-modal confirmation shown in the same panel.
    private void Flash(IReadOnlyList<string> lines, double seconds = 2.2)
    {
        if (_context is not { } context || !StartTrackingHost(context))
        {
            Hide();
            return;
        }
        var panel = _flyout.Panel;
        panel.Mode = AssistMode.Message;
        panel.Title = "lasso";
        panel.MessageLines = lines;
        _flyout.Present(_popupCaret);
        _flashTimer.Stop();
        _flashTimer.Interval = TimeSpan.FromSeconds(seconds);
        _flashTimer.Start();
    }

    /// Shows the deterministic design fixture, for visual checks.
    public void ShowDesignFixture() => AssistDesignFixture.Show();
}

/// What a verified insertion produced, handed to the highlighter so it can
/// record a reference without searching the document again.
public sealed record VerifiedInsertion(
    string ObjectId,
    string? VersionId,
    string Label,
    string? ValueText,
    string SourcePath,
    string SourceLocation,
    string Document,
    UnitRange Range,
    int DocumentOffset,
    CaretContext Context);

/// A source picked in the chooser.
public sealed record SourceChoice(
    string Id, string Label, string? ValueText, string Path, string Location,
    string ObjectType, string? VersionId, string? SnapshotId);
