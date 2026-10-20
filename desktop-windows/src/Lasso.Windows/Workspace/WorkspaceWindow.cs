//  The workspace window.
//
//  The same local pages `npm start` serves, shown in WebView2 inside a normal
//  Windows 11 window: the system caption with its own buttons, Mica behind the
//  content, rounded corners, and the user's light or dark app mode. Closing it
//  hides it and leaves the server running, which is the point of a background
//  companion.

using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Lasso.Windows.Branding;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Workspace;

public sealed class WorkspaceWindow : Window
{
    private readonly WebView2 _web = new();
    private readonly TextBlock _status = new();
    private Uri? _serverOrigin;
    private bool _webReady;
    private Uri? _pending;

    /// The page reports the active project so system-wide suggestions know
    /// which indexed sources to draw from.
    public Action<string>? OnActiveProjectChanged { get; set; }
    public Action? OnToggleSuggestions { get; set; }
    public Action? OnSuggestionStateRequested { get; set; }

    public WorkspaceWindow()
    {
        Title = "Lasso";
        Width = 1040;
        Height = 700;
        MinWidth = 820;
        MinHeight = 560;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Icon = LassoGlyph.Image(64);
        ShowInTaskbar = true;

        _status.HorizontalAlignment = HorizontalAlignment.Center;
        _status.VerticalAlignment = VerticalAlignment.Center;
        _status.TextAlignment = TextAlignment.Center;
        _status.Opacity = 0.7;
        _status.Margin = new Thickness(32);
        _status.Text = "Starting the local Lasso server...";

        var root = new Grid();
        root.Children.Add(_status);
        root.Children.Add(_web);
        Content = root;

        _web.Visibility = Visibility.Collapsed;
        _web.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        _web.CoreWebView2InitializationCompleted += OnWebViewReady;

        SourceInitialized += (_, _) => WindowComposition.Apply(
            this, Backdrop.Mica, CornerStyle.Default);
        Loaded += (_, _) => _ = InitializeWebViewAsync();
        Closing += OnClosing;
    }

    /// Closing the window keeps the server running in the background, which is
    /// the point of a notification-area application.
    private void OnClosing(object? sender, System.ComponentModel.CancelEventArgs args)
    {
        if (App.IsShuttingDown) return;
        args.Cancel = true;
        Hide();
    }

    public void Present()
    {
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
        Focus();
    }

    public void Toggle()
    {
        if (IsVisible && IsActive) Hide();
        else Present();
    }

    private async Task InitializeWebViewAsync()
    {
        if (_web.CoreWebView2 is not null) return;
        try
        {
            AppPaths.EnsureCreated();
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: AppPaths.WebViewProfile);
            await _web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception error)
        {
            ShowMessage("The Microsoft Edge WebView2 runtime is required.\n\n" + error.Message);
        }
    }

    private void OnWebViewReady(object? sender, CoreWebView2InitializationCompletedEventArgs args)
    {
        if (!args.IsSuccess || _web.CoreWebView2 is not { } core)
        {
            ShowMessage("The workspace view could not be created. Open Lasso in your browser instead.");
            return;
        }

        var settings = core.Settings;
        settings.AreDefaultContextMenusEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.UserAgent = settings.UserAgent + " LassoDesktop";

        core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        core.WebMessageReceived += OnWebMessage;
        core.NewWindowRequested += OnNewWindowRequested;
        core.DocumentTitleChanged += (_, _) =>
        {
            var title = core.DocumentTitle;
            if (!string.IsNullOrWhiteSpace(title)) Title = title;
        };

        _webReady = true;
        if (_pending is { } target) Load(target);
    }

    /// External links belong in the user's browser, not in the workspace view.
    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        OpenExternally(args.Uri);
    }

    public static void OpenExternally(string uri)
    {
        try
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri)
            {
                UseShellExecute = true,
            });
        }
        catch (Exception)
        {
            // Nothing to do if the user has no handler for the scheme.
        }
    }

    public void Load(Uri url)
    {
        _serverOrigin = url;
        if (!_webReady)
        {
            _pending = url;
            return;
        }
        _pending = null;
        _status.Visibility = Visibility.Collapsed;
        _web.Visibility = Visibility.Visible;
        _web.Source = url;
    }

    public void Reload()
    {
        if (_webReady && _web.CoreWebView2 is { } core && _serverOrigin is not null) core.Reload();
    }

    public void ShowMessage(string message)
    {
        _status.Text = message;
        _status.Visibility = Visibility.Visible;
        _web.Visibility = Visibility.Collapsed;
    }

    /// Mirrors the macOS build's `publishAssistState`, using the same event the
    /// page already listens for.
    public void PublishAssistState(bool enabled)
    {
        if (!_webReady || _web.CoreWebView2 is not { } core) return;
        var flag = enabled ? "true" : "false";
        _ = core.ExecuteScriptAsync(
            "window.dispatchEvent(new CustomEvent('lasso-assist-state', {detail: {enabled: "
            + flag + "}}))");
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        // Only the local server this window was pointed at may drive the shell.
        if (_serverOrigin is null) return;
        if (!Uri.TryCreate(args.Source, UriKind.Absolute, out var source)) return;
        if (source.Scheme != _serverOrigin.Scheme || source.Host != _serverOrigin.Host
            || source.Port != _serverOrigin.Port)
        {
            return;
        }

        string json;
        try
        {
            json = args.WebMessageAsJson;
        }
        catch (Exception)
        {
            return;
        }

        try
        {
            using var document = JsonDocument.Parse(json);
            var payload = document.RootElement;
            if (payload.ValueKind != JsonValueKind.Object) return;
            if (payload.TryGetProperty("activeProjectId", out var project)
                && project.ValueKind == JsonValueKind.String
                && project.GetString() is { Length: > 0 } projectId)
            {
                OnActiveProjectChanged?.Invoke(projectId);
            }
            if (payload.TryGetProperty("action", out var action) && action.ValueKind == JsonValueKind.String)
            {
                switch (action.GetString())
                {
                    case "toggleSuggestions": OnToggleSuggestions?.Invoke(); break;
                    case "suggestionState": OnSuggestionStateRequested?.Invoke(); break;
                }
            }
        }
        catch (JsonException)
        {
            // A message the shell does not understand is ignored.
        }
    }

    /// Gives the page the same `window.webkit.messageHandlers.lasso` bridge the
    /// macOS build provides, so public/app.js needs no Windows-specific branch,
    /// and marks the document as running on Windows for the platform skin.
    private const string BridgeScript = """
        (function () {
          var bridge = window.chrome && window.chrome.webview;
          if (!bridge) { return; }
          function post(payload) {
            try { bridge.postMessage(payload); } catch (error) { /* shell is gone */ }
          }
          window.webkit = window.webkit || {};
          window.webkit.messageHandlers = window.webkit.messageHandlers || {};
          window.webkit.messageHandlers.lasso = { postMessage: post };
          function markPlatform() {
            var root = document.documentElement;
            if (!root) { return; }
            root.setAttribute('data-platform', 'windows');
          }
          markPlatform();
          document.addEventListener('DOMContentLoaded', markPlatform);
        })();
        """;
}
