using System;
using System.Security.Principal;
using System.Threading;

namespace Lasso.Windows;

internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex mutex;
    private readonly EventWaitHandle activation;
    private RegisteredWaitHandle? registration;
    public bool IsFirst { get; }

    public SingleInstance()
    {
        string identity = WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName;
        string prefix = @"Local\Lasso.Windows." + identity;
        activation = new EventWaitHandle(false, EventResetMode.AutoReset, prefix + ".Activate");
        mutex = new Mutex(true, prefix + ".Instance", out bool created);
        IsFirst = created;
        if (!IsFirst) activation.Set();
    }

    public void OnActivation(Action callback) => registration = ThreadPool.RegisterWaitForSingleObject(
        activation, (_, timedOut) => { if (!timedOut) callback(); }, null, Timeout.Infinite, false);

    public void Dispose()
    {
        registration?.Unregister(null);
        if (IsFirst) mutex.ReleaseMutex();
        mutex.Dispose();
        activation.Dispose();
    }
}
