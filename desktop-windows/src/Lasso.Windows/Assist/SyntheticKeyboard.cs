//  Synthesized keystrokes.
//
//  Events are tagged so the application's own keyboard hook can tell them apart
//  from real typing, and sent as Unicode scan codes rather than virtual keys,
//  which is what makes insertion independent of the user's keyboard layout —
//  the same reason the macOS build posts a unicode string instead of key codes.

using System.Threading;
using Lasso.Windows.Interop;

namespace Lasso.Windows.Assist;

public static class SyntheticKeyboard
{
    /// Marks events this app generated, so the hook ignores its own output.
    /// The same value the macOS build uses for the equivalent purpose.
    public static readonly IntPtr Marker = new(0x0C01AB);

    private const int ChunkSize = 16;

    private static void Send(params NativeMethods.INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        NativeMethods.SendInput((uint)inputs.Length, inputs,
            System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.INPUT>());
    }

    private static NativeMethods.INPUT Key(ushort virtualKey, ushort scan, uint flags) => new()
    {
        type = NativeMethods.INPUT_KEYBOARD,
        union = new NativeMethods.INPUTUNION
        {
            ki = new NativeMethods.KEYBDINPUT
            {
                wVk = virtualKey,
                wScan = scan,
                dwFlags = flags,
                time = 0,
                dwExtraInfo = Marker,
            },
        },
    };

    public static void DeleteBackwards(int count)
    {
        if (count <= 0) return;
        for (var index = 0; index < count; index++)
        {
            Send(Key(NativeMethods.VK_BACK, 0, 0),
                 Key(NativeMethods.VK_BACK, 0, NativeMethods.KEYEVENTF_KEYUP));
            Thread.Sleep(4);
        }
    }

    /// Types text as Unicode code units, which works regardless of layout.
    /// A character outside the basic plane is two units and is sent as two
    /// events, which is how Windows expects a surrogate pair.
    public static void Type(string text)
    {
        if (text.Length == 0) return;
        for (var offset = 0; offset < text.Length; offset += ChunkSize)
        {
            var length = Math.Min(ChunkSize, text.Length - offset);
            var inputs = new NativeMethods.INPUT[length * 2];
            for (var index = 0; index < length; index++)
            {
                var unit = text[offset + index];
                inputs[index * 2] = Key(0, unit, NativeMethods.KEYEVENTF_UNICODE);
                inputs[index * 2 + 1] = Key(0, unit,
                    NativeMethods.KEYEVENTF_UNICODE | NativeMethods.KEYEVENTF_KEYUP);
            }
            Send(inputs);
            Thread.Sleep(6);
        }
    }

    /// Ctrl+V, for the rich-text paste a hyperlink insertion needs.
    public static void Paste()
    {
        Send(Key(NativeMethods.VK_CONTROL, 0, 0),
             Key(NativeMethods.VK_V, 0, 0),
             Key(NativeMethods.VK_V, 0, NativeMethods.KEYEVENTF_KEYUP),
             Key(NativeMethods.VK_CONTROL, 0, NativeMethods.KEYEVENTF_KEYUP));
    }

    /// True when an event came from this application rather than the keyboard.
    public static bool IsOurs(IntPtr extraInfo) => extraInfo == Marker;
}
