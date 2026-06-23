import type {
  AppState, AnnotationPayload, DirectoryListing, TerminalExit, TerminalOutput, Workspace
} from "../types";

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function invokeNative<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`Native command "${command}" is only available inside Tauri.`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function listenNative<T>(
  event: string,
  callback: (payload: T) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (message) => callback(message.payload));
}

export async function loadState(): Promise<AppState | null> {
  if (!isTauri()) {
    const raw = localStorage.getItem("byocli.app-state") || localStorage.getItem("relay.app-state");
    return raw ? (JSON.parse(raw) as AppState) : null;
  }
  return invokeNative<AppState | null>("load_app_state");
}

export async function saveState(state: AppState): Promise<void> {
  if (!isTauri()) {
    localStorage.setItem("byocli.app-state", JSON.stringify(state));
    localStorage.removeItem("relay.app-state");
    return;
  }
  await invokeNative("save_app_state", { state });
}

export async function chooseWorkspace(): Promise<string | null> {
  if (!isTauri()) return "C:\\Users\\Alex\\Documents\\codex\\Multi-cli";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function getAutomationTempDirectory(): Promise<string> {
  if (!isTauri()) {
    return navigator.userAgent.includes("Windows")
      ? "C:\\Temp\\BYOCLI\\automations"
      : "/tmp/byocli/automations";
  }
  return invokeNative<string>("get_automation_temp_directory");
}

export async function spawnTerminal(workspace: Workspace, sessionId: string, command: string, args: string[]) {
  if (!isTauri()) return;
  await invokeNative("spawn_terminal", {
    request: {
      sessionId,
      workspaceId: workspace.id,
      cwd: workspace.path,
      command,
      args,
      cols: 120,
      rows: 32
    }
  });
}

export async function writeTerminal(sessionId: string, data: string) {
  if (!isTauri()) return;
  await invokeNative("write_terminal", { sessionId, data });
}

export async function resizeTerminal(sessionId: string, cols: number, rows: number) {
  if (!isTauri()) return;
  await invokeNative("resize_terminal", { sessionId, cols, rows });
}

export async function killTerminal(sessionId: string) {
  if (!isTauri()) return;
  await invokeNative("kill_terminal", { sessionId });
}

/// Sentinel exit code emitted by the backend for a session explicitly killed
/// via `kill_terminal` (or `kill_all_terminals` on app quit). Distinct from a
/// genuine crash so the frontend can skip "failed" framing and retry logic.
export const KILLED_EXIT_CODE = 137;

export async function getRunningTerminalSessionIds(): Promise<string[]> {
  if (!isTauri()) return [];
  return invokeNative<string[]>("get_running_terminal_session_ids");
}

export async function openExternal(target: string) {
  if (!isTauri()) {
    window.open(target, "_blank", "noopener,noreferrer");
    return;
  }
  await invokeNative("open_external", { target });
}

export async function listWorkspaceDirectory(root: string, path: string): Promise<DirectoryListing> {
  if (!isTauri()) return { entries: [], truncated: false };
  return invokeNative<DirectoryListing>("list_workspace_directory", { root, path });
}

export const onTerminalOutput = (callback: (payload: TerminalOutput) => void) =>
  listenNative<TerminalOutput>("terminal-output", callback);

export const onTerminalExit = (callback: (payload: TerminalExit) => void) =>
  listenNative<TerminalExit>("terminal-exit", callback);

export const onAutomationTick = (callback: () => void) =>
  listenNative<void>("automation-tick", callback);

export const onAnnotation = (callback: (payload: AnnotationPayload) => void) =>
  listenNative<AnnotationPayload>("browser-annotation", callback);

export type BrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export async function openBrowserWebview(label: string, url: string, bounds: BrowserBounds) {
  if (!isTauri()) return;
  await invokeNative("open_browser_webview", {
    request: { label, url, ...bounds }
  });
}

export async function navigateBrowserWebview(label: string, url: string) {
  if (!isTauri()) return;
  await invokeNative("navigate_browser_webview", { label, url });
}

export async function resizeBrowserWebview(label: string, bounds: BrowserBounds) {
  if (!isTauri()) return;
  await invokeNative("resize_browser_webview", { label, bounds });
}

export async function closeBrowserWebview(label: string) {
  if (!isTauri()) return;
  await invokeNative("close_browser_webview", { label });
}

export async function setBrowserWebviewVisibility(label: string, visible: boolean) {
  if (!isTauri()) return;
  await invokeNative("set_browser_webview_visibility", { label, visible });
}

export async function browserWebviewAction(
  label: string,
  action: "back" | "forward" | "reload" | "devtools"
) {
  if (!isTauri()) return;
  await invokeNative("browser_webview_action", { label, action });
}
