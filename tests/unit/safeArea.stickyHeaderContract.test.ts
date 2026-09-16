/*
  릴리스 폴리시 배치 6차(2026-09-15) — 상단 safe-area 겹침이 3번째로 재신고된 뒤 진행한
  구조적 재진단 결과를 회귀 방지로 고정한다.

  근본 원인: @capacitor/status-bar의 overlaysWebView는 capacitor.config.ts의 선언적
  config로 브릿지 초기화 시점(첫 페인트 "전")에 네이티브가 직접 적용한다(StatusBarPlugin
  .swift의 override load() 확인함) — 그런데 CapacitorBootstrap.tsx가 매 페이지 로드마다
  (이 앱은 탭 전환마다 전체 페이지가 새로 로드됨) JS로 다시 setOverlaysWebView를
  호출해, 이미 config로 적용된 값을 또 왕복시켜 첫 페인트 "이후"에 레이아웃이 다시
  계산되는 불필요한 창을 만들었다 — CSS의 env(safe-area-inset-top) 자체는 이미
  맞았는데도 겹침이 반복 재현된 근본 원인. 이 테스트는 (1) JS 쪽 setOverlaysWebView
  호출이 다시 생기지 않는지, (2) config 쪽에 선언이 있는지를 고정한다.

  추가로 이번 배치에서 헤더를 position:sticky로 고정해 러버밴드 오버스크롤 중에도
  본문만 튕기고 헤더는 고정되도록 했다(iOS Settings 스타일) — .back-header가 이
  앱에서 ~50개 화면이 재사용하는 유일한 공용 상세/뒤로가기 헤더 계약이라 여기 한 줄만
  추가하면 전체 화면에 일괄 적용된다는 것도 함께 고정한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const capacitorConfigSource = readFileSync(join(__dirname, "../../capacitor.config.ts"), "utf-8");
const bootstrapSource = readFileSync(join(__dirname, "../../app/components/CapacitorBootstrap.tsx"), "utf-8");
const cssSource = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");

describe("iOS 상태바 오버레이 — 선언적 config로만 설정(JS 왕복 재도입 금지)", () => {
  it("capacitor.config.ts에 StatusBar.overlaysWebView: true 선언이 있다", () => {
    expect(capacitorConfigSource).toMatch(/StatusBar:\s*{\s*overlaysWebView:\s*true/);
  });

  it("CapacitorBootstrap.tsx는 더 이상 StatusBar.setOverlaysWebView를 호출하지 않는다(설명 주석 자체는 남아있을 수 있어 실제 호출 문법만 검사)", () => {
    expect(bootstrapSource).not.toContain("StatusBar.setOverlaysWebView(");
    expect(bootstrapSource).not.toContain('import("@capacitor/status-bar")');
  });
});

describe("공용 헤더 계약(.header/.back-header)이 sticky로 고정돼 러버밴드 중에도 헤더가 안 끌려간다", () => {
  it(".header(홈 등 탭 루트)가 position: sticky다", () => {
    const rule = cssSource.match(/\.header \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("top: 0");
    expect(rule).toContain("background: var(--bg)");
  });

  it(".back-header(이 앱에서 가장 많이 재사용되는 상세/뒤로가기 헤더)가 position: sticky다", () => {
    const ruleStart = cssSource.indexOf(".back-header {");
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleEnd = cssSource.indexOf("\n}", ruleStart);
    const rule = cssSource.slice(ruleStart, ruleEnd);
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("background: var(--bg)");
  });
});

describe("1:1 문의 목록 화면 — .inquiry-head 이중 safe-area 패딩 버그 회귀 방지", () => {
  it(".inquiry-head는 .noti-head/.mypage-titlebar와 더 이상 safe-area 규칙을 공유하지 않는다(자기 자신은 safe-top을 쓰지 않음 — .back-header가 이미 그 화면의 safe-area를 처리함)", () => {
    expect(cssSource).not.toMatch(/\.noti-head,\.inquiry-head/);
    const rule = cssSource.match(/\.inquiry-head\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toContain("--safe-top");
  });
});
