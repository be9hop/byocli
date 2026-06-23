/// Generate an RFC-4122 v4 UUID. Prefers `crypto.randomUUID` (available in
/// secure contexts — Tauri's tauri:// and https), and falls back to a
/// getRandomValues-based implementation so the non-Tauri dev mode served over
/// plain http (where randomUUID is undefined) doesn't throw.
export function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 via crypto.getRandomValues. Sets the version (4) and variant
  // (10xx) bits manually.
  const bytes = new Uint8Array(16);
  (crypto ?? (window as unknown as { crypto: Crypto }).crypto).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
