using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Lasso.Windows.Assist;

internal static class AssistNative
{
    internal const int WhKeyboardLl = 13;
    internal const int WmKeyDown = 0x100, WmKeyUp = 0x101, WmSysKeyDown = 0x104, WmSysKeyUp = 0x105;
    internal const uint LlkhfInjected = 0x10;
    internal const int VkTab = 9, VkReturn = 13, VkEscape = 27, VkUp = 38, VkDown = 40;
    internal const int VkShift = 0x10, VkControl = 0x11, VkAlt = 0x12, VkLWin = 0x5B, VkRWin = 0x5C;
    internal delegate IntPtr KeyboardProcedure(int code, IntPtr wParam, IntPtr lParam);
    internal delegate void WinEventProcedure(IntPtr hook, uint eventType, IntPtr hwnd, int objectId, int childId, uint threadId, uint time);

    [StructLayout(LayoutKind.Sequential)]
    internal struct KeyboardEvent { public uint VirtualKey, ScanCode, Flags, Time; public UIntPtr ExtraInfo; }

    [DllImport("user32.dll", SetLastError = true)]
    internal static extern IntPtr SetWindowsHookExW(int hookId, KeyboardProcedure callback, IntPtr module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    internal static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern IntPtr GetModuleHandleW(string? moduleName);
    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    internal static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")]
    internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
    [DllImport("user32.dll")]
    internal static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]
    internal static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProcedure callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnhookWinEvent(IntPtr hook);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int capacity);
    internal static string WindowTitle(IntPtr hwnd)
    {
        var text = new StringBuilder(512);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    internal static bool Down(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;
    internal static bool AnyModifierDown => Down(VkControl) || Down(VkAlt) || Down(VkShift) || Down(VkLWin) || Down(VkRWin);
    internal static bool IsOwnWindow(IntPtr hwnd)
    {
        GetWindowThreadProcessId(hwnd, out var pid);
        return pid == Environment.ProcessId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public uint Size; public NativeRect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromRect(ref NativeRect rect, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    internal static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    internal static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    internal static NativeRect WorkArea(NativeRect anchor)
    {
        var monitor = MonitorFromRect(ref anchor, 2);
        var info = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
        return GetMonitorInfoW(monitor, ref info) ? info.Work : anchor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public KeyboardInput Keyboard;
        // INPUT's size includes MOUSEINPUT, even for keyboard-only SendInput calls.
        [FieldOffset(0)] public MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { public int X, Y; public uint MouseData, Flags, Time; public UIntPtr ExtraInfo; }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);

    internal static bool Paste(IntPtr expectedForeground)
    {
        if (GetForegroundWindow() != expectedForeground || AnyModifierDown) return false;
        var inputs = new Input[4];
        var keys = new ushort[] { VkControl, 0x56, 0x56, VkControl };
        for (int i = 0; i < 4; i++) inputs[i] = new Input { Type = 1, Data = new InputUnion {
            Keyboard = new KeyboardInput { Key = keys[i], Flags = i >= 2 ? 2u : 0u } } };
        return SendInput(4, inputs, Marshal.SizeOf<Input>()) == 4;
    }

    internal static bool SendUnicode(string text, IntPtr expectedForeground)
    {
        if (GetForegroundWindow() != expectedForeground || AnyModifierDown || string.IsNullOrEmpty(text)) return false;
        var inputs = new Input[text.Length * 2];
        for (var i = 0; i < text.Length; i++)
        {
            inputs[i * 2] = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { Scan = text[i], Flags = 4 } } };
            inputs[i * 2 + 1] = new Input { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { Scan = text[i], Flags = 4 | 2 } } };
        }
        // One array is inserted serially by Windows. Never clear or replace the clipboard.
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>()) == inputs.Length;
    }
}
