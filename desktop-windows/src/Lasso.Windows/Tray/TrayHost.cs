//  The notification area icon and its menu.
//
//  The macOS companion lives in the menu bar: clicking the icon shows or hides
//  the workspace, and the menu holds browser access, server controls, and
//  writing-assistance settings. This is the same companion in the place Windows
//  keeps background applications — the notification area — with a real Windows
//  context menu rather than a drawn imitation.

using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Interop;
using System.Windows.Media;
using Lasso.Windows.Branding;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Tray;

public sealed class TrayHost : IDisposable
{
    private const int IconId = 1;
    private static readonly IntPtr HwndMessage = new(-3);

    private readonly HwndSource _source;
    private readonly uint _taskbarCreated;
    private readonly Window _menuHost;
    private IntPtr _icon;
    private bool _added;
    private string _tooltip = "Lasso";

    /// Builds the menu each time it is opened, so item state — the server's
    /// port, whether suggestions are on — is always current.
    public Func<ContextMenu>? BuildMenu { get; set; }
    public Action? OnPrimaryClick { get; set; }

    public TrayHost()
    {
        var parameters = new HwndSourceParameters("LassoTrayHost")
        {
            Width = 0,
            Height = 0,
            ParentWindow = HwndMessage,
            WindowStyle = 0,
        };
        _source = new HwndSource(parameters);
        _source.AddHook(WndProc);
        _taskbarCreated = NativeMethods.RegisterWindowMessage("TaskbarCreated");

        // A context menu needs a window to belong to and to take focus from.
        // This one is never seen: it is moved to the cursor only so the menu
        // opens on the right monitor, at the right scale.
        _menuHost = new Window
        {
            Width = 0,
            Height = 0,
            ShowInTaskbar = false,
            WindowStyle = WindowStyle.None,
            ResizeMode = ResizeMode.NoResize,
            AllowsTransparency = true,
            Background = null,
            Topmost = true,
            ShowActivated = true,
        };

        Add();
    }

    public void SetTooltip(string tooltip)
    {
        _tooltip = tooltip.Length > 127 ? tooltip[..127] : tooltip;
        if (!_added) return;
        var data = Describe(NativeMethods.NIF_TIP | NativeMethods.NIF_SHOWTIP);
        NativeMethods.Shell_NotifyIcon(NativeMethods.NIM_MODIFY, ref data);
    }

    private void Add()
    {
        RefreshIconHandle();
        var data = Describe(NativeMethods.NIF_MESSAGE | NativeMethods.NIF_ICON
            | NativeMethods.NIF_TIP | NativeMethods.NIF_SHOWTIP);
        _added = NativeMethods.Shell_NotifyIcon(NativeMethods.NIM_ADD, ref data);
        if (!_added) return;
        var version = new NativeMethods.NOTIFYICONDATA
        {
            cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.NOTIFYICONDATA>(),
            hWnd = _source.Handle,
            uID = IconId,
            uVersion = NativeMethods.NOTIFYICON_VERSION_4,
            szTip = _tooltip,
            szInfo = "",
            szInfoTitle = "",
        };
        NativeMethods.Shell_NotifyIcon(NativeMethods.NIM_SETVERSION, ref version);
    }

    private void RefreshIconHandle()
    {
        var size = Math.Max(16, NativeMethods.GetSystemMetrics(NativeMethods.SM_CXSMICON));
        var replacement = LassoGlyph.CreateIcon(size);
        if (replacement == IntPtr.Zero) return;
        if (_icon != IntPtr.Zero) NativeMethods.DestroyIcon(_icon);
        _icon = replacement;
    }

    private NativeMethods.NOTIFYICONDATA Describe(uint flags) => new()
    {
        cbSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.NOTIFYICONDATA>(),
        hWnd = _source.Handle,
        uID = IconId,
        uFlags = flags,
        uCallbackMessage = NativeMethods.WM_TRAYICON,
        hIcon = _icon,
        szTip = _tooltip,
        szInfo = "",
        szInfoTitle = "",
    };

    private IntPtr WndProc(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (message == _taskbarCreated)
        {
            _added = false;
            Add();
            handled = true;
            return IntPtr.Zero;
        }

        if (message == NativeMethods.WM_TRAYICON)
        {
            // Version 4 packs the event into the low word of lParam.
            var notification = (int)((long)lParam & 0xFFFF);
            switch (notification)
            {
                case NativeMethods.WM_LBUTTONUP:
                    OnPrimaryClick?.Invoke();
                    handled = true;
                    break;
                case NativeMethods.WM_RBUTTONUP:
                case NativeMethods.WM_CONTEXTMENU:
                    ShowMenu();
                    handled = true;
                    break;
            }
            return IntPtr.Zero;
        }

        if (message == NativeMethods.WM_SETTINGCHANGE || message == NativeMethods.WM_DPICHANGED)
        {
            // A theme or scale change means the icon should be drawn again.
            RefreshIconHandle();
            if (_added)
            {
                var data = Describe(NativeMethods.NIF_ICON);
                NativeMethods.Shell_NotifyIcon(NativeMethods.NIM_MODIFY, ref data);
            }
        }

        return IntPtr.Zero;
    }

    private void ShowMenu()
    {
        var menu = BuildMenu?.Invoke();
        if (menu is null) return;

        // Put the invisible owner under the cursor so WPF opens the menu on the
        // monitor the click happened on, then let Windows place and flip it.
        if (NativeMethods.GetCursorPos(out var cursor))
        {
            var scale = VisualTreeHelper.GetDpi(_menuHost).PixelsPerDip;
            _menuHost.Left = cursor.X / scale;
            _menuHost.Top = cursor.Y / scale;
        }
        _menuHost.Show();
        _menuHost.Activate();
        NativeMethods.SetForegroundWindow(new WindowInteropHelper(_menuHost).Handle);

        menu.PlacementTarget = _menuHost;
        menu.Placement = PlacementMode.MousePoint;
        menu.Closed += OnMenuClosed;
        menu.IsOpen = true;
    }

    private void OnMenuClosed(object sender, RoutedEventArgs args)
    {
        if (sender is ContextMenu menu) menu.Closed -= OnMenuClosed;
        _menuHost.Hide();
    }

    public void Dispose()
    {
        if (_added)
        {
            var data = Describe(0);
            NativeMethods.Shell_NotifyIcon(NativeMethods.NIM_DELETE, ref data);
            _added = false;
        }
        if (_icon != IntPtr.Zero)
        {
            NativeMethods.DestroyIcon(_icon);
            _icon = IntPtr.Zero;
        }
        _menuHost.Close();
        _source.RemoveHook(WndProc);
        _source.Dispose();
    }
}
