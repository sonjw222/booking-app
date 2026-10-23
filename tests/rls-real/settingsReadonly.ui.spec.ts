/* F20 — 운영 설정 화면: 센터 오너는 편집 가능, 운영 설정 권한이 없는 직원은 읽기 전용(실제 JWT, 격리 PostgREST, 로컬 브라우저). 서버의 저장 거부는 DB 테스트에서 별도 확인. */
import { expect, test } from "@playwright/test";
import { ensureExtraStaff, U, U2 } from "./support";
import { loginAs } from "./uiLogin";

test.beforeAll(() => { ensureExtraStaff(); });

test("[실제 JWT] 권한 없는 직원: 모든 입력이 비활성이고 안내·'읽기 전용'이 보이며 키보드로도 값이 바뀌지 않는다", async ({ page }) => {
  await loginAs(page, U2.S, "s@test.invalid");
  await page.goto("/manager/settings");
  await expect(page.locator(".settings-wrap")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("운영 설정을 변경할 권한이 없어요")).toBeVisible();
  const fs = page.locator("fieldset.settings-fieldset");
  await expect(fs).toHaveAttribute("disabled", "");   // fieldset 자체는 toBeDisabled 대상이 아니라 속성으로 확인
  await expect(page.getByRole("switch").first()).toBeDisabled();
  const enabled = await fs.locator("input:not([disabled]), button:not([disabled]), select:not([disabled])").evaluateAll((els) => els.filter((e) => !(e as HTMLElement).closest("fieldset:disabled")).length);
  expect(enabled).toBe(0);
  await expect(page.getByRole("button", { name: "변경사항 저장" })).toHaveCount(0);
  await expect(page.getByText("읽기 전용", { exact: true })).toBeVisible();
  // 포커스를 줘도(키보드) 값이 바뀌지 않고 미저장 경고 상태가 되지 않는다
  const firstSwitch = page.getByRole("switch").first();
  const before = await firstSwitch.getAttribute("aria-checked");
  await firstSwitch.focus().catch(() => {});
  await page.keyboard.press("Space").catch(() => {});
  expect(await firstSwitch.getAttribute("aria-checked")).toBe(before);
  await expect(page.getByText("저장됨", { exact: true })).toHaveCount(0);
});

test("[실제 JWT] 센터 오너: 같은 화면이 편집 가능하고 저장 버튼 흐름이 유지된다", async ({ page }) => {
  await loginAs(page, U.M, "m@test.invalid");
  await page.goto("/manager/settings");
  await expect(page.locator(".settings-wrap")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("운영 설정을 변경할 권한이 없어요")).toHaveCount(0);
  await expect(page.locator("fieldset.settings-fieldset")).not.toHaveAttribute("disabled", "");
  const sw = page.getByRole("switch", { name: "일일 예약 횟수 제한" });
  await expect(sw).toBeEnabled();
  const was = await sw.getAttribute("aria-checked");
  await sw.click();
  expect(await sw.getAttribute("aria-checked")).not.toBe(was);
  await expect(page.getByRole("button", { name: "변경사항 저장" })).toBeEnabled();
});
