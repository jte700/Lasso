//  Owns the Node child process: start, health-poll, restart, and shutdown.
//
//  A direct counterpart to the macOS ServerController. The server is the same
//  src/server.js the development command runs; only the supervision is native.

using System.Diagnostics;
using System.IO;
using System.Net.Http;
using Lasso.Windows.Support;

namespace Lasso.Windows.Server;

public enum ServerPhase
{
    Starting,
    Ready,
    Failed,
}

public readonly record struct ServerState(ServerPhase Phase, string? Message = null)
{
    public static readonly ServerState Starting = new(ServerPhase.Starting);
    public static readonly ServerState Ready = new(ServerPhase.Ready);
    public static ServerState Failed(string message) => new(ServerPhase.Failed, message);
}

public sealed class ServerController : IDisposable
{
    private readonly string _appDirectory;
    private readonly string _dataDirectory;
    private readonly string _logPath;
    private readonly ProcessJob _job = new();
    private readonly object _gate = new();
    private Process? _process;
    private FileStream? _log;
    private int _generation;

    public int Port { get; private set; }
    public ServerState State { get; private set; } = ServerState.Starting;
    public Action<ServerState>? OnStateChange { get; set; }

    public Uri? Url => Port > 0 ? new Uri($"http://127.0.0.1:{Port}/") : null;

    public ServerController(string appDirectory, string dataDirectory, string logPath)
    {
        _appDirectory = appDirectory;
        _dataDirectory = dataDirectory;
        _logPath = logPath;
    }

    public void Start()
    {
        Transition(ServerState.Starting);

        var node = NodeLocator.Resolve();
        if (node is null)
        {
            Transition(ServerState.Failed(
                "Node.js 24+ was not found. Install Node, or set LASSO_NODE to its path."));
            return;
        }

        // Share links embed the port, so a stable one is preferred: links sent
        // yesterday still resolve today. Falls back to any free port.
        var chosen = PortAllocator.ClaimPreferred(PortAllocator.PreferredPort) ?? PortAllocator.FindFree();
        if (chosen is not { } port)
        {
            Transition(ServerState.Failed("No free local port was available."));
            return;
        }
        Port = port;

        try
        {
            Directory.CreateDirectory(_dataDirectory);
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
        }
        catch (Exception error)
        {
            Transition(ServerState.Failed($"The data folder could not be created: {error.Message}"));
            return;
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = node,
            // Config resolves public/ and migrations/ from the working directory.
            WorkingDirectory = _appDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--disable-warning=ExperimentalWarning");
        startInfo.ArgumentList.Add(Path.Combine("src", "server.js"));
        startInfo.Environment["PORT"] = port.ToString();
        startInfo.Environment["LASSO_DATA_DIR"] = _dataDirectory;
        // Isolated here so shares can later be served from a hosted origin.
        startInfo.Environment["SHARE_BASE_URL"] =
            Environment.GetEnvironmentVariable("SHARE_BASE_URL") ?? $"http://localhost:{port}";

        Process child;
        try
        {
            OpenLog();
            child = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            child.OutputDataReceived += (_, args) => AppendLog(args.Data);
            child.ErrorDataReceived += (_, args) => AppendLog(args.Data);
            var generation = ++_generation;
            child.Exited += (_, _) => OnChildExited(generation);
            if (!child.Start())
            {
                Transition(ServerState.Failed("The server could not be launched."));
                return;
            }
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            _job.Assign(child.Handle);
        }
        catch (Exception error)
        {
            Transition(ServerState.Failed($"The server could not be launched: {error.Message}"));
            return;
        }

        _process = child;
        _ = WaitUntilHealthyAsync(_generation);
    }

    /// Polls the static root until the HTTP server answers, so the web view is
    /// only pointed at a port that is actually serving.
    private async Task WaitUntilHealthyAsync(int generation)
    {
        if (Url is not { } url) return;
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTimeOffset.UtcNow.AddSeconds(25);

        while (DateTimeOffset.UtcNow < deadline)
        {
            if (generation != _generation) return;
            if (_process is null || _process.HasExited) return;
            try
            {
                using var response = await client.GetAsync(url).ConfigureAwait(false);
                if ((int)response.StatusCode == 200)
                {
                    if (generation == _generation) Transition(ServerState.Ready);
                    return;
                }
            }
            catch (Exception)
            {
                // Not listening yet.
            }
            await Task.Delay(250).ConfigureAwait(false);
        }
        if (generation == _generation)
        {
            Transition(ServerState.Failed("The server did not become ready. See the log for details."));
        }
    }

    private void OnChildExited(int generation)
    {
        if (generation != _generation) return;
        if (State.Phase != ServerPhase.Ready) return;
        Transition(ServerState.Failed("The Lasso server stopped. Use Restart Server to bring it back."));
    }

    public void Restart()
    {
        Stop();
        Start();
    }

    public void Stop()
    {
        _generation++;
        var process = _process;
        _process = null;
        if (process is not null)
        {
            try
            {
                if (!process.HasExited)
                {
                    // Windows has no SIGTERM to offer a child. The history store
                    // is SQLite with a journal, which is crash-safe by design —
                    // the same reason the macOS build is willing to SIGKILL a
                    // server that ignores its termination request.
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3_000);
                }
            }
            catch (Exception)
            {
                // Already gone.
            }
            process.Dispose();
        }
        CloseLog();
    }

    private void OpenLog()
    {
        lock (_gate)
        {
            CloseLog();
            try
            {
                _log = new FileStream(_logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            }
            catch (Exception)
            {
                _log = null;
            }
        }
    }

    private void AppendLog(string? line)
    {
        if (line is null) return;
        lock (_gate)
        {
            if (_log is null) return;
            try
            {
                var bytes = System.Text.Encoding.UTF8.GetBytes(line + Environment.NewLine);
                _log.Write(bytes, 0, bytes.Length);
                _log.Flush();
            }
            catch (Exception)
            {
                // The log is a convenience, never a dependency.
            }
        }
    }

    private void CloseLog()
    {
        try
        {
            _log?.Dispose();
        }
        catch (Exception)
        {
            // Ignored.
        }
        _log = null;
    }

    private void Transition(ServerState next)
    {
        State = next;
        OnStateChange?.Invoke(next);
    }

    public void Dispose()
    {
        Stop();
        _job.Dispose();
    }
}
