//  Local port allocation.
//
//  Share links embed the port, so the same loopback port is preferred on every
//  launch: a link sent yesterday still resolves today. Any free port will do
//  when it is taken, which is also what keeps the companion from colliding with
//  a development server started by `npm start`.

using System.Net;
using System.Net.Sockets;

namespace Lasso.Windows.Server;

public static class PortAllocator
{
    public const int PreferredPort = 4319;

    /// Binds a specific loopback port when it is free. Returns null when the
    /// port is already taken. Deliberately does not set ReuseAddress: on
    /// Windows that would let this process bind a port another one is serving.
    public static int? ClaimPreferred(int port)
    {
        try
        {
            using var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            listener.Bind(new IPEndPoint(IPAddress.Loopback, port));
            return port;
        }
        catch (SocketException)
        {
            return null;
        }
    }

    /// Asks the kernel for an unused loopback port.
    public static int? FindFree()
    {
        try
        {
            using var listener = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            listener.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            return ((IPEndPoint)listener.LocalEndPoint!).Port;
        }
        catch (SocketException)
        {
            return null;
        }
    }
}
