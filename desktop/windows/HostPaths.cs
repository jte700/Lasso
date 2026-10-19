using System;
using System.IO;
using System.Text.Json;

namespace Lasso.Windows;

internal static class HostPaths
{
    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lasso");
    public static readonly string Data = Path.Combine(Root, "data");
    public static readonly string Logs = Path.Combine(Root, "logs");
    public static readonly string Browser = Path.Combine(Root, "WebView2");
    public static readonly string Settings = Path.Combine(Root, "settings.json");
    private static readonly object LogLock = new();

    public static void Initialize()
    {
        Directory.CreateDirectory(Data);
        Directory.CreateDirectory(Logs);
        Directory.CreateDirectory(Browser);
    }

    public static void Log(string message)
    {
        try
        {
            lock (LogLock)
            {
                var path = Path.Combine(Logs, "lasso.log");
                if (File.Exists(path) && new FileInfo(path).Length > 5 * 1024 * 1024)
                    File.Move(path, path + ".1", true);
                File.AppendAllText(path, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
            }
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }
}

internal sealed class HostSettings
{
    public bool AssistEnabled { get; set; }
    public string? ProjectId { get; set; }
    public double Width { get; set; } = 1360;
    public double Height { get; set; } = 900;

    public static HostSettings Load()
    {
        try { return JsonSerializer.Deserialize<HostSettings>(File.ReadAllText(HostPaths.Settings)) ?? new(); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    public void Save()
    {
        try
        {
            var temporary = HostPaths.Settings + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this));
            File.Move(temporary, HostPaths.Settings, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { HostPaths.Log($"Settings: {error.Message}"); }
    }
}
