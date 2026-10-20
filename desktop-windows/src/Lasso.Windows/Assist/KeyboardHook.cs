//  Watching for typing, everywhere.
//
//  The macOS build installs a CGEventTap; the Windows equivalent is a
//  low-level keyboard hook. Both see every key before the focused application
//  does, and both can swallow one — which is what lets Tab accept a suggestion
//  instead of inserting a tab character.
//
//  Two things matter for correctness. The callback must return almost
//  immediately, because Windows silently removes a hook that takes too long,
//  so every decision is queued onto the UI thread. And the application's own
//  synthesized keystrokes must be recognised and ignored, or accepting a
//  suggestion would look like the user typing and trigger another refresh.
//
//  Unlike macOS this needs no permission prompt. What it cannot do is reach a
//  window running at a higher integrity level — an application started as
//  administrator — and Windows blocks it entirely while a UAC prompt is up.

using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Threading;
using Lasso.Windows.Interop;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

/// What the coordinator wants done with a key. Returning Swallow stops the key
/// reaching the focused application.
public enum KeyDisposition
{
    PassThrough,
    Swallow,
}

public readonly record struct AssistKey(int VirtualKey, bool Control, bool Shift, bool Alt, bool Windows)
{
    public bool HasModifier => Control || Alt || Windows;
}

public sealed class KeyboardHook : IDisposable
{
    public const int VK_TAB = 0x09;
    public const int VK_RETURN = 0x0D;
    public const int VK_ESCAPE = 0x1B;
    public const int VK_UP = 0x26;
    public const int VK_DOWN = 0x28;
    public const int VK_F4 = 0x73;

    private readonly Dispatcher _dispatcher;
    private readonly NativeMethods.HookProc _callback;
    private IntPtr _hook;
    private bool _sawEvent;

    /// Decides what happens to a key. Runs on the UI thread, synchronously,
    /// because the answer decides whether the key reaches the host — so it must
    /// only ever inspect state, never block.
    public Func<AssistKey, KeyDisposition>? OnKey { get; set; }

    public bool IsInstalled => _hook != IntPtr.Zero;

    /// Set while the application is typing its own insertion, so its keystrokes
    /// are never mistaken for the user's.
    public bool IsInserting { get; set; }

    public KeyboardHook(Dispatcher dispatcher)
    {
        _dispatcher = dispatcher;
        // Held in a field: a collected delegate would leave Windows calling
        // into freed memory.
        _callback = Callback;
    }

    /// Returns null on success, or a message explaining what to do.
    public string? Install()
    {
        if (_hook != IntPtr.Zero) return null;
        using var process = Process.GetCurrentProcess();
        using var module = process.MainModule!;
        var handle = Marshal.GetHINSTANCE(typeof(KeyboardHook).Module);
        _hook = NativeMethods.SetWindowsHookEx(NativeMethods.WH_KEYBOARD_LL, _callback, handle, 0);
        if (_hook == IntPtr.Zero)
        {
            var error = Marshal.GetLastWin32Error();
            AssistLog.Write($"hook creation failed (win32 error {error})");
            return "The keyboard hook could not be installed.\n\n"
                + "Close any application that filters keyboard input and try again.";
        }
        _sawEvent = false;
        AssistLog.Write("hook installed and listening");
        // If nothing arrives the hook exists but is not receiving, which is the
        // real signal that something else is holding the input queue.
        _dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(async () =>
        {
            await Task.Delay(20_000);
            if (IsInstalled && !_sawEvent) AssistLog.Write("no key events after 20s - hook is not receiving input");
        }));
        return null;
    }

    public void Remove()
    {
        if (_hook == IntPtr.Zero) return;
        NativeMethods.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
        AssistLog.Write("hook removed");
    }

    private IntPtr Callback(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code != NativeMethods.HC_ACTION) return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);

        var message = (int)wParam;
        if (message != NativeMethods.WM_KEYDOWN && message != NativeMethods.WM_SYSKEYDOWN)
        {
            return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);
        }

        var info = Marshal.PtrToStructure<NativeMethods.KBDLLHOOKSTRUCT>(lParam);

        // Our own synthesized keys are not the user typing.
        if (IsInserting || SyntheticKeyboard.IsOurs(info.dwExtraInfo))
        {
            return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);
        }

        if (!_sawEvent)
        {
            _sawEvent = true;
            AssistLog.Write("first key event received");
        }

        var key = new AssistKey(
            VirtualKey: (int)info.vkCode,
            Control: Down(NativeMethods.VK_CONTROL),
            Shift: Down(NativeMethods.VK_SHIFT),
            Alt: Down(NativeMethods.VK_MENU),
            Windows: Down(NativeMethods.VK_LWIN) || Down(NativeMethods.VK_RWIN));

        var disposition = KeyDisposition.PassThrough;
        if (OnKey is { } decide)
        {
            // The hook callback already runs on the thread that installed it,
            // so this is a direct call and never a wait on another thread.
            if (_dispatcher.CheckAccess())
            {
                disposition = decide(key);
            }
            else
            {
                // Should not happen, but never block the input queue to find out.
                _dispatcher.BeginInvoke(new Action(() => decide(key)));
            }
        }

        if (disposition == KeyDisposition.Swallow) return new IntPtr(1);
        return NativeMethods.CallNextHookEx(_hook, code, wParam, lParam);
    }

    private static bool Down(int virtualKey) => (NativeMethods.GetKeyState(virtualKey) & 0x8000) != 0;

    public void Dispose() => Remove();
}
