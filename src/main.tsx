import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, readPersistedTheme } from "./lib/theme";

// Apply the persisted theme BEFORE React mounts. Without this, a light-mode
// user sees a flash of the dark default background while state loads from
// SQLite/localStorage and the theme effect runs. Setting data-theme here means
// the very first paint uses the correct token values.
applyTheme(readPersistedTheme());

createRoot(document.getElementById("root")!).render(<App />);
