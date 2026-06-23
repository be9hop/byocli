export type TerminalProfile = {
  id: string;
  name: string;
  command: string;
  args: string[];
  resumeArgs?: string[];
  accent: string;
};

export type TerminalSession = {
  id: string;
  title: string;
  profileId: string;
  cwd: string;
  scrollback: string;
  pendingCommand?: string;
  commandOverride?: string;
  argsOverride?: string[];
  automationRunId?: string;
  createdAt: number;
  lastActiveAt: number;
  hasLaunched: boolean;
};

export type AutomationSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; time: string }
  | { kind: "weekly"; days: number[]; time: string }
  | { kind: "cron"; expression: string };

export type AutomationOverlapPolicy = "skip" | "queue" | "terminate" | "parallel";

export type Automation = {
  id: string;
  name: string;
  scope: "workspace" | "temp";
  workspaceId?: string;
  workingDirectory?: string;
  command: string;
  enabled: boolean;
  schedule: AutomationSchedule;
  overlapPolicy: AutomationOverlapPolicy;
  timeoutMinutes: number;
  retryCount: number;
  nextRunAt: number;
  lastRunAt?: number;
  createdAt: number;
};

export type AutomationRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "skipped";

export type AutomationRun = {
  id: string;
  automationId: string;
  workspaceId?: string;
  workingDirectory: string;
  command: string;
  sessionId?: string;
  status: AutomationRunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  output: string;
  error?: string;
  attempt: number;
};

export type TerminalAction = {
  id: string;
  name: string;
  command: string;
  favorite?: boolean;
};

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
};

export type Workspace = {
  id: string;
  name: string;
  path: string;
  sessions: TerminalSession[];
  activeSessionId: string;
  browserTabs: BrowserTab[];
  activeBrowserTabId: string | null;
  browserOpen: boolean;
  splitRatio: number;
  filesOpen: boolean;
  filesRatio: number;
};

export type Theme = "light" | "dark";

export type AppState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  profiles: TerminalProfile[];
  defaultProfileId: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalActions: TerminalAction[];
  automations: Automation[];
  automationRuns: AutomationRun[];
  sidebarCollapsed: boolean;
  theme: Theme;
};

export type TerminalOutput = {
  sessionId: string;
  data: string;
};

export type TerminalExit = {
  sessionId: string;
  exitCode: number;
};

export type AnnotationPayload = {
  url: string;
  tag: string;
  text: string;
  selector: string;
  xpath: string;
  bounds: { x: number; y: number; width: number; height: number };
  nearbyText: string;
};

export type AnnotationItem = {
  id: string;
  payload: AnnotationPayload;
  comment: string;
};

export type FileTreeEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink";
};

export type DirectoryListing = {
  entries: FileTreeEntry[];
  truncated: boolean;
};
