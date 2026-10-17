//  The typing log.
//
//  Every stage of an insertion writes one line here: what was planned, whether
//  it landed, and why it was refused when it was. It is the difference between
//  "it does not work in that app" and a fix.

using System.Text;

namespace Lasso.Windows.Support;

public static class AssistLog
{
    private static readonly object Gate = new();

    /// On by default while the feature settles; turn it off in the tray menu.
    public static bool Enabled { get; set; } = true;

    public static void Write(string line)
    {
        if (!Enabled) return;
        try
        {
            var entry = $"[{DateTimeOffset.Now:o}] {line}{Environment.NewLine}";
            lock (Gate)
            {
                Directory.CreateDirectory(AppPaths.Logs);
                File.AppendAllText(AppPaths.AssistLogFile, entry, Encoding.UTF8);
            }
        }
        catch (Exception)
        {
            // Logging must never take the application down with it.
        }
    }
}
