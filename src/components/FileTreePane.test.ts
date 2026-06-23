import { describe, expect, it } from "vitest";
import { isBrowserOpenable, toFileUrl } from "./FileTreePane";

describe("toFileUrl", () => {
  it("builds a canonical 3-slash file URL from a Windows path", () => {
    // The regression this guards: a 2-slash `file://C:/...` got mangled by the
    // webview into `https://file:////?/C:/...`. Three slashes is canonical.
    expect(toFileUrl("C:\\Users\\Alex\\site\\index.html"))
      .toBe("file:///C:/Users/Alex/site/index.html");
  });

  it("builds a 3-slash file URL from a Unix path", () => {
    expect(toFileUrl("/home/alex/site/index.html"))
      .toBe("file:///home/alex/site/index.html");
  });

  it("normalizes forward slashes in mixed input", () => {
    expect(toFileUrl("C:/Users/Alex/index.html"))
      .toBe("file:///C:/Users/Alex/index.html");
  });

  it("does not double-slash a path that already has a leading slash", () => {
    // file:// + /home/... = file:///home/... (exactly three, not four)
    expect(toFileUrl("/var/www/index.html").match(/\//g)!.length)
      .toBe("file:///var/www/index.html".match(/\//g)!.length);
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
