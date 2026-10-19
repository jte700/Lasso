//  Persisted preferences.
//
//  The macOS build keeps these in UserDefaults. A small JSON file beside the
//  history store is the Windows equivalent that does not reach into the
//  registry for something the user may want to delete with the app's data.

using System.Text.Json;
using System.Text.Json.Serialization;
using Lasso.Core;

namespace Lasso.Windows.Support;

public sealed class AppSettings
{
    [JsonPropertyName("insertionMode")] public string InsertionModeName { get; set; } = "plain";
    [JsonPropertyName("assistDebug")] public bool AssistDebug { get; set; } = true;
    [JsonPropertyName("wasTrusted")] public bool WasTrusted { get; set; }

    [JsonIgnore]
    public InsertionMode InsertionMode
    {
        get => InsertionModeExtensions.Parse(InsertionModeName);
        set => InsertionModeName = value.Name();
    }

    private static readonly Lazy<AppSettings> Loaded = new(Load);
    public static AppSettings Current => Loaded.Value;

    private static AppSettings Load()
    {
        try
        {
            if (File.Exists(AppPaths.Settings))
            {
                var decoded = JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(AppPaths.Settings));
                if (decoded is not null) return decoded;
            }
        }
        catch (Exception)
        {
            // A damaged settings file falls back to the defaults.
        }
        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            AppPaths.EnsureCreated();
            var temporary = AppPaths.Settings + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(this,
                new JsonSerializerOptions { WriteIndented = true }));
            File.Move(temporary, AppPaths.Settings, overwrite: true);
        }
        catch (Exception)
        {
            // Preferences are a convenience; the session still works.
        }
    }
}
