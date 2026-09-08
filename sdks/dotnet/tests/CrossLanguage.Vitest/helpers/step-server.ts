import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as net from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build and spawn a GettingStarted Step*.Server sample so a TS HttpAgent can
 * drive it over the wire. The Step samples are unmodified — when no Azure
 * configuration is supplied they fall back to a deterministic FakeChatClient,
 * which is exactly the cross-language test surface we want.
 *
 * Each Step sample is its own ASP.NET Core executable; we shell out to its
 * built .exe (rather than `dotnet run`) so the spawned process is a single
 * PID that is easy to kill cleanly on Windows.
 */
export interface StepServerHandle {
  baseUrl: string;
  stop: () => Promise<void>;
}

export interface StartStepServerOptions {
  /** Step number, e.g. 1, 2, 9, 10. */
  step: number;
  /** Project name suffix, e.g. "GettingStarted", "BackendTools". */
  projectName: string;
  /** TCP port to bind. Each Step test should pick a unique port to allow parallel runs. */
  port: number;
  /** Extra env vars passed to the spawned exe. */
  env?: Record<string, string>;
}

export async function startStepServer(opts: StartStepServerOptions): Promise<StepServerHandle> {
  const stepName = `Step${String(opts.step).padStart(2, "0")}_${opts.projectName}`;
  const projectDir = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "samples",
    "GettingStarted",
    stepName,
    `${stepName}.Server`,
  );

  await ensurePortFree(opts.port);

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
    ],
    { stdio: "inherit" },
  );
  if (build.status !== 0) {
    throw new Error(`dotnet build of ${stepName}.Server failed (exit ${build.status}).`);
  }

  const exe = path.join(
    projectDir,
    "bin",
    "Debug",
    "net10.0",
    process.platform === "win32" ? `${stepName}.Server.exe` : `${stepName}.Server`,
  );

  const baseUrl = `http://localhost:${opts.port}`;

  const child = spawn(exe, [`--urls=${baseUrl}`], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ASPNETCORE_ENVIRONMENT: "Development",
      DOTNET_NOLOGO: "1",
      ...(opts.env ?? {}),
    },
  });

  child.stdout?.on("data", (data) => process.stderr.write(`[${stepName}] ${data}`));
  child.stderr?.on("data", (data) => process.stderr.write(`[${stepName}:err] ${data}`));

  await waitForServer(baseUrl, 60_000);

  return {
    baseUrl,
    stop: () => stopChild(child, opts.port),
  };
}

async function stopChild(child: ChildProcess, port: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await killOrphanByPort(port);
    return;
  }

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

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
  await killOrphanByPort(port);
}

async function killOrphanByPort(port: number): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }
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
    `Step server did not become reachable at ${url} within ${timeoutMs}ms (last error: ${String(lastError)})`,
  );
}

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
      `Port ${port} is already in use. An orphan Step server from a previous run may be listening; terminate it before retrying.`,
    );
  }
}
