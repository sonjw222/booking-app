/*
  실기기 QA(2026-09-25) — SwipeRow 재설계 회귀 방지.
  - 방향별 action: 오른쪽→왼쪽(x<0) = 삭제(rightAction), 왼쪽→오른쪽(x>0) = 고정/고정 해제(leftAction)
  - partial release는 절대 중간에 멈추지 않는다(0 또는 ±width)
  - threshold / gain / flick 판정
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applySwipeGain, clampSwipeX, resolveSwipeRelease,
  SWIPE_INTENT_PX, SWIPE_GAIN_MAX, SWIPE_OPEN_THRESHOLD_PX,
} from "../../app/components/SwipeRow";

const L = 88, R = 88;
const rel = (x: number, velocity = 0, base = 0, lw = L, rw = R) => resolveSwipeRelease({ x, velocity, base, leftWidth: lw, rightWidth: rw });

describe("SwipeRow — gain", () => {
  it("7px 미만(의도 미확정)은 1.0배 — 튀지 않는다", () => {
    expect(applySwipeGain(SWIPE_INTENT_PX)).toBeCloseTo(SWIPE_INTENT_PX, 5);
    expect(applySwipeGain(-5)).toBeCloseTo(-5, 5);
  });
  it("의도 확정 후 손가락보다 빠르게 따라오되(1.0 < gain ≤ 1.4) 방향 부호를 유지한다", () => {
    const x = applySwipeGain(20);
    expect(x).toBeGreaterThan(20);
    expect(x / 20).toBeLessThanOrEqual(SWIPE_GAIN_MAX);
    expect(applySwipeGain(-20)).toBeCloseTo(-x, 5);
  });
  it("멀리 끌어도 배율은 최대 1.4배", () => {
    expect(applySwipeGain(100) / 100).toBeCloseTo(SWIPE_GAIN_MAX, 5);
  });
  it("손가락 15~25px 의도 swipe는 열림 임계값 근처까지 반응한다", () => {
    expect(applySwipeGain(20)).toBeGreaterThanOrEqual(SWIPE_OPEN_THRESHOLD_PX);
  });
});

describe("SwipeRow — release 결정", () => {
  it("R→L threshold 통과 → 삭제(오른쪽 action) 폭까지 snap", () => {
    expect(rel(-40)).toBe(-R);
  });
  it("L→R threshold 통과 → 고정/고정 해제(왼쪽 action) 폭까지 snap", () => {
    expect(rel(40)).toBe(L);
  });
  it("partial(threshold 미만) release → 항상 closed(0), 빈 공간에 멈추지 않는다", () => {
    for (const x of [-23, -15, -8, 8, 15, 23]) expect(rel(x)).toBe(0);
  });
  it("release 결과는 항상 {0, +L, -R} 중 하나 — 중간 위치 없음", () => {
    for (let x = -120; x <= 120; x += 3) {
      for (const v of [-1, -0.4, 0, 0.4, 1]) expect([0, L, -R]).toContain(rel(x, v));
    }
  });
  it("빠른 flick은 임계값 미만이어도 방향대로 열린다(최소 이동 12px)", () => {
    expect(rel(-14, -0.6)).toBe(-R);
    expect(rel(14, 0.6)).toBe(L);
    expect(rel(-4, -0.9)).toBe(0); // 너무 짧으면 무시
  });
  it("action이 없는 방향으로는 절대 열리지 않는다", () => {
    expect(rel(60, 0, 0, 0, R)).toBe(0); // leftAction 없음
    expect(rel(-60, 0, 0, L, 0)).toBe(0); // rightAction 없음
  });
  it("열린 상태(삭제) — 조금만 되돌려도 닫히고, 거의 안 움직이면 유지", () => {
    expect(rel(-R + 22, 0, -R)).toBe(0);
    expect(rel(-R + 6, 0, -R)).toBe(-R);
  });
  it("열린 상태(고정) — 왼쪽으로 조금만 되돌려도 닫히고, 거의 안 움직이면 유지", () => {
    expect(rel(L - 22, 0, L)).toBe(0);
    expect(rel(L - 6, 0, L)).toBe(L);
  });
});

describe("SwipeRow — clamp", () => {
  it("열려 있는 쪽의 반대 방향(action 없는 쪽)으로는 넘어가지 않는다", () => {
    expect(clampSwipeX(30, L, R, -R)).toBeLessThanOrEqual(0);
    expect(clampSwipeX(-30, L, R, L)).toBeGreaterThanOrEqual(0);
  });
  it("action 폭을 넘는 구간은 고무줄(최대 24px)로만 늘어난다", () => {
    expect(clampSwipeX(500, L, R, 0)).toBeLessThanOrEqual(L + 24);
    expect(clampSwipeX(-500, L, R, 0)).toBeGreaterThanOrEqual(-R - 24);
  });
  it("action이 없는 쪽은 거의 움직이지 않는다", () => {
    expect(clampSwipeX(80, 0, R, 0)).toBeLessThanOrEqual(6);
  });
});

describe("알림 화면 — 방향별 action 배치(회원/관리자 공통)", () => {
  for (const [name, path] of [["회원", "app/notifications/page.tsx"], ["관리자", "app/manager/notifications/page.tsx"]] as const) {
    const src = readFileSync(join(__dirname, "../..", path), "utf-8");
    it(`${name}: leftAction=고정/고정 해제, rightAction=삭제 — 한 쪽에 둘이 같이 나오지 않는다`, () => {
      const left = src.slice(src.indexOf("leftAction={"), src.indexOf("rightAction={"));
      const right = src.slice(src.indexOf("rightAction={"), src.indexOf("rightAction={") + 700);
      expect(left).toContain('n.pinned ? "고정 해제" : "고정"');
      expect(left).toContain("handleTogglePin(n)");
      expect(left).not.toContain("handleDelete");
      expect(right).toContain("handleDelete(n.id)");
      expect(right).not.toContain("handleTogglePin");
    });
    it(`${name}: 삭제/고정은 버튼 onClick에서만 실행된다(swipe 자체는 실행하지 않음)`, () => {
      expect(src).not.toMatch(/onSwipe|onFullSwipe/);
    });
  }
});
