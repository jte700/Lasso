using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Lasso.Windows.Assist;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Forms = System.Windows.Forms;

namespace Lasso.Windows;

internal sealed class MainWindow : Window
{
    private readonly HostSettings settings = HostSettings.Load();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Grid layout = new();
    private readonly TextBlock loading = new() { Text = "Opening your workspace…", FontSize = 15,
        HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
    private readonly WebView2 browser = new() { Visibility = Visibility.Hidden };
    private readonly Forms.NotifyIcon tray;
    private readonly Forms.ToolStripMenuItem assistMenu;
    private ServerProcess? server;
    private AssistController? assist;
    private bool exiting;
    private bool pageReady;
    private bool trayNoticeShown;
    private Uri? baseUri;

    public MainWindow()
    {
        Title = "Lasso";
        Width = Math.Clamp(settings.Width, Math.Min(900, SystemParameters.WorkArea.Width), SystemParameters.WorkArea.Width);
        Height = Math.Clamp(settings.Height, Math.Min(600, SystemParameters.WorkArea.Height), SystemParameters.WorkArea.Height);
        MinWidth = 780;
        MinHeight = 520;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = new SolidColorBrush(Color.FromRgb(243, 243, 243));
        FontFamily = new FontFamily("Segoe UI");
        Icon = BitmapFrame.Create(new Uri("pack://application:,,,/Assets/lasso.ico"));
        Content = layout;
        layout.Children.Add(loading);
        layout.Children.Add(browser);
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("Open Lasso", null, (_, _) => Dispatcher.BeginInvoke(new Action(Reveal)));
        assistMenu = new Forms.ToolStripMenuItem("Writing suggestions") { CheckOnClick = false };
        assistMenu.Click += (_, _) => Dispatcher.BeginInvoke(new Action(() => SetAssistEnabled(!(assist?.Enabled ?? false))));
        menu.Items.Add(assistMenu);
        menu.Items.Add("Recent inserted sources", null, (_, _) => Dispatcher.BeginInvoke(new Action(ShowRecentSources)));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("Open log folder", null, (_, _) => OpenExternal(HostPaths.Logs, allowFolder: true));
        menu.Items.Add("Quit Lasso", null, (_, _) => Dispatcher.BeginInvoke(new Action(Quit)));
        tray = new Forms.NotifyIcon
        {
            Text = "Lasso",
            Icon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath!) ?? System.Drawing.SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(new Action(Reveal));
        Loaded += async (_, _) => await InitializeAsync();
        Closing += OnClosing;
        SourceInitialized += (_, _) => ApplyWindowsBackdrop();
    }

    private async Task InitializeAsync()
    {
        try
        {
            server = await ServerProcess.StartAsync(cancellationToken: lifetime.Token);
            if (exiting) { server.Dispose(); return; }
            server.UnexpectedExit += (_, _) => Dispatcher.BeginInvoke(new Action(() =>
            {
                if (exiting) return;
                assist?.SetEnabled(false);
                browser.Visibility = Visibility.Hidden;
                loading.Text = "Lasso's local server stopped. Quit and reopen Lasso to reconnect.\nYour workspace is saved. Details are in the Lasso log folder.";
                loading.TextAlignment = TextAlignment.Center;
                loading.Visibility = Visibility.Visible;
            }));
            baseUri = server.BaseUri!;
            assist = new AssistController(baseUri) { ProjectId = settings.ProjectId };
            assist.StateChanged += (_, args) => Dispatcher.BeginInvoke(new Action(() =>
            {
                settings.AssistEnabled = args.Enabled;
                settings.Save();
                assistMenu.Checked = args.Enabled;
                Send(new { type = "assist-state", enabled = args.Enabled });
            }));
            assist.OpenSourceRequested += (_, args) => Dispatcher.BeginInvoke(new Action(() =>
            {
                Reveal();
                Send(new { type = "open-source", sourceId = args.SourceId, versionId = args.VersionId,
                    fragmentId = args.FragmentId, openSharing = args.OpenSharing, shareInsertionId = args.ShareInsertionId, projectId = args.ProjectId ?? assist.ProjectId });
            }));
            var environment = await CoreWebView2Environment.CreateAsync(null, HostPaths.Browser);
            if (exiting) return;
            await browser.EnsureCoreWebView2Async(environment);
            var core = browser.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = true;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsWebMessageEnabled = true;
            core.NavigationStarting += (_, args) =>
            {
                if (IsTrusted(args.Uri)) { pageReady = false; return; }
                args.Cancel = true;
                OpenExternal(args.Uri);
            };
            // Native bridge is subscribed only on CoreWebView2 (top-level), never
            // CoreWebView2Frame. Local preview iframes cannot call the host.
            core.FrameNavigationStarting += (_, args) => { if (!IsTrusted(args.Uri) && args.Uri != "about:blank") args.Cancel = true; };
            core.WebMessageReceived += OnWebMessage;
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                if (IsTrusted(args.Uri)) core.Navigate(args.Uri);
                else OpenExternal(args.Uri);
            };
            core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
            core.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess && IsTrusted(core.Source))
                {
                    pageReady = true;
                    loading.Visibility = Visibility.Collapsed;
                    browser.Visibility = Visibility.Visible;
                    Send(new { type = "assist-state", enabled = assist.Enabled });
                }
                else if (!args.IsSuccess && args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                    ShowFailure("The workspace could not load. Quit and reopen Lasso to reconnect.");
            };
            core.ProcessFailed += (_, args) =>
            {
                if (args.ProcessFailedKind is CoreWebView2ProcessFailedKind.BrowserProcessExited or CoreWebView2ProcessFailedKind.RenderProcessExited)
                    ShowFailure("The workspace display stopped. Quit and reopen Lasso to restore it.");
            };
            assist.SetEnabled(settings.AssistEnabled);
            assistMenu.Checked = assist.Enabled;
            core.Navigate(new Uri(baseUri, "?app=1&platform=windows").AbsoluteUri);
        }
        catch (OperationCanceledException) when (exiting) { }
        catch (WebView2RuntimeNotFoundException error)
        {
            HostPaths.Log(error.ToString());
            assist?.Dispose();
            server?.Dispose();
            ShowFailure("Microsoft Edge WebView2 Runtime is required. Install it, then reopen Lasso.",
                "Install WebView2", () => OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/"));
        }
        catch (Exception error)
        {
            HostPaths.Log(error.ToString());
            assist?.Dispose();
            server?.Dispose();
            ShowFailure(error is OperationCanceledException ? "Lasso took too long to start. Reopen it and try again." : error.Message);
        }
    }

