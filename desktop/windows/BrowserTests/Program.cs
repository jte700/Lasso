using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Threading;
using Lasso.Windows.Assist;

namespace Lasso.Windows;

internal static class HostPaths
{
    internal static string Root { get; } = Path.Combine(Path.GetTempPath(), "lasso-browser-test-" + Guid.NewGuid().ToString("N"));
    internal static void Log(string message) => Console.WriteLine(message);
}

// Runs on a real Windows desktop. Uses synthetic source responses and an
// isolated browser profile; no personal projects, browser tabs or history.
internal static class Program
{
    private static int checks;
    private static readonly string pageTitle = "Lasso browser check " + Guid.NewGuid().ToString("N");
    [STAThread]
    private static int Main(string[] args)
    {
        Directory.CreateDirectory(HostPaths.Root);
        var app = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        app.Dispatcher.BeginInvoke(new Action(async () =>
        {
            var code = 0;
            try { await Run(args.FirstOrDefault() ?? "edge"); }
            catch (Exception error) { Console.Error.WriteLine(error); code = 1; }
            finally { app.Shutdown(code); }
        }));
        return app.Run();
    }

    private static void Check(bool value, string description)
    {
        if (!value) throw new InvalidOperationException(description);
        Console.WriteLine("PASS: " + description); checks++;
    }

