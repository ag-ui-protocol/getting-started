import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Port for the C# AG-UI server. Picked to avoid colliding with the dojo's
 * 8016 .NET backend in case both are running on the same machine.
 */
export const DOTNET_SERVER_PORT = 8091;

let server: ChildProcess | null = null;

/**
 * Build the CrossLanguage.TestServer (sibling project), spawn the produced
 * executable, and wait until it responds on its HTTP port. We launch the
 * built binary instead of `dotnet run` so we get a single PID to terminate
 * cleanly — `dotnet run` spawns intermediate hosts that don't always die
 * with their parent on Windows, which leaves orphans bound to the port.
 *
 * The server reads OPENAI_BASE_URL from configuration and routes LLM calls
 * through the supplied URL — set this to point at the LLMock instance
 * started by helpers/llmock.ts.
 */
export async function startDotnetServer(opts: {
  openAiBaseUrl: string;
  modelId?: string;
  apiKey?: string;
}): Promise<string> {
  if (server) {
    return baseUrl();
  }

  await ensurePortFree(DOTNET_SERVER_PORT);

  const projectDir = path.resolve(__dirname, "..", "..", "CrossLanguage.TestServer");

  // Pre-build so the spawned process is just the server, not the dotnet
  // build pipeline. -p:NuGetAudit=false avoids the OpenTelemetry NU1902
  // advisory blocking restore (a known shared-workspace blocker, see
  // sdks/dotnet/docs/cross-language-testing.md for context). SignAssembly=false
  // keeps AGUI.Protobuf's test-only InternalsVisibleTo access enabled.
  const build = spawnSync(
    "dotnet",
    [
      "build",
      projectDir,
      "-c",
      "Debug",
      "-nologo",
      "-clp:NoSummary",
      "-p:NuGetAudit=false",
      "-p:SignAssembly=false",
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error(`dotnet build of CrossLanguage.TestServer failed (exit ${build.status}).`);
  }

  const exe = path.join(
    projectDir,
    "bin",
    "Debug",
    "net10.0",
    process.platform === "win32" ? "CrossLanguage.TestServer.exe" : "CrossLanguage.TestServer",
  );

  server = spawn(exe, [`--urls=${baseUrl()}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENAI_BASE_URL: opts.openAiBaseUrl,
      OPENAI_API_KEY: opts.apiKey ?? "sk-mock",
      OPENAI_CHAT_MODEL_ID: opts.modelId ?? "gpt-4o",
      ASPNETCORE_ENVIRONMENT: "Development",
      DOTNET_NOLOGO: "1",
    },
  });

  // Mirror server logs to stderr so failures during test runs are visible.
  server.stdout?.on("data", (data) => process.stderr.write(`[dotnet] ${data}`));
  server.stderr?.on("data", (data) => process.stderr.write(`[dotnet:err] ${data}`));

  await waitForServer(baseUrl(), 60_000);
  return baseUrl();
}

export async function stopDotnetServer(): Promise<void> {
  if (!server) {
    return;
  }
  const child = server;
  server = null;

  if (child.exitCode !== null || child.signalCode !== null) {
    await killOrphanByPort(DOTNET_SERVER_PORT);
    return;
  }

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  // Direct exe means a single PID, so plain kill works on all platforms.
  // We still set a hard timeout in case the process is wedged in native code.
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve();
    }, 5_000),
  );

  await Promise.race([exited, timeout]);

  // Belt-and-suspenders: occasionally Windows leaves the .exe alive even
  // after Node thinks it killed it (the child PID may be reused / the
  // listening socket may still hold the port). Force-kill whoever owns the
  // port so the next run can bind without "EADDRINUSE".
  await killOrphanByPort(DOTNET_SERVER_PORT);
}

async function killOrphanByPort(port: number): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
  const { spawnSync } = await import("node:child_process");
  // netstat -ano emits "  TCP   127.0.0.1:8091   0.0.0.0:0   LISTENING   <pid>"
  const out = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  if (out.status !== 0) return;
  for (const line of out.stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.includes(`:${port} `) && trimmed.includes("LISTENING")) {
      const parts = trimmed.split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid) && pid > 0) {
        spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
      }
    }
  }
}

export function baseUrl(): string {
  return `http://localhost:${DOTNET_SERVER_PORT}`;
}

// Polling probe: ASP.NET Core returns 404 once routing is up, which is the
// signal we want here — we don't need a healthz endpoint, only confirmation
// that the HTTP listener has bound the port.
async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status >= 200 && res.status < 600) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `C# AG-UI server did not become reachable at ${url} within ${timeoutMs}ms (last error: ${String(lastError)})`,
  );
}

// Guard against orphan servers from a previous interrupted run: if the port
// is already in use we abort with a clear error so the developer can clean up.
// We don't kill it automatically — the bound process might be unrelated.
async function ensurePortFree(port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
  if (inUse) {
    throw new Error(
      `Port ${port} is already in use. An orphan CrossLanguage.TestServer from a previous run may be listening; terminate it before retrying.`,
    );
  }
}
