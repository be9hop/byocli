import { memo, useCallback, useEffect, useState } from "react";
import {
  ChevronDown, ChevronRight, File, FileCode2, FileJson, FileText,
  Folder, FolderOpen, FolderTree, RefreshCw
} from "lucide-react";
import type { FileTreeEntry } from "../types";
import { listWorkspaceDirectory } from "../lib/platform";
import { IconButton } from "./IconButton";

type Props = {
  workspaceName: string;
  root: string;
  /// Fired when a browser-renderable file is double-clicked. The argument is a
  /// `file://` URL the parent passes to its browser pane.
  onOpenInBrowser?: (url: string) => void;
};

type TreeNodeProps = {
  entry: FileTreeEntry;
  root: string;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onOpenInBrowser?: (url: string) => void;
  refreshToken: number;
};

/// Extensions a browser can render natively via a file:// URL. Double-clicking
/// a file with one of these opens it in the browser split; everything else
/// (code, configs, text) is left to single-click selection only.
const BROWSER_OPENABLE_EXTENSIONS = new Set([
  "html", "htm", "xhtml", "svg",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico",
  "pdf"
]);

function isBrowserOpenable(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return ext ? BROWSER_OPENABLE_EXTENSIONS.has(ext) : false;
}

/// Build a `file://` URL from an absolute path. Windows paths (C:\\...) become
/// `file:///C:/...`; Unix paths (/home/...) become `file:///home/...`.
function toFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `file://${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

function fileIcon(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "json") return <FileJson size={14} />;
  if (["ts", "tsx", "js", "jsx", "rs", "py", "css", "html", "astro", "vue", "svelte"].includes(extension || "")) {
    return <FileCode2 size={14} />;
  }
  if (["md", "mdx", "txt", "log"].includes(extension || "")) return <FileText size={14} />;
  return <File size={14} />;
}

function displayRelativePath(root: string, path: string) {
  const normalize = (value: string) => value.replace(/^\\\\\?\\/, "").replaceAll("\\", "/");
  const normalizedRoot = normalize(root).replace(/\/$/, "");
  const normalizedPath = normalize(path);
  if (normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return `.${normalizedPath.slice(normalizedRoot.length) || "/"}`;
  }
  return normalizedPath;
}

const TreeNode = memo(function TreeNode({
  entry, root, depth, selectedPath, onSelect, onOpenInBrowser, refreshToken
}: TreeNodeProps) {
  const directory = entry.kind === "directory";
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileTreeEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  const loadChildren = useCallback(async () => {
    if (!directory) return;
    setLoading(true);
    setError(null);
    try {
      const listing = await listWorkspaceDirectory(root, entry.path);
      setChildren(listing.entries);
      setTruncated(listing.truncated);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [directory, entry.path, root]);

  useEffect(() => {
    if (expanded) void loadChildren();
  }, [refreshToken]);

  const activate = () => {
    onSelect(entry.path);
    if (!directory) return;
    const next = !expanded;
    setExpanded(next);
    if (next && children === null) void loadChildren();
  };

  return (
    <li role="treeitem" aria-expanded={directory ? expanded : undefined}>
      <button
        type="button"
        className={`file-tree-row ${selectedPath === entry.path ? "is-selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={activate}
        onDoubleClick={() => {
          // Double-click a browser-renderable file to open it in the browser
          // split. Directories and code files keep single-click behavior.
          if (!directory && isBrowserOpenable(entry.name) && onOpenInBrowser) {
            onOpenInBrowser(toFileUrl(entry.path));
          }
        }}
        title={entry.path}
      >
        <span className="file-tree-chevron">
          {directory && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <span className={`file-tree-icon is-${entry.kind}`}>
          {directory ? (expanded ? <FolderOpen size={14} /> : <Folder size={14} />) : fileIcon(entry.name)}
        </span>
        <span>{entry.name}</span>
        {loading && <span className="file-tree-loading" />}
      </button>
      {directory && expanded && (
        <ul role="group">
          {error && <li className="file-tree-message" style={{ paddingLeft: 30 + depth * 14 }}>{error}</li>}
          {!error && children?.length === 0 && (
            <li className="file-tree-message" style={{ paddingLeft: 30 + depth * 14 }}>Empty folder</li>
          )}
          {children?.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              root={root}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onOpenInBrowser={onOpenInBrowser}
              refreshToken={refreshToken}
            />
          ))}
          {truncated && (
            <li className="file-tree-message is-warning" style={{ paddingLeft: 30 + depth * 14 }}>
              First 500 entries shown
            </li>
          )}
        </ul>
      )}
    </li>
  );
});

export const FileTreePane = memo(function FileTreePane({ workspaceName, root, onOpenInBrowser }: Props) {
  const [entries, setEntries] = useState<FileTreeEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const listing = await listWorkspaceDirectory(root, root);
      setEntries(listing.entries);
      setTruncated(listing.truncated);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    setSelectedPath(null);
    void loadRoot();
  }, [loadRoot]);

  const refresh = () => {
    setRefreshToken((token) => token + 1);
    void loadRoot();
  };

  return (
    <aside className="file-tree-pane" aria-label={`${workspaceName} files`}>
      <header className="file-tree-header">
        <div>
          <FolderTree size={14} />
          <strong>Files</strong>
          <span>read only</span>
        </div>
        <div>
          <IconButton label="Refresh file tree" onClick={refresh}><RefreshCw size={13} /></IconButton>
        </div>
      </header>
      <div className="file-tree-root" title={root}>
        <FolderOpen size={13} />
        <span>{workspaceName}</span>
      </div>
      <div className="file-tree-scroll">
        {loading && <div className="file-tree-state">Reading workspace…</div>}
        {error && <div className="file-tree-state is-error">{error}</div>}
        {!loading && !error && (
          <ul className="file-tree" role="tree" aria-label={`${workspaceName} directory tree`}>
            {entries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                root={root}
                depth={0}
                selectedPath={selectedPath}
                onSelect={setSelectedPath}
                onOpenInBrowser={onOpenInBrowser}
                refreshToken={refreshToken}
              />
            ))}
            {truncated && <li className="file-tree-message is-warning">First 500 entries shown</li>}
          </ul>
        )}
      </div>
      <footer className="file-tree-footer" title={selectedPath || root}>
        {selectedPath ? displayRelativePath(root, selectedPath) : "Select a file or folder"}
      </footer>
    </aside>
  );
});
