import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Bug, ExternalLink, Globe2,
  MousePointer2, Plus, RefreshCw, X
} from "lucide-react";
import type { AnnotationPayload, BrowserTab } from "../types";
import { IconButton } from "./IconButton";
import {
  browserWebviewAction,
  closeBrowserWebview,
  invokeNative,
  isTauri,
  navigateBrowserWebview,
  onAnnotation,
  openExternal,
  openBrowserWebview,
  resizeBrowserWebview,
  setBrowserWebviewVisibility,
} from "../lib/platform";

type Props = {
  workspaceId: string;
  tabs: BrowserTab[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onNavigate: (url: string) => void;
  onAnnotation: (payload: AnnotationPayload) => void;
  annotating: boolean;
  onAnnotatingChange: (annotating: boolean) => void;
  suspended: boolean;
};

function normalizeUrl(value: string) {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

export function BrowserPane({
  workspaceId, tabs, activeTabId, onSelect, onClose, onNew, onNavigate,
  onAnnotation: forwardAnnotation, annotating, onAnnotatingChange, suspended
}: Props) {
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0];
  const [address, setAddress] = useState(activeTab?.url || "https://www.google.com");
  const [webviewReady, setWebviewReady] = useState(false);
  const [webviewError, setWebviewError] = useState<string | null>(null);
  const [creationAttempt, setCreationAttempt] = useState(0);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const currentUrlRef = useRef(activeTab?.url || "");
  const loadedUrlRef = useRef("");
  // A short per-instance suffix makes the webview label globally unique, so two
  // concurrently-mounted BrowserPanes (or workspaces whose IDs differ only in
  // stripped characters) can never collide and kill each other's webview on
  // teardown. The workspace prefix is kept for debuggability in devtools.
  const instanceSuffixRef = useRef(
    Math.random().toString(16).slice(2, 8).padEnd(6, "0")
  );
  const webviewLabel = useMemo(
    () => `browser-${workspaceId.replace(/[^a-zA-Z0-9-_]/g, "")}-${instanceSuffixRef.current}`,
    [workspaceId]
  );

  currentUrlRef.current = activeTab?.url || "";

  useEffect(() => {
    if (activeTab) setAddress(activeTab.url);
  }, [activeTab?.id, activeTab?.url]);

  useEffect(() => {
    let stop = () => {};
    void onAnnotation((payload) => {
      onAnnotatingChange(false);
      forwardAnnotation(payload);
    }).then((unlisten) => { stop = unlisten; });
    return () => stop();
  }, [forwardAnnotation, onAnnotatingChange]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!isTauri() || !activeTab || !surface) return;
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let resizeFrame = 0;

    void (async () => {
      try {
        setWebviewReady(false);
        setWebviewError(null);
        const rect = surface.getBoundingClientRect();
        const initialUrl = currentUrlRef.current;
        await openBrowserWebview(webviewLabel, initialUrl, {
          x: rect.x,
          y: rect.y,
          width: Math.max(1, rect.width),
          height: Math.max(1, rect.height)
        });
        if (disposed) {
          await closeBrowserWebview(webviewLabel);
          return;
        }
        loadedUrlRef.current = initialUrl;
        setWebviewReady(true);

        if (currentUrlRef.current && currentUrlRef.current !== initialUrl) {
          await navigateBrowserWebview(webviewLabel, currentUrlRef.current);
          loadedUrlRef.current = currentUrlRef.current;
        }
      } catch (error) {
        if (!disposed) {
          setWebviewError(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      const syncBounds = () => {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          if (disposed || !surfaceRef.current) return;
          const next = surfaceRef.current.getBoundingClientRect();
          void resizeBrowserWebview(webviewLabel, {
            x: next.x,
            y: next.y,
            width: Math.max(1, next.width),
            height: Math.max(1, next.height)
          }).catch(() => {});
        });
      };
      observer = new ResizeObserver(syncBounds);
      observer.observe(surface);
      window.addEventListener("resize", syncBounds);
    })();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(resizeFrame);
      observer?.disconnect();
      setWebviewReady(false);
      void closeBrowserWebview(webviewLabel);
    };
  }, [creationAttempt, webviewLabel]);

  useEffect(() => {
    if (!isTauri() || !webviewReady || !activeTab?.url || loadedUrlRef.current === activeTab.url) return;
    setWebviewError(null);
    void navigateBrowserWebview(webviewLabel, activeTab.url)
      .then(() => { loadedUrlRef.current = activeTab.url; })
      .catch((error) => setWebviewError(error instanceof Error ? error.message : String(error)));
  }, [activeTab?.url, webviewLabel, webviewReady]);

  useEffect(() => {
    if (!isTauri() || !activeTab || !webviewReady) return;
    void invokeNative("set_annotation_mode", { webviewLabel, enabled: annotating })
      .catch((error) => setWebviewError(error instanceof Error ? error.message : String(error)));
  }, [annotating, activeTab?.id, webviewLabel, webviewReady]);

  useEffect(() => {
    if (!webviewReady) return;
    void setBrowserWebviewVisibility(webviewLabel, !suspended).catch(() => {});
  }, [suspended, webviewLabel, webviewReady]);

  if (!activeTab) return null;

  const submitAddress = () => {
    const url = normalizeUrl(address);
    setAddress(url);
    onAnnotatingChange(false);
    onNavigate(url);
  };

  const runBrowserAction = (action: "back" | "forward" | "reload" | "devtools") => {
    setWebviewError(null);
    void browserWebviewAction(webviewLabel, action)
      .catch((error) => setWebviewError(error instanceof Error ? error.message : String(error)));
  };

  return (
    <section className="browser-pane">
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={`browser-tab ${tab.id === activeTab.id ? "is-active" : ""}`}
            onClick={() => onSelect(tab.id)}
          >
            <Globe2 size={13} />
            <span>{tab.title}</span>
            <X
              size={12}
              aria-label={`Close ${tab.title}`}
              onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
            />
          </button>
        ))}
        <IconButton label="New browser tab" onClick={onNew}><Plus size={14} /></IconButton>
      </div>

      <form className="browser-toolbar" onSubmit={(event) => { event.preventDefault(); submitAddress(); }}>
        <IconButton label="Back" disabled={!webviewReady} onClick={() => runBrowserAction("back")}><ArrowLeft size={14} /></IconButton>
        <IconButton label="Forward" disabled={!webviewReady} onClick={() => runBrowserAction("forward")}><ArrowRight size={14} /></IconButton>
        <IconButton label="Reload" disabled={!webviewReady} onClick={() => runBrowserAction("reload")}><RefreshCw size={14} /></IconButton>
        <label className="address-field">
          <span className="sr-only">Browser address</span>
          <Globe2 size={12} />
          <input
            type="url"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            spellCheck={false}
          />
        </label>
        <button
          type="button"
          className={`annotate-button ${annotating ? "is-active" : ""}`}
          onClick={() => onAnnotatingChange(!annotating)}
        >
          <MousePointer2 size={13} />
          {annotating ? "Annotating" : "Annotate"}
        </button>
        <IconButton label="Open DevTools" disabled={!webviewReady} onClick={() => runBrowserAction("devtools")}><Bug size={14} /></IconButton>
        <IconButton
          label="Open externally"
          onClick={() => void openExternal(activeTab.url).catch((error) =>
            setWebviewError(error instanceof Error ? error.message : String(error))
          )}
        >
          <ExternalLink size={14} />
        </IconButton>
      </form>

      <div className="browser-surface" ref={surfaceRef}>
        {isTauri() && !webviewReady && (
          <div className={`browser-native-status ${webviewError ? "is-error" : ""}`}>
            <Globe2 size={18} />
            <strong>{webviewError ? "Browser failed to open" : "Opening browser…"}</strong>
            {webviewError && <span>{webviewError}</span>}
            {webviewError && (
              <button type="button" onClick={() => setCreationAttempt((attempt) => attempt + 1)}>
                Try again
              </button>
            )}
          </div>
        )}
        {!isTauri() && (
          <iframe
            title={activeTab.title}
            src={activeTab.url}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          />
        )}
      </div>
    </section>
  );
}
