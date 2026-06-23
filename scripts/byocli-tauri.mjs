import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(scriptsDir, "..");
const args = process.argv.slice(2);
const devMode = args[0] === "dev";

function canConnect(port, host) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(400);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function portOccupied(port) {
  const results = await Promise.all([
    canConnect(port, "127.0.0.1"),
    canConnect(port, "::1")
  ]);
  return results.some(Boolean);
}

if (devMode && (process.env.BYOCLI_WORKSPACE_ID || process.env.RELAY_WORKSPACE_ID)) {
  console.error(
    "BYOCLI cannot restart its own Tauri development process from an embedded terminal. " +
    "Run `npm run tauri dev` from an external PowerShell window."
  );
  process.exit(1);
}

if (devMode && process.platform === "win32") {
  const cleanup = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(scriptsDir, "stop-byocli-dev.ps1"),
      "-Workspace", workspace,
      "-ExcludePid", String(process.pid)
    ],
    { stdio: "inherit" }
  );
  if (cleanup.status !== 0) process.exit(cleanup.status ?? 1);
}

if (devMode && await portOccupied(1420)) {
  console.error(
    "Port 1420 is still occupied by another application. " +
    "Stop that application or run `npm run dev:stop`, then try again."
  );
  process.exit(1);
}

const tauriCli = path.join(workspace, "node_modules", "@tauri-apps", "cli", "tauri.js");
const child = spawn(process.execPath, [tauriCli, ...args], {
  cwd: workspace,
  stdio: "inherit",
  env: process.env
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
