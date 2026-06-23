#!/usr/bin/env python3
"""
Second-pass migration: bucket the remaining ~125 hand-tuned gray/slate variants
into the nearest semantic token by lightness. These are all subtle variations of
the same muted/faint text tones the author sprinkled inline.

Bucket by perceived lightness (0-255 scale, approximated from hex):
- very light (> 0.85) → --text (near-white on dark / near-black on light)
- light (0.70-0.85)   → --text-muted
- mid (0.45-0.70)     → --text-muted
- dark (0.25-0.45)    → --text-faint
- very dark (< 0.25)  → --surface-raised / --bg

Also handles a few known reds and the leftover surface hexes.
"""
import re

PATH = "src/styles.css"
START_LINE = 116

with open(PATH, encoding="utf-8") as f:
    lines = f.readlines()

head = lines[:START_LINE - 1]
text = "".join(lines[START_LINE - 1:])

def luminance(hex6):
    r = int(hex6[0:2], 16) / 255
    g = int(hex6[2:4], 16) / 255
    b = int(hex6[4:6], 16) / 255
    # relative luminance (rough)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def bucket(hex6):
    l = luminance(hex6)
    if l > 0.90:
        return "var(--text-strong)"
    if l > 0.70:
        return "var(--text)"
    if l > 0.45:
        return "var(--text-muted)"
    if l > 0.22:
        return "var(--text-faint)"
    if l > 0.04:
        return "var(--surface-raised)"
    return "var(--bg)"

# Known explicit mappings the luma heuristic would get wrong (file-tree icon
# colors, specific danger tints, etc.) — preserve as literal by leaving them
# out of the replacement set.
preserve = {
    "c99b57",  # amber file icon
    "75a9b2",  # cyan symlink icon
    "877777",  # muted error text variant
}

def repl(m):
    full = m.group(0)
    digits = m.group(1).lower()
    if digits in preserve:
        return full
    if len(digits) == 3:
        # expand #abc -> #aabbcc
        digits = "".join(c * 2 for c in digits)
    return bucket(digits)

text = re.sub(r"#([0-9a-fA-F]{6})\b", repl, text)
text = re.sub(r"#([0-9a-fA-F]{3})\b", repl, text)

with open(PATH, "w", encoding="utf-8") as f:
    f.writelines(head)
    f.write(text)

remaining = re.findall(r"#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b", text)
print(f"Remaining hex literals: {len(remaining)}")
from collections import Counter
for h, n in Counter([r.lower() for r in remaining]).most_common(10):
    print(f"  {h}: {n}")
