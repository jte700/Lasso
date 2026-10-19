//  Where the Windows companion keeps its data and logs.
//
//  The macOS build uses ~/Library/Application Support/Lasso/data and
//  ~/Library/Logs/Lasso. The Windows equivalent is LocalApplicationData: the
//  history store is a SQLite database with content-addressed snapshots, which
//  is machine-local and can be large, so it must not land in a roaming profile.

namespace Lasso.Windows.Support;

public static class AppPaths
{
    public static string Support { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lasso");

    /// LASSO_DATA_DIR overrides the history store, as it does for the
    /// development server. Useful for trying a project against a fresh index
    /// without disturbing the one in use.
    public static string Data =>
        Environment.GetEnvironmentVariable("LASSO_DATA_DIR") is { Length: > 0 } overridden
            ? overridden
            : Path.Combine(Support, "data");
    public static string Logs => Path.Combine(Support, "Logs");
    public static string ServerLog => Path.Combine(Logs, "server.log");
    public static string AssistLogFile => Path.Combine(Logs, "assist.log");
    public static string References => Path.Combine(Support, "references.json");
    public static string Settings => Path.Combine(Support, "settings.json");
    /// WebView2 keeps its own profile; pinning it here stops it landing beside
    /// the executable, which may be read-only.
    public static string WebViewProfile => Path.Combine(Support, "WebView2");

    public static void EnsureCreated()
    {
        Directory.CreateDirectory(Support);
        Directory.CreateDirectory(Logs);
    }
}
