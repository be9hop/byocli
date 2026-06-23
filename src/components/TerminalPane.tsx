import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalProfile, TerminalSession, Workspace } from "../types";
import {
  isTauri,
  onTerminalExit,
  onTerminalOutput,
  resizeTerminal,
  spawnTerminal,
  writeTerminal
} from "../lib/platform";

type Props = {
  workspace: Workspace;
  session: TerminalSession;
  profile: TerminalProfile;
  fontSize: number;
  lineHeight: number;
  onOpenUrl: (url: string) => void;
  onLaunched: (sessionId: string) => void;
  onAgentDetected: (sessionId: string, profileId: string) => void;
  onCommandDispatched: (sessionId: string) => void;
};

const demoOutput = [
  "\x1b[38;2;23;245;193mBYOCLI workspace\x1b[0m  \x1b[38;2;145;154;151m• persistent CLI session shell\x1b[0m\r\n",
  "\x1b[38;2;117;125;130mWorkspace\x1b[0m  C:\\Users\\Alex\\Documents\\codex\\Multi-cli\r\n",
  "\x1b[38;2;117;125;130mProfile\x1b[0m    PowerShell\r\n\r\n",
  "\x1b[38;2;120;210;164m✓\x1b[0m Session restored from local workspace state\r\n",
  "\x1b[38;2;120;210;164m✓\x1b[0m Browser links open inside a split view\r\n",
  "\x1b[38;2;120;210;164m✓\x1b[0m Terminal state isolated by workspace\r\n\r\n",
  "\x1b[38;2;224;189;108mPS\x1b[0m C:\\Users\\Alex\\Documents\\codex\\Multi-cli> npm run dev\r\n",
  "\x1b[38;2;117;125;130m  Local:\x1b[0m   \x1b[4;38;2;126;166;255mhttp://localhost:1420/\x1b[0m\r\n\r\n",
  "\x1b[38;2;224;189;108mPS\x1b[0m C:\\Users\\Alex\\Documents\\codex\\Multi-cli> "
].join("");

const agentCommands: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini",
  omp: "omp",
  aider: "aider",
  opencode: "opencode",
  goose: "goose"
};

