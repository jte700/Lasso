using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Lasso.Windows.Assist;

public sealed record AcceptedReference(string Id, string ProjectId, string SourceId, string? VersionId,
    string? SnapshotId, string Path, string Text, string HostProcess, DateTimeOffset RecordedAt, TextAnchor? Anchor = null, string? WindowTitle = null,
    string? EditorIdentity = null, long HostWindow = 0, string? SessionId = null);

/// <summary>Opt-in suggestions; native input is issued only after rechecking the original editable caret.</summary>
public sealed class AssistController : IDisposable
{
    private readonly HttpClient client;
    private readonly AutomationReader reader = new();
    private readonly AssistPopup popup = new();
    private readonly ReferenceHighlights highlights = new();
    private readonly DispatcherTimer highlightTracking = new() { Interval = TimeSpan.FromMilliseconds(350) };
    private bool highlightBusy;
    private readonly Dispatcher dispatcher = Dispatcher.CurrentDispatcher;
    private readonly DispatcherTimer debounce = new() { Interval = TimeSpan.FromMilliseconds(450) };
    private readonly DispatcherTimer tracking = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private readonly AssistNative.KeyboardProcedure keyboardCallback;
    private readonly AssistNative.WinEventProcedure focusCallback;
    private readonly string sessionId = Guid.NewGuid().ToString();
    private readonly string referencePath = System.IO.Path.Combine(HostPaths.Root, "accepted-sources.json");
    private readonly List<AcceptedReference> references = [];
    private readonly HashSet<int> consumedKeys = [];
    private CancellationTokenSource pending = new();
    private AutomationReader.Snapshot? context;
    private AssistPrediction? prediction;
    private IntPtr keyboardHook, focusHook;
    private int generation;
    private bool disposed, inserting, trackingBusy;
    private string? projectId;
    private (string Id, AssistSuggestion Suggestion, AutomationReader.Snapshot Snapshot, string Title)? shareTarget;
    public bool Enabled { get; private set; }
    public string? ProjectId
    {
        get => projectId;
        set { if (projectId == value) return; projectId = value; shareTarget = null; Dismiss(); highlights.Hide(); }
    }
    public event EventHandler<AssistStateChangedEventArgs>? StateChanged;
    public event EventHandler<SourceOpenRequestedEventArgs>? OpenSourceRequested;
    public event EventHandler? ReferenceRecorded;

