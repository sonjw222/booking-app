/* 실기기 UI QA(2026-10-03) — ① 수강권 설정 검색/필터 바깥 네모 ② 일시적 action toast geometry ③ 예약조건 펼침 강조. CSS/정적 계약(기능/DB 변경 없음). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const css = read("app/globals.css");
// 셀렉터 텍스트로 선언 블록을 찾는다(그룹 셀렉터의 일부여도 매칭). 같은 셀렉터가 여러 번 나오면 모두 돌려준다.
function blocks(selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, "").split(",").map((x) => x.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}
const flat = (b: string) => b.replace(/\s+/g, " ");
const decl = (selector: string, prop: string): string[] => blocks(selector).flatMap((b) => [...flat(b).matchAll(new RegExp(`(?:^|[;{ ])${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) => m[1].trim()));
const last = (selector: string, prop: string) => decl(selector, prop).at(-1)?.replace(/\s*!important$/, "");   // 최종(가장 늦은) 선언값, !important 표시는 제외

describe("1. 수강권 설정 검색/필터 바깥 네모는 이 화면에서만 제거", () => {
  it("membership-rules wrapper에 전용 class, 그 안의 .catalog-filter 배경만 transparent", () => {
    const page = read("app/manager/membership-rules/page.tsx");
    expect(page).toContain('<div className="membership-rules-filter" style={{ padding: "0 20px" }}>');
    expect(last(".membership-rules-filter .catalog-filter", "background")).toBe("transparent");
  });
  it("공용 CatalogSearchFilter/기본 .catalog-filter/input/chip 규칙과 구매 sheet 규칙은 그대로", () => {
    const comp = read("app/components/CatalogSearchFilter.tsx");
    expect(comp).toContain('className={`catalog-filter${sticky ? " is-sticky" : ""}`}');
    expect(comp).not.toContain("membership-rules");
    expect(last(".catalog-filter", "background")).toBe("var(--card-bg, var(--bg))");                 // 전역 기본값 불변
    expect(last(".sheet .catalog-filter", "background")).toBe("var(--bg)");                           // 구매 sheet(회원) 규칙 불변
    expect(css).not.toMatch(/\.manager-v3-content \.catalog-filter/);                                   // 전역/다른 관리자 화면으로 번지는 규칙 없음
    expect(blocks(".catalog-search-input").join(" ")).toContain("border: 1px solid var(--line)");      // 검색 input 자체 테두리/배경 유지
    expect(blocks(".catalog-search-input").join(" ")).toContain("background: var(--surface)");
    expect(read("app/center/[id]/page.tsx")).not.toContain("membership-rules-filter");
    expect(read("app/manager/goods/page.tsx")).not.toContain("membership-rules-filter");
  });
});

describe("2. 일시적 action toast geometry(.toast / .error-toast / .status-toast)", () => {
  it(".toast: compact min-height, flex center, 중앙 정렬 텍스트, 정상 line-height, rounded rectangle, safe-area top 유지", () => {
    expect(last(".toast", "min-height")).toBe("44px");
    expect(last(".toast", "display")).toBe("flex");
    expect(last(".toast", "align-items")).toBe("center");
    expect(last(".toast", "justify-content")).toBe("center");
    expect(last(".toast", "text-align")).toBe("center");
    expect(last(".toast", "line-height")).toBe("1.35");
    expect(last(".toast", "padding")).toBe("10px 16px");
    expect(last(".toast", "border-radius")).toBe("14px");                                              // 999px pill 아님
    expect(last(".toast", "box-sizing")).toBe("border-box");
    expect(last(".toast", "max-width")).toBe("calc(100vw - 32px)");
    expect(last(".toast", "font-size")).toBe("13px"); expect(last(".toast", "font-weight")).toBe("700");
    expect(last(".toast", "top")).toBe("max(18px, var(--safe-top))");
  });
  it(".error-toast: 같은 geometry + 텍스트/닫기 버튼 수직 중심 정렬, 버튼이 높이를 키우지 않음, safe-area 유지", () => {
    expect(last(".error-toast", "min-height")).toBe("44px");
    expect(last(".error-toast", "align-items")).toBe("center");
    expect(last(".error-toast", "padding")).toBe("10px 16px");
    expect(last(".error-toast", "border-radius")).toBe("14px");
    expect(last(".error-toast", "line-height")).toBe("1.35");
    expect(last(".error-toast", "top")).toBe("max(18px, var(--safe-top))");
    expect(last(".error-toast", "background")).toBe("var(--danger)");                                  // 기존 danger 색 의미 유지
    expect(last(".error-toast button", "width")).toBe("20px"); expect(last(".error-toast button", "height")).toBe("20px");
    expect(last(".error-toast button", "padding")).toBe("0"); expect(last(".error-toast button", "line-height")).toBe("1");
    expect(last(".error-toast button", "flex")).toBe("0 0 auto"); expect(last(".error-toast button", "align-self")).toBe("center");
  });
  it(".status-toast: 같은 높이/radius/typography, success/info 색 의미 유지, 닫기 버튼 center", () => {
    expect(last(".status-toast", "min-height")).toBe("44px");
    expect(last(".status-toast", "align-items")).toBe("center");
    expect(last(".status-toast", "padding")).toBe("10px 16px");
    expect(last(".status-toast", "border-radius")).toBe("14px");
    expect(last(".status-toast", "line-height")).toBe("1.35");
    expect(last(".status-toast", "top")).toBe("max(18px, var(--safe-top))");
    expect(last(".status-toast.is-success", "background")).toBe("var(--success-soft)");
    expect(last(".status-toast.is-info", "color")).toBe("var(--info)");
    expect(last(".status-toast button", "align-self")).toBe("center"); expect(last(".status-toast button", "line-height")).toBe("1");
  });
  it("후반 slab-guard 블록: 3종 토스트 모두 같은 최종 값(base와 모순 없음), 상한 유지", () => {
    for (const sel of [".toast", ".error-toast", ".status-toast", ".manager-v3-content .toast", ".manager-v3-content .error-toast", ".admin-v3-content .toast"]) {
      expect(last(sel, "min-height")).toBe("44px");
      expect(last(sel, "border-radius")).toBe("14px");
      expect(last(sel, "padding")).toBe("10px 16px");
    }
    expect(last(".toast", "height")).toBe("auto"); expect(last(".toast", "max-height")).toBe("160px");
    expect(last(".toast", "width")).toBe("max-content");
    expect(decl(".toast", "min-height").some((v) => v.endsWith("!important"))).toBe(true);   // slab guard는 !important로 유지(후반 override가 상한을 깨지 못하게)
    expect(last(".manager-v3-content .error-toast", "padding")).toBe("10px 16px");                    // manager 전용 블록도 동일
    expect(last(".manager-v3-content .error-toast", "min-height")).toBe("44px");
  });
  it(".error-toast-with-action: 버튼 포함 구조 유지, 폭이 지나치게 커지지 않고 메시지와 CTA 간격을 gap으로 정돈", () => {
    expect(last(".error-toast-with-action", "flex-wrap")).toBe("wrap");
    expect(last(".error-toast-with-action", "gap")).toBe("8px 10px");
    expect(last(".error-toast.error-toast-with-action", "max-width")).toContain("min(360px, calc(100vw - 32px))");
    expect(last(".error-toast-action", "flex")).toBe("0 0 100%");
  });
  it("위치 계약: manager/admin toast는 BottomNav 위(bottom 112px, top auto)로 유지, 회원 화면은 safe-top 유지", () => {
    expect(last(".manager-v3-content .toast", "bottom")).toBe("112px");
    expect(last(".admin-v3-content .toast", "top")).toBe("auto");
    expect(last(".manager-v3-content .error-toast", "top")).toBe("max(14px, var(--safe-top))");
    expect(last(".toast", "top")).toContain("--safe-top");
  });
  it("제목+본문 카드인 실시간 알림/네이티브 푸시 배너는 일반 토스트 geometry에 포함하지 않는다", () => {
    const geometryGuard = blocks(".toast").find((b) => b.includes("max-height")) ?? "";
    expect(geometryGuard).toBeTruthy();
    // guard 블록의 셀렉터 목록에 noti/push가 없다
    const m = css.match(/([^{}]*\.status-toast[^{}]*\.admin-v3-content \.error-toast)\s*\{/)!;
    expect(m[1]).not.toMatch(/noti-|push-foreground/);
    expect(last(".push-foreground-banner", "border-radius")).toBe("16px");
    expect(last(".push-foreground-banner", "padding")).toBe("14px 16px");
    expect(blocks(".noti-toaster").length).toBeGreaterThan(0);
  });
  it("토스트를 쓰는 화면 코드는 바뀌지 않았다(className/구조 그대로: 수강권 설정 toast)", () => {
    const page = read("app/manager/membership-rules/page.tsx");
    expect(page).toContain('<div className="toast">{toast}</div>');
  });
});

describe("3. 예약조건 펼침: 큰 brand-soft 면 제거, 얇은 왼쪽 line + 개별 카드", () => {
  it(".pass-rules: transparent, radius 0, 왼쪽 brand line 유지, 어떤 정의에도 brand-soft 없음", () => {
    expect(last(".pass-rules", "background")).toBe("transparent");
    expect(last(".pass-rules", "border-radius")).toBe("0");
    expect(last(".pass-rules", "border-left")).toBe("2px solid var(--brand)");
    expect(last(".pass-rules", "padding")).toBe("4px 0 4px 12px");
    expect(blocks(".pass-rules").join(" ")).not.toContain("brand-soft");
  });
  it(".pass-rule 개별 카드: surface 배경 + 1px line border + radius 유지", () => {
    expect(last(".pass-rule", "background")).toBe("var(--surface)");
    expect(last(".pass-rule", "border")).toBe("1px solid var(--line)");
    expect(last(".pass-rule", "border-radius")).toBe("8px");
    expect(last(".pass-rule", "min-height")).toBe("44px");
  });
  it("다크/라이트 모두 토큰만 사용(하드코딩 색 없음)", () => {
    for (const sel of [".pass-rules", ".pass-rule", ".membership-rules-filter .catalog-filter"]) expect(blocks(sel).join(" ")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
  it("예약조건 추가/삭제/펼침 로직은 그대로(UI class만 변경)", () => {
    const page = read("app/manager/membership-rules/page.tsx");
    for (const keep of ["addRule(", "deleteRule(", "applyRulesToProducts", "handleAddRule", "setExpandedProducts", 'className="pass-rules"', 'className="pass-rule"']) expect(page, keep).toContain(keep);
  });
});
