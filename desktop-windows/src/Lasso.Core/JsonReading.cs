//  Tolerant JSON accessors.
//
//  The macOS build reads server payloads with optional casts — a missing or
//  wrongly typed field yields nil and the caller decides. These helpers give the
//  Windows port the same forgiving behaviour, so one unexpected field in a
//  prediction response degrades that row instead of throwing away the response.

using System.Text.Json;

namespace Lasso.Core;

public static class JsonReading
{
    public static JsonElement? Object(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var found)
            && found.ValueKind == JsonValueKind.Object
                ? found
                : null;

    public static IEnumerable<JsonElement> Array(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return [];
        if (!element.TryGetProperty(name, out var found)) return [];
        return found.ValueKind == JsonValueKind.Array ? found.EnumerateArray() : [];
    }

    public static string? String(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var found)
            && found.ValueKind == JsonValueKind.String
                ? found.GetString()
                : null;

    public static IReadOnlyList<string> StringArray(JsonElement element, string name) =>
        Array(element, name)
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString() ?? "")
            .ToList();

    public static bool? Bool(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(name, out var found)
            && found.ValueKind is JsonValueKind.True or JsonValueKind.False
                ? found.GetBoolean()
                : null;

    public static int? Int(JsonElement element, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) return null;
        if (!element.TryGetProperty(name, out var found)) return null;
        if (found.ValueKind != JsonValueKind.Number) return null;
        if (found.TryGetInt32(out var exact)) return exact;
        // A JSON number need not be integral; truncate as an NSNumber intValue would.
        return found.TryGetDouble(out var approximate) && double.IsFinite(approximate)
            ? (int)approximate
            : null;
    }

    public static bool TryDouble(JsonElement element, string name, out double value)
    {
        value = 0;
        if (element.ValueKind != JsonValueKind.Object) return false;
        return element.TryGetProperty(name, out var found) && TryDouble(found, out value);
    }

    public static bool TryDouble(JsonElement element, out double value)
    {
        value = 0;
        if (element.ValueKind != JsonValueKind.Number) return false;
        if (!element.TryGetDouble(out var parsed) || !double.IsFinite(parsed)) return false;
        value = parsed;
        return true;
    }
}