    public AssistController(Uri serverUrl)
    {
        client = new HttpClient(new HttpClientHandler { UseProxy = false }) { BaseAddress = serverUrl, Timeout = TimeSpan.FromSeconds(8) };
        keyboardCallback = Keyboard;
        focusCallback = (_, _, _, _, _, _, _) => dispatcher.BeginInvoke(new Action(() => { if (!disposed) { Dismiss(); highlights.Hide(); } }));
        debounce.Tick += async (_, _) => { debounce.Stop(); await PredictAsync(); };
        tracking.Tick += async (_, _) => await TrackAsync();
        highlightTracking.Tick += async (_, _) => await RefreshHighlightsAsync();
        highlights.OpenRequested += async reference =>
        {
            var fresh = await reader.LocateReferencesAsync([reference], CancellationToken.None);
            if (Enabled && fresh?.Length > 0 && reference.ProjectId == ProjectId)
            { Dismiss(); highlights.Hide(); OpenReference(reference); }
        };
        popup.Selected += index => { _ = PreviewAsync(); };
        popup.AcceptRequested += async () => await AcceptAsync();
        popup.DismissRequested += Dismiss;
        popup.SourceRequested += OpenSource;
        try
        {
            if (File.Exists(referencePath) && new FileInfo(referencePath).Length < 2_000_000)
                references.AddRange((JsonSerializer.Deserialize<List<AcceptedReference>>(File.ReadAllText(referencePath)) ?? []).Take(250));
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
    }

    public IReadOnlyList<AcceptedReference> GetRecentReferences() => references.ToArray();
    public void OpenReference(AcceptedReference reference) => OpenSourceRequested?.Invoke(this,
        new SourceOpenRequestedEventArgs(reference.SourceId, reference.VersionId, null) { ProjectId = reference.ProjectId });

    public void SetEnabled(bool enabled)
    {
        if (disposed || enabled == Enabled) return;
        string status = enabled ? "Writing suggestions enabled" : "Writing suggestions disabled";
        if (enabled)
        {
            keyboardHook = AssistNative.SetWindowsHookExW(AssistNative.WhKeyboardLl, keyboardCallback, AssistNative.GetModuleHandleW(null), 0);
            if (keyboardHook == IntPtr.Zero) { enabled = false; status = "Windows could not enable the typing shortcut hook."; }
            else focusHook = AssistNative.SetWinEventHook(3, 3, IntPtr.Zero, focusCallback, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND
        }
        Enabled = enabled;
        if (enabled) highlightTracking.Start(); else { highlightTracking.Stop(); highlights.Hide(); }
        if (!enabled)
        {
            if (keyboardHook != IntPtr.Zero) AssistNative.UnhookWindowsHookEx(keyboardHook);
            if (focusHook != IntPtr.Zero) AssistNative.UnhookWinEvent(focusHook);
            keyboardHook = focusHook = IntPtr.Zero;
            consumedKeys.Clear(); shareTarget = null; Dismiss();
        }
        StateChanged?.Invoke(this, new(enabled, status));
    }

    private IntPtr Keyboard(int code, IntPtr message, IntPtr data)
    {
        if (code < 0 || !Enabled || disposed) return AssistNative.CallNextHookEx(keyboardHook, code, message, data);
        var keyEvent = Marshal.PtrToStructure<AssistNative.KeyboardEvent>(data);
        if ((keyEvent.Flags & AssistNative.LlkhfInjected) != 0) return AssistNative.CallNextHookEx(keyboardHook, code, message, data);
        int key = (int)keyEvent.VirtualKey;
        bool down = message.ToInt32() is AssistNative.WmKeyDown or AssistNative.WmSysKeyDown;
        bool up = message.ToInt32() is AssistNative.WmKeyUp or AssistNative.WmSysKeyUp;
        if (up && consumedKeys.Remove(key)) return new IntPtr(1);
        if (!down) return AssistNative.CallNextHookEx(keyboardHook, code, message, data);
        bool visible = popup.IsVisible && context != null && context.Foreground == AssistNative.GetForegroundWindow();
        bool control = AssistNative.Down(AssistNative.VkControl), shift = AssistNative.Down(AssistNative.VkShift);
        bool otherModifier = AssistNative.Down(AssistNative.VkAlt) || AssistNative.Down(AssistNative.VkLWin) || AssistNative.Down(AssistNative.VkRWin);
        if (visible && !otherModifier)
        {
            Action? action = null;
            if (key == AssistNative.VkEscape) action = Dismiss;
            else if (key is AssistNative.VkDown or AssistNative.VkUp && !control && !shift)
                action = () => { if (prediction == null) return; popup.Select((popup.SelectedIndex + (key == AssistNative.VkDown ? 1 : prediction.Suggestions.Count - 1)) % prediction.Suggestions.Count); _ = PreviewAsync(); };
            else if (key == 0x73 && !control && !shift) action = () => OpenSource(false); // F4
            else if (key == AssistNative.VkReturn && control && shift) action = () => OpenSource(true);
            else if (key == AssistNative.VkTab && !control && !shift) action = () => _ = AcceptAsync();
            else if (key == AssistNative.VkReturn && control && !shift) action = () => _ = AcceptAsync(false);
            if (action != null)
            {
                if (consumedKeys.Add(key)) dispatcher.BeginInvoke(action);
                return new IntPtr(1);
            }
        }
        // Changes, movement and shortcuts invalidate results immediately. UIA/network work
        // runs after the hook returns; the hook never reads or logs typed characters.
        if (key is not (AssistNative.VkControl or AssistNative.VkShift or AssistNative.VkAlt or AssistNative.VkLWin or AssistNative.VkRWin))
        {
            Dismiss(); highlights.Hide();
            if (!control && !otherModifier && !inserting && !string.IsNullOrEmpty(ProjectId)) debounce.Start();
        }
        return AssistNative.CallNextHookEx(keyboardHook, code, message, data);
    }

    private void Dismiss()
    {
        generation++;
        pending.Cancel(); pending.Dispose(); pending = new();
        debounce.Stop(); tracking.Stop(); popup.Hide(); context = null; prediction = null;
    }

    private async Task PredictAsync()
    {
        if (!Enabled || disposed || inserting || string.IsNullOrEmpty(ProjectId)) return;
        int revision = generation;
        string project = ProjectId;
        var token = pending.Token;
        try
        {
            var captured = await reader.CaptureAsync(token).WaitAsync(TimeSpan.FromMilliseconds(900), token);
            if (captured == null || captured.Before.Trim().Length < 2 || generation != revision) return;
            using var response = await client.PostAsJsonAsync($"api/projects/{Uri.EscapeDataString(project)}/dependencies/predict",
                new { text = captured.Before, cursor = captured.Before.Length, blockIndex = 0,
                    pendingDependencies = PendingDependencies(captured, project) }, token);
            response.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            var result = AssistPayload.ParsePrediction(body.RootElement, project);
            result = result with { Suggestions = result.Suggestions.Where(s => CompletionPlan.Create(captured.Before, s.InsertText, s.IsContinuation, s.ReplaceStart, s.ReplaceEnd) != null).ToArray() };
            if (generation != revision || !Enabled || ProjectId != project || result.Suggestions.Count == 0) return;
            var fresh = await reader.CurrentAsync(captured, token).WaitAsync(TimeSpan.FromMilliseconds(900), token);
            if (fresh == null || generation != revision) return;
            context = fresh; prediction = result; popup.Present(result, fresh.CaretBounds); tracking.Start();
            _ = PreviewAsync();
        }
        catch (Exception error) when (error is OperationCanceledException or TimeoutException or HttpRequestException or JsonException) { }
    }

    private object[] PendingDependencies(AutomationReader.Snapshot captured, string project)
    {
        var editor = string.Join(":", captured.RuntimeId);
        var title = AssistNative.WindowTitle(captured.Foreground);
        return references.Where(r => r.ProjectId == project && r.Anchor != null &&
            r.SnapshotId != null && r.EditorIdentity == editor && r.WindowTitle == title && r.HostWindow == captured.Foreground.ToInt64())
            .Select(r => new { Reference = r, Start = r.Anchor!.Locate(captured.Before + captured.After) })
            .Where(item => item.Start >= 0 && item.Start + item.Reference.Text.Length <= captured.Before.Length)
            .Take(50).Select(item => (object)new { blockIndex = 0, start = item.Start, end = item.Start + item.Reference.Text.Length,
                sourceObjectId = item.Reference.SourceId, sourceSnapshotId = item.Reference.SnapshotId }).ToArray();
    }

    private async Task RefreshHighlightsAsync()
    {
        if (highlightBusy || disposed || !Enabled || inserting) return;
        highlightBusy = true;
        var project = ProjectId;
        try
        {
            var geometry = await reader.LocateReferencesAsync(references.Where(r => r.ProjectId == project).ToArray(),
                CancellationToken.None).WaitAsync(TimeSpan.FromMilliseconds(1000));
            if (Enabled && !disposed && project == ProjectId) highlights.Present(geometry ?? []);
        }
        catch (TimeoutException) { highlights.Hide(); }
        finally { highlightBusy = false; }
    }

    private async Task TrackAsync()
    {
        if (trackingBusy || inserting || context == null || !popup.IsVisible) return;
        trackingBusy = true;
        int revision = generation;
        try
        {
            var fresh = await reader.CaptureAsync(pending.Token).WaitAsync(TimeSpan.FromMilliseconds(800), pending.Token);
            if (generation != revision) return;
            // Browser providers temporarily return no caret during layout/accessibility updates.
            // Keep the result until positive evidence of a changed target; acceptance rechecks it.
            if (context == null) return;
            if (AssistNative.GetForegroundWindow() != context.Foreground) Dismiss();
            else if (fresh != null)
            {
                if (!AutomationReader.SameElement(context, fresh) || context.Before != fresh.Before || context.After != fresh.After) Dismiss();
                else { context = fresh; popup.Place(fresh.CaretBounds); }
            }
        }
        catch (Exception error) when (error is OperationCanceledException or TimeoutException) { /* A slow provider does not expire an otherwise current suggestion. */ }
        finally { trackingBusy = false; }
    }

    private AssistSuggestion? Selected => prediction != null && popup.SelectedIndex < prediction.Suggestions.Count ? prediction.Suggestions[popup.SelectedIndex] : null;
    private async Task PreviewAsync()
    {
        var suggestion = Selected;
        if (suggestion?.ObjectId == null) return;
        int revision = generation, index = popup.SelectedIndex;
        try
        {
            var url = $"api/dependency-objects/{Uri.EscapeDataString(suggestion.ObjectId)}/preview?version={Uri.EscapeDataString(suggestion.VersionId ?? "")}";
            using var response = await client.GetAsync(url, pending.Token);
            response.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(pending.Token));
            if (generation == revision && popup.SelectedIndex == index) popup.SetPreview(AssistPayload.ParsePreview(body.RootElement));
        }
        catch (Exception error) when (error is OperationCanceledException or HttpRequestException or JsonException)
        { if (generation == revision && popup.SelectedIndex == index) popup.SetPreview("Open source to inspect the recorded evidence."); }
    }

    private void OpenSource(bool sharing)
    {
        var selected = Selected;
        if (selected?.ObjectId == null) return;
        shareTarget = sharing && context != null ? (Guid.NewGuid().ToString(), selected, context, AssistNative.WindowTitle(context.Foreground)) : null;
        Dismiss();
        OpenSourceRequested?.Invoke(this, new(selected.ObjectId, selected.VersionId, null, sharing)
            { ProjectId = selected.ProjectId, ShareInsertionId = shareTarget?.Id });
    }

    public async Task<string?> InsertSharedLinkAsync(string targetId, string shareToken)
    {
        if (shareTarget is not { } target || target.Id != targetId || !Enabled || inserting || target.Suggestion.ProjectId != ProjectId)
            return "The insertion target is no longer available. Choose the source again.";
        if (shareToken.Length > 200) return "Invalid source link.";
        bool matchedShare = false, completed = false;
        BorrowedClipboard? clipboard = null;
        inserting = true;
        try
        {
            using var response = await client.GetAsync($"api/projects/{Uri.EscapeDataString(target.Suggestion.ProjectId)}/object-shares");
            response.EnsureSuccessStatusCode();
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var share = AssistPayload.Items(body.RootElement, "shares").FirstOrDefault(item =>
                AssistPayload.Text(item, "token") == shareToken && AssistPayload.Text(item, "objectId") == target.Suggestion.ObjectId &&
                AssistPayload.Text(item, "versionId") == target.Suggestion.VersionId && AssistPayload.Text(item, "revokedAt") == null);
            var url = AssistPayload.Text(share, "url");
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")) return "The source link is unavailable.";
            matchedShare = true;
            var original = target.Snapshot;
            if (AssistNative.WindowTitle(original.Foreground) != target.Title) return "The browser tab changed. Choose the source again.";
            var suggestion = target.Suggestion;
            var normal = CompletionPlan.Create(original.Before, suggestion.InsertText, suggestion.IsContinuation, suggestion.ReplaceStart, suggestion.ReplaceEnd);
            if (normal == null) return "The insertion range is unavailable.";
            var rich = new CompletionPlan(original.Before, 0, suggestion.InsertText, normal.RemoveLength > 0 ? normal.RemoveLength : normal.PrefixLength);
            var fallback = rich with { Suffix = SharedLinkFormats.PlainText(suggestion.InsertText, url!) };
            clipboard = new BorrowedClipboard(suggestion.InsertText, url!);
            var fresh = await reader.RestoreFocusAsync(original, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
            if (fresh == null) return "The insertion point changed. Choose the source again.";
            var inserted = await reader.InsertAsync(fresh, rich, () => Enabled && !disposed && ProjectId == suggestion.ProjectId && clipboard.Unchanged,
                CancellationToken.None, () => clipboard.Unchanged && AssistNative.Paste(original.Foreground)).WaitAsync(TimeSpan.FromSeconds(2));
            if (inserted == null) return "The editor could not accept the link.";
            await Task.Delay(250);
            AutomationReader.Snapshot? verified = null;
            CompletionPlan accepted = rich;
            for (int attempt = 0; attempt < 4 && verified == null; attempt++)
            {
                verified = await reader.VerifyAsync(original, rich, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
                if (verified == null)
                {
                    verified = await reader.VerifyAsync(original, fallback, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(2));
                    if (verified != null) accepted = fallback;
                }
                if (verified == null) await Task.Delay(100);
            }
            if (verified == null) return "The pasted link could not be verified.";
            RecordReference(suggestion, original, verified, accepted.CompletedPhrase);
            _ = RecordUsageAsync(suggestion);
            completed = true;
            return null;
        }
        catch (Exception error) when (error is HttpRequestException or JsonException or OperationCanceledException or TimeoutException or ExternalException or InvalidOperationException)
        { return "The source link could not be inserted. " + error.Message; }
        finally
        {
            if (clipboard != null) await clipboard.RestoreAsync();
            if (matchedShare && !completed)
            {
                try { using var revoked = await client.PostAsJsonAsync($"api/object-shares/{Uri.EscapeDataString(shareToken)}/revoke", new { }); }
                catch (Exception error) when (error is HttpRequestException or OperationCanceledException) { HostPaths.Log("Could not revoke an unverified share; use Shared links to revoke it."); }
            }
            inserting = false; shareTarget = null; Dismiss();
            if (completed) { _ = RefreshHighlightsAsync(); debounce.Start(); }
        }
    }

    private void RecordReference(AssistSuggestion selected, AutomationReader.Snapshot original, AutomationReader.Snapshot verified, string phrase)
    {
        if (selected.ObjectId == null || selected.VersionId == null) return;
        string processName = "Supported editor";
        try { AssistNative.GetWindowThreadProcessId(original.Foreground, out var pid); using var process = Process.GetProcessById((int)pid); processName = process.ProcessName; } catch (ArgumentException) { }
        references.Insert(0, new(Guid.NewGuid().ToString(), selected.ProjectId, selected.ObjectId, selected.VersionId,
            selected.SnapshotId, selected.Path, phrase, processName, DateTimeOffset.Now,
            TextAnchor.AtCaret(verified.Before, verified.After, phrase), AssistNative.WindowTitle(original.Foreground),
            string.Join(":", verified.RuntimeId), original.Foreground.ToInt64(), sessionId));
        if (references.Count > 250) references.RemoveRange(250, references.Count - 250);
        SaveReferences(); ReferenceRecorded?.Invoke(this, EventArgs.Empty);
    }

    private async Task AcceptAsync(bool linkSource = true)
    {
        var selected = Selected; var original = context;
        if (inserting || selected == null || original == null || !Enabled) return;
        var plan = CompletionPlan.Create(original.Before, selected.InsertText, selected.IsContinuation, selected.ReplaceStart, selected.ReplaceEnd);
        if (plan == null) return;
        int revision = generation; var token = pending.Token;
        bool accepted = false;
        inserting = true; popup.Hide(); tracking.Stop();
        try
        {
            // Ctrl+Enter is released before Unicode injection; never leave a modifier stuck.
            for (int i = 0; AssistNative.AnyModifierDown && i < 40; i++) await Task.Delay(20, token);
            if (AssistNative.AnyModifierDown || revision != generation) return;
            var inserted = await reader.InsertAsync(original, plan, () => Enabled && !disposed && generation == revision, token)
                .WaitAsync(TimeSpan.FromMilliseconds(900), token);
            if (inserted == null) return;
            await Task.Delay(120, token);
            AutomationReader.Snapshot? verified = null;
            for (int attempt = 0; attempt < 4 && verified == null && generation == revision; attempt++)
            {
                verified = await reader.VerifyAsync(original, plan, token).WaitAsync(TimeSpan.FromMilliseconds(900), token);
                if (verified == null) await Task.Delay(80, token);
            }
            if (verified == null || generation != revision) return;
            if (linkSource) RecordReference(selected, original, verified, plan.CompletedPhrase);
            accepted = true;
            _ = RecordUsageAsync(selected);
        }
        catch (Exception error) when (error is OperationCanceledException or TimeoutException) { }
        finally { inserting = false; Dismiss(); if (accepted) { _ = RefreshHighlightsAsync(); debounce.Start(); } }
    }

    private async Task RecordUsageAsync(AssistSuggestion suggestion)
    {
        if (suggestion.UsageObjectId == null) return;
        try
        {
            using var response = await client.PostAsJsonAsync($"api/projects/{Uri.EscapeDataString(suggestion.ProjectId)}/recommendation-usage",
                new { objectId = suggestion.UsageObjectId, kind = "accept", sessionId });
        }
        catch (Exception error) when (error is HttpRequestException or OperationCanceledException or ObjectDisposedException) { }
    }

    private void SaveReferences()
    {
        try { File.WriteAllText(referencePath + ".tmp", JsonSerializer.Serialize(references)); File.Move(referencePath + ".tmp", referencePath, true); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { HostPaths.Log("Could not save an accepted source reference."); }
    }

    public void Dispose()
    {
        if (disposed) return;
        SetEnabled(false); disposed = true;
        debounce.Stop(); tracking.Stop(); pending.Cancel(); pending.Dispose();
        highlightTracking.Stop(); highlights.Dispose(); popup.Close(); reader.Dispose(); client.Dispose();
    }
}
