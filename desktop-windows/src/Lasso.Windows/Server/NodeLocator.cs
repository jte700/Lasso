//  Finding the Node executable.
//
//  A shortcut, a scheduled task, or a Start menu launch can hand this process a
//  PATH without Node on it, so the executable is resolved explicitly: an
//  environment override, the path recorded at build time, the usual install
//  locations, any version manager's installs, and only then PATH.

using System.Diagnostics;

namespace Lasso.Windows.Server;

public static class NodeLocator
{
    public static string? Resolve()
    {
        foreach (var candidate in Candidates())
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate)) return candidate;
        }
        return FromPath();
    }

    private static IEnumerable<string> Candidates()
    {
        var overridden = Environment.GetEnvironmentVariable("LASSO_NODE")
            ?? Environment.GetEnvironmentVariable("COLAB_NODE");
        if (!string.IsNullOrWhiteSpace(overridden)) yield return overridden;

        if (RecordedPath() is { } recorded) yield return recorded;

        foreach (var folder in new[]
                 {
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                     Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                     Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"),
                 })
        {
            if (!string.IsNullOrWhiteSpace(folder)) yield return Path.Combine(folder, "nodejs", "node.exe");
        }

        // Version managers, newest install first.
        foreach (var version in VersionManagerInstalls()) yield return version;

        var volta = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Volta", "bin", "node.exe");
        yield return volta;
    }

    /// The executable the build found, written beside the application rather
    /// than compiled into it: a plain file keeps machine-specific paths out of
    /// source control, and lets the path be corrected without a rebuild.
    private static string? RecordedPath()
    {
        try
        {
            var record = Path.Combine(AppContext.BaseDirectory, "node-path.txt");
            if (!File.Exists(record)) return null;
            var recorded = File.ReadAllText(record).Trim();
            return recorded.Length > 0 ? recorded : null;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static IEnumerable<string> VersionManagerInstalls()
    {
        var roots = new List<(string Root, string[] Tail)>
        {
            // nvm-windows
            (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "nvm"), ["node.exe"]),
            // fnm
            (Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "fnm", "node-versions"),
                ["installation", "node.exe"]),
        };

        foreach (var (root, tail) in roots)
        {
            string[] versions;
            try
            {
                if (!Directory.Exists(root)) continue;
                versions = Directory.GetDirectories(root);
            }
            catch (Exception)
            {
                continue;
            }
            Array.Sort(versions, StringComparer.OrdinalIgnoreCase);
            Array.Reverse(versions);
            foreach (var version in versions)
            {
                yield return Path.Combine([version, .. tail]);
            }
        }
    }

    /// Last resort: ask the shell, the same way `nodePathFromLoginShell` does on
    /// macOS.
    private static string? FromPath()
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo
            {
                FileName = "where.exe",
                Arguments = "node.exe",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (process is null) return null;
            var output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(4_000);
            foreach (var line in output.Split('\n'))
            {
                var candidate = line.Trim();
                if (candidate.Length > 0 && File.Exists(candidate)) return candidate;
            }
        }
        catch (Exception)
        {
            // where.exe is absent or refused; treated as "Node not found".
        }
        return null;
    }
}
