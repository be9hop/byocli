import {
  ArrowLeft, CalendarClock, CheckCircle2, CirclePause, Clock3,
  Play, Plus, RotateCcw, Save, Search, Square, TerminalSquare, Trash2, XCircle
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Automation, AutomationRun, AutomationSchedule, Workspace } from "../types";
import { describeSchedule, formatRunTime, nextRunForSchedule, validateCron } from "../lib/automations";
import { uuid } from "../lib/uuid";

type Props = {
  automations: Automation[];
  runs: AutomationRun[];
  workspaces: Workspace[];
  activeWorkspaceId: string;
  tempDirectory: string;
  onChange: (automations: Automation[]) => void;
  onRun: (automation: Automation) => void;
  /// Stop a running automation by killing its backing terminal session. The
  /// run's status is updated by the terminal-exit handler in App.tsx (which
  /// treats a killed session as "skipped", not "failed").
  onStopRun: (run: AutomationRun) => void;
};

const defaultSchedule: AutomationSchedule = { kind: "daily", time: "09:00" };

export function AutomationsView({
  automations, runs, workspaces, activeWorkspaceId, tempDirectory, onChange, onRun, onStopRun
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selected = automations.find((item) => item.id === selectedId);
  const [draft, setDraft] = useState<Automation | null>(selected || null);

  useEffect(() => setDraft(selected || null), [selectedId, selected]);
  useEffect(() => setSelectedRunId(null), [selectedId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return automations.filter((automation) => {
      const workspace = workspaces.find((item) => item.id === automation.workspaceId);
      return !needle || [automation.name, automation.command, workspace?.name, automation.scope === "temp" ? "temp" : ""]
        .some((value) => value?.toLowerCase().includes(needle));
    });
  }, [automations, query, workspaces]);

  const selectedRuns = useMemo(
    () => runs.filter((run) => run.automationId === selectedId).slice().reverse(),
    [runs, selectedId]
  );
  useEffect(() => {
    if (selectedRuns.length && !selectedRuns.some((run) => run.id === selectedRunId)) {
      setSelectedRunId(selectedRuns[0].id);
    }
  }, [selectedRunId, selectedRuns]);
  const selectedRun = selectedRuns.find((run) => run.id === selectedRunId);
  const activeCount = automations.filter((item) => item.enabled).length;
  const runningCount = runs.filter((item) => item.status === "running").length;
  const failedCount = runs.filter((item) =>
    (item.status === "failed" || item.status === "timed_out") &&
    item.startedAt > Date.now() - 86_400_000
  ).length;
  const nextAutomation = automations.filter((item) => item.enabled).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];

  const createAutomation = () => {
    const now = Date.now();
    const workspace = workspaces.find((item) => item.id === activeWorkspaceId) || workspaces[0];
    const next: Automation = {
      id: uuid(),
      name: "New automation",
      scope: workspace ? "workspace" : "temp",
      workspaceId: workspace?.id,
      workingDirectory: workspace?.path,
      command: "npm run test",
      enabled: false,
      schedule: defaultSchedule,
      overlapPolicy: "skip",
      timeoutMinutes: 30,
      retryCount: 0,
      nextRunAt: nextRunForSchedule(defaultSchedule, now),
      createdAt: now
    };
    onChange([...automations, next]);
    setSelectedId(next.id);
  };

  const normalizedDraft = () => {
    if (!draft || !draft.name.trim() || !draft.command.trim()) return null;
    // Block saving/running a cron automation whose expression is malformed —
    // otherwise it would silently never fire (or fall back to +1h).
    if (draft.schedule.kind === "cron" && validateCron(draft.schedule.expression)) return null;
    return {
      ...draft,
      name: draft.name.trim(),
      command: draft.command.trim(),
      nextRunAt: nextRunForSchedule(draft.schedule)
    };
  };

  const saveDraft = () => {
    const next = normalizedDraft();
    if (!next) return;
    onChange(automations.map((item) => item.id === next.id ? next : item));
  };

  const runDraft = () => {
    const next = normalizedDraft();
    if (!next) return;
    onChange(automations.map((item) => item.id === next.id ? next : item));
    onRun(next);
  };

  const toggleEnabled = () => {
    if (!draft) return;
    const enabled = !draft.enabled;
    const next = { ...draft, enabled, nextRunAt: enabled ? nextRunForSchedule(draft.schedule) : draft.nextRunAt };
    setDraft(next);
    onChange(automations.map((item) => item.id === next.id ? next : item));
  };

  const removeSelected = () => {
    if (!draft) return;
    onChange(automations.filter((item) => item.id !== draft.id));
    setSelectedId(null);
  };

  const setScheduleKind = (kind: AutomationSchedule["kind"]) => {
    if (!draft) return;
    const schedule: AutomationSchedule =
      kind === "interval" ? { kind, minutes: 60 } :
      kind === "daily" ? { kind, time: "09:00" } :
      kind === "weekly" ? { kind, days: [1], time: "09:00" } :
      { kind, expression: "0 9 * * 1-5" };
    setDraft({ ...draft, schedule });
  };

  if (draft) {
    return (
      <main className="automations-page automation-detail-page">
        <header className="automations-page-header">
          <div>
            <button type="button" className="automation-back" onClick={() => setSelectedId(null)}>
              <ArrowLeft size={16} /> All automations
            </button>
            <h1>{draft.name}</h1>
            <p>{draft.enabled ? `Active · next run ${formatRunTime(draft.nextRunAt)}` : "Paused · scheduled runs will not start"}</p>
          </div>
          <div className="automation-page-actions">
            <button
              type="button"
              role="switch"
              aria-checked={draft.enabled}
              className={`automation-status-switch ${draft.enabled ? "is-enabled" : ""}`}
              onClick={toggleEnabled}
            >
              <span className="switch-track"><span /></span>
              <span><strong>{draft.enabled ? "Active" : "Paused"}</strong><small>{draft.enabled ? "Runs on schedule" : "Schedule disabled"}</small></span>
            </button>
            <button type="button" onClick={runDraft}><Play size={15} /> Run now</button>
            <button type="button" className="is-primary" onClick={saveDraft}><Save size={15} /> Save changes</button>
          </div>
        </header>

        <div className="automation-detail-layout">
          <div className="automation-detail-main">
            <section className="automation-form-section">
              <div className="automation-section-heading"><span>01</span><div><h3>Command</h3><p>Choose the execution context and command.</p></div></div>
              <div className="automation-fields">
                <label><span>Automation name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label>
                  <span>Scope</span>
                  <select value={draft.scope} onChange={(event) => {
                    const scope = event.target.value as Automation["scope"];
                    const workspace = workspaces.find((item) => item.id === draft.workspaceId) || workspaces[0];
                    setDraft({
                      ...draft,
                      scope,
                      workspaceId: scope === "workspace" ? workspace?.id : undefined,
                      workingDirectory: scope === "workspace" ? workspace?.path : undefined
                    });
                  }}>
                    <option value="workspace">BYOCLI workspace</option>
                    <option value="temp">BYOCLI temp</option>
                  </select>
                </label>
                {draft.scope === "workspace" ? (
                  <label className="is-wide">
                    <span>Workspace</span>
                    <select value={draft.workspaceId || ""} onChange={(event) => {
                      const workspace = workspaces.find((item) => item.id === event.target.value);
                      setDraft({ ...draft, workspaceId: event.target.value, workingDirectory: workspace?.path });
                    }}>
                      {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name} — {workspace.path}</option>)}
                    </select>
                  </label>
                ) : (
                  <label className="is-wide">
                    <span>Temporary execution directory</span>
                    <div className="automation-temp-location">
                      <code>{tempDirectory || "Resolving system temp directory…"}</code>
                      <small>BYOCLI creates and reuses this folder under the operating system’s temp location. The OS may clear its contents at any time.</small>
                    </div>
                  </label>
                )}
                <label className="is-wide">
                  <span>Command to run</span>
                  <input className="is-command" value={draft.command} spellCheck={false} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
                  <small>Runs in an isolated PowerShell process. Output is retained with each automation run.</small>
                </label>
              </div>
            </section>

            <section className="automation-form-section">
              <div className="automation-section-heading"><span>02</span><div><h3>Schedule</h3><p>Set when this command should run.</p></div></div>
              <div className="automation-fields">
                <label><span>Frequency</span><select value={draft.schedule.kind} onChange={(event) => setScheduleKind(event.target.value as AutomationSchedule["kind"])}>
                  <option value="interval">Interval</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="cron">Cron expression</option>
                </select></label>
                <ScheduleFields schedule={draft.schedule} onChange={(schedule) => setDraft({ ...draft, schedule })} />
              </div>
            </section>

            <section className="automation-form-section">
              <div className="automation-section-heading"><span>03</span><div><h3>Run behavior</h3><p>Control collisions, failures, and long-running commands.</p></div></div>
              <div className="automation-fields automation-behavior-fields">
                <label><span>If a previous run is active</span><select value={draft.overlapPolicy} onChange={(event) => setDraft({ ...draft, overlapPolicy: event.target.value as Automation["overlapPolicy"] })}>
                  <option value="skip">Skip this run</option><option value="queue">Queue one run</option><option value="terminate">Stop previous run</option><option value="parallel">Run in parallel</option>
                </select></label>
                <label><span>Stop after</span><div className="input-with-suffix"><input type="number" min="1" max="1440" value={draft.timeoutMinutes} onChange={(event) => setDraft({ ...draft, timeoutMinutes: Number(event.target.value) || 1 })} /><span>minutes</span></div></label>
                <label><span>Retry failed runs</span><div className="input-with-suffix"><input type="number" min="0" max="5" value={draft.retryCount} onChange={(event) => setDraft({ ...draft, retryCount: Number(event.target.value) || 0 })} /><span>times</span></div></label>
              </div>
            </section>
            <button type="button" className="automation-delete automation-detail-delete" onClick={removeSelected}><Trash2 size={15} /> Delete automation</button>
          </div>

          <aside className="automation-runs-panel">
            <header><div><h2>Run history</h2><p>{selectedRuns.length} recorded runs</p></div></header>
            <div className="automation-run-list">
              {selectedRuns.length === 0 && <div className="automation-run-empty"><Clock3 size={22} /><strong>No runs yet</strong><p>Run this automation to capture its output and status.</p></div>}
              {selectedRuns.map((run) => (
                <div key={run.id} className={`automation-run-row ${run.id === selectedRunId ? "is-active" : ""}`}>
                  <button type="button" className="automation-run-summary" onClick={() => setSelectedRunId(run.id)}>
                    <RunIcon status={run.status} />
                    <span><strong>{run.status.replace("_", " ")}</strong><small>{formatRunTime(run.startedAt)} · attempt {run.attempt}</small></span>
                    {run.exitCode !== undefined && <code>{run.exitCode}</code>}
                  </button>
                  {run.status === "running" && run.sessionId && (
                    <button
                      type="button"
                      className="automation-run-stop"
                      title="Stop this run"
                      aria-label={`Stop run started ${formatRunTime(run.startedAt)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onStopRun(run);
                      }}
                    >
                      <Square size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {selectedRun && (
              <section className="automation-run-detail">
                <div><span>Status</span><strong>{selectedRun.status.replace("_", " ")}</strong></div>
                <div><span>Started</span><strong>{formatRunTime(selectedRun.startedAt)}</strong></div>
                <div><span>Duration</span><strong>{formatDuration(selectedRun)}</strong></div>
                <div><span>Exit code</span><strong>{selectedRun.exitCode ?? "—"}</strong></div>
                <div className="is-wide"><span>Command</span><code>{selectedRun.command}</code></div>
                <div className="is-wide"><span>Working directory</span><code>{selectedRun.workingDirectory}</code></div>
                {selectedRun.error && <div className="is-wide automation-run-error"><span>Error</span><p>{selectedRun.error}</p></div>}
                <div className="is-wide"><span>Output</span><pre>{stripAnsi(selectedRun.output) || "No output captured."}</pre></div>
                {selectedRun.status === "running" && selectedRun.sessionId && (
                  <button type="button" className="automation-stop-run" onClick={() => onStopRun(selectedRun)}>
                    <Square size={14} /> Stop run
                  </button>
                )}
              </section>
            )}
          </aside>
        </div>
      </main>
    );
  }

  return (
    <main className="automations-page">
      <header className="automations-page-header">
        <div><h1>Automations</h1><p>Schedule commands in a BYOCLI workspace or a file-free temporary environment.</p></div>
        <button type="button" className="is-primary" onClick={createAutomation}><Plus size={16} /> New automation</button>
      </header>

      <section className="automation-summary">
        <Summary label="Active" value={activeCount} detail={`${automations.length} total`} />
        <Summary label="Running now" value={runningCount} detail={runningCount ? "In progress" : "Nothing running"} />
        <Summary label="Failed today" value={failedCount} detail={failedCount ? "Needs attention" : "All clear"} tone={failedCount ? "danger" : undefined} />
        <Summary label="Next run" value={nextAutomation ? formatRunTime(nextAutomation.nextRunAt) : "—"} detail={nextAutomation?.name || "No active schedules"} compact />
      </section>

      <section className="automation-catalog">
        <header>
          <div><h2>All automations</h2><p>Select an automation to inspect configuration, runs, and output.</p></div>
          <label className="automation-search"><Search size={15} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search automations" /></label>
        </header>
        {filtered.length === 0 ? (
          <div className="automation-page-empty">
            <CalendarClock size={28} /><strong>{automations.length ? "No matching automations" : "No automations yet"}</strong>
            <p>{automations.length ? "Try a different search." : "Create a schedule for a workspace command or a task that only needs a temporary execution environment."}</p>
            {!automations.length && <button type="button" onClick={createAutomation}><Plus size={15} /> Create automation</button>}
          </div>
        ) : (
          <div className="automation-table">
            <div className="automation-table-head"><span>Name</span><span>Scope</span><span>Schedule</span><span>Last run</span><span>Next run</span><span>Status</span></div>
            {filtered.map((automation) => {
              const workspace = workspaces.find((item) => item.id === automation.workspaceId);
              const lastRun = runs.filter((run) => run.automationId === automation.id).at(-1);
              return (
                <button type="button" key={automation.id} onClick={() => setSelectedId(automation.id)}>
                  <span className="automation-table-name"><strong>{automation.name}</strong><code>{automation.command}</code></span>
                  <span>{automation.scope === "workspace" ? workspace?.name || "Missing workspace" : "Temp"}</span>
                  <span>{describeSchedule(automation.schedule)}</span>
                  <span>{lastRun ? formatRunTime(lastRun.startedAt) : "Never"}</span>
                  <span>{automation.enabled ? formatRunTime(automation.nextRunAt) : "Paused"}</span>
                  <span className={`automation-table-status ${automation.enabled ? "is-enabled" : ""}`}>{automation.enabled ? "Active" : "Paused"}</span>
                </button>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

function Summary({ label, value, detail, tone, compact }: { label: string; value: string | number; detail: string; tone?: string; compact?: boolean }) {
  return <article className={`automation-summary-item ${tone ? `is-${tone}` : ""} ${compact ? "is-compact" : ""}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>;
}

function ScheduleFields({ schedule, onChange }: { schedule: AutomationSchedule; onChange: (value: AutomationSchedule) => void }) {
  if (schedule.kind === "interval") return <label><span>Every</span><div className="input-with-suffix"><input type="number" min="1" value={schedule.minutes} onChange={(event) => onChange({ ...schedule, minutes: Number(event.target.value) || 1 })} /><span>minutes</span></div></label>;
  if (schedule.kind === "daily") return <label><span>Time</span><input type="time" value={schedule.time} onChange={(event) => onChange({ ...schedule, time: event.target.value })} /></label>;
  if (schedule.kind === "weekly") return <div className="automation-weekly"><span>Days and time</span><div>{["S","M","T","W","T","F","S"].map((day,index) => <button type="button" key={`${day}-${index}`} className={schedule.days.includes(index) ? "is-active" : ""} onClick={() => onChange({ ...schedule, days: schedule.days.includes(index) ? schedule.days.filter((item) => item !== index) : [...schedule.days,index] })}>{day}</button>)}<input type="time" value={schedule.time} onChange={(event) => onChange({ ...schedule, time: event.target.value })} /></div></div>;
  const error = schedule.expression.trim() ? validateCron(schedule.expression) : null;
  return (
    <label className="is-wide">
      <span>Cron expression</span>
      <input className="is-command" value={schedule.expression} spellCheck={false} onChange={(event) => onChange({ ...schedule, expression: event.target.value })} />
      <small>5 fields: minute hour day-of-month month weekday (e.g. <code>0 9 * * 1-5</code>).</small>
      {error && <small className="automation-field-error">{error}</small>}
    </label>
  );
}

function RunIcon({ status }: { status: AutomationRun["status"] }) {
  if (status === "succeeded") return <CheckCircle2 className="run-success" size={16} />;
  if (status === "failed" || status === "timed_out") return <XCircle className="run-failed" size={16} />;
  if (status === "running") return <RotateCcw className="run-running" size={16} />;
  if (status === "queued") return <Clock3 size={16} />;
  if (status === "skipped") return <CirclePause size={16} />;
  return <TerminalSquare size={16} />;
}

function formatDuration(run: AutomationRun) {
  if (!run.endedAt) return run.status === "running" ? "Running" : "—";
  const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function stripAnsi(value: string) {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
