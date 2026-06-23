import { Search, TerminalSquare, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "../types";
import { IconButton } from "./IconButton";

type Props = {
  workspaces: Workspace[];
  onClose: () => void;
  onSelect: (workspaceId: string, sessionId?: string) => void;
};

export function SearchDialog({ workspaces, onClose, onSelect }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return workspaces.flatMap((workspace) => {
      const workspaceMatch = !needle ||
        workspace.name.toLowerCase().includes(needle) ||
        workspace.path.toLowerCase().includes(needle);
      const sessions = workspace.sessions.filter((session) =>
        !needle || session.title.toLowerCase().includes(needle)
      );
      return [{
        kind: "workspace" as const,
        workspace,
        sessionId: undefined
      }, ...sessions.map((session) => ({
        kind: "session" as const,
        workspace,
        sessionId: session.id,
        title: session.title
      }))].filter((result) => result.kind === "workspace" ? workspaceMatch : true);
    }).slice(0, 40);
  }, [query, workspaces]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search BYOCLI"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-input">
          <Search size={17} />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces and terminal sessions…"
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "Enter" && results[0]) {
                onSelect(results[0].workspace.id, results[0].sessionId);
              }
            }}
          />
          <IconButton label="Close search" onClick={onClose}><X size={15} /></IconButton>
        </div>
        <div className="search-results">
          {results.length === 0 && <div className="empty-results">No matching workspace or terminal.</div>}
          {results.map((result) => (
            <button
              type="button"
              key={`${result.kind}-${result.workspace.id}-${result.sessionId || ""}`}
              onClick={() => onSelect(result.workspace.id, result.sessionId)}
            >
              {result.kind === "workspace" ? <Search size={14} /> : <TerminalSquare size={14} />}
              <span>
                <strong>{result.kind === "workspace" ? result.workspace.name : result.title}</strong>
                <small>{result.kind === "workspace" ? result.workspace.path : result.workspace.name}</small>
              </span>
              <em>{result.kind}</em>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
