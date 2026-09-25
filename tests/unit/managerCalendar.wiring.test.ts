/*
  2026-09-26 — 관리자 수업 화면 캘린더 추가 + 관리자 홈 상단 다크/라이트 계약.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const page = read("app/manager/classes/page.tsx");
const css = read("app/globals.css");

describe("관리자 수업 화면 — 내 캘린더에 추가", () => {
  it("달력 헤더 아래에 버튼이 있고 공용 시트/서비스를 쓴다(회원 화면과 같은 컴포넌트)", () => {
    expect(page).toContain('className="manager-cal-add-row"');
    expect(page).toContain("onClick={openCalendarSheet}");
    expect(page).toContain('import CalendarAddSheet from "../../components/CalendarAddSheet"');
    expect(read("app/mypage/calendar/page.tsx")).toContain('import CalendarAddSheet from "../../components/CalendarAddSheet"');
  });
  it("현재 표시 월(year/month) + 현재 선택된 센터(activeCenter) 범위만 — 클릭 시점 상태로 계산", () => {
    const fn = page.slice(page.indexOf("function openCalendarSheet()"), page.indexOf("function handleCalendarResult"));
    expect(fn).toContain("filterEventsByMonth([...classEvents, ...holidayEvents], year, month)");
    expect(fn).toContain("activeCenter.name");
    expect(fn).toContain("d.startsWith(prefix)");            // 휴무일도 표시 월만
    expect(fn).toContain('c.status !== "cancelled"');        // 취소된 수업 제외
  });
  it("수업 + 센터 휴무일(연속 기간은 all-day range)을 함께 목록에 올린다", () => {
    const fn = page.slice(page.indexOf("function openCalendarSheet()"), page.indexOf("function handleCalendarResult"));
    expect(fn).toContain("classToEvent(");
    expect(fn).toContain("holidaysToEvents(");
  });
  it("시트: 체크박스 목록, 전체 선택/해제, 선택 개수 CTA, 유형 배지(수업/휴무일)", () => {
    const sheet = read("app/components/CalendarAddSheet.tsx");
    expect(sheet).toContain('type="checkbox"');
    expect(sheet).toContain("전체 선택");
    expect(sheet).toContain("전체 해제");
    expect(sheet).toContain("선택한 ${picked.length}개 기본 캘린더에 추가");
    expect(sheet).toContain("picked.length === 0"); // 선택 0개면 CTA 비활성
    expect(sheet).toContain('holiday: "휴무일"');
    expect(sheet).toContain("이 달에는 추가할 일정이 없어요");
    expect(sheet).toContain("다른 캘린더 앱 선택");
  });
});

describe("관리자 홈 상단 — 다크/라이트", () => {
  const tail = css.slice(css.lastIndexOf("관리자 홈 상단 다크/라이트 정리(2026-09-26"));
  it("센터 선택 칩: --ink 채움(다크=순백) 대신 중립 surface + 약한 accent 테두리, 역할 배지는 accent-soft", () => {
    expect(tail).toMatch(/\.manager-home-v2 \.center-chip\.on \{[^}]*background: var\(--card-bg\)/);
    expect(tail).not.toMatch(/\.manager-home-v2 \.center-chip\.on \{[^}]*background: var\(--ink\)/);
    expect(tail).toMatch(/\.center-role \{ background: var\(--accent-soft\)/);
  });
  it("회원 화면 전환 원형 버튼: 중립 surface + 얇은 테두리 + --ink 아이콘(다크 흰 원/라이트 검은 원 제거)", () => {
    expect(tail).toMatch(/\.manager-chrome-main > a \{ border: 1px solid var\(--line-strong\); background: var\(--card-bg\); color: var\(--ink\); \}/);
    expect(tail).toContain(".manager-chrome-main > a:active { background: var(--surface); }");
  });
  it("기능/route는 그대로(ManagerChrome 링크 유지)", () => {
    const chrome = read("app/components/ManagerChrome.tsx");
    expect(chrome).toContain('href="/"');
    expect(chrome).toContain('replaceTabNavigation(e, "/")');
  });
});

describe("long-press 회귀 방지 — 이번 작업에서 전역 pointer/touch CSS를 건드리지 않는다", () => {
  it("탭 UI user-select none / 입력창 text 복원 / pressed scale / touch-action 그대로", () => {
    expect(css).toMatch(/\.list-row \{\s*-webkit-touch-callout: none;\s*-webkit-user-select: none;\s*user-select: none;/);
    expect(css).toMatch(/input, textarea, select, \[contenteditable=""\], \[contenteditable="true"\] \{\s*-webkit-touch-callout: default;\s*-webkit-user-select: text;\s*user-select: text;/);
    expect(css).toContain("scale: .985");
    expect(css).toMatch(/\.swipe-row-content \{[^}]*touch-action: pan-y/);
    expect(css).not.toMatch(/(^|\n)\s*(\*|html|body)\s*\{[^}]*user-select:\s*none/);
  });
  it("InteractiveGuard도 그대로(네이티브 전용, 대상 판별 후에만)", () => {
    const g = read("app/components/InteractiveGuard.tsx");
    expect(g).toContain("if (!Capacitor.isNativePlatform()) return;");
    expect(g).toContain("if (isInteractiveTarget(e.target)) e.preventDefault();");
  });
});
