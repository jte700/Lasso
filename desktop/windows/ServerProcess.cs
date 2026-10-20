using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Lasso.Windows;

// Owns only the child it started. A preferred loopback port and a private stdout
// handshake prevent an unrelated local service from receiving native privileges.
internal sealed class ServerProcess : IDisposable
{
    private readonly Process process;
    private readonly ChildProcessJob job;
    private readonly string nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly TaskCompletionSource<Uri> ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool disposed;
    public Uri? BaseUri { get; private set; }
    public event EventHandler? UnexpectedExit;

    private ServerProcess(string appDirectory, string nodePath, string dataDirectory)
    {
        job = new ChildProcessJob();
        var start = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = appDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        start.ArgumentList.Add("--disable-warning=ExperimentalWarning");
        start.ArgumentList.Add(Path.Combine(appDirectory, "src", "server.js"));
        start.Environment["PORT"] = "4319";
        start.Environment["LASSO_DATA_DIR"] = dataDirectory;
        start.Environment["LASSO_DESKTOP_NONCE"] = nonce;
        start.Environment.Remove("NODE_OPTIONS");
        process = new Process { StartInfo = start, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, args) => ReadOutput(args.Data);
        process.ErrorDataReceived += (_, args) => { if (args.Data != null) HostPaths.Log("Server: " + args.Data); };
        process.Exited += (_, _) =>
        {
            ready.TrySetException(new InvalidOperationException("The local server stopped before it was ready. See the Lasso log for details."));
            if (!disposed) UnexpectedExit?.Invoke(this, EventArgs.Empty);
        };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Could not start Lasso's local server.");
            job.Add(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            process.Dispose();
            job.Dispose();
            throw;
        }
    }

    public static async Task<ServerProcess> StartAsync(string? dataDirectory = null, CancellationToken cancellationToken = default)
    {
        var appDirectory = Path.Combine(AppContext.BaseDirectory, "app");
        var nodePath = Path.Combine(AppContext.BaseDirectory, "runtime", "node.exe");
        if (!File.Exists(nodePath) || !File.Exists(Path.Combine(appDirectory, "src", "server.js")))
            throw new FileNotFoundException("Lasso's bundled runtime is missing. Extract the complete Windows package and launch Lasso.exe again.");
        var server = new ServerProcess(appDirectory, nodePath, dataDirectory ?? HostPaths.Data);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            server.BaseUri = await server.ready.Task.WaitAsync(timeout.Token);
            using var client = new HttpClient(new HttpClientHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(5) };
            using var response = await client.GetAsync(new Uri(server.BaseUri, "api/health"), timeout.Token);
            response.EnsureSuccessStatusCode();
            using var health = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            if (!health.RootElement.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True)
                throw new InvalidOperationException("Lasso's local server failed its startup health check.");
            return server;
        }
        catch { server.Dispose(); throw; }
    }

    private void ReadOutput(string? line)
    {
        if (line == null) return;
        const string prefix = "LASSO_READY ";
        if (!line.StartsWith(prefix, StringComparison.Ordinal)) { HostPaths.Log("Server: " + line); return; }
        try
        {
            using var payload = JsonDocument.Parse(line[prefix.Length..]);
            var token = payload.RootElement.GetProperty("nonce").GetString();
            var port = payload.RootElement.GetProperty("port").GetInt32();
            if (token != nonce || port is < 1 or > 65535)
                throw new InvalidOperationException("The local server returned an invalid startup identity.");
            ready.TrySetResult(new Uri($"http://127.0.0.1:{port}/"));
        }
        catch (Exception error) { ready.TrySetException(error); }
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        try
        {
            if (!process.HasExited)
            {
                try { process.StandardInput.WriteLine("LASSO_SHUTDOWN " + nonce); process.StandardInput.Flush(); process.StandardInput.Close(); }
                catch (IOException) { }
                if (!process.WaitForExit(3000)) process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { HostPaths.Log("Shutdown: " + error.Message); }
        finally { job.Dispose(); process.Dispose(); }
    }
}
