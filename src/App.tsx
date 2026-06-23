import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, ChevronDown, Columns2, FolderGit2, FolderTree,
  MessageSquareText, PanelLeftClose, PanelLeftOpen, Plus, Send,
  TerminalSquare, X, Zap
} from "lucide-react";
import type {
  AnnotationItem, AnnotationPayload, AppState, Automation, AutomationRun, BrowserTab, TerminalAction,
  TerminalSession, Workspace
} from "./types";
import { createDefaultState, createWorkspace, normalizeState } from "./lib/defaults";
import {
  chooseWorkspace, getAutomationTempDirectory, getLocalFileServerPort, getRunningTerminalSessionIds, isTauri, killTerminal, loadState, onAutomationTick, onTerminalExit, onTerminalOutput, openExternal,
  saveState, spawnTerminal, writeTerminal, KILLED_EXIT_CODE
} from "./lib/platform";
import { Sidebar, type SidebarWorkspace } from "./components/Sidebar";
import { IconButton } from "./components/IconButton";
import { TerminalPane } from "./components/TerminalPane";
import { BrowserPane } from "./components/BrowserPane";
import { FileTreePane } from "./components/FileTreePane";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsDialog, type SettingsSection } from "./components/SettingsDialog";
import { AutomationsView } from "./components/AutomationsView";
import { nextRunForSchedule } from "./lib/automations";
import { uuid } from "./lib/uuid";
import { applyTheme, logoForTheme, persistTheme } from "./lib/theme";
import "./styles.css";

function tabTitle(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "localhost" ? `localhost:${parsed.port || "80"}` : parsed.hostname.replace(/^www\./, "");
  } catch {
    return "Browser";
  }
}

