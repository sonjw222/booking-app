/*
  릴리스 폴리시 배치 7차(2026-09-17) — 실기기 재신고: 홈/예약 화면이 스크롤 없이 첫
  페인트부터 상태바와 겹침(6차 배치의 .header/.back-header 공용 계약 수정 이후에도
  재현됨). 전수 감사 결과 세 곳에서 동일 패턴의 버그를 발견:

    1) .member-home .header — .header 기본 규칙보다 specificity가 높은 override가
       safe-area 토큰 없이 padding을 통째로 재선언해 6차 배치의 수정을 무효화하고
       있었다(홈 화면 전용).
    2) .resv-page-head — .header/.back-header 공용 계약과 완전히 별개의 전용
       selector라 애초에 6차 배치의 감사 대상에 없었고, safe-area 토큰이 한 번도
       없었다(예약 화면 전용).
    3) .mgr-mode-bar(+ .manager-home-v2 override) — 역시 공용 계약 밖의 전용
       selector, safe-area 토큰이 한 번도 없었다(관리자 홈 + 플랫폼 어드민 3개
       화면).

  이 테스트는 "화면마다 padding 조금 추가"가 아니라 "공용 계약을 우회하는 override가
  더 없는지"를 구조적으로 고정한다 — 세 selector 모두 safe-area 토큰을 포함하는지,
  그리고 화면 최상단 요소로 쓰이는 나머지 주요 selector들도 함께 재확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");

function rule(selectorPrefix: string): string {
  const idx = css.indexOf(selectorPrefix);
  if (idx === -1) return "";
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}

describe("홈 화면 — .member-home .header override가 safe-area를 무효화하지 않는다", () => {
  it(".member-home .header가 --safe-top을 포함한다", () => {
    const r = rule(".member-home .header {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });

  it(".header 기본 규칙도 여전히 --safe-top + sticky를 유지한다(회귀 확인)", () => {
    const r = rule(".header { position: sticky");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });
});

describe("예약 화면 — .resv-page-head가 공용 헤더 계약(sticky + safe-area)을 갖는다", () => {
  it(".resv-page-head가 --safe-top과 position: sticky를 포함한다", () => {
    const r = rule(".resv-page-head {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
    expect(r).toContain("position: sticky");
  });
});

describe("관리자 홈 / 플랫폼 어드민 — .mgr-mode-bar가 safe-area를 갖는다", () => {
  it("기본 .mgr-mode-bar 규칙이 --safe-top을 포함한다", () => {
    const r = rule(".mgr-mode-bar {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });

  it(".manager-home-v2 .mgr-mode-bar override도 --safe-top을 유지한다", () => {
    expect(css).toMatch(/\.manager-home-v2 \.mgr-mode-bar\{padding:max\(22px, var\(--safe-top\)\)/);
  });
});

describe("토스트/실시간 알림 팝업 — 상단 고정 위치의 safe-area 회귀 방지", () => {
  it(".toast(예약/취소 결과 등 회원 화면 기본 토스트)가 --safe-top을 포함한다", () => {
    const r = rule(".toast {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });

  it(".error-toast(회원 화면 기본)가 --safe-top을 포함한다", () => {
    const r = rule(".error-toast {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });

  it(".noti-toaster(실시간 알림 팝업)가 --safe-top을 포함한다", () => {
    const r = rule(".noti-toaster {");
    expect(r).not.toBe("");
    expect(r).toContain("--safe-top");
  });
});

describe("화면 최상단 헤더로 쓰이는 나머지 selector들의 safe-area 회귀 방지", () => {
  const mustHaveSafeTop = [
    ".back-header {",
    ".noti-head,.mypage-titlebar{",
    ".discovery-page-v2 .search-header {",
    ".auth-scene{",
  ];
  for (const sel of mustHaveSafeTop) {
    it(`${sel} 규칙이 --safe-top을 포함한다`, () => {
      const r = rule(sel);
      expect(r).not.toBe("");
      expect(r).toContain("--safe-top");
    });
  }
});