    private static async Task Run(string browserName)
    {
        var paths = browserName.Equals("chrome", StringComparison.OrdinalIgnoreCase)
            ? new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google/Chrome/Application/chrome.exe"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google/Chrome/Application/chrome.exe") }
            : new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft/Edge/Application/msedge.exe"), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft/Edge/Application/msedge.exe") };
        var executable = paths.FirstOrDefault(File.Exists) ?? throw new FileNotFoundException("Install " + browserName + " to run this check.");
        var socket = new TcpListener(IPAddress.Loopback, 0); socket.Start();
        var port = ((IPEndPoint)socket.LocalEndpoint).Port; socket.Stop();
        var origin = new Uri($"http://127.0.0.1:{port}/");
        using var server = new HttpListener(); server.Prefixes.Add(origin.ToString()); server.Start();
        var receivedLinkedContext = false;
        var responses = Task.Run(async () =>
        {
            while (server.IsListening)
            {
                HttpListenerContext request;
                try { request = await server.GetContextAsync(); } catch { break; }
                string body;
                if (request.Request.Url!.AbsolutePath == "/")
                {
                    request.Response.ContentType = "text/html";
                    body = $"<!doctype html><title>{pageTitle}</title><style>body{{font:18px Segoe UI;padding:70px}}textarea,input,div[contenteditable]{{display:block;font:18px Segoe UI;width:650px;min-height:60px;margin:25px}}</style><textarea aria-label='Test textarea' autofocus></textarea><input aria-label='Test input'><div contenteditable='true' role='textbox' aria-label='Test rich editor'></div>";
                }
                else if (request.Request.Url.AbsolutePath.EndsWith("/predict"))
                {
                    using var input = JsonDocument.Parse(await new StreamReader(request.Request.InputStream).ReadToEndAsync());
                    var text = input.RootElement.GetProperty("text").GetString()!;
                    receivedLinkedContext |= input.RootElement.TryGetProperty("pendingDependencies", out var links) && links.GetArrayLength() > 0;
                    body = JsonSerializer.Serialize(new { prediction = new { claims = new[] { new {
                        type = "STUDY_VARIABLE", start = Math.Max(0, text.Length - 7), end = text.Length,
                        candidates = Enumerable.Range(1, 5).Select(i => new { id = "object" + i, versionId = "version1", snapshotId = "snapshot1",
                            label = i == 1 ? "Revenue" : "Revenue " + i, valueText = "revenue; inferred numeric variable; examples 41, 5, 42", path = "test.xlsx" }) } } } });
                }
                else body = "{\"preview\":{\"text\":\"Synthetic workbook source\"}}";
                var bytes = Encoding.UTF8.GetBytes(body);
                request.Response.ContentLength64 = bytes.Length;
                try { await request.Response.OutputStream.WriteAsync(bytes); } finally { request.Response.Close(); }
            }
        });
        var info = new ProcessStartInfo(executable) { UseShellExecute = false };
        info.ArgumentList.Add("--user-data-dir=" + Path.Combine(HostPaths.Root, "browser"));
        foreach (var flag in new[] { "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility", "--disable-background-networking", "--disable-sync", "--app=" + origin }) info.ArgumentList.Add(flag);
        using var browser = Process.Start(info)!;
        using var reader = new AutomationReader();
        using var controller = new AssistController(origin) { ProjectId = "test" };
        try
        {
            IntPtr hwnd = IntPtr.Zero;
            for (int attempt = 0; attempt < 100 && hwnd == IntPtr.Zero; attempt++)
            {
                foreach (var process in Process.GetProcessesByName(browserName == "chrome" ? "chrome" : "msedge"))
                {
                    using (process) if (process.MainWindowTitle.Contains(pageTitle)) { hwnd = process.MainWindowHandle; break; }
                }
                if (hwnd == IntPtr.Zero) await Task.Delay(150);
            }
            Check(hwnd != IntPtr.Zero, "Isolated browser fixture opened");
            controller.SetEnabled(true);
            Check(controller.Enabled, "Native assistance hook enabled");
            foreach (var label in new[] { "Test textarea", "Test input", "Test rich editor" })
            {
                SetForegroundWindow(hwnd);
                await Task.Delay(100);
                var element = await Task.Run(() => AutomationElement.FromHandle(hwnd).FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.NameProperty, label)));
                Check(element != null, label + " is accessible");
                await Task.Run(() => element!.SetFocus());
                AutomationReader.Snapshot? captured = null;
                for (int attempt = 0; attempt < 30 && captured == null; attempt++) { captured = await reader.CaptureAsync(CancellationToken.None); await Task.Delay(100); }
                Check(captured != null, label + " exposes an editable caret");
                Check(AssistNative.SendUnicode("I was looking at the revenue", hwnd), "Typed fixture text without clipboard changes");
                await Task.Delay(350);
                await Invoke(controller, "PredictAsync");
                var popup = (AssistPopup)typeof(AssistController).GetField("popup", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(controller)!;
                var prediction = (AssistPrediction?)typeof(AssistController).GetField("prediction", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(controller);
                Check(popup.IsVisible && prediction?.Suggestions.Count == 5, label + " shows five alternatives");
                await Task.Delay(6500);
                Check(popup.IsVisible, label + " popup remains visible after idle");
                await Invoke(controller, "AcceptAsync");
                var after = await reader.CaptureAsync(CancellationToken.None);
                Check(after?.Before == "I was looking at the revenue", "Exact acceptance never duplicates text or inserts metadata");
                var reference = controller.GetRecentReferences()[0];
                Check(reference.Text == "revenue", "Accepted word has a verified source reference");
                var geometry = await reader.LocateReferencesAsync([reference], CancellationToken.None);
                Check(geometry?.Length == 1 && geometry[0].Bounds.Length > 0, "Accepted word has real browser text geometry");
                await Task.Delay(700);
                Check(receivedLinkedContext, "Following predictions carry the accepted source");
                var opened = false;
                EventHandler<SourceOpenRequestedEventArgs> handler = (_, e) => opened |= e.SourceId == reference.SourceId;
                controller.OpenSourceRequested += handler;
                var rect = geometry![0].Bounds[0];
                SetCursorPos((int)(rect.Left + rect.Width / 2), (int)(rect.Top + rect.Height / 2));
                mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                for (int attempt = 0; attempt < 20 && !opened; attempt++) await Task.Delay(100);
                controller.OpenSourceRequested -= handler;
                Check(opened, label + " accepted word opens its source when clicked");
                receivedLinkedContext = false;
            }
            Console.WriteLine($"Passed {checks} live Windows {browserName} checks.");
        }
        finally
        {
            controller.SetEnabled(false); server.Stop();
            if (!browser.HasExited) browser.Kill(true);
            await responses;
            try { Directory.Delete(HostPaths.Root, true); } catch (IOException) { }
        }
    }
    private static Task Invoke(AssistController target, string method) => (Task)typeof(AssistController)
        .GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(target, method == "AcceptAsync" ? new object[] { true } : null)!;
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
