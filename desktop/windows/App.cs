using System;
using System.IO;
using System.Threading.Tasks;
using System.Windows;

namespace Lasso.Windows;

internal sealed class App : Application
{
    [STAThread]
    public static int Main(string[] args)
    {
        HostPaths.Initialize();
        if (Array.IndexOf(args, "--smoke-test") >= 0) return SmokeTestAsync().GetAwaiter().GetResult();
        using var instance = new SingleInstance();
        if (!instance.IsFirst) return 0;
        var application = new App { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        var window = new MainWindow();
        application.MainWindow = window;
        instance.OnActivation(() => application.Dispatcher.BeginInvoke(new Action(window.Reveal)));
        application.SessionEnding += (_, _) => window.ShutdownHost();
        application.Exit += (_, _) => window.ShutdownHost();
        application.DispatcherUnhandledException += (_, eventArgs) =>
        {
            HostPaths.Log(eventArgs.Exception.ToString());
            MessageBox.Show("Lasso encountered an unexpected error. Details were saved in " + HostPaths.Logs,
                "Lasso", MessageBoxButton.OK, MessageBoxImage.Error);
            eventArgs.Handled = true;
            window.ShutdownHost();
            application.Shutdown(1);
        };
        return application.Run(window);
    }

    private static async Task<int> SmokeTestAsync()
    {
        // Packaging validation uses temporary data, never the user's workspace.
        var data = Path.Combine(Path.GetTempPath(), "Lasso-smoke-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(data);
        try
        {
            using var server = await ServerProcess.StartAsync(data);
            return server.BaseUri != null ? 0 : 1;
        }
        catch (Exception error) { HostPaths.Log("Smoke test: " + error); return 1; }
        finally { try { Directory.Delete(data, true); } catch (IOException) { } }
    }
}
