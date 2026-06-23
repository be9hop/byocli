import { describe, expect, it } from "vitest";
import type { AppState, TerminalSession, Workspace } from "../types";
import { createDefaultState, createWorkspace, normalizeState, profiles } from "./defaults";

/// Minimal helper to build a session row without repeating boilerplate.
function session(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: crypto.randomUUID(),
    title: "PowerShell",
    profileId: "shell",
    cwd: "C:\\proj",
    scrollback: "",
    createdAt: 1000,
    lastActiveAt: 1000,
    hasLaunched: false,
    ...overrides
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: crypto.randomUUID(),
    name: "proj",
    path: "C:\\proj",
    sessions: [session()],
    activeSessionId: "",
    browserTabs: [],
    activeBrowserTabId: null,
    browserOpen: false,
    splitRatio: 0.5,
    filesOpen: false,
    filesRatio: 0.22,
    ...overrides
  };
}

function state(workspaces: Workspace[], overrides: Partial<AppState> = {}): AppState {
  return {
    workspaces,
    activeWorkspaceId: workspaces[0]?.id || "",
    profiles,
    defaultProfileId: "shell",
    terminalFontSize: 15,
    terminalLineHeight: 1.45,
    terminalActions: [],
    automations: [],
    automationRuns: [],
    sidebarCollapsed: false,
    ...overrides
  };
}

describe("createWorkspace", () => {
  it("derives the name from the last path segment", () => {
    expect(createWorkspace("C:\\Users\\me\\code\\byocli").name).toBe("byocli");
    expect(createWorkspace("/home/me/code/app").name).toBe("app");
  });

  it("seeds one shell session and selects it", () => {
    const ws = createWorkspace("C:\\proj");
    expect(ws.sessions).toHaveLength(1);
    expect(ws.sessions[0].profileId).toBe("shell");
    expect(ws.activeSessionId).toBe(ws.sessions[0].id);
    expect(ws.sessions[0].hasLaunched).toBe(false);
  });

  it("honours a custom default profile id", () => {
    const ws = createWorkspace("C:\\proj", "claude");
    expect(ws.sessions[0].profileId).toBe("claude");
  });

  it("falls back to the first profile when the requested id is unknown", () => {
    const ws = createWorkspace("C:\\proj", "nope");
    expect(ws.sessions[0].profileId).toBe(profiles[0].id);
  });
});

describe("normalizeState — session preservation (M3)", () => {
  it("keeps every shell session on reload instead of collapsing to one", () => {
    const s1 = session({ id: "s1", title: "Tab 1" });
    const s2 = session({ id: "s2", title: "Tab 2" });
    const s3 = session({ id: "s3", title: "Tab 3" });
    const ws = workspace({ sessions: [s1, s2, s3], activeSessionId: "s2" });
    const normalized = normalizeState(state([ws]));

    expect(normalized.workspaces[0].sessions).toHaveLength(3);
    expect(normalized.workspaces[0].sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(normalized.workspaces[0].activeSessionId).toBe("s2");
  });

  it("clears stale shell scrollback (PTY is gone after restart)", () => {
    const s = session({ id: "s1", scrollback: "leftover output from dead process" });
    const ws = workspace({ sessions: [s], activeSessionId: "s1" });
    const normalized = normalizeState(state([ws]));
    expect(normalized.workspaces[0].sessions[0].scrollback).toBe("");
  });

  it("preserves agent session scrollback (used by native --resume restore)", () => {
    const s = session({ id: "a1", profileId: "claude", scrollback: "claude history" });
    const ws = workspace({ sessions: [s], activeSessionId: "a1" });
    const normalized = normalizeState(state([ws]));
    expect(normalized.workspaces[0].sessions[0].scrollback).toBe("claude history");
  });

  it("clears a pending command so it isn't replayed after restart", () => {
    const s = session({ id: "s1", pendingCommand: "npm run dev" });
    const ws = workspace({ sessions: [s], activeSessionId: "s1" });
    const normalized = normalizeState(state([ws]));
    expect(normalized.workspaces[0].sessions[0].pendingCommand).toBeUndefined();
  });

  it("seeds a default shell session when a workspace has none", () => {
    const ws = workspace({ sessions: [], activeSessionId: "" });
    const normalized = normalizeState(state([ws]));
    expect(normalized.workspaces[0].sessions).toHaveLength(1);
    expect(normalized.workspaces[0].sessions[0].profileId).toBe("shell");
  });

  it("re-points activeSessionId to the last session if the stored id is gone", () => {
    const s1 = session({ id: "s1" });
    const ws = workspace({ sessions: [s1], activeSessionId: "missing-id" });
    const normalized = normalizeState(state([ws]));
    expect(normalized.workspaces[0].activeSessionId).toBe("s1");
  });
});

describe("normalizeState — profile merge", () => {
  it("keeps built-in profile accents (user can't override brand colors)", () => {
    const custom = { ...profiles[0], accent: "#000000", name: "Renamed" };
    const normalized = normalizeState(state([], { profiles: [custom] }));
    const shell = normalized.profiles.find((p) => p.id === "shell");
    expect(shell?.name).toBe("Renamed"); // name preserved
    expect(shell?.accent).toBe(profiles[0].accent); // accent forced back
  });

  it("fills missing resumeArgs from the built-in profile", () => {
    const claudeWithoutResume = { ...profiles.find((p) => p.id === "claude")!, resumeArgs: undefined };
    const normalized = normalizeState(state([], { profiles: [claudeWithoutResume] }));
    const claude = normalized.profiles.find((p) => p.id === "claude");
    expect(claude?.resumeArgs).toEqual(["--continue"]);
  });

  it("retains user-defined custom profiles that aren't built-in", () => {
    const customProfile = { id: "custom-1", name: "My CLI", command: "mycli", args: [], accent: "#ff0000" };
    const normalized = normalizeState(state([], { profiles: [customProfile] }));
    expect(normalized.profiles.some((p) => p.id === "custom-1")).toBe(true);
  });
});

describe("normalizeState — automations", () => {
  it("caps automationRuns at the last 150", () => {
    const runs = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`, automationId: "a1", workingDirectory: "", command: "echo",
      status: "succeeded" as const, startedAt: i, output: "", attempt: 1
    }));
    const normalized = normalizeState(state([], { automationRuns: runs }));
    expect(normalized.automationRuns).toHaveLength(150);
    // The most recent 150 are retained (the tail of the array).
    expect(normalized.automationRuns.at(-1)!.id).toBe("r199");
  });
});

describe("createDefaultState", () => {
  it("seeds one workspace with a shell session and sane defaults", () => {
    const s = createDefaultState();
    expect(s.workspaces).toHaveLength(1);
    expect(s.workspaces[0].sessions[0].profileId).toBe("shell");
    expect(s.defaultProfileId).toBe("shell");
    expect(s.sidebarCollapsed).toBe(false);
  });
});