export function TerminalPane({
  workspace, session, profile, fontSize, lineHeight, onOpenUrl, onLaunched, onAgentDetected, onCommandDispatched
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Berkeley Mono", "Cascadia Code", Consolas, monospace',
      fontSize,
      lineHeight,
      letterSpacing: 0.1,
      scrollback: 8000,
      allowTransparency: true,
      theme: {
        background: "#000308",
        foreground: "#f4f7f6",
        cursor: "#17f5c1",
        cursorAccent: "#000308",
        selectionBackground: "#123a31",
        black: "#03090b",
        red: "#ef8f8f",
        green: "#17f5c1",
        yellow: "#a9c9b9",
        blue: "#76a997",
        magenta: "#c39bdd",
        cyan: "#17f5c1",
        white: "#f4f7f6",
        brightBlack: "#668478",
        brightGreen: "#17f5c1",
        brightCyan: "#17f5c1",
        brightWhite: "#f0fff8"
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => onOpenUrl(uri)));
    terminal.open(containerRef.current);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const nativeAgentRestore = session.hasLaunched && Boolean(profile.resumeArgs?.length);
    if (session.scrollback && !nativeAgentRestore) {
      terminal.write(session.scrollback.replace(/\u0007/g, ""));
      terminal.write("\r\n\x1b[38;2;118;126;121m— restored session boundary —\x1b[0m\r\n");
    } else if (nativeAgentRestore) {
      terminal.write(`\x1b[38;2;118;126;121mRestoring ${profile.name} with its native session history…\x1b[0m\r\n`);
    } else if (!isTauri()) {
      terminal.write(demoOutput);
    }

    const fitAndResize = () => {
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) {
        void resizeTerminal(session.id, terminal.cols, terminal.rows);
      }
    };
    const observer = new ResizeObserver(fitAndResize);
    observer.observe(containerRef.current);
    requestAnimationFrame(fitAndResize);

    let commandBuffer = "";
    let fallbackAttempted = false;
    const launchStartedAt = Date.now();
    const launch = async (args: string[]) => {
      await spawnTerminal(
        workspace,
        session.id,
        session.commandOverride || profile.command,
        session.argsOverride || args
      );
      onLaunched(session.id);
      if (session.pendingCommand) {
        await writeTerminal(session.id, `${session.pendingCommand}\r`);
        onCommandDispatched(session.id);
      }
      terminal.focus();
    };

    const restartFreshAfterFailedResume = async () => {
      if (fallbackAttempted || !nativeAgentRestore) return;
      fallbackAttempted = true;
      terminal.writeln(`\r\n\x1b[38;2;224;189;108m${profile.name} resume ended early. Starting a fresh session in this tab…\x1b[0m`);
      try {
        await launch(profile.args);
      } catch (error) {
        terminal.writeln(`\r\n\x1b[31mUnable to restart ${profile.name}: ${String(error)}\x1b[0m`);
      }
    };

    const inputDisposable = terminal.onData((data) => {
      if (data === "\r") {
        const executable = commandBuffer
          .trim()
          .split(/\s+/)[0]
          ?.replace(/^.*[\\/]/, "")
          .replace(/\.exe$/i, "")
          .toLowerCase();
        const detectedProfile = executable ? agentCommands[executable] : undefined;
        if (detectedProfile) onAgentDetected(session.id, detectedProfile);
        commandBuffer = "";
      } else if (data === "\u007f") {
        commandBuffer = commandBuffer.slice(0, -1);
      } else if (!data.startsWith("\u001b") && /^[\x20-\x7e]+$/.test(data)) {
        commandBuffer += data;
      }
      void writeTerminal(session.id, data).catch((error) => {
        terminal.writeln(`\r\n\x1b[31mTerminal input disconnected: ${String(error)}\x1b[0m`);
        void restartFreshAfterFailedResume();
      });
    });

    let stopListening = () => {};
    let stopExitListening = () => {};
    void onTerminalOutput((payload) => {
      if (payload.sessionId !== session.id) return;
      terminal.write(payload.data.replace(/\u0007/g, ""));
    }).then((unlisten) => { stopListening = unlisten; });
    void onTerminalExit((payload) => {
      if (payload.sessionId !== session.id) return;
      if (nativeAgentRestore && Date.now() - launchStartedAt < 15_000) {
        void restartFreshAfterFailedResume();
      } else {
        terminal.writeln(`\r\n\x1b[38;2;118;126;121m— terminal process ended (exit ${payload.exitCode}) —\x1b[0m`);
      }
    }).then((unlisten) => { stopExitListening = unlisten; });

    const launchArgs = session.hasLaunched && profile.resumeArgs?.length
      ? profile.resumeArgs
      : profile.args;
    void launch(launchArgs)
      .catch((error) => {
        terminal.writeln(`\r\n\x1b[31mUnable to launch ${profile.name}: ${String(error)}\x1b[0m`);
      });

    return () => {
      stopListening();
      stopExitListening();
      inputDisposable.dispose();
      observer.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
    // This effect owns the xterm instance + PTY subscription for the life of the
    // session. It deliberately does NOT depend on fontSize/lineHeight — those are
    // applied live by the effect below so changing them no longer destroys the
    // running terminal and re-spawns the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  // Apply font size / line height live without tearing down the terminal.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = fontSize;
    terminal.options.lineHeight = lineHeight;
    // Re-fit so the cols/rows match the new glyph metrics, then notify the
    // backend PTY of the new dimensions.
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
      if (terminal.cols > 0 && terminal.rows > 0) {
        void resizeTerminal(session.id, terminal.cols, terminal.rows);
      }
    } catch {
      // fit() can throw if the terminal is mid-dispose; safe to ignore.
    }
  }, [fontSize, lineHeight, session.id]);

  return <div ref={containerRef} className="terminal-surface" aria-label={`${session.title} terminal`} />;
}
