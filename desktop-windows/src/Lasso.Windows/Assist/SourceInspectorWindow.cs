//  The Source Inspector shown when a highlighted dependency is clicked.
//
//  It reuses the workspace's own source rendering — the window loads the same
//  locally served view the share page is built from — so provenance is
//  described in exactly one place rather than being restated natively.

using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Lasso.Core;
using Lasso.Windows.Branding;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

internal sealed class SourceInspectorWindow : Window
{
    private const double PanelWidth = 420;
    private const double PanelHeight = 540;

    private readonly WebView2 _web = new();
    private DependencyReference? _reference;
    private Uri? _server;
    private bool _ready;
    private bool _resolved;

    public Action<DependencyReference>? OnOpenSource { get; set; }
    public Action<DependencyReference>? OnShare { get; set; }
    public Action<DependencyReference>? OnUnlink { get; set; }

    public SourceInspectorWindow()
    {
        Title = "Source";
        Width = PanelWidth;
        Height = PanelHeight;
        MinWidth = 380;
        MinHeight = 440;
        WindowStyle = WindowStyle.ToolWindow;
        ShowInTaskbar = false;
        ShowActivated = false;
        Topmost = true;
        Icon = LassoGlyph.Image(64);
        Content = _web;

        _web.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        _web.CoreWebView2InitializationCompleted += OnReady;
        SourceInitialized += (_, _) => WindowComposition.Apply(this, Backdrop.Acrylic, CornerStyle.Round);
        Loaded += (_, _) => _ = InitializeAsync();
        Closing += (_, args) =>
        {
            args.Cancel = true;
            Hide();
        };
    }

    private async Task InitializeAsync()
    {
        if (_web.CoreWebView2 is not null) return;
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null, userDataFolder: AppPaths.WebViewProfile);
            await _web.EnsureCoreWebView2Async(environment);
        }
        catch (Exception error)
        {
            AssistLog.Write($"inspector: WebView2 unavailable ({error.Message})");
        }
    }

    private void OnReady(object? sender, CoreWebView2InitializationCompletedEventArgs args)
    {
        if (!args.IsSuccess || _web.CoreWebView2 is not { } core) return;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.AddScriptToExecuteOnDocumentCreatedAsync(BridgeScript);
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += (_, completed) => _resolved = completed.IsSuccess;
        _ready = true;
        if (_pending is { } target) Navigate(target);
    }

    private Uri? _pending;

    /// Beside the words when there is room, otherwise left, below, or above —
    /// always fully on the monitor the dependency is on. Coordinates arrive in
    /// physical pixels.
    public void ShowFor(DependencyReference reference, HostRect anchor, Uri server)
    {
        _reference = reference;
        _server = server;
        _resolved = false;

        var address = new UriBuilder(new Uri(server, "inspect"))
        {
            Query = $"object={Uri.EscapeDataString(reference.ObjectId)}"
                + (reference.VersionId is { Length: > 0 } version
                    ? $"&version={Uri.EscapeDataString(version)}" : "")
                + $"&reference={Uri.EscapeDataString(reference.Id)}",
        }.Uri;
        Navigate(address);

        if (!IsVisible) Show();
        Place(anchor);
    }

    private void Navigate(Uri address)
    {
        if (!_ready)
        {
            _pending = address;
            return;
        }
        _pending = null;
        _web.Source = address;
    }

    private void Place(HostRect anchor)
    {
        var point = new NativeMethods.POINT
        {
            X = (int)Math.Round(anchor.MidX),
            Y = (int)Math.Round(anchor.MidY),
        };
        var monitor = NativeMethods.MonitorFromPoint(point, NativeMethods.MONITOR_DEFAULTTONEAREST);
        var scale = 1.0;
        if (monitor != IntPtr.Zero
            && NativeMethods.GetDpiForMonitor(monitor, NativeMethods.MDT_EFFECTIVE_DPI, out var dpiX, out _) == 0
            && dpiX > 0)
        {
            scale = dpiX / 96.0;
        }

        var info = new NativeMethods.MONITORINFO
        {
            cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.MONITORINFO>(),
        };
        var work = monitor != IntPtr.Zero && NativeMethods.GetMonitorInfo(monitor, ref info)
            ? info.rcWork
            : new NativeMethods.RECT { Left = 0, Top = 0, Right = 1920, Bottom = 1080 };

        var width = (int)Math.Round(PanelWidth * scale);
        var height = (int)Math.Round(PanelHeight * scale);
        var gap = (int)Math.Round(10 * scale);

        var x = (int)Math.Round(anchor.MaxX) + gap;
        if (x + width > work.Right) x = (int)Math.Round(anchor.MinX) - width - gap;
        x = Math.Max(work.Left + 4, Math.Min(x, work.Right - width - 4));

        var y = (int)Math.Round(anchor.MinY) - height + (int)Math.Round(anchor.Height);
        if (y < work.Top) y = (int)Math.Round(anchor.MaxY) + gap;
        y = Math.Max(work.Top + 4, Math.Min(y, work.Bottom - height - 4));

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero) return;
        NativeMethods.SetWindowPos(handle, NativeMethods.HWND_TOPMOST, x, y, width, height,
            NativeMethods.SWP_NOACTIVATE);
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (_server is null || _reference is not { } reference) return;
        if (!Uri.TryCreate(args.Source, UriKind.Absolute, out var source)) return;
        if (source.Host != _server.Host || source.Port != _server.Port) return;

        try
        {
            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            if (document.RootElement.ValueKind != JsonValueKind.Object) return;
            var action = JsonReading.String(document.RootElement, "action");
            switch (action)
            {
                case "open": OnOpenSource?.Invoke(reference); break;
                case "share": OnShare?.Invoke(reference); break;
                case "unlink": OnUnlink?.Invoke(reference); Hide(); break;
                case "close": Hide(); break;
            }
        }
        catch (JsonException)
        {
            // A message the inspector does not understand is ignored.
        }
    }

    /// Records an explicit open once the recorded source actually resolved.
    public async Task RecordOpenIfResolvedAsync()
    {
        if (_resolved && _server is { } server && _reference is { } reference)
        {
            await AssistHttp.RecordResolvedOpenAsync(server, reference.ObjectId).ConfigureAwait(true);
        }
    }

    private const string BridgeScript = """
        (function () {
          var bridge = window.chrome && window.chrome.webview;
          if (!bridge) { return; }
          window.webkit = window.webkit || {};
          window.webkit.messageHandlers = window.webkit.messageHandlers || {};
          window.webkit.messageHandlers.inspector = {
            postMessage: function (payload) {
              try { bridge.postMessage(payload); } catch (error) { /* shell is gone */ }
            }
          };
        })();
        """;
}
