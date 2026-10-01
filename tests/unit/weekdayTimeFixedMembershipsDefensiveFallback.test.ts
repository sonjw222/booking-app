/*
  add_weekday_time_fixed_memberships.sql이 아직 production에 적용되지 않은 환경에서도
  기존 화면(수업/체크아웃/상품관리/매출)이 42703(컬럼 없음) 에러로 깨지지 않는지 실제
  호출로 검증한다(lib/rooms.ts에서 이미 검증된 패턴과 동일한 원칙). Supabase 클라이언트를
  체이닝 가능한 목(mock)으로 구성해 "새 컬럼 select 시 42703 → 컬럼 없이 재시도 → 성공"
  흐름을 재현한다.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";

function makeChain(finalResult: any) {
  // supabase-js 쿼리빌더는 체이닝 가능하면서(.select().eq()...) 그 자체로 await 가능한
  // thenable이다 — 실제 Promise 위에 체이닝 메서드(전부 자기 자신을 반환)만 얹어 흉내낸다.
  const chain: any = Object.assign(Promise.resolve(finalResult), {});
  for (const m of ["select", "eq", "order", "in"]) chain[m] = vi.fn(() => chain);
  return chain;
}

const MISSING_COLUMN = { code: "42703", message: 'column "weekday_selectable" does not exist' };

describe("lib/passes.ts fetchProducts — 42703 방어", () => {
  let fromMock: any;
  beforeEach(() => { vi.resetModules(); });

  it("새 컬럼 select가 42703이면 컬럼 없이 재시도해서 목록을 정상 반환한다", async () => {
    const rows = [{ id: "p1", name: "10회권", price: 100000, pass_type: "count", total_count: 10, is_on_sale: true, product_kind: "pass", unlimited: false, unlimited_pass: false, expiry_mode: "none", expiry_days: null, expiry_date: null, rolling_month_cutoff_day: null, rolling_month_allow_early_use: false, description: null, sizes: null, auto_book_days: null, group_label: null, max_quantity: null, visibility_type: "all", coupon_eligible: true }];
    let callCount = 0;
    fromMock = vi.fn((table: string) => {
      if (table === "products") {
        callCount++;
        return makeChain(callCount === 1 ? { data: null, error: MISSING_COLUMN } : { data: rows, error: null });
      }
      return makeChain({ data: [], error: null });
    });
    vi.doMock("../../lib/supabaseClient", () => ({ supabase: { from: fromMock } }));
    const { fetchProducts } = await import("../../lib/passes");
    const result = await fetchProducts("center-1");
    expect(result).toHaveLength(1);
    expect(result[0].weekdaySelectable).toBe(false); // 컬럼이 없어 안전한 기본값으로
    expect(result[0].timeSelectable).toBe(false);
    expect(callCount).toBe(2); // 1차 실패 + 2차 재시도
  });
});

describe("lib/orders.ts createOrder — 42703 방어(주문 생성 자체는 막히지 않음)", () => {
  beforeEach(() => { vi.resetModules(); });

  it("selected_day_of_week 컬럼이 없어도(42703) 나머지 필드만으로 주문을 생성한다", async () => {
    let insertedRows: any[] = [];
    const insertMock = vi.fn((row: any) => {
      insertedRows.push(row);
      const isFirstAttempt = insertedRows.length === 1;
      return {
        select: () => ({
          single: () => isFirstAttempt
            ? Promise.resolve({ data: null, error: MISSING_COLUMN })
            : Promise.resolve({ data: { id: "order-1" }, error: null }),
        }),
      };
    });
    vi.doMock("../../lib/supabaseClient", () => ({
      supabase: {
        from: (table: string) => {
          if (table === "orders") return { insert: insertMock };
          if (table === "profiles") return { select: () => ({ eq: () => ({ is: () => ({ order: () => ({ order: () => ({ limit: () => Promise.resolve({ data: [{ id: "profile-1", is_primary: true, created_at: "2026-01-01" }] }) }) }) }) }) }) };
          return {};
        },
      },
    }));
    vi.doMock("../../lib/authAccount", () => ({ getMyAccountId: () => Promise.resolve("account-1") }));
    const { createOrder } = await import("../../lib/orders");
    const orderId = await createOrder({
      centerId: "center-1", productId: "p1", productName: "10회권", amount: 100000,
      selectedDayOfWeek: 1, selectedStartTime: "16:00",
    });
    expect(orderId).toBe("order-1");
    expect(insertedRows).toHaveLength(2);
    expect(insertedRows[0]).toHaveProperty("selected_day_of_week", 1); // 1차 시도엔 있었음
    expect(insertedRows[1]).not.toHaveProperty("selected_day_of_week"); // 재시도는 빼고 감
  });
});
