import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("responsive workspace layout contract", () => {
  const css = read("app/globals.css");

  it("keeps mobile as the base layout and enables tablet/desktop progressively", () => {
    expect(css).toContain(".member-desktop-nav,\n.workspace-sidebar { display: none; }");
    expect(css).toContain("@media (min-width: 768px)");
    expect(css).not.toContain("@media (min-width: 1120px)");
    expect(css).toContain("@media (min-width: 1280px)");
    expect(css).toContain("@media (min-width: 1360px)");
    expect(css).toContain("--safe-top");
    expect(css).toContain("--safe-bottom");
  });

  it("uses shared workspace variables instead of per-screen sidebar widths", () => {
    expect(css).toContain("--workspace-sidebar");
    expect(css).toContain("--workspace-content-max");
    expect(css).toContain("padding-left: var(--workspace-sidebar)");
    expect(css).toContain("max-width: var(--workspace-content-max)");
  });

  it("expands compact rails without shifting workspace content", () => {
    expect(css).toContain("@media (min-width: 768px) and (max-width: 1359px) and (hover: hover) and (pointer: fine)");
    expect(css).toContain(".workspace-sidebar:focus-within");
    expect(css).toContain("width: 244px");
    expect(css).toContain("transition: width 220ms");
    expect(css).toContain("max-width: 180px");
  });

  it("keeps manager controls readable in both color themes", () => {
    expect(css).toContain("background-color: var(--card-bg)");
    expect(css).toContain('[data-theme="charcoal"] .manager-v3-content select.input-field { color-scheme: dark; }');
    expect(css).not.toContain("background-color: var(--text-inverse);\n  background-image:");
    expect(css).toContain("word-break: keep-all");
  });

  it("gives authentication screens tablet cards and a desktop split layout", () => {
    expect(css).toContain("Responsive authentication workspace");
    expect(css).toContain(".auth-page-v2");
    expect(css).toContain("grid-template-columns: minmax(390px,42%) minmax(560px,58%)");
    expect(css).toContain(".auth-page-v2 .auth-panel.login");
    expect(css).toContain(".auth-page-v2 .auth-panel.signup");
    expect(css).toContain("grid-template-columns: repeat(2,minmax(0,1fr))");
    expect(css).toContain(".auth-page-v2 .social-btn .sr-only");
  });

  it("keeps one Next.js app and chooses layout by viewport width, never device sniffing", () => {
    const layoutSources = [
      "app/layout.tsx",
      "app/manager/layout.tsx",
      "app/admin/layout.tsx",
      "app/components/BottomNav.tsx",
      "app/components/ManagerNav.tsx",
      "app/components/AdminNav.tsx",
    ].map(read).join("\n");
    expect(css).toContain("viewport width alone");
    expect(layoutSources).not.toMatch(/navigator\.userAgent|userAgentData|isMobile|isTablet|isDesktop/);
    expect(layoutSources).not.toMatch(/mobile\.mwhabit\.com|desktop\.mwhabit\.com|m\.mwhabit\.com/);
  });

  it("keeps bottom navigation on mobile and replaces it with wide navigation", () => {
    const memberNav = read("app/components/BottomNav.tsx");
    const managerNav = read("app/components/ManagerNav.tsx");
    expect(memberNav).toContain('className="member-desktop-nav"');
    expect(memberNav).toContain("<nav className={`bottom-nav");
    expect(managerNav).toContain('className="workspace-sidebar manager-sidebar"');
    expect(managerNav).toContain("canSeeManagerMenu");
    expect(css).toContain("body:has(> .member-desktop-nav) .bottom-nav { display: none; }");
    expect(css).toContain(".manager-v3 > .bottom-nav { display: none; }");
  });

  it("provides operator navigation and desktop drawer behavior", () => {
    const adminLayout = read("app/admin/layout.tsx");
    const adminNav = read("app/components/AdminNav.tsx");
    expect(adminLayout).toContain("<AdminNav />");
    expect(adminNav).toContain('aria-label="플랫폼 운영 메뉴"');
    expect(css).toContain("align-items: stretch; justify-content: flex-end");
    expect(css).toContain("border-radius: 0");
  });

  it("groups manager dashboard regions for stable multi-panel placement", () => {
    const managerHome = read("app/manager/page.tsx");
    const managerClasses = read("app/manager/classes/page.tsx");
    expect(managerHome).toContain('className="manager-dashboard-block"');
    expect(managerHome).toContain('className="manager-today-classes"');
    expect(managerHome).toContain('className="manager-menu-panel"');
    expect(managerClasses).toContain('className="manager-calendar-panel"');
    expect(managerClasses).toContain('className="manager-agenda-panel"');
  });
});
