/*
  릴리스 폴리시 배치 8차(2026-09-17) — Root Navigation 정책 회귀 방지.
  isRootNavPath()는 회원 5탭/관리자 4탭/운영자 1탭에서만 true여야 하고(그 화면들에서
  edge-swipe/Android back이 차단됨), 그 아래 상세 경로에서는 반드시 false여야 한다(상세
  화면 back이 깨지면 안 됨 — 4-4).
*/
import { describe, expect, it } from "vitest";
import { isRootNavPath } from "../../lib/navState";

describe("isRootNavPath", () => {
  it("회원 root 5개는 true", () => {
    for (const p of ["/", "/reservation", "/my-reservations", "/notifications", "/mypage"]) {
      expect(isRootNavPath(p)).toBe(true);
    }
  });

  it("관리자 root 4개는 true", () => {
    for (const p of ["/manager", "/manager/classes", "/manager/members", "/manager/notifications"]) {
      expect(isRootNavPath(p)).toBe(true);
    }
  });

  it("운영자 root(운영 홈) 1개는 true", () => {
    expect(isRootNavPath("/admin")).toBe(true);
  });

  it("상세 경로(root의 하위)는 false — 정상 back이 깨지면 안 됨", () => {
    for (const p of [
      "/manager/members/123",
      "/manager/classes/456",
      "/manager/notifications/789",
      "/mypage/points",
      "/mypage/calendar",
      "/notifications/abc",
      "/admin/centers",
      "/admin/categories",
    ]) {
      expect(isRootNavPath(p)).toBe(false);
    }
  });

  it("무관한 경로는 false", () => {
    expect(isRootNavPath("/login")).toBe(false);
    expect(isRootNavPath("/search")).toBe(false);
    expect(isRootNavPath("/center/1")).toBe(false);
  });
});
