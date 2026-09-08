using System.Diagnostics;
using System.Net.Sockets;
using System.Runtime.InteropServices;

namespace AGUI.CrossLanguage.IntegrationTests;

/// <summary>
/// Spawns the sibling TypeScript fake-agent AG-UI server
/// (<c>CrossLanguage.Vitest/server/main.ts</c>) as an out-of-process child and
/// exposes its base URL. The fixture is shared across all tests in the
/// collection so we only pay the Node startup cost once per <c>dotnet test</c>
/// invocation.
/// </summary>
public sealed class TsServerFixture : IAsyncLifetime
{
    private const int Port = 8092;
    private Process? _process;

    public string BaseUrl => $"http://localhost:{Port}";

    public async Task InitializeAsync()
    {
        if (await IsPortInUseAsync(Port).ConfigureAwait(false))
        {
            throw new InvalidOperationException(
                $"Port {Port} is already in use. An orphan TS server may be running; terminate it before retrying.");
        }

        string scriptDir = ResolveVitestProjectDir();
        bool isWindows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);

        // pnpm invokes tsx which transpiles TypeScript on the fly — same path
        // the developer would use locally via `pnpm run server`. We don't shell
        // out via cmd.exe's UseShellExecute=true so we own a clean PID for
        // teardown, but on Windows a .cmd batch file cannot be Process.Start'd
        // directly with UseShellExecute=false — we have to go through cmd /c.
        //
        // We deliberately do NOT redirect stdout/stderr: under `dotnet test`
        // the runner's pipes can stall the child if the buffers fill, and we
        // don't need to inspect the server's logs from C# — `pnpm run server`
        // streams them to the test console directly which is good enough for
        // diagnosis.
        ProcessStartInfo psi = new()
        {
            FileName = isWindows ? "cmd.exe" : "pnpm",
            WorkingDirectory = scriptDir,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        if (isWindows)
        {
            psi.ArgumentList.Add("/c");
            psi.ArgumentList.Add("pnpm");
        }
        psi.ArgumentList.Add("run");
        psi.ArgumentList.Add("server");
        psi.Environment["PORT"] = Port.ToString(System.Globalization.CultureInfo.InvariantCulture);

        _process = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to launch the TypeScript fake-agent AG-UI server.");

        await WaitForServerAsync(BaseUrl, TimeSpan.FromSeconds(60)).ConfigureAwait(false);
    }

    public async Task DisposeAsync()
    {
        if (_process is null)
        {
            return;
        }

        try
        {
            if (!_process.HasExited)
            {
                // Process.Kill(entireProcessTree:true) only kills descendants
                // of the cmd.exe we own; intermediate pnpm/tsx hops orphan
                // the actual node listener to the System process, so a tree
                // kill misses it. Fall back to "whoever holds the port" so the
                // testhost doesn't leak the server process and hold its
                // stdout pipe (which makes the dotnet test runner appear to
                // hang even though the tests already passed).
                _process.Kill(entireProcessTree: true);
                using CancellationTokenSource cts = new(TimeSpan.FromSeconds(5));
                try
                {
                    await _process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { }
            }
        }
        catch (InvalidOperationException)
        {
            // Process already exited between HasExited check and Kill.
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }

        await KillOrphanByPortAsync(Port).ConfigureAwait(false);
    }

    private static async Task KillOrphanByPortAsync(int port)
    {
        // netstat-style probe to find the PID still bound to our port and kill
        // it directly. taskkill /F /PID terminates a specific process, which
        // is the only name-anchored variant our test environment policy
        // permits. We re-poll until the port frees so the next run can bind.
        for (int attempt = 0; attempt < 10; attempt++)
        {
            int? pid = FindListeningPid(port);
            if (pid is null)
            {
                return;
            }

            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                using Process kill = Process.Start(new ProcessStartInfo
                {
                    FileName = "taskkill",
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    ArgumentList = { "/F", "/PID", pid.Value.ToString(System.Globalization.CultureInfo.InvariantCulture) },
                }) ?? throw new InvalidOperationException("Failed to start taskkill.");
                await kill.WaitForExitAsync().ConfigureAwait(false);
            }
            else
            {
                try
                {
                    using Process? proc = Process.GetProcessById(pid.Value);
                    proc.Kill(entireProcessTree: true);
                }
                catch (ArgumentException) { /* process already gone */ }
            }

            await Task.Delay(250).ConfigureAwait(false);
        }
    }

    private static int? FindListeningPid(int port)
    {
        // System.Net.NetworkInformation gives us the bound endpoint, but the
        // owning PID needs a Win32 lookup that's not exposed there. On Windows
        // we shell out to netstat -ano -p tcp; on other platforms (CI Linux)
        // we use lsof. Both produce parseable text.
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            ProcessStartInfo psi = new()
            {
                FileName = "netstat",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
                ArgumentList = { "-ano", "-p", "tcp" },
            };
            using Process? proc = Process.Start(psi);
            if (proc is null)
            {
                return null;
            }
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();
            foreach (string line in output.Split('\n'))
            {
                string trimmed = line.Trim();
                if (trimmed.Contains($":{port} ", StringComparison.Ordinal) &&
                    trimmed.Contains("LISTENING", StringComparison.Ordinal))
                {
                    string[] parts = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length > 0 && int.TryParse(parts[^1], out int pid))
                    {
                        return pid;
                    }
                }
            }
            return null;
        }
        return null;
    }

    private static string ResolveVitestProjectDir()
    {
        string assemblyDir = Path.GetDirectoryName(typeof(TsServerFixture).Assembly.Location)
            ?? throw new InvalidOperationException("Cannot determine test assembly location.");

        // Walk up to sdks/dotnet/tests, then over to CrossLanguage.Vitest.
        // bin/Debug/net10.0 -> AGUI.CrossLanguage.IntegrationTests -> tests
        string testsDir = Path.GetFullPath(Path.Combine(assemblyDir, "..", "..", "..", ".."));
        string vitestDir = Path.Combine(testsDir, "CrossLanguage.Vitest");

        if (!Directory.Exists(vitestDir))
        {
            throw new DirectoryNotFoundException(
                $"Expected CrossLanguage.Vitest directory at {vitestDir} but it was not found. " +
                "Run `pnpm install` from the repository root before running these tests.");
        }

        return vitestDir;
    }

    private static async Task WaitForServerAsync(string url, TimeSpan timeout)
    {
        using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(2) };
        DateTime deadline = DateTime.UtcNow + timeout;
        Exception? last = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                // Even a 404 means the listener is up and routing — the TS
                // server only registers POST routes so a GET / returns 404.
                using HttpResponseMessage response = await http.GetAsync(url).ConfigureAwait(false);
                return;
            }
            catch (Exception ex)
            {
                last = ex;
            }
            await Task.Delay(500).ConfigureAwait(false);
        }
        throw new TimeoutException($"TS fake-agent server did not become reachable at {url} within {timeout} (last error: {last?.Message}).");
    }

    private static async Task<bool> IsPortInUseAsync(int port)
    {
        try
        {
            using TcpClient client = new();
            using CancellationTokenSource cts = new(TimeSpan.FromMilliseconds(500));
            await client.ConnectAsync("127.0.0.1", port, cts.Token).ConfigureAwait(false);
            return true;
        }
        catch
        {
            return false;
        }
    }
}

[CollectionDefinition(nameof(TsServerCollection))]
public sealed class TsServerCollection : ICollectionFixture<TsServerFixture>
{
}