/// Stable empty array returned by the sidebar-workspaces memo before state has
/// loaded, so the memoized Sidebar receives a consistent reference (avoids a
/// fresh `[]` each render triggering an unnecessary re-render).
const EMPTY_WORKSPACES: SidebarWorkspace[] = [];

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [annotation, setAnnotation] = useState<AnnotationPayload | null>(null);
  const [annotationItems, setAnnotationItems] = useState<AnnotationItem[]>([]);
  const [annotationComment, setAnnotationComment] = useState("");
  const [annotating, setAnnotating] = useState(false);
  const [annotationSending, setAnnotationSending] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<Workspace | null>(null);
  const [activeView, setActiveView] = useState<"workspace" | "automations">("workspace");
  const [automationTempDirectory, setAutomationTempDirectory] = useState("");
  const [fileServerPort, setFileServerPort] = useState(0);
  const annotationInputRef = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState<"browser" | "files" | null>(null);
  const stateRef = useRef<AppState | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef<Promise<void> | null>(null);
  const outputBufferRef = useRef(new Map<string, string>());
  const outputFlushRef = useRef<number | null>(null);
  const automationTimeoutsRef = useRef(new Map<string, number>());
  const timedOutSessionsRef = useRef(new Set<string>());
  const automationRunSessionsRef = useRef(new Map<string, AutomationRun>());
  const automationDispatchRef = useRef(new Set<string>());
  const runAutomationRef = useRef<(automationId: string, attempt?: number, focus?: boolean) => Promise<void>>(async () => {});
  // Stable ref to addWorkspace so the global keydown listener can call the
  // latest version without re-subscribing on every render.
  const addWorkspaceRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    void (async () => {
      try {
        const saved = await loadState();
        const runningSessionIds = await getRunningTerminalSessionIds().catch((error) => {
          console.warn("Unable to inspect running terminal sessions during startup", error);
          return [];
        });
        const next = saved ? normalizeState(saved) : createDefaultState();
        const running = new Set(runningSessionIds);
        const now = Date.now();
        next.automationRuns = next.automationRuns.map((run) =>
          (run.status === "running" || run.status === "queued") && (!run.sessionId || !running.has(run.sessionId))
            ? {
                ...run,
                status: "failed",
                endedAt: now,
                exitCode: 1,
                error: "The run was interrupted because its process is no longer active."
              }
            : run
        );
        setState(next);

        // Reattach timeouts to automation runs that survived (their backend PTY
        // is still alive and the frontend is resuming oversight).
        const survivingRunSessionIds = new Set(
          next.automationRuns.filter((run) => run.status === "running" && run.sessionId).map((run) => run.sessionId!)
        );
        next.automationRuns.filter((run) => run.status === "running" && run.sessionId).forEach((run) => {
          const automation = next.automations.find((item) => item.id === run.automationId);
          if (!automation || !run.sessionId) return;
          const remaining = run.startedAt + Math.max(1, automation.timeoutMinutes) * 60_000 - now;
          const timeout = window.setTimeout(() => {
            timedOutSessionsRef.current.add(run.sessionId!);
            void killTerminal(run.sessionId!);
          }, Math.max(0, remaining));
          automationTimeoutsRef.current.set(run.sessionId, timeout);
        });

        // Clean up orphaned backend PTYs: any backend session the frontend is no
        // longer tracking (e.g. after a dev reload or crash) would otherwise emit
        // terminal-output into the void and leak a child process.
        if (runningSessionIds.length) {
          for (const sessionId of runningSessionIds) {
            if (!survivingRunSessionIds.has(sessionId)) {
              void killTerminal(sessionId).catch(() => {});
            }
          }
        }
      } catch (error) {
        console.error("Unable to restore BYOCLI state", error);
        setState(createDefaultState());
      }
    })();
    void getAutomationTempDirectory().then(setAutomationTempDirectory).catch(console.error);
    void getLocalFileServerPort().then(setFileServerPort).catch(console.error);
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        void addWorkspaceRef.current();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setState((current) => current ? {
          ...current,
          sidebarCollapsed: !current.sidebarCollapsed
        } : current);
      }
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
        setActionMenuOpen(false);
        setSearchOpen(false);
        setSettingsSection(null);
        setPendingRemoval(null);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
    // Subscribe once. The only non-stable dependency (addWorkspace) is reached
    // via addWorkspaceRef.current, so the listener always sees the latest copy
    // without re-registering on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flushState = useCallback(async (force = false) => {
    if (!stateRef.current || (!dirtyRef.current && !force)) return;
    if (savingRef.current) {
      await savingRef.current;
      if (dirtyRef.current || force) await flushState(false);
      return;
    }

    const snapshot = stateRef.current;
    dirtyRef.current = false;
    const save = saveState(snapshot)
      .catch((error) => {
        dirtyRef.current = true;
        console.error("Unable to save workspace state", error);
        throw error;
      })
      .finally(() => {
        savingRef.current = null;
      });
    savingRef.current = save;
    await save;
  }, []);

  useEffect(() => {
    if (!state) return;
    stateRef.current = state;
    dirtyRef.current = true;
  }, [state]);

  // Apply the theme to the DOM and mirror it to localStorage for the next
  // boot's flash-prevention read. main.tsx does the initial synchronous apply;
  // this effect keeps the DOM in sync whenever the user changes the theme.
  useEffect(() => {
    if (!state?.theme) return;
    applyTheme(state.theme);
    persistTheme(state.theme);
  }, [state?.theme]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (dirtyRef.current) void flushState();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [flushState]);

  useEffect(() => {
    let stop = () => {};
    void onTerminalOutput((payload) => {
      const automationRun = stateRef.current?.automationRuns.find((run) =>
        run.sessionId === payload.sessionId && run.status === "running"
      );
      if (automationRun && payload.data.includes("\u001b[6n")) {
        void writeTerminal(payload.sessionId, "\u001b[1;1R").catch(() => {});
      }
      outputBufferRef.current.set(
        payload.sessionId,
        `${outputBufferRef.current.get(payload.sessionId) || ""}${payload.data}`
      );
      if (outputFlushRef.current !== null) return;
      outputFlushRef.current = window.setTimeout(() => {
        outputFlushRef.current = null;
        const buffered = outputBufferRef.current;
        outputBufferRef.current = new Map();
        const now = Date.now();
        setState((current) => {
          if (!current || buffered.size === 0) return current;
          let found = false;
          const workspaces = current.workspaces.map((workspace) => {
            if (!workspace.sessions.some((session) => buffered.has(session.id))) return workspace;
            found = true;
            return {
              ...workspace,
              sessions: workspace.sessions.map((session) => {
                const data = buffered.get(session.id);
                return data ? {
                  ...session,
                  scrollback: `${session.scrollback}${data}`.slice(-200_000),
                  lastActiveAt: now
                } : session;
              })
            };
          });
          const automationRuns = current.automationRuns.map((run) => {
            const data = run.sessionId ? buffered.get(run.sessionId) : undefined;
            if (!data) return run;
            found = true;
            return { ...run, output: `${run.output}${data}`.slice(-120_000) };
          });
          return found ? { ...current, workspaces, automationRuns } : current;
        });
      }, 100);
    }).then((unlisten) => { stop = unlisten; });
    return () => {
      stop();
      if (outputFlushRef.current !== null) window.clearTimeout(outputFlushRef.current);
    };
  }, []);

  useEffect(() => {
    let stop = () => {};
    void onTerminalExit((payload) => {
      const timeout = automationTimeoutsRef.current.get(payload.sessionId);
      if (timeout) window.clearTimeout(timeout);
      automationTimeoutsRef.current.delete(payload.sessionId);

      const snapshot = stateRef.current;
      const run = snapshot?.automationRuns.find((item) => item.sessionId === payload.sessionId)
        || automationRunSessionsRef.current.get(payload.sessionId);
      automationRunSessionsRef.current.delete(payload.sessionId);
      if (!snapshot || !run) return;
      const timedOut = timedOutSessionsRef.current.delete(payload.sessionId);
      const killed = payload.exitCode === KILLED_EXIT_CODE;
      const automation = snapshot.automations.find((item) => item.id === run.automationId);
      // A killed session (user cancel, overlap "terminate", or shutdown) is not a
      // failure: no retry, no "failed" framing.
      const failed = !timedOut && !killed && payload.exitCode !== 0;

      setState((current) => current ? ({
        ...current,
        automationRuns: current.automationRuns.map((item) => item.id === run.id ? {
          ...item,
          status: timedOut ? "timed_out" : killed ? "skipped" : payload.exitCode === 0 ? "succeeded" : "failed",
          endedAt: Date.now(),
          exitCode: payload.exitCode,
          error: timedOut
            ? "The automation exceeded its configured timeout."
            : killed
              ? "The run was cancelled."
              : payload.exitCode === 0
                ? undefined
                : `The command exited with code ${payload.exitCode}.`
        } : item)
      }) : current);

      if (failed && automation && run.attempt <= automation.retryCount) {
        window.setTimeout(() => void runAutomationRef.current(automation.id, run.attempt + 1, false), 1500);
        return;
      }

      if (automation) {
        const queued = snapshot.automationRuns.find((item) =>
          item.automationId === automation.id && item.status === "queued"
        );
        if (queued) {
          setState((current) => current ? ({
            ...current,
            automationRuns: current.automationRuns.filter((item) => item.id !== queued.id)
          }) : current);
          window.setTimeout(() => void runAutomationRef.current(automation.id, 1, false), 250);
        }
      }
    }).then((unlisten) => { stop = unlisten; });
    return () => stop();
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      const flush = () => {
        if (stateRef.current) localStorage.setItem("byocli.app-state", JSON.stringify(stateRef.current));
      };
      window.addEventListener("beforeunload", flush);
      return () => window.removeEventListener("beforeunload", flush);
    }

    let stop = () => {};
    let closing = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      stop = await appWindow.onCloseRequested(async (event) => {
        if (closing) return;
        event.preventDefault();
        closing = true;
        try {
          await flushState(true);
        } finally {
          await appWindow.hide();
          closing = false;
        }
      });
    });
    return () => stop();
  }, [flushState]);

  const workspace = state?.workspaces.find((item) => item.id === state.activeWorkspaceId);
  const session = workspace?.sessions.find((item) => item.id === workspace.activeSessionId);
  const profile = state?.profiles.find((item) => item.id === session?.profileId);
  // Sidebar only reads id/name/path/activeSessionId and each session's id+title
  // — never scrollback or other hot fields. Memoize on a content signature so
  // the memoized Sidebar skips re-rendering during the 100ms-coalesced terminal
  // output flushes, which would otherwise rebuild it ~10x/sec on busy shells.
  const sidebarWorkspaces = useMemo(() => {
    if (!state) return EMPTY_WORKSPACES;
    return state.workspaces.map((item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      activeSessionId: item.activeSessionId,
      sessions: item.sessions.map((entry) => ({ id: entry.id, title: entry.title }))
    }));
    // Signature covers exactly the fields consumed above; scrollback/output
    // changes do not appear here, so the array reference stays stable across
    // terminal output flushes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state?.workspaces.map((w) => `${w.id}|${w.name}|${w.path}|${w.activeSessionId}|${w.sessions.map((s) => `${s.id}:${s.title}`).join(",")}`).join("||")
  ]);
  const updateWorkspace = useCallback((workspaceId: string, update: (workspace: Workspace) => Workspace) => {
    setState((current) => current ? ({
      ...current,
      workspaces: current.workspaces.map((item) => item.id === workspaceId ? update(item) : item)
    }) : current);
  }, []);

  const selectWorkspace = useCallback((id: string, sessionId?: string) => {
    setActiveView("workspace");
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        activeWorkspaceId: id,
        workspaces: sessionId
          ? current.workspaces.map((item) => item.id === id ? { ...item, activeSessionId: sessionId } : item)
          : current.workspaces
      };
    });
  }, []);

  const addWorkspace = async () => {
    const path = await chooseWorkspace();
    if (!path) return;
    const next = createWorkspace(path, state?.defaultProfileId || "shell", state?.profiles);
    setState((current) => current ? ({
      ...current,
      workspaces: [...current.workspaces.filter((item) => item.path !== path), next],
      activeWorkspaceId: next.id
    }) : current);
  };
  addWorkspaceRef.current = addWorkspace;

  const openBrowser = useCallback((url = "https://www.google.com") => {
    if (!workspace) return;
    // Accept any explicit URL scheme (http(s)://, file://, etc.) as-is; only
    // prepend https:// for bare hostnames typed in the address bar. Previously
    // a `file://` URL failed the http-only check and got wrapped as
    // `https://file://...`, corrupting local-file opens from the file tree.
    const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
    const existing = workspace.browserTabs.find((tab) => tab.url === normalized);
    if (existing) {
      updateWorkspace(workspace.id, (item) => ({
        ...item, browserOpen: true, activeBrowserTabId: existing.id
      }));
      return;
    }
    const tab: BrowserTab = {
      id: uuid(),
      title: tabTitle(normalized),
      url: normalized
    };
    updateWorkspace(workspace.id, (item) => ({
      ...item,
      browserOpen: true,
      browserTabs: [...item.browserTabs, tab],
      activeBrowserTabId: tab.id
    }));
  }, [workspace, updateWorkspace]);

  const toggleBrowser = useCallback(() => {
    if (!workspace) return;
    if (workspace.browserOpen) {
      updateWorkspace(workspace.id, (item) => ({
        ...item,
        browserOpen: false,
        browserTabs: [],
        activeBrowserTabId: null
      }));
      setAnnotating(false);
      return;
    }
    openBrowser();
  }, [openBrowser, updateWorkspace, workspace]);

  const addSession = (profileId = state?.defaultProfileId || "shell", pendingCommand?: string) => {
    if (!workspace || !state) return;
    const selectedProfile = state.profiles.find((item) => item.id === profileId) || state.profiles[0];
    const next: TerminalSession = {
      id: uuid(),
      title: selectedProfile.name,
      profileId: selectedProfile.id,
      cwd: workspace.path,
      scrollback: "",
      pendingCommand,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      hasLaunched: false
    };
    updateWorkspace(workspace.id, (item) => ({
      ...item,
      sessions: [...item.sessions, next],
      activeSessionId: next.id
    }));
    setProfileMenuOpen(false);
    setActionMenuOpen(false);
  };

  const runTerminalAction = (action: TerminalAction) => {
    addSession("shell", action.command);
  };

  const runAutomation = useCallback(async (automationId: string, attempt = 1, focus = true) => {
    const snapshot = stateRef.current;
    const automation = snapshot?.automations.find((item) => item.id === automationId);
    const targetWorkspace = snapshot?.workspaces.find((item) => item.id === automation?.workspaceId);
    // A workspace-scoped automation must keep its workspace. If the workspace is
    // gone, fail the run explicitly rather than silently relocating to the temp
    // dir — running a workspace command in the wrong cwd could mutate the wrong
    // project or surface confusing "file not found" errors.
    if (automation?.scope === "workspace" && !targetWorkspace) {
      const now = Date.now();
      const failedRun: AutomationRun = {
        id: uuid(), automationId, workspaceId: automation.workspaceId,
        workingDirectory: "", command: automation.command, output: "",
        status: "failed", startedAt: now, endedAt: now, attempt, exitCode: 1,
        error: "The workspace for this automation was removed."
      };
      setState((current) => current ? {
        ...current,
        automations: current.automations.map((item) => item.id === automationId
          ? { ...item, enabled: false, nextRunAt: Number.MAX_SAFE_INTEGER } : item),
        automationRuns: [...current.automationRuns, failedRun].slice(-150)
      } : current);
      return;
    }
    const workingDirectory = automation?.scope === "workspace"
      ? targetWorkspace?.path
      : await getAutomationTempDirectory();
    if (!snapshot || !automation || !workingDirectory) return;
    const executionWorkspace: Workspace = targetWorkspace || {
      id: `temp-${automation.id}`,
      name: automation.name,
      path: workingDirectory,
      sessions: [],
      activeSessionId: "",
      browserTabs: [],
      activeBrowserTabId: null,
      browserOpen: false,
      splitRatio: 0.5,
      filesOpen: false,
      filesRatio: 0.22
    };

    const running = snapshot.automationRuns.filter((item) =>
      item.automationId === automation.id && item.status === "running"
    );
    if (running.length && attempt === 1) {
      if (automation.overlapPolicy === "skip") {
        const now = Date.now();
        const skipped: AutomationRun = {
          id: uuid(), automationId, workspaceId: targetWorkspace?.id,
          workingDirectory, command: automation.command, output: "",
          status: "skipped", startedAt: now, endedAt: now, attempt
        };
        setState((current) => current ? ({
          ...current,
          automations: current.automations.map((item) => item.id === automationId
            ? { ...item, nextRunAt: nextRunForSchedule(item.schedule, now) } : item),
          automationRuns: [...current.automationRuns, skipped].slice(-150)
        }) : current);
        return;
      }
      if (automation.overlapPolicy === "queue") {
        if (!snapshot.automationRuns.some((item) => item.automationId === automationId && item.status === "queued")) {
          const queued: AutomationRun = {
            id: uuid(), automationId, workspaceId: targetWorkspace?.id,
            workingDirectory, command: automation.command, output: "",
            status: "queued", startedAt: Date.now(), attempt
          };
          setState((current) => current ? ({
            ...current,
            automations: current.automations.map((item) => item.id === automationId
              ? { ...item, nextRunAt: nextRunForSchedule(item.schedule) } : item),
            automationRuns: [...current.automationRuns, queued].slice(-150)
          }) : current);
        }
        return;
      }
      if (automation.overlapPolicy === "terminate") {
        // Kill the in-flight run(s) and wait for them to actually exit before
        // starting the new one — otherwise terminate briefly runs two processes.
        await Promise.all(running.flatMap((item) => item.sessionId ? [killTerminal(item.sessionId)] : []));
        // Mark the killed runs as skipped so the history reflects the collision.
        setState((current) => current ? ({
          ...current,
          automationRuns: current.automationRuns.map((item) =>
            running.some((r) => r.id === item.id) ? {
              ...item, status: "skipped", endedAt: Date.now(),
              error: "Superseded by a newer run (terminate policy)."
            } : item
          )
        }) : current);
      } else if (automation.overlapPolicy === "parallel") {
        // Explicit no-op: fall through and start an additional run alongside.
      }
    }

    const now = Date.now();
    const runId = uuid();
    const sessionId = uuid();
    const run: AutomationRun = {
      id: runId, automationId, workspaceId: targetWorkspace?.id, workingDirectory,
      command: automation.command, output: "", sessionId,
      status: "running", startedAt: now, attempt
    };
    automationRunSessionsRef.current.set(sessionId, run);

    setState((current) => current ? ({
      ...current,
      automations: current.automations.map((item) => item.id === automationId ? {
        ...item,
        lastRunAt: now,
        nextRunAt: nextRunForSchedule(item.schedule, now)
      } : item),
      automationRuns: [...current.automationRuns, run].slice(-150)
    }) : current);

    try {
      await spawnTerminal(executionWorkspace, sessionId, "powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", automation.command
      ]);
      const timeout = window.setTimeout(() => {
        timedOutSessionsRef.current.add(sessionId);
        void killTerminal(sessionId);
      }, Math.max(1, automation.timeoutMinutes) * 60_000);
      automationTimeoutsRef.current.set(sessionId, timeout);
    } catch {
      setState((current) => current ? ({
        ...current,
        automationRuns: current.automationRuns.map((item) => item.id === runId ? {
          ...item, status: "failed", endedAt: Date.now(), exitCode: 1,
          error: "BYOCLI could not start the automation process."
        } : item)
      }) : current);
    }
  }, []);
  runAutomationRef.current = runAutomation;

  useEffect(() => {
    const check = () => {
      const snapshot = stateRef.current;
      if (!snapshot) return;
      const now = Date.now();
      snapshot.automations
        .filter((automation) =>
          automation.enabled &&
          automation.nextRunAt <= now &&
          !automationDispatchRef.current.has(automation.id)
        )
        .forEach((automation) => {
          automationDispatchRef.current.add(automation.id);
          // Release the gate only after the dispatch fully resolves, then wait
          // a short grace period. runAutomation advances nextRunAt via setState
          // before resolving, so by the time .finally fires the schedule can no
          // longer match this tick. The grace period absorbs the React commit
          // delay between setState and stateRef seeing the new nextRunAt.
          void runAutomationRef.current(automation.id, 1, false)
            .catch(() => {})
            .finally(() => window.setTimeout(() => automationDispatchRef.current.delete(automation.id), 2000));
        });
    };
    check();
    const interval = window.setInterval(check, 15_000);
    let stop = () => {};
    void onAutomationTick(check).then((unlisten) => { stop = unlisten; });
    return () => {
      window.clearInterval(interval);
      stop();
    };
  }, []);

  const closeSession = async (sessionId: string) => {
    if (!workspace || workspace.sessions.length === 1) return;
    await killTerminal(sessionId);
    updateWorkspace(workspace.id, (item) => {
      const sessions = item.sessions.filter((entry) => entry.id !== sessionId);
      return {
        ...item,
        sessions,
        activeSessionId: item.activeSessionId === sessionId ? sessions.at(-1)!.id : item.activeSessionId
      };
    });
  };

  const removeWorkspace = async () => {
    if (!pendingRemoval || !state) return;
    if (state.workspaces.length === 1) {
      setPendingRemoval(null);
      return;
    }
    await Promise.all(pendingRemoval.sessions.map((item) => killTerminal(item.id).catch(() => {})));
    const remaining = state.workspaces.filter((item) => item.id !== pendingRemoval.id);
    const nextActive = state.activeWorkspaceId === pendingRemoval.id
      ? remaining[0]?.id || ""
      : state.activeWorkspaceId;
    const removedAutomationIds = new Set(
      state.automations.filter((item) => item.workspaceId === pendingRemoval.id).map((item) => item.id)
    );
    setState({
      ...state,
      workspaces: remaining,
      activeWorkspaceId: nextActive,
      automations: state.automations.filter((item) => item.workspaceId !== pendingRemoval.id),
      automationRuns: state.automationRuns.filter((item) => !removedAutomationIds.has(item.automationId))
    });
    setPendingRemoval(null);
  };

  const handleAnnotation = useCallback((payload: AnnotationPayload) => {
    setAnnotation(payload);
    setAnnotationComment("");
    window.setTimeout(() => annotationInputRef.current?.focus(), 0);
  }, []);

  const currentAnnotationItem = () => {
    const comment = annotationComment.trim();
    if (!annotation || !comment) return null;
    return { id: uuid(), payload: annotation, comment } satisfies AnnotationItem;
  };

  const addAnnotationItem = () => {
    const item = currentAnnotationItem();
    if (!item) return;
    setAnnotationItems((items) => [...items, item]);
    setAnnotation(null);
    setAnnotationComment("");
    setAnnotating(true);
  };

  const sendAnnotations = async () => {
    const current = currentAnnotationItem();
    const items = current ? [...annotationItems, current] : annotationItems;
    if (!session || items.length === 0 || annotationSending) return;
    const itemSections = items.flatMap((item, index) => {
      const selected = item.payload;
      return [
        `${index + 1}. ${item.comment}`,
        `   URL: ${selected.url}`,
        `   Element: ${selected.tag}`,
        `   Text: "${selected.text}"`,
        `   CSS selector: ${selected.selector}`,
        `   XPath: ${selected.xpath}`,
        `   Bounding box: x=${Math.round(selected.bounds.x)} y=${Math.round(selected.bounds.y)} width=${Math.round(selected.bounds.width)} height=${Math.round(selected.bounds.height)}`,
        `   Nearby text: "${selected.nearbyText}"`,
        ""
      ];
    });
    const message = [
      `The user annotated ${items.length} browser element${items.length === 1 ? "" : "s"} and requested these changes:`,
      "",
      ...itemSections,
      "Apply all requested changes in the current workspace."
    ].join("\n");
    setAnnotationSending(true);
    try {
      await writeTerminal(session.id, `\u001b[200~${message}\u001b[201~\r`);
      setAnnotation(null);
      setAnnotationItems([]);
      setAnnotationComment("");
    } finally {
      setAnnotationSending(false);
    }
  };

  useEffect(() => {
    if (!dragging || !workspace) return;
    const move = (event: MouseEvent) => {
      const shell = document.querySelector<HTMLElement>(".workspace-content");
      if (!shell) return;
      const rect = shell.getBoundingClientRect();
      if (dragging === "files") {
        const ratio = Math.min(0.4, Math.max(0.14, (rect.right - event.clientX) / rect.width));
        updateWorkspace(workspace.id, (item) => ({ ...item, filesRatio: ratio }));
        return;
      }
      const filesWidth = workspace.filesOpen ? rect.width * workspace.filesRatio : 0;
      const availableWidth = Math.max(1, rect.width - filesWidth);
      const ratio = Math.min(0.72, Math.max(0.28, (event.clientX - rect.left) / availableWidth));
      updateWorkspace(workspace.id, (item) => ({ ...item, splitRatio: ratio }));
    };
    const stop = () => setDragging(null);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
    };
  }, [dragging, workspace, updateWorkspace]);

  const layoutStyle = useMemo(() => {
    if (!workspace) return undefined;
    if (workspace.browserOpen && workspace.filesOpen) {
      const filesWeight = workspace.filesRatio / (1 - workspace.filesRatio);
      return {
        gridTemplateColumns:
          `${workspace.splitRatio}fr 4px ${1 - workspace.splitRatio}fr 4px ${filesWeight}fr`
      };
    }
    if (workspace.browserOpen) {
      return { gridTemplateColumns: `${workspace.splitRatio}fr 4px ${1 - workspace.splitRatio}fr` };
    }
    if (workspace.filesOpen) {
      return { gridTemplateColumns: `${1 - workspace.filesRatio}fr 4px ${workspace.filesRatio}fr` };
    }
    return undefined;
  }, [workspace]);

  if (!state || !workspace || !session || !profile) {
    return <div className="boot-screen"><img className="boot-logo" src={logoForTheme(state?.theme ?? "dark")} alt="BYOCLI" /><span>Restoring workspace…</span></div>;
  }

  return (
    <div className={`app-shell ${state.sidebarCollapsed ? "sidebar-is-collapsed" : ""} ${dragging ? "is-resizing" : ""}`}>
      <Sidebar
        workspaces={sidebarWorkspaces}
        activeId={workspace.id}
        automationsActive={activeView === "automations"}
        collapsed={state.sidebarCollapsed}
        theme={state.theme}
        onExpand={() => setState((current) => current ? { ...current, sidebarCollapsed: false } : current)}
        onSelect={selectWorkspace}
        onAdd={addWorkspace}
        onSearch={() => setSearchOpen(true)}
        onAutomations={() => setActiveView("automations")}
        onSettings={() => setSettingsSection("general")}
        onRemove={(sidebarWorkspace) => {
          // Resolve the minimal sidebar shape back to the full workspace, which
          // carries the session rows needed for terminal cleanup on removal.
          const full = state.workspaces.find((item) => item.id === sidebarWorkspace.id);
          if (full) setPendingRemoval(full);
        }}
        onOpenAppLink={() => void openExternal(workspace.path)}
      />

      {activeView === "automations" ? (
        <section className="workspace-shell automation-workspace-shell">
          <AutomationsView
            automations={state.automations}
            runs={state.automationRuns}
            workspaces={state.workspaces}
            activeWorkspaceId={workspace.id}
            tempDirectory={automationTempDirectory}
            onChange={(automations) => setState((current) => current ? { ...current, automations } : current)}
            onRun={(automation) => {
              const current = stateRef.current;
              if (current) {
                const next = {
                  ...current,
                  automations: current.automations.map((item) => item.id === automation.id ? automation : item)
                };
                stateRef.current = next;
                setState(next);
              }
              void runAutomation(automation.id, 1, false);
            }}
            onStopRun={(run) => {
              // Kill the backing PTY. The terminal-exit handler will flip the
              // run to "skipped" (KILLED_EXIT_CODE path) and clear its timeout.
              if (run.sessionId) void killTerminal(run.sessionId);
            }}
          />
        </section>
      ) : (
      <main className="workspace-shell">
        <header className="titlebar" data-tauri-drag-region>
          <div className="workspace-identity">
            <IconButton
              label={state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              active={state.sidebarCollapsed}
              onClick={() => setState((current) => current ? {
                ...current,
                sidebarCollapsed: !current.sidebarCollapsed
              } : current)}
            >
              {state.sidebarCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
            </IconButton>
            <strong>{workspace.name}</strong>
            <span className="path-chip"><FolderGit2 size={13} /> {workspace.path}</span>
          </div>
          <div className="titlebar-actions">
            <button
              type="button"
              className={`pane-launch ${workspace.browserOpen ? "is-active" : ""}`}
              aria-pressed={workspace.browserOpen}
              onClick={toggleBrowser}
            >
              <Columns2 size={14} /> {workspace.browserOpen ? "Close browser" : "Open browser"}
            </button>
            <button
              type="button"
              className={`pane-launch ${workspace.filesOpen ? "is-active" : ""}`}
              aria-pressed={workspace.filesOpen}
              onClick={() => updateWorkspace(workspace.id, (item) => ({
                ...item,
                filesOpen: !item.filesOpen
              }))}
            >
              <FolderTree size={14} /> Files
            </button>
          </div>
        </header>

        <div
          className={`workspace-content ${workspace.browserOpen ? "has-browser" : ""} ${workspace.filesOpen ? "has-files" : ""}`}
          style={layoutStyle}
        >
          <section className="terminal-pane">
            <div className="terminal-tabs">
              <div className="terminal-tab-scroll">
                {workspace.sessions.map((item) => {
                  const itemProfile = state.profiles.find((entry) => entry.id === item.profileId);
                  return (
                    <button
                      type="button"
                      key={item.id}
                      className={`terminal-tab ${item.id === session.id ? "is-active" : ""}`}
                      onClick={() => updateWorkspace(workspace.id, (current) => ({
                        ...current, activeSessionId: item.id
                      }))}
                    >
                      <span className="profile-dot" style={{ background: itemProfile?.accent }} />
                      <TerminalSquare size={13} />
                      <span>{item.title}</span>
                      {workspace.sessions.length > 1 && (
                        <X size={12} onClick={(event) => { event.stopPropagation(); void closeSession(item.id); }} />
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="new-session">
                <button
                  type="button"
                  className="new-terminal-button"
                  aria-expanded={profileMenuOpen}
                  onClick={() => {
                    setActionMenuOpen(false);
                    setProfileMenuOpen((value) => !value);
                  }}
                >
                  <Plus size={14} />
                  <span>New terminal</span>
                  <ChevronDown size={12} />
                </button>
                {profileMenuOpen && (
                  <div className="profile-menu">
                    <span>Choose a terminal profile</span>
                    {state.profiles.map((item) => (
                      <button type="button" key={item.id} onClick={() => addSession(item.id)}>
                        <span className="profile-dot" style={{ background: item.accent }} />
                        <span>{item.name}</span>
                        <code>{item.command}</code>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <TerminalPane
              key={session.id}
              workspace={workspace}
              session={session}
              profile={profile}
              fontSize={state.terminalFontSize}
              lineHeight={state.terminalLineHeight}
              theme={state.theme}
              onOpenUrl={openBrowser}
              onLaunched={(sessionId) => updateWorkspace(workspace.id, (item) => ({
                ...item,
                sessions: item.sessions.map((entry) =>
                  entry.id === sessionId && !entry.hasLaunched ? { ...entry, hasLaunched: true } : entry
                )
              }))}
              onAgentDetected={(sessionId, profileId) => {
                const detectedProfile = state.profiles.find((item) => item.id === profileId);
                updateWorkspace(workspace.id, (item) => ({
                  ...item,
                  sessions: item.sessions.map((entry) => entry.id === sessionId ? ({
                    ...entry,
                    profileId,
                    title: detectedProfile?.name || entry.title,
                    hasLaunched: true
                  }) : entry)
                }));
              }}
              onCommandDispatched={(sessionId) => updateWorkspace(workspace.id, (item) => ({
                ...item,
                sessions: item.sessions.map((entry) =>
                  entry.id === sessionId ? { ...entry, pendingCommand: undefined } : entry
                )
              }))}
            />

            <div className="terminal-commandbar">
              <span className="commandbar-label"><Zap size={13} /> Quick commands</span>
              <div className="quick-command-list">
                {state.terminalActions.filter((action) => action.favorite).slice(0, 4).map((action) => (
                  <button type="button" key={action.id} onClick={() => runTerminalAction(action)}>
                    <span>{action.name}</span>
                    <code>{action.command}</code>
                  </button>
                ))}
                {!state.terminalActions.some((action) => action.favorite) && (
                  <span className="no-favorite-commands">Choose favorites in Settings</span>
                )}
              </div>
              <div className="command-menu-wrap">
                <button
                  type="button"
                  className="run-command-button"
                  aria-expanded={actionMenuOpen}
                  onClick={() => {
                    setProfileMenuOpen(false);
                    setActionMenuOpen((value) => !value);
                  }}
                >
                  Run commands <ChevronDown size={12} />
                </button>
                {actionMenuOpen && (
                  <div className="action-menu">
                    <div className="action-menu-head">
                      <span>Other commands</span>
                      <small>Each command opens in a new PowerShell tab.</small>
                    </div>
                    <div className="action-list">
                      {state.terminalActions.filter((action) => !action.favorite).map((action) => (
                        <button type="button" className="action-row" key={action.id} onClick={() => runTerminalAction(action)}>
                          <Zap size={12} />
                          <span>{action.name}</span>
                          <code>{action.command}</code>
                        </button>
                      ))}
                      {!state.terminalActions.some((action) => !action.favorite) && (
                        <p className="command-menu-empty">All saved commands are pinned as favorites.</p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="manage-commands"
                      onClick={() => {
                        setActionMenuOpen(false);
                        setSettingsSection("commands");
                      }}
                    >
                      Manage saved commands
                    </button>
                  </div>
                )}
              </div>
            </div>

            {(annotation || annotationItems.length > 0) && (
              <form
                className="annotation-card"
                aria-label="Describe browser annotation"
                onSubmit={(event) => {
                  event.preventDefault();
                  void sendAnnotations();
                }}
              >
                <div className="annotation-card-head">
                  <span><AppWindow size={14} /> Annotation list · {annotationItems.length + (annotation ? 1 : 0)}</span>
                  <IconButton
                    label="Dismiss annotations"
                    onClick={() => {
                      setAnnotation(null);
                      setAnnotationItems([]);
                      setAnnotationComment("");
                      setAnnotating(false);
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                </div>
                {annotationItems.length > 0 && (
                  <ol className="annotation-list">
                    {annotationItems.map((item) => (
                      <li key={item.id}>
                        <div>
                          <span>{item.payload.tag.toLowerCase()}</span>
                          <strong>{item.comment}</strong>
                          <small>“{item.payload.text.slice(0, 64) || "Untitled element"}”</small>
                        </div>
                        <IconButton
                          label="Remove annotation"
                          onClick={() => setAnnotationItems((items) => items.filter((entry) => entry.id !== item.id))}
                        >
                          <X size={12} />
                        </IconButton>
                      </li>
                    ))}
                  </ol>
                )}
                {annotation ? (
                  <>
                    <div className="annotation-element">
                      <span>{annotation.tag.toLowerCase()}</span>
                      <strong>“{annotation.text.slice(0, 72) || "Untitled element"}”</strong>
                    </div>
                    <code title={annotation.selector}>{annotation.selector}</code>
                    <label className="annotation-comment-label" htmlFor="annotation-comment">
                      <MessageSquareText size={13} />
                      What should change?
                    </label>
                    <textarea
                      ref={annotationInputRef}
                      id="annotation-comment"
                      value={annotationComment}
                      onChange={(event) => setAnnotationComment(event.target.value)}
                      placeholder="Increase this heading’s font size and make it more prominent."
                      rows={3}
                      disabled={annotationSending}
                      onKeyDown={(event) => {
                        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                          event.preventDefault();
                          void sendAnnotations();
                        }
                      }}
                    />
                  </>
                ) : (
                  <button type="button" className="select-another" onClick={() => setAnnotating(true)}>
                    <Plus size={13} /> Select another browser element
                  </button>
                )}
                <div className="annotation-actions">
                  {annotation && (
                    <button
                      type="button"
                      className="annotation-add"
                      disabled={!annotationComment.trim() || annotationSending}
                      onClick={addAnnotationItem}
                    >
                      <Plus size={13} /> Add & select another
                    </button>
                  )}
                  <button
                    type="submit"
                    disabled={(annotationItems.length === 0 && !annotationComment.trim()) || annotationSending}
                  >
                    <Send size={13} />
                    {annotationSending ? "Sending…" : `Send ${annotationItems.length + (annotationComment.trim() ? 1 : 0)} to ${session.title}`}
                  </button>
                </div>
              </form>
            )}

          </section>

          {workspace.browserOpen && (
            <>
              <button
                type="button"
                className="split-handle"
                aria-label="Resize browser split"
                onMouseDown={() => setDragging("browser")}
              />
              <BrowserPane
                workspaceId={workspace.id}
                tabs={workspace.browserTabs}
                activeTabId={workspace.activeBrowserTabId}
                onSelect={(id) => updateWorkspace(workspace.id, (item) => ({ ...item, activeBrowserTabId: id }))}
                onClose={(id) => updateWorkspace(workspace.id, (item) => {
                  const tabs = item.browserTabs.filter((tab) => tab.id !== id);
                  return {
                    ...item,
                    browserTabs: tabs,
                    browserOpen: tabs.length > 0,
                    activeBrowserTabId: item.activeBrowserTabId === id ? tabs.at(-1)?.id || null : item.activeBrowserTabId
                  };
                })}
                onNew={() => openBrowser("https://www.google.com")}
                onNavigate={(url) => updateWorkspace(workspace.id, (item) => ({
                  ...item,
                  browserTabs: item.browserTabs.map((tab) =>
                    tab.id === item.activeBrowserTabId ? { ...tab, url, title: tabTitle(url) } : tab
                  )
                }))}
                onAnnotation={handleAnnotation}
                annotating={annotating}
                onAnnotatingChange={setAnnotating}
                suspended={searchOpen || settingsSection !== null || pendingRemoval !== null}
              />
            </>
          )}
          {workspace.filesOpen && (
            <>
              <button
                type="button"
                className="split-handle file-split-handle"
                aria-label="Resize file tree split"
                onMouseDown={() => setDragging("files")}
              />
              <FileTreePane
                workspaceName={workspace.name}
                root={workspace.path}
                fileServerPort={fileServerPort}
                onOpenInBrowser={openBrowser}
              />
            </>
          )}
        </div>
      </main>
      )}

      {searchOpen && (
        <SearchDialog
          workspaces={state.workspaces}
          onClose={() => setSearchOpen(false)}
          onSelect={(selectedWorkspaceId, selectedSessionId) => {
            selectWorkspace(selectedWorkspaceId, selectedSessionId);
            setSearchOpen(false);
          }}
        />
      )}

      {settingsSection && (
        <SettingsDialog
          initialSection={settingsSection}
          profiles={state.profiles}
          defaultProfileId={state.defaultProfileId}
          terminalFontSize={state.terminalFontSize}
          terminalLineHeight={state.terminalLineHeight}
          terminalActions={state.terminalActions}
          theme={state.theme}
          onDefaultProfileChange={(defaultProfileId) =>
            setState((current) => current ? { ...current, defaultProfileId } : current)
          }
          onTerminalDisplayChange={(terminalFontSize, terminalLineHeight) =>
            setState((current) => current ? { ...current, terminalFontSize, terminalLineHeight } : current)
          }
          onProfilesChange={(profiles) => setState((current) => current ? { ...current, profiles } : current)}
          onTerminalActionsChange={(terminalActions) =>
            setState((current) => current ? { ...current, terminalActions } : current)
          }
          onThemeChange={(theme) => setState((current) => current ? { ...current, theme } : current)}
          onClose={() => setSettingsSection(null)}
        />
      )}

      {pendingRemoval && (
        <ConfirmDialog
          title={`Remove “${pendingRemoval.name}” from BYOCLI?`}
          description={state.workspaces.length === 1
            ? "BYOCLI needs at least one workspace. Add another workspace before removing this one."
            : "This only removes the workspace, terminal history, and browser state from BYOCLI. No project files or folders will be deleted."}
          confirmLabel={state.workspaces.length === 1 ? "Keep workspace" : "Remove workspace"}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => state.workspaces.length === 1 ? setPendingRemoval(null) : void removeWorkspace()}
        />
      )}
    </div>
  );
}
