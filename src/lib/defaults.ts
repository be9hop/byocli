import type { AppState, TerminalAction, TerminalProfile, Workspace } from "../types";
import { uuid } from "./uuid";

export const profiles: TerminalProfile[] = [
  { id: "shell", name: "PowerShell", command: "powershell.exe", args: ["-NoLogo"], accent: "#aeb6b4" },
  { id: "claude", name: "Claude Code", command: "claude", args: [], resumeArgs: ["--continue"], accent: "#17f5c1" },
  { id: "codex", name: "Codex CLI", command: "codex", args: [], resumeArgs: ["resume", "--last"], accent: "#17f5c1" },
  { id: "gemini", name: "Gemini CLI", command: "gemini", args: [], resumeArgs: ["--resume", "latest"], accent: "#17f5c1" },
  { id: "omp", name: "Oh My Pi", command: "omp", args: [], resumeArgs: ["--continue"], accent: "#17f5c1" },
  { id: "aider", name: "Aider", command: "aider", args: [], accent: "#17f5c1" },
  { id: "opencode", name: "OpenCode", command: "opencode", args: [], accent: "#17f5c1" },
  { id: "goose", name: "Goose", command: "goose", args: [], accent: "#17f5c1" }
];

export const terminalActions: TerminalAction[] = [
  { id: "npm-dev", name: "npm dev", command: "npm run dev", favorite: true },
  { id: "tauri-dev", name: "Tauri dev", command: "npm run tauri dev", favorite: true }
];

export function createWorkspace(path: string, defaultProfileId = "shell", availableProfiles = profiles): Workspace {
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || "workspace";
  const id = uuid();
  const sessionId = uuid();
  const selectedProfile = availableProfiles.find((profile) => profile.id === defaultProfileId) || profiles[0];
  return {
    id,
    name,
    path,
    sessions: [{
      id: sessionId,
      title: selectedProfile.name,
      profileId: selectedProfile.id,
      cwd: path,
      scrollback: "",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      hasLaunched: false
    }],
    activeSessionId: sessionId,
    browserTabs: [],
    activeBrowserTabId: null,
    browserOpen: false,
    splitRatio: 0.5,
    filesOpen: false,
    filesRatio: 0.22
  };
}

export function normalizeState(state: AppState): AppState {
  const knownProfiles = new Map(profiles.map((profile) => [profile.id, profile]));
  const mergedProfiles = profiles.map((profile) => {
    const saved = state.profiles?.find((item) => item.id === profile.id);
    return saved ? {
      ...profile,
      ...saved,
      accent: profile.accent,
      resumeArgs: saved.resumeArgs || profile.resumeArgs
    } : profile;
  });
  for (const saved of state.profiles || []) {
    if (!knownProfiles.has(saved.id)) mergedProfiles.push(saved);
  }

  const normalizedWorkspaces = state.workspaces.map((workspace) => {
    // Preserve every session the user had open. PTY processes don't survive a
    // restart, so the scrollback is reset (TerminalPane will re-spawn each
    // session from its profile/cwd), but the tab metadata — title, profile,
    // working directory, order — is kept intact instead of collapsing multiple
    // shell tabs into one.
    const sessions = workspace.sessions.map((session) => ({
      ...session,
      hasLaunched: session.hasLaunched ?? true,
      // The backing PTY is gone after a restart; clear stale scrollback so the
      // restored terminal doesn't render ghost output from a dead process.
      scrollback: session.profileId === "shell" ? "" : session.scrollback,
      pendingCommand: undefined
    }));
    const finalSessions = sessions.length ? sessions : [{
      id: uuid(),
      title: "PowerShell",
      profileId: "shell",
      cwd: workspace.path,
      scrollback: "",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      hasLaunched: false
    }];
    return {
      ...workspace,
      filesOpen: workspace.filesOpen ?? false,
      filesRatio: workspace.filesRatio ?? 0.22,
      sessions: finalSessions,
      activeSessionId: finalSessions.some((session) => session.id === workspace.activeSessionId)
        ? workspace.activeSessionId
        : finalSessions.at(-1)!.id
    };
  });

  return {
    ...state,
    profiles: mergedProfiles,
    sidebarCollapsed: state.sidebarCollapsed ?? false,
    defaultProfileId: mergedProfiles.some((profile) => profile.id === state.defaultProfileId)
      ? state.defaultProfileId
      : "shell",
    terminalFontSize: state.terminalFontSize ?? 15,
    terminalLineHeight: state.terminalLineHeight ?? 1.45,
    terminalActions: (state.terminalActions || terminalActions).map((action, index) => ({
      ...action,
      favorite: action.favorite ?? index < 2
    })),
    automations: (state.automations || []).map((automation) => ({
      ...automation,
      scope: automation.scope === "workspace" ? "workspace" : automation.scope ? "temp" : "workspace",
      workingDirectory: automation.scope === "workspace" || !automation.scope
        ? automation.workingDirectory || state.workspaces.find((workspace) => workspace.id === automation.workspaceId)?.path
        : undefined
    })),
    automationRuns: (state.automationRuns || []).map((run) => ({
      ...run,
      workingDirectory: run.workingDirectory || state.workspaces.find((workspace) => workspace.id === run.workspaceId)?.path || "",
      command: run.command || state.automations?.find((automation) => automation.id === run.automationId)?.command || "",
      output: run.output || ""
    })).slice(-150),
    workspaces: normalizedWorkspaces
  };
}

export function createDefaultState(): AppState {
  const workspace = createWorkspace("C:\\Users\\Alex\\Documents\\codex\\Multi-cli");
  return {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    profiles,
    defaultProfileId: "shell",
    terminalFontSize: 15,
    terminalLineHeight: 1.45,
    terminalActions,
    automations: [],
    automationRuns: [],
    sidebarCollapsed: false
  };
}
