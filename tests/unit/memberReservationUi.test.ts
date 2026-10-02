/*
  회원 예약 화면(2026-10-01 QA): 목록 룸 표시 / 배지 겹침 / 잔여횟수 stale / 대여상품 RPC.
  - A 룸: lib/reservations.ts가 rooms(name)을 select해 ClassInfo.place로 매핑 → 목록·확인 시트가 같은 값 사용(SQL 불필요).
  - B 겹침: 배지가 제목 줄이 아니라 독립된 wrap 줄(.class-row-tags), 우측 액션 영역은 shrink하지 않음.
  - C stale: passesRefreshKey가 두 조회 효과 deps에 있고 예약/취소 성공 후 증가.
  - D goods: reserveWithGoods가 reserve_with_goods RPC를 호출, 미적용 환경 폴백/명확한 오류.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const page = stripComments(read("app/reservation/page.tsx"));
const lib = stripComments(read("lib/reservations.ts"));
const css = read("app/globals.css");

describe("[A] 예약 목록 룸 즉시 표시 — 데이터 경로", () => {
  it("수업 조회가 rooms(name)을 select하고 ClassInfo.place로 매핑한다(추가 SQL/조회 없음)", () => {
    expect(lib).toContain("room_id, centers(id, name, categories), rooms(name)");
    expect(lib).toContain('place: roomNameFromEmbed((c as any).rooms)');   // 객체/배열 임베드 모두 처리(roomNameFromEmbed 테스트)
  });

  it("목록 카드와 예약 확인 시트가 같은 cls.place / confirmClass.place를 쓴다(다른 fallback 없음)", () => {
    expect(page).toContain("classListMetaText(center?.name, instructorText, cls.place)");   // 카드 meta 한 줄에 룸 포함
    expect(page).toContain("confirmClassSubText(confirmClass.place, confirmClass.date, confirmClass.start)");   // 시트도 같은 place
  });

  it("룸이 없으면 룸 줄 자체를 그리지 않는다(빈 점/undefined/null 노출 없음)", () => {
    expect(page).not.toMatch(/\{cls\.place \?\? /);
    expect(page).toContain("return meta ? <div className=\"class-row-place\">{meta}</div> : null;");   // meta가 비면 줄 자체를 그리지 않음
  });

  it("상세주소는 목록에 노출하지 않는다", () => {
    expect(lib).not.toMatch(/detail_address/);
  });
});

describe("[A] classListMetaText — 첫 meta line은 '센터명 · 담당 강사'", () => {
  it("둘 다 있으면 ' · '로 연결", async () => {
    const { classListMetaText } = await import("../../lib/reservations");
    expect(classListMetaText("A10TION 피겨팀", "손지윤")).toBe("A10TION 피겨팀 · 손지윤");
  });
  it("강사가 없거나 비면 구분자/undefined/null 없이 센터명만", async () => {
    const { classListMetaText } = await import("../../lib/reservations");
    expect(classListMetaText("센터", "")).toBe("센터");
    expect(classListMetaText("센터", null)).toBe("센터");
    expect(classListMetaText(undefined, "강사")).toBe("강사");
    expect(classListMetaText(undefined, undefined)).toBe("");
    for (const v of [classListMetaText("센터", undefined), classListMetaText(null, "강사")]) {
      expect(v).not.toMatch(/undefined|null|^ ·| ·$/);
    }
  });
});

describe("[B] 배지 겹침 방지 — CSS/구조 계약", () => {
  it("제목 줄에는 수업명만 있고 배지는 독립된 .class-row-tags 줄에 있다", () => {
    const title = page.slice(page.indexOf('className="class-row-title"'), page.indexOf('className="class-row-tags"'));
    expect(title).toContain("class-row-title-text");
    expect(title).not.toContain("booked-tag");
    const tags = page.slice(page.indexOf('className="class-row-tags"'), page.indexOf('className="class-row-place"'));
    expect(tags).toContain("프라이빗");
    expect(tags).toContain("내 예약");
    expect(tags).toContain("대기중");
  });

  it("배지 줄은 wrap, 제목/정보 영역은 min-width:0 + overflow-wrap, 우측 액션은 shrink하지 않는다", () => {
    expect(css).toMatch(/\.class-row-tags \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.class-row-title-text \{[^}]*overflow-wrap: anywhere/);
    expect(css).toMatch(/\.member-reservation \.class-info \{[^}]*min-width: 0/);
    expect(css).toMatch(/\.class-right \{[^}]*flex: 0 0 auto/);
  });

  it("긴 룸 이름은 2줄에서 자르고, 예약 버튼 터치영역(44px)은 줄이지 않는다", () => {
    expect(css).toMatch(/\.member-reservation \.class-row-room \{[^}]*-webkit-line-clamp: 2/);
    expect(css).toMatch(/\.member-reservation \.mini-btn \{[^}]*min-height: 44px/);
  });

  it("320~360px 전용 규칙이 있다(시간 열 축소, 액션 영역 유지)", () => {
    expect(css).toMatch(/@media \(max-width: 360px\) \{\s*\.member-reservation \.class-row \{ gap: 10px; \}/);
  });
});

describe("[C] 예약/취소 직후 잔여횟수를 다시 조회한다", () => {
  it("passesRefreshKey가 수강권·상품 조회 효과 deps에 들어있다", () => {
    expect(page).toContain("}, [classIdsForSelectedDay, activeProfileId, passesRefreshKey]);");
    expect(page).toContain("}, [centerIdsForSelectedDay, activeProfileId, passesRefreshKey]);");
  });

  it("예약 성공/취소 성공 후 키를 증가시킨다(클라이언트에서 임의로 차감하지 않음)", () => {
    expect((page.match(/setPassesRefreshKey\(\(k\) => k \+ 1\)/g) ?? []).length).toBe(2);
    expect(page).not.toMatch(/remainingCount\s*-\s*1|remainingCount\s*\+\s*1|remainingCount--/);
  });
});

describe("[D] reserveWithGoods — 수강권 지정 + 대여상품", () => {
  let rpcArgs: { name: string; args: any }[];
  let rpcError: { code: string; message: string } | null;
  beforeEach(() => {
    vi.resetModules();
    rpcArgs = [];
    rpcError = null;
    vi.doMock("../../lib/supabaseClient", () => ({
      supabase: {
        rpc: (name: string, args: any) => {
          rpcArgs.push({ name, args });
          if (name === "reserve_with_goods" && rpcError) return Promise.resolve({ data: null, error: rpcError });
          return Promise.resolve({ data: { status: "confirmed", reservation_id: "r1", goods_status: "deducted" }, error: null });
        },
      },
    }));
  });

  it("수강권 + 상품: reserve_with_goods에 네 인자를 모두 전달한다", async () => {
    const { reserveWithGoods } = await import("../../lib/reservations");
    await expect(reserveWithGoods("c1", "p1", "m1", "g1")).resolves.toBe("confirmed");
    expect(rpcArgs).toEqual([{ name: "reserve_with_goods", args: {
      p_class_id: "c1", p_profile_id: "p1", p_membership_id: "m1", p_goods_membership_id: "g1" } }]);
  });

  it("대기예약 상태를 그대로 반환한다", async () => {
    vi.doMock("../../lib/supabaseClient", () => ({
      supabase: { rpc: () => Promise.resolve({ data: { status: "waitlisted" }, error: null }) },
    }));
    const { reserveWithGoods } = await import("../../lib/reservations");
    await expect(reserveWithGoods("c1", "p1", null, "g1")).resolves.toBe("waitlisted");
  });

  it("함수 미적용(PGRST202) + 수강권 미지정: 기존 reserve_class_with_goods로 폴백", async () => {
    rpcError = { code: "PGRST202", message: "not found" };
    const { reserveWithGoods } = await import("../../lib/reservations");
    await reserveWithGoods("c1", "p1", null, "g1");
    expect(rpcArgs.map((c) => c.name)).toEqual(["reserve_with_goods", "reserve_class_with_goods"]);
  });

  it("함수 미적용 + 수강권 지정 + 상품: 상품을 조용히 버리지 않고 명확한 오류(예약 RPC 미호출)", async () => {
    rpcError = { code: "42883", message: "function does not exist" };
    const { reserveWithGoods } = await import("../../lib/reservations");
    await expect(reserveWithGoods("c1", "p1", "m1", "g1")).rejects.toThrow(/대여상품/);
    expect(rpcArgs.map((c) => c.name)).toEqual(["reserve_with_goods"]);
  });

  it("그 외 서버 오류는 메시지를 그대로 전달", async () => {
    rpcError = { code: "P0001", message: "ERROR: 남은 횟수가 없는 상품이에요" };
    const { reserveWithGoods } = await import("../../lib/reservations");
    await expect(reserveWithGoods("c1", "p1", "m1", "g1")).rejects.toThrow("남은 횟수가 없는 상품이에요");
  });

  it("doReserve: 상품을 고르면 항상 reserveWithGoods, 아니면 기존 경로 유지", () => {
    const body = page.slice(page.indexOf("async function doReserve"), page.indexOf("async function handleCancel"));
    expect(body).toContain("selectedGoodsId");
    expect(body).toContain("reserveWithGoods(cls.id, activeProfileId ?? null, passPick, selectedGoodsId)");
    expect(body).toContain("reserveWithMembership(cls.id, activeProfileId!, passPick)");
    expect(body).toContain("reserveClass(cls.id, activeProfileId)");
  });
});
