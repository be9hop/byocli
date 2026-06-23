#!/usr/bin/env python3
"""
Migrate hardcoded colors in styles.css (lines after the token definitions) to
semantic CSS variables. Operates ONLY on lines >= START_LINE so the token
definitions in :root and [data-theme="light"] are never touched.

Each replacement is a deliberate mapping. We preserve the original intent:
- surface hexes -> --surface / --surface-raised / --surface-sunken / --bg
- text hexes    -> --text / --text-strong / --text-muted / --text-faint
- white overlays-> --hover / --active / --border / --border-strong
- accent hex    -> --accent
- danger reds   -> --danger / --danger-strong / --danger-soft
- black shadows -> --shadow-color
"""
import re
import sys

PATH = "src/styles.css"
START_LINE = 116  # first rule after the two token blocks

with open(PATH, encoding="utf-8") as f:
    lines = f.readlines()

head = lines[:START_LINE - 1]   # 0-indexed; lines[0..114]
tail = lines[START_LINE - 1:]   # lines[115..]
text = "".join(tail)

# ---- direct hex replacements (case-insensitive) ----
# Order matters: longer/more-specific patterns first.
hex_map = {
    # surfaces
    "#000308": "var(--bg)",
    "#06090c": "var(--surface)",
    "#0b1013": "var(--surface-raised)",
    "#11181b": "var(--surface-raised)",
    "#101719": "var(--surface-raised)",
    "#050709": "var(--surface)",
    "#02050a": "var(--surface)",
    "#070907": "var(--surface)",
    "#05080a": "var(--surface)",
    "#03090b": "var(--surface-sunken)",
    # text — strong whites
    "#f4f7f6": "var(--text)",
    "#ffffff": "var(--text-strong)",
    "#fff": "var(--text-strong)",
    "#f0fff8": "var(--text)",
    "#eff0ec": "var(--text)",
    "#e2e4e0": "var(--text)",
    "#e5e6e3": "var(--text-strong)",
    "#dfe0dd": "var(--text-strong)",
    "#d5d8d3": "var(--text-strong)",
    "#e89d9d": "var(--danger)",         # light red text on hover
    "#d78e8e": "var(--danger)",
    "#d99a9a": "var(--danger)",
    "#cd6868": "var(--danger-strong)",
    "#b97b7b": "var(--danger-strong)",
    "#a94e4e": "var(--danger-strong)",
    "#b85450": "var(--danger-strong)",
    # text — muted
    "#9aa5a2": "var(--text-muted)",
    "#9ca19c": "var(--text-muted)",
    "#afb2ae": "var(--text-muted)",
    "#afb4ae": "var(--text-muted)",
    "#b8bcb7": "var(--text-muted)",
    "#b8c4c0": "var(--text-muted)",
    "#8f9794": "var(--text-muted)",
    "#7f847f": "var(--text-muted)",
    "#7f8986": "var(--text-muted)",
    "#78827f": "var(--text-muted)",
    "#787d78": "var(--text-muted)",
    "#bec1bd": "var(--text-muted)",
    "#cfd2cd": "var(--text-muted)",
    "#8a908d": "var(--text-muted)",
    # text — faint
    "#626c69": "var(--text-faint)",
    "#626a66": "var(--text-faint)",
    "#666a66": "var(--text-faint)",
    "#70746f": "var(--text-faint)",
    "#4f534f": "var(--text-faint)",
    "#565a56": "var(--text-faint)",
    # accent — the mint
    "#17f5c1": "var(--accent)",
    "#5ffad3": "var(--accent)",
    # warning/success tones
    "#e0bd5c": "var(--warning)",
    "#83b997": "var(--success)",
    "#78d8b6": "var(--success)",
    "#12090b": "var(--text-strong)",   # cursor accent (near-black)
    # file-tree icons (amber/cyan kept as literal — they're semantic file colors,
    # not theme surfaces). Skip these deliberately by not including them.
}

for hex_val, token in hex_map.items():
    # case-insensitive replace of the hex literal
    text = re.sub(re.escape(hex_val), token, text, flags=re.IGNORECASE)

# ---- white overlay replacements ----
# rgba(255,255,255, x) where x is a low alpha (hover/active/border).
# Map by alpha bands:
def overlay_repl(m):
    alpha_str = m.group(1)
    try:
        alpha = float(alpha_str)
    except ValueError:
        return m.group(0)
    if alpha <= 0.05:
        return "var(--hover)"
    if alpha <= 0.10:
        return "var(--active)"
    if alpha <= 0.16:
        return "var(--border-strong)"
    return "var(--text-strong)"  # high-alpha whites → near-opaque

text = re.sub(r"rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*([\d.]+)\s*\)", overlay_repl, text)

# ---- black shadow replacements ----
# rgba(0,0,0, x) → var(--shadow-color) for shadow-like alphas
def black_repl(m):
    alpha_str = m.group(1)
    try:
        alpha = float(alpha_str)
    except ValueError:
        return m.group(0)
    if alpha >= 0.25:
        return "var(--shadow-color)"
    # very-low-alpha blacks behave like a hover/border tint
    if alpha <= 0.10:
        return "var(--border)"
    return "var(--active)"

text = re.sub(r"rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)", black_repl, text)

with open(PATH, "w", encoding="utf-8") as f:
    f.writelines(head)
    f.write(text)

# report remaining hexes for manual review
remaining = re.findall(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b", text)
from collections import Counter
print("Remaining hex literals in migrated section (review for completeness):")
for h, n in Counter([r.lower() for r in remaining]).most_common(25):
    print(f"  {h}: {n}")
print(f"Total remaining: {len(remaining)}")
