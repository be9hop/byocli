import { Plus, Settings2, Star, Sun, TerminalSquare, Trash2, Workflow, X, Zap } from "lucide-react";
import { useState } from "react";
import type { TerminalAction, TerminalProfile, Theme } from "../types";
import { uuid } from "../lib/uuid";
import { IconButton } from "./IconButton";

export type SettingsSection = "general" | "profiles" | "commands";

type Props = {
  initialSection: SettingsSection;
  profiles: TerminalProfile[];
  defaultProfileId: string;
  terminalFontSize: number;
  terminalLineHeight: number;
  terminalActions: TerminalAction[];
  theme: Theme;
  onDefaultProfileChange: (profileId: string) => void;
  onTerminalDisplayChange: (fontSize: number, lineHeight: number) => void;
  onProfilesChange: (profiles: TerminalProfile[]) => void;
  onTerminalActionsChange: (actions: TerminalAction[]) => void;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
};

const builtInProfiles = new Set(["shell", "claude", "codex", "gemini", "omp", "aider", "opencode", "goose"]);

export function SettingsDialog({
  initialSection, profiles, defaultProfileId, terminalFontSize, terminalLineHeight, terminalActions,
  theme, onDefaultProfileChange, onTerminalDisplayChange, onProfilesChange, onTerminalActionsChange,
  onThemeChange, onClose
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [actionName, setActionName] = useState("");
  const [actionCommand, setActionCommand] = useState("");

  const updateProfile = (profileId: string, patch: Partial<TerminalProfile>) => {
    onProfilesChange(profiles.map((profile) => profile.id === profileId ? { ...profile, ...patch } : profile));
  };

  const addProfile = () => {
    const id = `custom-${uuid()}`;
    onProfilesChange([...profiles, {
      id,
      name: "Custom agent",
      command: "",
      args: [],
      accent: "#17f5c1"
    }]);
  };

  const removeProfile = (profileId: string) => {
    onProfilesChange(profiles.filter((profile) => profile.id !== profileId));
    if (defaultProfileId === profileId) onDefaultProfileChange("shell");
  };

  const addAction = () => {
    const name = actionName.trim();
    const command = actionCommand.trim();
    if (!name || !command) return;
    onTerminalActionsChange([...terminalActions, { id: uuid(), name, command, favorite: false }]);
    setActionName("");
    setActionCommand("");
  };

  const favoriteCount = terminalActions.filter((action) => action.favorite).length;
  const toggleFavorite = (actionId: string) => {
    const action = terminalActions.find((item) => item.id === actionId);
    if (!action || (!action.favorite && favoriteCount >= 4)) return;
    onTerminalActionsChange(terminalActions.map((item) =>
      item.id === actionId ? { ...item, favorite: !item.favorite } : item
    ));
  };

  const sectionCopy = {
    general: ["General", "Defaults for new terminals and terminal display."],
    profiles: ["Terminal profiles", "Agents and shells BYOCLI can launch."],
    commands: ["Saved commands", "Reusable commands that open in a new terminal tab."]
  } as const;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <aside className="settings-nav">
          <div className="settings-title">
            <img src="/byocli-app-icon.png" alt="" />
            <div><strong id="settings-title">Settings</strong><small>Bring Your Own CLI</small></div>
          </div>
          <button type="button" className={section === "general" ? "is-active" : ""} onClick={() => setSection("general")}>
            <Settings2 size={14} /> General
          </button>
          <button type="button" className={section === "profiles" ? "is-active" : ""} onClick={() => setSection("profiles")}>
            <Workflow size={14} /> Terminal profiles
          </button>
          <button type="button" className={section === "commands" ? "is-active" : ""} onClick={() => setSection("commands")}>
            <Zap size={14} /> Saved commands
          </button>
        </aside>

        <div className="settings-content">
          <header>
            <div>
              <h2>{sectionCopy[section][0]}</h2>
              <p>{sectionCopy[section][1]}</p>
            </div>
            <IconButton label="Close settings" onClick={onClose}><X size={16} /></IconButton>
          </header>

          {section === "general" && (
            <div className="settings-section">
              <section className="settings-group">
                <div className="settings-group-heading">
                  <Sun size={16} />
                  <div><strong>Appearance</strong><small>Choose how BYOCLI looks.</small></div>
                </div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>Theme</span>
                    <small>Light or dark interface. Applies instantly and is saved per workspace.</small>
                    <select value={theme} onChange={(event) => onThemeChange(event.target.value as Theme)}>
                      <option value="dark">Dark</option>
                      <option value="light">Light</option>
                    </select>
                  </label>
                </div>
              </section>

              <section className="settings-group">
                <div className="settings-group-heading">
                  <TerminalSquare size={16} />
                  <div><strong>Terminal</strong><small>Applied to every workspace terminal.</small></div>
                </div>
                <div className="settings-grid">
                  <label className="settings-field">
                    <span>Default profile</span>
                    <small>Used when creating a workspace or default terminal.</small>
                    <select value={defaultProfileId} onChange={(event) => onDefaultProfileChange(event.target.value)}>
                      {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Text size</span>
                    <small>Increase terminal text without scaling the whole interface.</small>
                    <select
                      value={terminalFontSize}
                      onChange={(event) => onTerminalDisplayChange(Number(event.target.value), terminalLineHeight)}
                    >
                      {[13, 14, 15, 16, 17, 18].map((size) => <option key={size} value={size}>{size}px</option>)}
                    </select>
                  </label>
                  <label className="settings-field">
                    <span>Line spacing</span>
                    <small>Controls vertical density inside terminal sessions.</small>
                    <select
                      value={terminalLineHeight}
                      onChange={(event) => onTerminalDisplayChange(terminalFontSize, Number(event.target.value))}
                    >
                      <option value={1.25}>Compact</option>
                      <option value={1.45}>Comfortable</option>
                      <option value={1.6}>Relaxed</option>
                    </select>
                  </label>
                </div>
              </section>
            </div>
          )}

          {section === "profiles" && (
            <div className="profiles-editor">
              <div className="profiles-toolbar">
                <span>{profiles.length} launch profiles</span>
                <button type="button" onClick={addProfile}><Plus size={13} /> Add custom profile</button>
              </div>
              {profiles.map((profile) => (
                <article className="profile-editor" key={profile.id}>
                  <div className="profile-editor-head">
                    <span className="profile-dot" style={{ background: profile.accent }} />
                    <strong>{profile.name}</strong>
                    {!builtInProfiles.has(profile.id) && (
                      <IconButton label={`Delete ${profile.name}`} onClick={() => removeProfile(profile.id)}>
                        <Trash2 size={13} />
                      </IconButton>
                    )}
                  </div>
                  <div className="profile-fields">
                    <label>
                      <span>Name</span>
                      <input value={profile.name} onChange={(event) => updateProfile(profile.id, { name: event.target.value })} />
                    </label>
                    <label>
                      <span>Command</span>
                      <input value={profile.command} spellCheck={false} onChange={(event) => updateProfile(profile.id, { command: event.target.value })} />
                    </label>
                    <label>
                      <span>Arguments</span>
                      <input
                        value={profile.args.join(" ")}
                        spellCheck={false}
                        onChange={(event) => updateProfile(profile.id, { args: event.target.value.trim() ? event.target.value.trim().split(/\s+/) : [] })}
                      />
                    </label>
                    <label>
                      <span>Resume arguments</span>
                      <input
                        value={profile.resumeArgs?.join(" ") || ""}
                        spellCheck={false}
                        onChange={(event) => updateProfile(profile.id, {
                          resumeArgs: event.target.value.trim() ? event.target.value.trim().split(/\s+/) : undefined
                        })}
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>
          )}

          {section === "commands" && (
            <div className="commands-settings">
              <form
                className="command-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  addAction();
                }}
              >
                <div>
                  <strong>Add saved command</strong>
                  <small>Pin up to four favorites to the command bar. Everything else stays in Run commands.</small>
                </div>
                <label>
                  <span>Name</span>
                  <input value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="Start development server" />
                </label>
                <label>
                  <span>Command</span>
                  <input value={actionCommand} onChange={(event) => setActionCommand(event.target.value)} placeholder="npm run dev" spellCheck={false} />
                </label>
                <button type="submit" disabled={!actionName.trim() || !actionCommand.trim()}><Plus size={14} /> Save command</button>
              </form>

              <div className="saved-command-list">
                <div className="saved-command-list-head">
                  <span>Saved commands</span>
                  <small>{favoriteCount}/4 favorites</small>
                </div>
                {terminalActions.map((action) => (
                  <article className="saved-command" key={action.id}>
                    <span><Zap size={14} /></span>
                    <div><strong>{action.name}</strong><code>{action.command}</code></div>
                    <IconButton
                      label={action.favorite
                        ? `Remove ${action.name} from favorites`
                        : favoriteCount >= 4
                          ? "Favorite limit reached"
                          : `Add ${action.name} to favorites`}
                      className={action.favorite ? "is-favorite" : ""}
                      active={action.favorite}
                      disabled={!action.favorite && favoriteCount >= 4}
                      onClick={() => toggleFavorite(action.id)}
                    >
                      <Star size={14} fill={action.favorite ? "currentColor" : "none"} />
                    </IconButton>
                    <IconButton
                      label={`Delete ${action.name}`}
                      onClick={() => onTerminalActionsChange(terminalActions.filter((item) => item.id !== action.id))}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </article>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