    private bool IsTrusted(string? value) => baseUri != null && Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && uri.Scheme == baseUri.Scheme && uri.Host == baseUri.Host && uri.Port == baseUri.Port && uri.UserInfo.Length == 0;

    private bool IsWorkspace(string? value) => IsTrusted(value) && new Uri(value!).AbsolutePath is "/" or "/index.html";

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsWorkspace(args.Source) || !IsWorkspace(browser.CoreWebView2.Source) || exiting) return;
        try
        {
            if (args.WebMessageAsJson.Length > 8192) return;
            using var message = JsonDocument.Parse(args.WebMessageAsJson);
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            if (root.TryGetProperty("activeProjectId", out var currentProject))
            {
                UpdateProject(currentProject.ValueKind == JsonValueKind.Null ? null : currentProject.GetString());
                return;
            }
            string? action = root.TryGetProperty("action", out var command) ? command.GetString()
                : root.TryGetProperty("type", out command) ? command.GetString() : null;
            switch (action)
            {
                case "activeProjectId":
                    string? project = root.TryGetProperty("projectId", out var id) ? id.GetString() : null;
                    UpdateProject(project);
                    break;
                case "toggleSuggestions": SetAssistEnabled(!(assist?.Enabled ?? false)); break;
                case "suggestionState": Send(new { type = "assist-state", enabled = assist?.Enabled ?? false }); break;
                case "appearance":
                    if (root.TryGetProperty("dark", out var dark) && dark.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    {
                        int enabled = dark.GetBoolean() ? 1 : 0;
                        DwmSetWindowAttribute(new WindowInteropHelper(this).Handle, 20, ref enabled, sizeof(int));
                        Background = new SolidColorBrush(enabled == 1 ? Color.FromRgb(32,32,32) : Color.FromRgb(243,243,243));
                    }
                    break;
                case "insertSharedLink":
                    if (assist != null && root.TryGetProperty("targetId", out var targetId) && targetId.ValueKind == JsonValueKind.String &&
                        root.TryGetProperty("token", out var shareToken) && shareToken.ValueKind == JsonValueKind.String)
                        _ = InsertSharedLinkAsync(targetId.GetString()!, shareToken.GetString()!);
                    break;
                case "chooseFolder":
                    var picker = new Microsoft.Win32.OpenFolderDialog { Title = "Choose a project folder", Multiselect = false };
                    var accepted = picker.ShowDialog(this) == true;
                    Send(new { type = "folder-selected", path = accepted ? picker.FolderName : null });
                    break;
            }
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or ArgumentException)
        { HostPaths.Log("Native bridge: " + error.Message); Send(new { type = "host-error", message = "Lasso could not complete that action." }); }
    }

    private async System.Threading.Tasks.Task InsertSharedLinkAsync(string targetId, string token)
    {
        if (assist == null) return;
        var error = await assist.InsertSharedLinkAsync(targetId, token);
        Send(new { type = "share-inserted", targetId, error });
        if (error != null) Reveal();
    }

    private void UpdateProject(string? project)
    {
        if (project?.Length > 256) return;
        if (assist != null) assist.ProjectId = project;
        settings.ProjectId = project;
        settings.Save();
    }

    private void SetAssistEnabled(bool enabled)
    {
        if (assist == null) return;
        assist.SetEnabled(enabled);
        assistMenu.Checked = assist.Enabled;
        settings.AssistEnabled = assist.Enabled;
        settings.Save();
        Send(new { type = "assist-state", enabled = assist.Enabled });
    }

    private void Send(object message)
    {
        if (pageReady && !exiting && browser.CoreWebView2 != null && IsTrusted(browser.CoreWebView2.Source))
            browser.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
    }

    private void ShowRecentSources()
    {
        Reveal();
        var dialog = new Window { Owner = this, Title = "Recent inserted sources", Width = 620, Height = 480,
            WindowStartupLocation = WindowStartupLocation.CenterOwner, FontFamily = new FontFamily("Segoe UI") };
        var entries = new StackPanel { Margin = new Thickness(20) };
        entries.Children.Add(new TextBlock { Text = "Sources inserted in other apps", FontSize = 22, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0,0,0,16) });
        var references = assist?.GetRecentReferences();
        if (references == null || references.Count == 0) entries.Children.Add(new TextBlock { Text = "Accepted, verified source references will appear here.", TextWrapping = TextWrapping.Wrap });
        if (references != null) foreach (var reference in references)
        {
            var button = new Button { HorizontalContentAlignment = HorizontalAlignment.Left, Padding = new Thickness(12), Margin = new Thickness(0,0,0,8),
                Content = new TextBlock { Text = reference.Text + "\n" + reference.Path + " · " + reference.HostProcess + " · " + reference.RecordedAt.ToString("g"), TextWrapping = TextWrapping.Wrap } };
            button.Click += (_, _) => { dialog.Close(); assist?.OpenReference(reference); };
            entries.Children.Add(button);
        }
        dialog.Content = new ScrollViewer { Content = entries, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        dialog.ShowDialog();
    }

    private void ShowFailure(string message, string? actionLabel = null, Action? action = null)
    {
        browser.Visibility = Visibility.Hidden;
        loading.Visibility = Visibility.Collapsed;
        var panel = new StackPanel { MaxWidth = 520, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(32) };
        panel.Children.Add(new TextBlock { Text = "Let's get Lasso running", FontSize = 24, FontWeight = FontWeights.SemiBold });
        panel.Children.Add(new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 16, 0, 20), FontSize = 14 });
        if (action != null)
        {
            var button = new Button { Content = actionLabel, Padding = new Thickness(16, 8, 16, 8), HorizontalAlignment = HorizontalAlignment.Left };
            button.Click += (_, _) => action();
            panel.Children.Add(button);
        }
        var logs = new Button { Content = "Open log folder", Margin = new Thickness(0, 12, 0, 0), Padding = new Thickness(16, 8, 16, 8), HorizontalAlignment = HorizontalAlignment.Left };
        logs.Click += (_, _) => OpenExternal(HostPaths.Logs, allowFolder: true);
        panel.Children.Add(logs);
        layout.Children.Add(panel);
    }

    public void Reveal()
    {
        if (exiting) return;
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    private void OnClosing(object? sender, CancelEventArgs args)
    {
        if (exiting) return;
        args.Cancel = true;
        SaveWindowSize();
        Hide();
        if (!trayNoticeShown)
        {
            trayNoticeShown = true;
            tray.ShowBalloonTip(4000, "Lasso is still running", "Open Lasso or quit from its icon in the notification area.", Forms.ToolTipIcon.Info);
        }
    }

    private void SaveWindowSize()
    {
        settings.Width = RestoreBounds.Width > 0 ? RestoreBounds.Width : Width;
        settings.Height = RestoreBounds.Height > 0 ? RestoreBounds.Height : Height;
        settings.Save();
    }

    private void Quit() { ShutdownHost(); Application.Current.Shutdown(); }

    public void ShutdownHost()
    {
        if (exiting) return;
        SaveWindowSize();
        exiting = true;
        lifetime.Cancel();
        assist?.Dispose();
        browser.Dispose();
        tray.Visible = false;
        tray.Dispose();
        server?.Dispose();
    }

    private static void OpenExternal(string value, bool allowFolder = false)
    {
        if (!allowFolder && (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))) return;
        try { Process.Start(new ProcessStartInfo(value) { UseShellExecute = true }); }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException) { HostPaths.Log("Open external: " + error.Message); }
    }

    private void ApplyWindowsBackdrop()
    {
        // Keep the actual OS caption, system menu, resize border and Snap Layouts.
        // Windows 10 ignores these Windows 11 attributes and retains its native frame.
        var handle = new WindowInteropHelper(this).Handle;
        int backdrop = 2; // DWMSBT_MAINWINDOW (Mica)
        DwmSetWindowAttribute(handle, 38, ref backdrop, sizeof(int));
        int corners = 2; // DWMWCP_ROUND
        DwmSetWindowAttribute(handle, 33, ref corners, sizeof(int));
    }

    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
