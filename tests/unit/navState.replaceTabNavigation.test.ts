// @vitest-environment jsdom
/*
  릴리스 폴리시 배치 6차(2026-09-15) — 탭/모드 전환은 edge-swipe 뒤로가기로 이전 위치가
  되돌아오면 안 된다는 정책(회귀 방지). 수락 기준(사용자 제공 예시):
    - 마이 → bottom nav "예약" → edge swipe → 마이로 복귀 = FAIL
    - 마이 → "예약 내역" 단축 진입 → 내 예약 tab → edge swipe → 마이로 복귀 = FAIL
    - 마이 → 1:1 문의 → edge swipe → 마이로 복귀 = PASS(정상)
    - 회원모드 → 관리자모드 → edge swipe → 회원모드로 복귀 = FAIL
  replaceTabNavigation()은 일반 클릭(왼쪽 버튼, modifier 없음)만 가로채 location.replace()
  로 이동시키고, 새 탭 열기(Cmd/Ctrl/중클릭)나 이미 preventDefault된 이벤트는 그대로
  기본 동작(=push)에 맡긴다 — 이 두 가지 동작을 모두 고정한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { replaceTabNavigation } from "../../lib/navState";

function makeEvent(overrides: Partial<{ defaultPrevented: boolean; button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("replaceTabNavigation", () => {
  it("일반 좌클릭이면 preventDefault 후 location.replace로 이동한다(히스토리에 새 항목을 안 남김)", () => {
    // jsdom의 window.location.replace는 spyOn으로 직접 재정의가 안 돼(non-configurable)
    // location 객체 자체를 교체 가능한 stub으로 바꿔치기한다.
    const originalLocation = window.location;
    const replaceSpy = vi.fn();
    // @ts-expect-error 테스트 전용 stub
    delete window.location;
    // @ts-expect-error 테스트 전용 stub
    window.location = { ...originalLocation, replace: replaceSpy };

    const e = makeEvent();
    replaceTabNavigation(e, "/manager");

    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(replaceSpy).toHaveBeenCalledWith("/manager");

    // @ts-expect-error 원복
    window.location = originalLocation;
  });

  it("Cmd/Ctrl/Shift/Alt 클릭(새 탭 열기 의도)이면 가로채지 않고 기본 동작(push)에 맡긴다", () => {
    for (const mod of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      const e = makeEvent({ [mod]: true });
      replaceTabNavigation(e, "/manager");
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
  });

  it("왼쪽 버튼이 아닌 클릭(중클릭 등)은 가로채지 않는다", () => {
    const e = makeEvent({ button: 1 });
    replaceTabNavigation(e, "/manager");
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("이미 preventDefault된 이벤트는 다시 처리하지 않는다", () => {
    const e = makeEvent({ defaultPrevented: true });
    replaceTabNavigation(e, "/manager");
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

describe("탭 전환 링크 소스 고정 — 회귀 방지", () => {
  const read = (p: string) => readFileSync(join(__dirname, "../../", p), "utf-8");

  it("BottomNav의 5개 탭 <Link>가 전부 replace prop을 쓴다", () => {
    const source = read("app/components/BottomNav.tsx");
    const linkTags = source.match(/<Link[^>]*href="\/[^"]*"[^>]*>/g) ?? [];
    expect(linkTags.length).toBeGreaterThanOrEqual(5);
    for (const tag of linkTags) expect(tag).toContain("replace");
  });

  it("ManagerNav의 4개 탭 <Link>가 전부 replace prop을 쓴다", () => {
    const source = read("app/components/ManagerNav.tsx");
    const linkTags = source.match(/<Link[^>]*href="\/[^"]*"[^>]*>/g) ?? [];
    expect(linkTags.length).toBeGreaterThanOrEqual(4);
    for (const tag of linkTags) expect(tag).toContain("replace");
  });

  it("마이페이지의 '관리자 모드로 전환'/'예약 내역' 단축 진입이 replaceTabNavigation을 쓴다", () => {
    const source = read("app/mypage/page.tsx");
    expect(source).toContain('href="/manager" onClick={(e) => replaceTabNavigation(e, "/manager")}');
    expect(source).toContain('href="/my-reservations" onClick={(e) => replaceTabNavigation(e, "/my-reservations")}');
  });

  it("관리자 모드의 '회원 모드로 전환'이 replaceTabNavigation을 쓴다", () => {
    const source = read("app/manager/page.tsx");
    expect(source).toContain('href="/" onClick={(e) => replaceTabNavigation(e, "/")}');
  });

  it("1:1 문의(상세 화면) 링크는 replaceTabNavigation을 쓰지 않는다 — 정상적인 push(뒤로가기 허용) 유지", () => {
    const source = read("app/mypage/page.tsx");
    // /mypage에는 1:1 문의로 가는 직접 링크가 없지만(설정 하위), 이 화면 안의 다른
    // "상세 진입" 링크들(프로필 수정, 구매내역, 포인트 내역 등)은 replaceTabNavigation을
    // 쓰면 안 된다 — 오직 관리자모드 전환/예약내역 두 곳만 예외적으로 써야 한다.
    const replaceUsageCount = (source.match(/replaceTabNavigation\(/g) ?? []).length;
    expect(replaceUsageCount).toBe(2); // import 제외하고 호출부만
  });
});
