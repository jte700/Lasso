//  Lasso - Windows notification area application.
//
//  The app lives in the notification area. It supervises the local Lasso server
//  as a background child process and shows the workspace in a WebView2 window.
//  No application logic lives here: this is a native shell around the same
//  local-first server that `npm start` runs.

using System.Diagnostics;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using Lasso.Core;
using Lasso.Windows.Assist;
using Lasso.Windows.Server;
using Lasso.Windows.Support;
using Lasso.Windows.Tray;
using Lasso.Windows.Workspace;

namespace Lasso.Windows;

public partial class App : Application
{
    public static bool IsShuttingDown { get; private set; }

    private static Mutex? _single;

    private TrayHost? _tray;
    private WorkspaceWindow? _workspace;
    private SourceInspectorWindow? _inspector;
    private ServerController? _server;
    private bool _hasPresented;

    protected override void OnStartup(StartupEventArgs args)
    {
        base.OnStartup(args);

        // One companion per user session: a second icon supervising a second
        // server would fight for the loopback port and the history store.
        _single = new Mutex(initiallyOwned: true, "Lasso.Windows.Companion", out var created);
        if (!created)
        {
            _single.Dispose();
            _single = null;
            IsShuttingDown = true;
            Shutdown();
            return;
        }

        AppPaths.EnsureCreated();
        AssistLog.Enabled = AppSettings.Current.AssistDebug;

        // Visual checks render the real panel with fixed content, with no
        // server, host application, or project data involved.
        if (Environment.GetEnvironmentVariable("LASSO_OVERLAY_FIXTURE") == "1")
        {
            Assist.AssistDesignFixture.Show();
            return;
        }

        _workspace = new WorkspaceWindow
        {
            OnActiveProjectChanged = projectId => GlobalAssistant.Shared.ProjectId = projectId,
            OnToggleSuggestions = ToggleSuggestions,
            OnSuggestionStateRequested = PublishAssistState,
        };

        GlobalAssistant.Shared.OnStateChange = () => Dispatcher.BeginInvoke(PublishAssistState);
        GlobalAssistant.Shared.ChooseSourceAsync = ChooseSourceAsync;
        GlobalAssistant.Shared.ComposeShareAsync = suggestion => ComposeShareAsync(suggestion, "Insert link");
        GlobalAssistant.Shared.OnVerifiedInsertion = DependencyHighlighter.Shared.RecordVerifiedInsertion;
        StartHighlighting();

        _tray = new TrayHost
        {
            OnPrimaryClick = () => _workspace?.Toggle(),
            BuildMenu = BuildMenu,
        };

        _server = new ServerController(
            appDirectory: ResolveAppDirectory(),
            dataDirectory: AppPaths.Data,
            logPath: AppPaths.ServerLog);
        _server.OnStateChange = state => Dispatcher.Invoke(() => Render(state));
        _server.Start();
    }

