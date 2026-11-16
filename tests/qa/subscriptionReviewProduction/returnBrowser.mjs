// Offline browser check: every request is intercepted; no PG/Auth/DB traffic.
import { rolldown } from "rolldown";
import { chromium } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const work = await mkdtemp(join(tmpdir(), "nicepay-review-return-offline-"));
const bundle = await rolldown({ input: resolve("lib/payments/server/nicepay/subscriptionReviewHttp.ts"), platform: "node", logLevel: "silent" });
await bundle.write({ file: join(work, "http.mjs"), format: "esm" });
await bundle.close();
const { registrationResult } = await import(pathToFileURL(join(work, "http.mjs")));
const response = registrationResult("closed"), html = await response.text();
const headers = Object.fromEntries(response.headers);
const target = "https://mwhabit.com/api/billing/nicepay/registration-review/result";
const browser = await chromium.launch({ headless: true });
let interceptedRequests = 0;
try {
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    interceptedRequests++;
    const url = route.request().url();
    if (url === target) return route.fulfill({ status: response.status, headers, body: html });
    if (url === "https://mwhabit.com/manager/subscription/nicepay-review") return route.fulfill({ contentType: "text/html; charset=utf-8", body: "<h1>심사용 확인 화면</h1>" });
    if (["https://pg-web.nicepay.co.kr/offline-fixture", "https://untrusted.example/offline-fixture"].includes(url)) return route.fulfill({ contentType: "text/html; charset=utf-8", body: `<iframe title="return" src="${target}"></iframe>` });
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto("https://pg-web.nicepay.co.kr/offline-fixture");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("heading", { name: "카드 등록 심사용 확인 종료" }).waitFor();
  await frame.getByRole("link", { name: "심사용 확인 화면으로 돌아가기", exact: true }).click();
  await page.waitForURL("https://mwhabit.com/manager/subscription/nicepay-review");
  assert.equal(page.frames().length, 1);
  await page.goto("https://untrusted.example/offline-fixture");
  await page.waitForLoadState("load");
  assert.equal(await page.frameLocator("iframe").getByRole("heading", { name: "카드 등록 심사용 확인 종료" }).count(), 0);
  const result = { pass: true, trustedPgFrameRendered: true, returnExitedIframe: true, untrustedAncestorBlocked: true, interceptedRequests, actualPgRequests: 0, actualAuthOrDbRequests: 0 };
  await writeFile(join(work, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
