import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Batch 1 design system contract", () => {
  it("keeps the approved neutral and sky-blue tokens centralized", () => {
    const css = read("app/globals.css");
    expect(css).toContain("--bg: #FBFBFA");
    expect(css).toContain("--ink: #171719");
    expect(css).toContain("--brand: #45BFE3");
    expect(css).toContain("--brand-ink: #087A9C");
    expect(css).toContain("--brand-soft: #E6F7FC");
    expect(css).toContain("--page-gutter: 16px");
  });

  it("provides every shared primitive without wiring it into feature pages", () => {
    for (const component of [
      "AppButton", "AppConfirmProvider", "ConfirmDialog", "DatePicker",
      "EmptyState", "SegmentedTabs", "UiIcon",
    ]) {
      expect(() => read(`app/components/${component}.tsx`)).not.toThrow();
    }
    const layout = read("app/layout.tsx");
    expect(layout).toContain("SessionWatcher");
    expect(layout).toContain("ImageViewerProvider");
    expect(layout).toContain("AppConfirmProvider");
  });
});

describe("Batch 3 discovery design contract", () => {
  it("uses the shared icon system across home, search and category discovery", () => {
    expect(read("app/page.tsx")).toContain("<UiIcon");
    expect(read("app/search/page.tsx")).toContain("<UiIcon");
    expect(read("app/category/[label]/page.tsx")).toContain("<UiIcon");
  });

  it("preserves the latest OAuth error callback behavior on home", () => {
    const home = read("app/page.tsx");
    expect(home).toContain("error_description");
    expect(home).toContain("window.location.replace(`/login?oauth_error=");
    expect(home).toContain("fetchMyUpcomingClasses");
  });
});

describe("Batch 2 chrome layer contract", () => {
  it("keeps persistent chrome below modal and sheet overlays", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.bottom-nav\s*\{[\s\S]*?z-index:\s*45;/);
    expect(css).toMatch(/\.manager-chrome\s*\{[\s\S]*?z-index:\s*30;/);
    expect(css).toMatch(/\.admin-chrome\s*\{[\s\S]*?z-index:\s*30;/);
    expect(css).toMatch(/\.sheet-overlay\s*\{[\s\S]*?z-index:\s*60;/);
    expect(css).toContain(".back-header:has(.header-action)");
  });
});
