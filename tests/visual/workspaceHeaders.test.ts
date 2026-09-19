// Real header components and production CSS, without authentication or server data.
// This verifies rendering only; it is not authenticated end-to-end QA.
import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const route = vi.hoisted(() => ({ path: "/manager" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path, useRouter: () => ({ push() {}, back() {} }) }));
vi.mock("../../lib/navState", () => ({ replaceTabNavigation() {} }));
vi.mock("../../app/components/CurrentCenterLabel", () => ({ default: () => null }));
import ManagerChrome from "../../app/components/ManagerChrome";
import AdminChrome from "../../app/components/AdminChrome";

it("keeps real mode-switch text within its control in both themes and split windows", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const css = ["app/globals.css", "app/workspace.css"].map((f) => readFileSync(f, "utf8")).join("\n");
  try {
    for (const theme of ["burgundy", "charcoal"]) for (const width of [390, 600, 768, 1024, 1440]) for (const path of ["/manager", "/manager/classes", "/admin/subscriptions"]) {
      route.path = path;
      const admin = path.startsWith("/admin");
      const markup = renderToStaticMarkup(createElement(admin ? AdminChrome : ManagerChrome));
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<html data-theme="${theme}"><style>${css}</style><body><div class="${admin ? "admin" : "manager"}-v3">${markup}</div></body></html>`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${path} ${width} page overflow`).toBe(true);
      if (width < 600) continue; // phone keeps its existing compact control
      const result = await page.locator(admin ? ".admin-chrome > a" : ".manager-chrome-main > a").evaluate((el) => {
        const span = el.querySelector("span")!;
        const box = el.getBoundingClientRect(), label = span.getBoundingClientRect();
        return { visible: getComputedStyle(span).visibility !== "hidden", fits: label.left >= box.left && label.right <= box.right && label.bottom <= box.bottom && label.top >= box.top, background: getComputedStyle(el).backgroundColor, color: getComputedStyle(span).color };
      });
      expect(result.visible, `${path} ${width} ${theme}`).toBe(true);
      expect(result.fits, `${path} ${width} ${theme} clipped label`).toBe(true);
      expect(result.color).not.toBe(result.background);
      if (width === 768) await page.screenshot({ path: `/private/tmp/mwhabit-${admin ? "admin" : path === "/manager" ? "manager" : "classes"}-${theme}-header.png` });
    }
  } finally { await browser.close(); }
});