    /// The bundled server, or the repository itself when running from a build
    /// output during development.
    private static string ResolveAppDirectory()
    {
        var baseDirectory = AppContext.BaseDirectory;
        var bundled = Path.Combine(baseDirectory, "app");
        if (File.Exists(Path.Combine(bundled, "src", "server.js"))) return bundled;

        // Walk up looking for the repository root, so `dotnet run` works.
        var directory = new DirectoryInfo(baseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "src", "server.js"))) return directory.FullName;
            directory = directory.Parent;
        }
        return baseDirectory;
    }

    private void Render(ServerState state)
    {
        _tray?.SetTooltip(state.Phase switch
        {
            ServerPhase.Ready => $"Lasso - running on port {_server?.Port}",
            ServerPhase.Failed => "Lasso - server stopped",
            _ => "Lasso - starting",
        });

        switch (state.Phase)
        {
            case ServerPhase.Ready when _server?.Url is { } url && _workspace is { } workspace:
                GlobalAssistant.Shared.ServerUrl = url;
                DependencyHighlighter.Shared.ServerUrl = url;
                // `app=1` lets the web layer drop its simulated window chrome,
                // and `view=documents` opens straight into the editor.
                var target = new Uri(url, "?app=1&view=documents");
                workspace.Load(target);
                // Show the workspace once on launch; afterwards the tray icon
                // toggles it and closing only hides it.
                if (!_hasPresented)
                {
                    _hasPresented = true;
                    workspace.Present();
                    // Integration checks need suggestions on without a click.
                    // Never on by default: assistance stays opt-in.
                    if (Environment.GetEnvironmentVariable("LASSO_ASSIST_AUTOSTART") == "1"
                        && !GlobalAssistant.Shared.IsEnabled)
                    {
                        _ = AdoptFirstProjectAsync().ContinueWith(
                            _ => Dispatcher.BeginInvoke(ToggleSuggestions),
                            TaskScheduler.Default);
                    }
                }
                break;
            case ServerPhase.Failed:
                _workspace?.ShowMessage(state.Message ?? "The Lasso server stopped.");
                break;
            case ServerPhase.Starting:
                _workspace?.ShowMessage("Starting the local Lasso server...");
                break;
        }
    }

    private ContextMenu BuildMenu()
    {
        var menu = new ContextMenu();

        var status = new MenuItem
        {
            Header = _server?.State.Phase switch
            {
                ServerPhase.Ready => $"Server: running on port {_server.Port}",
                ServerPhase.Failed => $"Server: {_server?.State.Message}",
                _ => "Server: starting...",
            },
            IsEnabled = false,
        };
        menu.Items.Add(status);
        menu.Items.Add(new Separator());

        menu.Items.Add(Item("Open Lasso", () => _workspace?.Present()));
        menu.Items.Add(Item("Open in Browser", () =>
        {
            if (_server?.Url is { } url) WorkspaceWindow.OpenExternally(url.AbsoluteUri);
        }));
        menu.Items.Add(Item("Reload", () => _workspace?.Reload()));
        menu.Items.Add(new Separator());

        var suggest = new MenuItem
        {
            Header = "Suggest While Typing Anywhere",
            IsCheckable = true,
            IsChecked = GlobalAssistant.Shared.IsEnabled,
        };
        suggest.Click += (_, _) => ToggleSuggestions();
        menu.Items.Add(suggest);

        var insertion = new MenuItem { Header = "Dependency insertion" };
        foreach (var mode in Enum.GetValues<InsertionMode>())
        {
            var item = new MenuItem
            {
                Header = mode.Title(),
                IsCheckable = true,
                IsChecked = AppSettings.Current.InsertionMode == mode,
            };
            var captured = mode;
            item.Click += (_, _) =>
            {
                AppSettings.Current.InsertionMode = captured;
                AppSettings.Current.Save();
            };
            insertion.Items.Add(item);
        }
        menu.Items.Add(insertion);

        menu.Items.Add(Item("Re-read Sources with the Current Reader", () => _ = ReindexAsync()));

        menu.Items.Add(Item("Restart Server", () => _server?.Restart()));

        var typingLog = new MenuItem
        {
            Header = "Write a typing log",
            IsCheckable = true,
            IsChecked = AppSettings.Current.AssistDebug,
        };
        typingLog.Click += (_, _) =>
        {
            AppSettings.Current.AssistDebug = !AppSettings.Current.AssistDebug;
            AppSettings.Current.Save();
            AssistLog.Enabled = AppSettings.Current.AssistDebug;
        };
        menu.Items.Add(typingLog);

        var geometry = new MenuItem
        {
            Header = "Show Dependency Geometry",
            IsCheckable = true,
            IsChecked = DependencyHighlighter.Shared.IsDebugging,
        };
        geometry.Click += (_, _) =>
            DependencyHighlighter.Shared.IsDebugging = !DependencyHighlighter.Shared.IsDebugging;
        menu.Items.Add(geometry);

        menu.Items.Add(Item("Reveal Server Log", () => Reveal(AppPaths.ServerLog)));
        menu.Items.Add(Item("Reveal Typing Log", () => Reveal(AppPaths.AssistLogFile)));
        menu.Items.Add(new Separator());
        menu.Items.Add(Item("Quit Lasso", Quit));
        return menu;
    }

    /// Local dependency highlights: Lasso's own visual layer over other apps.
    private void StartHighlighting()
    {
        _inspector = new SourceInspectorWindow
        {
            OnUnlink = reference => DependencyHighlighter.Shared.Unlink(reference.Id),
            OnOpenSource = reference =>
            {
                if (_server?.Url is not { } url) return;
                // The exact indexed source, never a similarly named file.
                var target = new UriBuilder(new Uri(url, "inspect"))
                {
                    Query = $"object={Uri.EscapeDataString(reference.ObjectId)}"
                        + (reference.VersionId is { Length: > 0 } version
                            ? $"&version={Uri.EscapeDataString(version)}" : ""),
                }.Uri;
                WorkspaceWindow.OpenExternally(target.AbsoluteUri);
                _ = Assist.AssistHttp.RecordResolvedOpenAsync(url, reference.ObjectId);
            },
            OnShare = reference => _ = ShareFromInspectorAsync(reference),
        };

        DependencyHighlighter.Shared.OnInspect = (reference, bounds) =>
        {
            if (_server?.Url is not { } url) return;
            _inspector?.ShowFor(reference, bounds, url);
        };
        DependencyHighlighter.Shared.Start();
    }

    private async Task ShareFromInspectorAsync(Lasso.Core.DependencyReference reference)
    {
        if (_server?.Url is not { } url || GlobalAssistant.Shared.ProjectId is not { } projectId) return;
        _inspector?.Hide();

        var configuration = await ShareComposerWindow.ComposeAsync(
            url, reference.ObjectId, reference.VersionId, reference.Label, reference.SourcePath,
            "Copy link").ConfigureAwait(true);
        if (configuration is null) return;

        var share = await Assist.AssistHttp.CreateShareAsync(
            url, projectId, reference.ObjectId, reference.VersionId, configuration).ConfigureAwait(true);
        if (share is null) return;
        try
        {
            Clipboard.SetText(share.Url.AbsoluteUri);
        }
        catch (Exception)
        {
            // Another application is holding the clipboard; the link still exists.
        }
    }

    private async Task<Lasso.Core.ShareConfiguration?> ComposeShareAsync(
        Lasso.Core.AssistSuggestion suggestion, string actionTitle)
    {
        if (_server?.Url is not { } url || suggestion.ObjectId is not { } objectId) return null;
        return await ShareComposerWindow.ComposeAsync(
            url, objectId, suggestion.VersionId, suggestion.Label, suggestion.Path, actionTitle)
            .ConfigureAwait(true);
    }

    /// Suggestions everywhere are opt-in and off by default, as on macOS.
    private void ToggleSuggestions()
    {
        var assistant = GlobalAssistant.Shared;
        if (assistant.IsEnabled)
        {
            assistant.Disable();
            PublishAssistState();
            return;
        }

        assistant.ServerUrl = _server?.Url;
        if (assistant.ProjectId is null) _ = AdoptFirstProjectAsync();

        if (assistant.Enable() is { } problem)
        {
            MessageBox.Show(problem, "Suggestions everywhere",
                MessageBoxButton.OK, MessageBoxImage.Information);
        }
        PublishAssistState();
    }

    /// Re-reads the indexed files with the reader this build ships.
    ///
    /// Always something the user asks for: it records a new version and may
    /// leave claims needing review, so it is never done on their behalf when a
    /// newer reader arrives.
    private async Task ReindexAsync()
    {
        if (_server?.Url is not { } url) return;
        var projectId = GlobalAssistant.Shared.ProjectId
            ?? await Assist.AssistHttp.FirstProjectIdAsync(url, CancellationToken.None).ConfigureAwait(true);
        if (projectId is null)
        {
            MessageBox.Show("No directory is indexed yet.", "Re-read sources",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        var outcome = await Assist.AssistHttp.ReindexAsync(url, projectId, CancellationToken.None)
            .ConfigureAwait(true);
        var message = outcome is null
            ? "The sources could not be re-read."
            : !outcome.Changed
                ? "The current reader reads these files exactly as recorded. Nothing was changed."
                : $"Version {outcome.Version} records a new reading of the same files: "
                    + $"{outcome.Before} sources before, {outcome.After} now. "
                    + "Earlier versions are unchanged, so existing links and shares still resolve."
                    + (outcome.NeedsReview > 0
                        ? $"\n\n{outcome.NeedsReview} claim(s) need review: the new reader identifies their source differently."
                        : "");
        MessageBox.Show(message, "Re-read sources", MessageBoxButton.OK, MessageBoxImage.Information);
        _workspace?.Reload();
    }

    /// Falls back to the first indexed project when the workspace has not
    /// reported one yet, so suggestions work straight from the tray.
    private async Task AdoptFirstProjectAsync()
    {
        if (_server?.Url is not { } url) return;
        var projectId = await Assist.AssistHttp.FirstProjectIdAsync(url, CancellationToken.None)
            .ConfigureAwait(true);
        if (projectId is not null && GlobalAssistant.Shared.ProjectId is null)
        {
            GlobalAssistant.Shared.ProjectId = projectId;
        }
    }

    private void PublishAssistState() => _workspace?.PublishAssistState(GlobalAssistant.Shared.IsEnabled);

    /// Shown when the panel asks to browse sources.
    private async Task<SourceChoice?> ChooseSourceAsync(string? sourcePath)
    {
        if (_server?.Url is not { } url || GlobalAssistant.Shared.ProjectId is not { } projectId)
        {
            return null;
        }
        return await SourceChooserWindow.ChooseAsync(url, projectId, sourcePath).ConfigureAwait(true);
    }

    private static MenuItem Item(string header, Action action)
    {
        var item = new MenuItem { Header = header };
        item.Click += (_, _) => action();
        return item;
    }

    /// Selects the file in Explorer, the counterpart of revealing it in Finder.
    private static void Reveal(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, "");
            }
            Process.Start(new ProcessStartInfo("explorer.exe", $"/select,\"{path}\"")
            {
                UseShellExecute = true,
            });
        }
        catch (Exception)
        {
            // Explorer is unavailable; nothing else to do.
        }
    }

    private void Quit()
    {
        IsShuttingDown = true;
        _server?.Stop();
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs args)
    {
        IsShuttingDown = true;
        DependencyHighlighter.Shared.Dispose();
        _server?.Dispose();
        _tray?.Dispose();
        _single?.ReleaseMutex();
        _single?.Dispose();
        base.OnExit(args);
    }
}
