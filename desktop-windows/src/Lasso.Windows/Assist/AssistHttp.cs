//  Talking to the local server.
//
//  Every request goes to 127.0.0.1 and nowhere else. The endpoints, payload
//  shapes, and timeouts are the same ones the macOS companion uses, so the two
//  platforms exercise one API rather than two.

using System.Net.Http;
using System.Text;
using System.Text.Json;
using Lasso.Core;
using Lasso.Windows.Support;

namespace Lasso.Windows.Assist;

public static class AssistHttp
{
    private static readonly HttpClient Client = new()
    {
        Timeout = TimeSpan.FromSeconds(70),
    };

    /// Stable for this process. Previews and impressions never report usage;
    /// only successful, intentional interactions do.
    private static readonly string SessionId = Guid.NewGuid().ToString();

    private static async Task<byte[]?> SendAsync(HttpRequestMessage request, TimeSpan timeout,
        CancellationToken cancellation)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(timeout);
        try
        {
            using var response = await Client.SendAsync(request, deadline.Token).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode) return null;
            return await response.Content.ReadAsByteArrayAsync(deadline.Token).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // A cancelled, timed out, or refused request simply has no answer.
            return null;
        }
        finally
        {
            request.Dispose();
        }
    }

    private static HttpRequestMessage Json(HttpMethod method, Uri url, object payload)
    {
        var request = new HttpRequestMessage(method, url)
        {
            Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json"),
        };
        return request;
    }

    // MARK: - Prediction

    public sealed record PendingDependency(int BlockIndex, int Start, int End,
        string SourceObjectId, string SourceSnapshotId);

    public static async Task<byte[]?> PredictAsync(Uri server, string projectId, string text, int cursor,
        IReadOnlyList<PendingDependency> pending, CancellationToken cancellation)
    {
        var payload = new Dictionary<string, object>
        {
            ["text"] = text,
            ["cursor"] = cursor,
            ["blockIndex"] = 0,
        };
        if (pending.Count > 0)
        {
            payload["pendingDependencies"] = pending.Select(item => new Dictionary<string, object>
            {
                ["blockIndex"] = item.BlockIndex,
                ["start"] = item.Start,
                ["end"] = item.End,
                ["sourceObjectId"] = item.SourceObjectId,
                ["sourceSnapshotId"] = item.SourceSnapshotId,
            }).ToList();
        }

        var url = new Uri(server, $"api/projects/{Uri.EscapeDataString(projectId)}/dependencies/predict");
        return await SendAsync(Json(HttpMethod.Post, url, payload),
            TimeSpan.FromMilliseconds(2500), cancellation).ConfigureAwait(false);
    }

    // MARK: - Previews

    public static async Task<byte[]?> PreviewAsync(Uri server, string objectId, string? versionId,
        bool isModel, CancellationToken cancellation)
    {
        var path = $"api/dependency-objects/{Uri.EscapeDataString(objectId)}/preview";
        if (versionId is { Length: > 0 }) path += "?version=" + Uri.EscapeDataString(versionId);
        // A first model preview compiles the geometry engine and reads the
        // model; later ones reuse it, and ordinary table requests stay brief.
        var timeout = isModel ? TimeSpan.FromSeconds(60) : TimeSpan.FromMilliseconds(2500);
        return await SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri(server, path)),
            timeout, cancellation).ConfigureAwait(false);
    }

    // MARK: - Projects

    public static async Task<string?> FirstProjectIdAsync(Uri server, CancellationToken cancellation)
    {
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri(server, "api/projects")),
            TimeSpan.FromSeconds(5), cancellation).ConfigureAwait(false);
        if (data is null) return null;
        try
        {
            using var document = JsonDocument.Parse(data);
            foreach (var project in JsonReading.Array(document.RootElement, "projects"))
            {
                if (JsonReading.String(project, "id") is { Length: > 0 } id) return id;
            }
        }
        catch (JsonException)
        {
            // Nothing usable in the answer.
        }
        return null;
    }

    public static async Task<string?> ProjectRootAsync(Uri server, string projectId,
        CancellationToken cancellation)
    {
        var url = new Uri(server, $"api/projects/{Uri.EscapeDataString(projectId)}");
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, url),
            TimeSpan.FromSeconds(5), cancellation).ConfigureAwait(false);
        if (data is null) return null;
        try
        {
            using var document = JsonDocument.Parse(data);
            return JsonReading.Object(document.RootElement, "project") is { } project
                ? JsonReading.String(project, "rootPath")
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static async Task<List<JsonElement>> SourceLibraryAsync(Uri server, string projectId,
        CancellationToken cancellation)
    {
        var url = new Uri(server, $"api/projects/{Uri.EscapeDataString(projectId)}/source-library");
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, url),
            TimeSpan.FromSeconds(10), cancellation).ConfigureAwait(false);
        var objects = new List<JsonElement>();
        if (data is null) return objects;
        try
        {
            // Cloned, because the document is disposed when this returns.
            using var document = JsonDocument.Parse(data);
            foreach (var entry in JsonReading.Array(document.RootElement, "objects"))
            {
                objects.Add(entry.Clone());
            }
        }
        catch (JsonException)
        {
            // Leave the list empty; the chooser says so.
        }
        return objects;
    }

    // MARK: - Sharing scope

    /// Whether generated links only resolve on this machine, which the
    /// composer states plainly before a token is minted.
    public static async Task<bool> ShareIsLocalOnlyAsync(Uri server)
    {
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri(server, "api/sharing/status")),
            TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(false);
        if (data is null) return true;
        try
        {
            using var document = JsonDocument.Parse(data);
            return JsonReading.Bool(document.RootElement, "localOnly") ?? true;
        }
        catch (JsonException)
        {
            return true;
        }
    }

    public sealed record FullSheet(string Name, IReadOnlyList<IReadOnlyList<string>> Rows);

    public sealed record FullDocument(string Kind, IReadOnlyList<FullSheet> Sheets,
        IReadOnlyList<string> Blocks);

    /// What a recipient would receive in full, which is what the redaction
    /// view lets the user mask before any link exists.
    public static async Task<FullDocument?> FullDocumentAsync(Uri server, string objectId, string? versionId)
    {
        var path = $"api/dependency-objects/{Uri.EscapeDataString(objectId)}/document";
        if (versionId is { Length: > 0 }) path += "?version=" + Uri.EscapeDataString(versionId);
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, new Uri(server, path)),
            TimeSpan.FromSeconds(6), CancellationToken.None).ConfigureAwait(false);
        if (data is null) return null;
        try
        {
            using var parsed = JsonDocument.Parse(data);
            if (JsonReading.Object(parsed.RootElement, "document") is not { } document) return null;
            var kind = JsonReading.String(document, "kind");
            if (kind is null) return null;

            var sheets = new List<FullSheet>();
            foreach (var sheet in JsonReading.Array(document, "sheets"))
            {
                var rows = new List<IReadOnlyList<string>>();
                foreach (var row in JsonReading.Array(sheet, "rows"))
                {
                    if (row.ValueKind != JsonValueKind.Array) continue;
                    rows.Add(row.EnumerateArray().Select(cell => cell.ValueKind switch
                    {
                        JsonValueKind.String => cell.GetString() ?? "",
                        JsonValueKind.Null or JsonValueKind.Undefined => "",
                        _ => cell.ToString(),
                    }).ToList());
                }
                sheets.Add(new FullSheet(JsonReading.String(sheet, "name") ?? "Sheet", rows));
            }
            return new FullDocument(kind, sheets, JsonReading.StringArray(document, "blocks"));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // MARK: - Usage

    /// Records a successful, intentional source interaction.
    public static void RecordUsage(Uri server, string projectId, string? objectId, string? path, string kind)
    {
        var payload = new Dictionary<string, object> { ["kind"] = kind, ["sessionId"] = SessionId };
        if (objectId is { Length: > 0 }) payload["objectId"] = objectId;
        else if (path is { Length: > 0 }) payload["path"] = path;
        else return;

        var url = new Uri(server, $"api/projects/{Uri.EscapeDataString(projectId)}/recommendation-usage");
        _ = SendAsync(Json(HttpMethod.Post, url, payload), TimeSpan.FromSeconds(3), CancellationToken.None);
    }

    /// A stored highlight can belong to a project other than the active one.
    /// Resolve its owning project before counting an explicit open.
    public static async Task RecordResolvedOpenAsync(Uri server, string objectId)
    {
        var url = new Uri(server, $"api/dependency-objects/{Uri.EscapeDataString(objectId)}");
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, url),
            TimeSpan.FromSeconds(3), CancellationToken.None).ConfigureAwait(false);
        if (data is null) return;
        try
        {
            using var document = JsonDocument.Parse(data);
            if (JsonReading.Object(document.RootElement, "object") is { } found
                && JsonReading.String(found, "projectId") is { Length: > 0 } projectId)
            {
                RecordUsage(server, projectId, objectId, null, "open");
            }
        }
        catch (JsonException)
        {
            // Nothing to record.
        }
    }

    /// The owning project of an indexed object, for a highlight whose project
    /// is not the active one.
    public static async Task<string?> OwningPathAsync(Uri server, string objectId)
    {
        var url = new Uri(server, $"api/dependency-objects/{Uri.EscapeDataString(objectId)}");
        var data = await SendAsync(new HttpRequestMessage(HttpMethod.Get, url),
            TimeSpan.FromSeconds(3), CancellationToken.None).ConfigureAwait(false);
        if (data is null) return null;
        try
        {
            using var document = JsonDocument.Parse(data);
            return JsonReading.Object(document.RootElement, "object") is { } found
                ? JsonReading.String(found, "path")
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // MARK: - Shares

    public static async Task<DependencyShare?> CreateShareAsync(Uri server, string projectId,
        string objectId, string? versionId, ShareConfiguration configuration)
    {
        var payload = new Dictionary<string, object>
        {
            ["objectId"] = objectId,
            ["accessScope"] = configuration.Scope.Name(),
            ["redactions"] = configuration.Redactions.Select(item => item.Payload()).ToList(),
        };
        if (versionId is { Length: > 0 }) payload["versionId"] = versionId;

        var url = new Uri(server, $"api/projects/{Uri.EscapeDataString(projectId)}/object-shares");
        var data = await SendAsync(Json(HttpMethod.Post, url, payload),
            TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(false);
        if (data is null) return null;
        try
        {
            using var document = JsonDocument.Parse(data);
            if (JsonReading.Object(document.RootElement, "share") is not { } share) return null;
            var token = JsonReading.String(share, "token");
            var raw = JsonReading.String(share, "url");
            if (token is null || raw is null || !Uri.TryCreate(raw, UriKind.Absolute, out var shareUrl))
            {
                return null;
            }
            return new DependencyShare(token, shareUrl);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// Used when an insertion fails after the record already exists.
    public static void RevokeShare(Uri server, string token)
    {
        var url = new Uri(server, $"api/object-shares/{Uri.EscapeDataString(token)}/revoke");
        _ = SendAsync(new HttpRequestMessage(HttpMethod.Post, url),
            TimeSpan.FromSeconds(5), CancellationToken.None);
        AssistLog.Write("share revoked after a failed insertion");
    }
}
