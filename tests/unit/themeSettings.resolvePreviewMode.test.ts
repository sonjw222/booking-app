/*
  릴리스 폴리시 배치 8차(2026-09-17), 13번 — 테마 설정 미리보기 색상 회귀 방지.
  버그였던 내용: "기본(라이트)"/"다크 모드" 옵션의 미리보기가 var(--bg)(=지금 실제 적용된
  테마)를 그대로 썼던 탓에 시스템이 다크면 "기본(라이트)" 카드도 어둡게 보였고, "시스템
  설정 따르기"는 실제 OS 상태와 무관한 고정 반반 그라데이션이었다. 수정 후 기대 동작:
    - 기본(라이트) → 시스템이 뭐든 항상 "light"
    - 다크 모드 → 시스템이 뭐든 항상 "dark"
    - 시스템 설정 따르기 → 실제 시스템 상태를 그대로 따라감
*/
import { describe, expect, it } from "vitest";
import { resolveThemePreviewMode } from "../../app/settings/theme/page";

describe("resolveThemePreviewMode", () => {
  it("시스템 dark + 시스템따르기 → dark preview", () => {
    expect(resolveThemePreviewMode("system", true)).toBe("dark");
  });
  it("시스템 light + 시스템따르기 → light preview", () => {
    expect(resolveThemePreviewMode("system", false)).toBe("light");
  });
  it("시스템 dark + 기본(라이트) → light preview(오염되지 않음)", () => {
    expect(resolveThemePreviewMode("burgundy", true)).toBe("light");
  });
  it("시스템 light + 기본(라이트) → light preview", () => {
    expect(resolveThemePreviewMode("burgundy", false)).toBe("light");
  });
  it("시스템 light + 다크모드 → dark preview", () => {
    expect(resolveThemePreviewMode("charcoal", false)).toBe("dark");
  });
  it("시스템 dark + 다크모드 → dark preview", () => {
    expect(resolveThemePreviewMode("charcoal", true)).toBe("dark");
  });
});
