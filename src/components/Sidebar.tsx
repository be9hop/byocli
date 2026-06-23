import {
  ArrowLeft, ArrowRight, CalendarClock, Folder, FolderOpen, PanelLeftOpen, Plus,
  Search, Settings2, TerminalSquare, Trash2
} from "lucide-react";
import { memo } from "react";
import type { Workspace } from "../types";
import { IconButton } from "./IconButton";

/// The minimal slice of a Workspace that the Sidebar actually renders. Accepting
/// this narrower shape lets the parent pass a projection that omits hot fields
/// (scrollback, output) so the memoized Sidebar doesn't re-render on every
/// terminal output flush.
export type SidebarWorkspace = Pick<Workspace, "id" | "name" | "path" | "activeSessionId"> & {
  sessions: Pick<Workspace["sessions"][number], "id" | "title">[];
};

type Props = {
  workspaces: SidebarWorkspace[];
  activeId: string;
  automationsActive: boolean;
  collapsed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onExpand: () => void;
  onBack: () => void;
  onForward: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onSearch: () => void;
  onAutomations: () => void;
  onSettings: () => void;
  onRemove: (workspace: SidebarWorkspace) => void;
  onOpenAppLink: () => void;
};

export const Sidebar = memo(function Sidebar({
  workspaces, activeId, automationsActive, collapsed, canGoBack, canGoForward, onExpand, onBack, onForward, onSelect,
  onAdd, onSearch, onAutomations, onSettings, onRemove, onOpenAppLink
}: Props) {
  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`} aria-label="Workspace navigation">
      <div className="brand-row">
        {collapsed ? (
          <IconButton label="Expand sidebar" className="sidebar-expand" onClick={onExpand}>
            <img src="/byocli-app-icon.png" alt="" />
            <PanelLeftOpen className="sidebar-expand-glyph" size={14} />
          </IconButton>
        ) : (
          <img className="brand-logo" src="/byocli-logo.png" alt="BYOCLI" />
        )}
        <div className="window-nav">
          <IconButton label="Previous workspace" disabled={!canGoBack} onClick={onBack}>
            <ArrowLeft size={14} />
          </IconButton>
          <IconButton label="Next workspace" disabled={!canGoForward} onClick={onForward}>
            <ArrowRight size={14} />
          </IconButton>
        </div>
      </div>

      <nav className="primary-nav" aria-label="Primary">
        <button type="button" title="New workspace" aria-label="New workspace" onClick={onAdd}>
          <Plus size={16} /><span>New workspace</span><kbd>Ctrl N</kbd>
        </button>
        <button type="button" title="Search" aria-label="Search" onClick={onSearch}>
          <Search size={16} /><span>Search</span><kbd>Ctrl K</kbd>
        </button>
        <button type="button" className={automationsActive ? "is-active" : ""} title="Automations" aria-label="Automations" onClick={onAutomations}>
          <CalendarClock size={16} /><span>Automations</span>
        </button>
      </nav>

      <div className="section-heading">
        <span>Workspaces</span>
      </div>

      <div className="workspace-list">
        {workspaces.map((workspace) => {
          const active = !automationsActive && workspace.id === activeId;
          const session = workspace.sessions.find((item) => item.id === workspace.activeSessionId);
          return (
            <div key={workspace.id} className={`workspace-entry ${active ? "is-active" : ""}`}>
              <button
                type="button"
                className="workspace-item"
                title={workspace.name}
                aria-label={`Open ${workspace.name}`}
                onClick={() => onSelect(workspace.id)}
              >
                <span className="workspace-name"><Folder size={15} /> {workspace.name}</span>
                <span className="workspace-session">
                  <TerminalSquare size={13} />
                  <span>{session?.title || "Terminal"}</span>
                  <time>{active ? "now" : "saved"}</time>
                </span>
              </button>
              <IconButton
                label={`Remove ${workspace.name} from BYOCLI`}
                className="workspace-remove"
                onClick={() => onRemove(workspace)}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button type="button" className="byocli-link" onClick={onOpenAppLink}>
          <img className="footer-brand-logo" src="/byocli-app-icon.png" alt="" />
          <span>Open workspace folder</span>
          <FolderOpen size={14} />
        </button>
        <IconButton label="BYOCLI settings" onClick={onSettings}><Settings2 size={16} /></IconButton>
      </div>
    </aside>
  );
});
