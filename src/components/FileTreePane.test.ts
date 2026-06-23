import { describe, expect, it } from "vitest";
import { isBrowserOpenable, toFileUrl } from "./FileTreePane";

describe("toFileUrl", () => {
  it("builds an http://127.0.0.1 URL from a Windows path", () => {
    // Local files are served over a localhost HTTP server because WebView2
    // blocks file:// and ignores custom protocols in child webviews.
    expect(toFileUrl("C:\\Users\\Alex\\site\\index.html", 43210))
      .toBe("http://127.0.0.1:43210/C:/Users/Alex/site/index.html");
  });

  it("builds an http://127.0.0.1 URL from a Unix path", () => {
    expect(toFileUrl("/home/alex/site/index.html", 43210))
      .toBe("http://127.0.0.1:43210/home/alex/site/index.html");
  });

  it("URL-encodes spaces and special chars in the path", () => {
    // Spaces (e.g. "Temp Demo") must be encoded so the HTTP path is valid.
    expect(toFileUrl("C:\\Users\\Alex\\Temp Demo\\index.html", 43210))
      .toBe("http://127.0.0.1:43210/C:/Users/Alex/Temp%20Demo/index.html");
  });

  it("never emits file:// or localfile:// (those are blocked by the webview)", () => {
    expect(toFileUrl("C:\\x.html", 43210)).not.toMatch(/^(file|localfile):\/\//);
  });

  it("normalizes forward slashes in mixed input", () => {
    expect(toFileUrl("C:/Users/Alex/index.html", 43210))
      .toBe("http://127.0.0.1:43210/C:/Users/Alex/index.html");
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
