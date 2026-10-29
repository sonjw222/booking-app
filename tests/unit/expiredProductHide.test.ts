/*
  만료 상품 자동 노출 종료(2026-10-31): 고정 만료일(expiry_mode='date')이 KST 오늘보다 이전이면 목록에서 빼고 신규 구매를 막는다.
  서버 규칙은 fix_expired_fixed_date_products_20261031.sql(PGlite 시험: tests/sql/expired-fixed-date-products.test.mjs) — 여기서는 클라이언트 방어선·경계·날짜 롤오버·SQL 파일 계약을 시험한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, computeServicePeriod, describeServicePeriod, isFixedExpiryPassed, kstToday } from "../../lib/servicePeriod";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const T = "2026-10-29";

describe("isFixedExpiryPassed — KST 날짜 경계", () => {
  it("어제는 만료, 오늘·내일은 유지", () => {
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: "2026-10-28" }, T)).toBe(true);
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: "2026-10-29" }, T)).toBe(false);
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: "2026-10-30" }, T)).toBe(false);
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: "2025-01-01" }, T)).toBe(true);
  });
  it("days·rolling_month·none·정보 없음·잘못된 날짜는 만료로 보지 않는다(서버가 최종 판정)", () => {
    for (const src of [{ expiryMode: "days" as const, expiryDays: 30 }, { expiryMode: "rolling_month" as const, rollingMonthCutoffDay: 20 }, { expiryMode: "none" as const }, null, undefined, { expiryMode: "date" as const, expiryDate: null }, { expiryMode: "date" as const, expiryDate: "27/03/31" }]) {
      expect(isFixedExpiryPassed(src, T), JSON.stringify(src)).toBe(false);
    }
  });
  it("날짜 롤오버: 같은 상품이 하루 뒤에는 만료(오늘 만료 → 다음 날 숨김)", () => {
    const src = { expiryMode: "date" as const, expiryDate: T };
    expect(isFixedExpiryPassed(src, T)).toBe(false);
    expect(isFixedExpiryPassed(src, addDays(T, 1))).toBe(true);
  });
  it("기본 today 는 kstToday()", () => {
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: addDays(kstToday(), -1) })).toBe(true);
    expect(isFixedExpiryPassed({ expiryMode: "date", expiryDate: kstToday() })).toBe(false);
  });
});

describe("고객 안내 — 시작일이 종료일보다 늦은 기간을 만들지 않는다", () => {
  it("지난 고정 만료일은 안내 문구가 null(만료 상품은 목록에서 제외되고 안내는 구매 불가 문구)", () => {
    expect(describeServicePeriod(computeServicePeriod({ expiryMode: "date", expiryDate: "2020-01-01" }, T))).toBeNull();
  });
  it("오늘·미래 만료일, 30/60/90일 상품 안내는 그대로", () => {
    expect(describeServicePeriod(computeServicePeriod({ expiryMode: "date", expiryDate: T }, T))!.service).toContain("2026년 10월 29일 ~ 2026년 10월 29일");
    for (const d of [30, 60, 90]) expect(describeServicePeriod(computeServicePeriod({ expiryMode: "days", expiryDays: d }, T))!.service).toContain(`결제일로부터 ${d}일`);
  });
  it("ServicePeriodNotice 는 지난 고정 만료일에 구매 불가 안내만 낸다", () => {
    const src = read("app/components/ServicePeriodNotice.tsx");
    expect(src).toContain("isFixedExpiryPassed(source)"); expect(src).toContain("판매 기간이 지난 상품이라 구매할 수 없어요");
  });
});

describe("lib/center.ts — 목록 방어선(서버 SQL 적용 전/응답 지연 대비)", () => {
  const y = addDays(kstToday(), -1), t = kstToday(), n = addDays(kstToday(), 1);
  const publicRows = ["어제", "오늘", "내일"].map((name, i) => ({ id: `p${i}`, center_id: "c1", center_name: "A", name, price: 1, product_kind: "pass", description: null, total_count: 1, unlimited: false, unlimited_pass: false, group_label: null, remaining: null }));
  const periodRows = [{ product_id: "p0", expiry_mode: "date", expiry_date: y }, { product_id: "p1", expiry_mode: "date", expiry_date: t }, { product_id: "p2", expiry_mode: "date", expiry_date: n }];
  const memberRows = ["어제", "오늘", "내일", "30일"].map((name, i) => ({ id: `m${i}`, name, price: 1, product_kind: "pass", total_count: 1, unlimited: false, description: null, sizes: null, auto_book_days: null, group_label: null, max_quantity: null, coupon_eligible: true,
    expiry_mode: i < 3 ? "date" : "days", expiry_days: i < 3 ? null : 30, expiry_date: [y, t, n, null][i] }));
  let session: unknown;
  beforeEach(() => {
    vi.resetModules(); session = null;
    vi.doMock("../../lib/supabaseClient", () => ({ supabase: {
      auth: { getSession: () => Promise.resolve({ data: { session } }) },
      rpc: (name: string) => {
        if (name === "fetch_public_storefront_products") return Promise.resolve({ data: publicRows, error: null });
        if (name === "fetch_public_storefront_product_periods") return Promise.resolve({ data: periodRows, error: null });
        return { select: () => Promise.resolve({ data: memberRows, error: null }) };
      },
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }),
    } }));
    vi.doMock("../../lib/authAccount", () => ({ getMyAccountId: () => Promise.resolve(null) }));
  });
  it("비로그인 공개 목록: 어제 만료만 제외", async () => {
    const { fetchCenterProducts } = await import("../../lib/center");
    expect((await fetchCenterProducts("c1")).map((p) => p.name)).toEqual(["오늘", "내일"]);
    const { fetchPublicStorefrontProducts } = await import("../../lib/center");   // 원본 공개 목록 함수는 서버 결과를 그대로 돌려준다(필터는 호출 화면이 날짜 롤오버와 함께 적용)
    expect((await fetchPublicStorefrontProducts()).map((p) => p.name)).toEqual(["어제", "오늘", "내일"]);
  });
  it("로그인 구매 목록: 어제 만료만 제외, days 상품 유지", async () => {
    session = { user: { id: "u" } };
    const { fetchCenterProducts, fetchCenterProductsForPurchase } = await import("../../lib/center");
    expect((await fetchCenterProducts("c1")).map((p) => p.name)).toEqual(["오늘", "내일", "30일"]);
    expect((await fetchCenterProductsForPurchase("c1")).map((p) => p.name)).toEqual(["오늘", "내일", "30일"]);
  });
});

describe("페이지·훅·주문 오류 문구 연결", () => {
  it("센터·상품 페이지는 useKstToday 로 날짜 롤오버 시 만료 상품을 다시 걸러낸다", () => {
    for (const f of ["app/center/[id]/page.tsx", "app/products/page.tsx"]) { const s = read(f); expect(s, f).toContain("useKstToday"); expect(s, f).toContain("isFixedExpiryPassed"); }
    const hook = read("lib/useKstToday.ts"); expect(hook).toContain("visibilitychange"); expect(hook).toContain("setTimeout");
  });
  it("관리자 상품 관리(lib/passes.ts)는 만료 필터를 쓰지 않는다(만료 상품 확인·수정 가능)", () => {
    expect(read("lib/passes.ts")).not.toContain("isFixedExpiryPassed"); expect(read("lib/passes.ts")).not.toContain("fixed_expiry_passed");
  });
  it("주문 생성 RLS 거부(42501)는 구매 불가 안내 문구로 바뀐다", () => { expect(read("lib/orders.ts")).toContain("구매할 수 없는 상품이에요"); });
});

describe("SQL 제안 파일 세트 계약", () => {
  const strip = (s: string) => s.replace(/--.*$/gm, "");
  const sql = read("fix_expired_fixed_date_products_20261031.sql");
  it("파일 세트가 모두 있고 변경 SQL 은 한 트랜잭션·해시 가드·적용 후 검증·데이터 불변", () => {
    for (const f of ["preflight_fix_expired_fixed_date_products_20261031.sql", "verify_fix_expired_fixed_date_products_20261031.sql", "rollback_fix_expired_fixed_date_products_20261031.sql"]) expect(read(f).length).toBeGreaterThan(200);
    expect(sql).toMatch(/^begin;/m); expect(sql).toMatch(/^commit;/m); expect(sql).toContain("덮어쓰지 않고 중단합니다"); expect(sql).toContain("트랜잭션 전체를 롤백합니다");
    expect(strip(sql)).not.toMatch(/\bupdate\s+(public\.)?(products|orders|memberships|payments|centers)\b|\bdelete\s+from\b|\btruncate\b|drop table/i);   // 데이터 변경 문장 없음(create_order_secure 본문의 insert into orders 는 기존 함수 로직)
  });
  it("목록 함수 3개는 만료 조건 + NICEPAY 심사 센터 격리 조건을 모두 가진다", () => {
    for (const fn of ["fetch_public_storefront_products", "fetch_public_storefront_product_periods", "fetch_purchasable_products"]) {
      const body = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`)); const end = body.indexOf("$function$;") > 0 ? body.indexOf("$function$;") : body.length;
      const def = body.slice(0, end); expect(def, fn).toContain("not fixed_expiry_passed(p.expiry_mode, p.expiry_date)"); expect(def, fn).toContain("nicepay_review_center_member_allowed");
    }
  });
  it("member_can_purchase_product(결제 확정·발급이 의존)는 바꾸지 않고, 신규 주문 경로(create_order_secure·orders 정책)만 막는다", () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.member_can_purchase_product/i);
    expect(sql).toContain("fixed_expiry_passed(v_product.expiry_mode, v_product.expiry_date)"); expect(sql).toContain('alter policy "주문 본인 생성" on public.orders');
    expect(sql).toContain("product_fixed_expiry_passed(product_id)");
  });
  it("기존 grade·지정 회원 구매 조건 보존(fetch_purchasable_products)", () => {
    expect(sql).toContain("membership_product_grades"); expect(sql).toContain("membership_product_members"); expect(sql).toContain("my_member_center_ids()");
  });
});
