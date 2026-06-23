import type { Theme } from "../types";

/// The localStorage key the non-Tauri fallback uses for app state. The Tauri
/// build persists via SQLite, but the theme must be readable synchronously at
/// boot (before React mounts) to prevent a flash of the wrong theme, so we
/// mirror just the theme into localStorage in both modes.
export const THEME_STORAGE_KEY = "byocli.theme";

/// Logo assets — the full-color logo reads on dark surfaces; the black-on-white
/// variant reads on light surfaces. The app-icon is a colored mark that works
/// on both, so it isn't swapped.
export const LOGO_DARK = "/byocli-logo.png";
export const LOGO_LIGHT = "/byocli-logo-black.png";

export function logoForTheme(theme: Theme): string {
  return theme === "light" ? LOGO_LIGHT : LOGO_DARK;
}

/// xterm.js theme palettes. The dark palette mirrors the original hardcoded
/// colors; the light palette is tuned for contrast on a light background with
/// the darkened teal accent.
export const DARK_TERMINAL_THEME = {
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
};

export const LIGHT_TERMINAL_THEME = {
  background: "#ffffff",
  foreground: "#1a2026",
  cursor: "#16a34a",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(22, 163, 74, 0.2)",
  black: "#1a2026",
  red: "#c0392b",
  green: "#16a34a",
  yellow: "#b8860b",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#56615d",
  brightBlack: "#56615d",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#d97706",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#1a2026"
};

export function terminalThemeFor(theme: Theme) {
  return theme === "light" ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

/// Apply a theme to the document: sets the `data-theme` attribute on <html>
/// (which the CSS token blocks key off) and updates the browser/theme-color
/// meta so the OS title-bar matches.
export function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const bg = theme === "light" ? "#eef0f3" : "#000308";
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", bg);
}

/// Read the persisted theme synchronously (before React mounts) to avoid a
/// flash of the wrong theme on boot. Falls back to "dark". Used in main.tsx.
export function readPersistedTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage may be unavailable (private mode, etc.) — fall back to dark.
  }
  return "dark";
}

/// Persist the theme so the next boot can read it synchronously (see
/// readPersistedTheme). Called from the theme effect in App.tsx.
export function persistTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore write failures — the in-memory state still drives the UI.
  }
}
