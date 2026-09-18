/*
  소셜 버튼 영구 비활성화 사고 방어 정책 회귀 방지(2026-09-15, release blocker) —
  Google을 네이티브로 전환해 구조적 원인은 없앴지만, 카카오/네이버는 여전히 브라우저
  리다이렉트 방식이라 provider 자체 페이지에서 실패/취소되면 우리 코드로 에러가
  reject되지 않아 socialLoading이 이전 provider 값으로 영구히 남을 수 있다(app/login/
  page.tsx 주석 참고). pageshow(bfcache 복원)/visibilitychange(탭 재활성화) 리스너가
  실제로 소스에 존재하는지, 그리고 소셜 버튼들이 여전히 하나의 공유 socialLoading으로
  disabled 처리되는지(=이 방어 로직이 전체 버튼에 적용됨)를 고정한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("app/login/page.tsx — 소셜 버튼 영구 비활성화 방어 로직", () => {
  const source = readFileSync(join(__dirname, "../../app/login/page.tsx"), "utf-8");

  it("pageshow(bfcache 복원) 이벤트에서 socialLoading을 리셋한다", () => {
    expect(source).toContain('window.addEventListener("pageshow"');
    expect(source).toContain("e.persisted");
  });

  it("visibilitychange(탭 재활성화) 이벤트에서도 socialLoading을 리셋한다", () => {
    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('document.visibilityState === "visible"');
  });

  it("리셋 로직이 setSocialLoading(null)을 호출한다", () => {
    const resetFnStart = source.indexOf("function resetStuckSocialLoading()");
    expect(resetFnStart).toBeGreaterThan(-1);
    const resetFnSlice = source.slice(resetFnStart, resetFnStart + 200);
    expect(resetFnSlice).toContain("setSocialLoading");
  });

  it("네 개 소셜 버튼(구글/카카오/네이버/애플) 모두 같은 socialLoading으로 disabled 처리된다 — 한 provider의 실패가 나머지도 막는 구조이므로 리셋 방어가 전체에 적용됨", () => {
    const disabledCount = (source.match(/disabled=\{!!socialLoading\}/g) ?? []).length;
    expect(disabledCount).toBe(4);
  });
});
