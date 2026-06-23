import { describe, expect, it } from "vitest";
import { isBrowserOpenable, toFileUrl } from "./FileTreePane";

describe("toFileUrl", () => {
  it("builds a canonical localfile:// URL from a Windows path", () => {
    // Uses the custom localfile:// protocol (not file://) because WebView2
    // blocks direct file:// navigation from external origins. The Rust
    // backend registers a localfile scheme handler that reads from disk.
    expect(toFileUrl("C:\\Users\\Alex\\site\\index.html"))
      .toBe("localfile:///C:/Users/Alex/site/index.html");
  });

  it("builds a localfile:// URL from a Unix path", () => {
    expect(toFileUrl("/home/alex/site/index.html"))
      .toBe("localfile:///home/alex/site/index.html");
  });

  it("normalizes forward slashes in mixed input", () => {
    expect(toFileUrl("C:/Users/Alex/index.html"))
      .toBe("localfile:///C:/Users/Alex/index.html");
  });

  it("always emits the localfile scheme (never file://)", () => {
    expect(toFileUrl("C:\\x.html")).not.toMatch(/^file:\/\//);
    expect(toFileUrl("/home/x.html")).toMatch(/^localfile:\/\//);
  });
});

describe("isBrowserOpenable", () => {
  it("accepts browser-renderable document types", () => {
    for (const name of ["index.html", "page.HTM", "chart.svg", "doc.xhtml"]) {
      expect(isBrowserOpenable(name)).toBe(true);
    }
  });

  it("accepts image types", () => {
    for (const name of ["photo.png", "banner.jpg", "anim.gif", "modern.webp", "icon.ico"]) {
      expect(isBrowserOpenable(name)).toBe(true);
    }
  });

  it("accepts PDF", () => {
    expect(isBrowserOpenable("report.pdf")).toBe(true);
  });

  it("rejects code, config, and text files", () => {
    for (const name of ["app.tsx", "Cargo.toml", "README.md", "main.rs", ".gitignore", "style.css", "data.json"]) {
      expect(isBrowserOpenable(name)).toBe(false);
    }
  });

  it("is case-insensitive on the extension", () => {
    expect(isBrowserOpenable("INDEX.HTML")).toBe(true);
    expect(isBrowserOpenable("Pic.PNG")).toBe(true);
  });

  it("rejects extensionless files and directories", () => {
    expect(isBrowserOpenable("Makefile")).toBe(false);
    expect(isBrowserOpenable("src")).toBe(false);
  });
});
