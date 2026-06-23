import { describe, expect, it } from "vitest";
import { uuid } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid", () => {
  it("produces a well-formed RFC 4122 v4 string", () => {
    const id = uuid();
    expect(id).toMatch(UUID_V4);
  });

  it("sets the v4 version nibble (4)", () => {
    // The 13th hex digit (index 14 in the string) must be 4.
    for (let i = 0; i < 50; i += 1) {
      expect(uuid()[14]).toBe("4");
    }
  });

  it("sets the variant bits (8, 9, a, or b)", () => {
    // The 17th hex digit (index 19) must be one of 8,9,a,b.
    for (let i = 0; i < 50; i += 1) {
      expect("89ab").toContain(uuid()[19]);
    }
  });

  it("generates unique values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const id = uuid();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });

  it("falls back to a getRandomValues implementation when randomUUID is absent", () => {
    // Simulate a non-secure context by hiding randomUUID. The fallback must
    // still produce a valid v4 — this is the L2 fix scenario.
    const original = (crypto as { randomUUID?: unknown }).randomUUID;
    // @ts-expect-error — deliberately deleting for the test
    delete crypto.randomUUID;
    try {
      const id = uuid();
      expect(id).toMatch(UUID_V4);
    } finally {
      // Restore so other tests in the suite aren't affected.
      if (original) (crypto as { randomUUID?: unknown }).randomUUID = original;
    }
  });
});
