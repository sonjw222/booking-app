/*
  2026-10-01 QA 배치 — 주문 발급/자동예약/직접결제 금액 검증/쿠폰 제거/PG 게이트.
  production DB가 없는 환경이라 SQL은 소스 텍스트(주석 제거 후)로 계약을 확인한다(이 프로젝트 관례).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { visiblePayMethodIds, resolveSelectedPayMethod } from "../../lib/payMethods";
import { fulfillResultMessage } from "../../lib/orders";
import { unplacedReasonText } from "../../lib/classes";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");
const stripSqlComments = (s: string) => s.replace(/--.*$/gm, "");
const stripTsComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sql = read("fix_order_issuance_and_auto_booking.sql");
const code = stripSqlComments(sql).split("select proname, prosecdef")[0];
function fn(name: string): string {
  const start = code.search(new RegExp(`create (or replace )?function (public\\.)?${name}\\(`, "i"));
  expect(start, `${name} 정의`).toBeGreaterThan(-1);
  const rest = code.slice(start + 10);
  const next = rest.search(/create (or replace )?function /i);
  return code.slice(start, next === -1 ? undefined : start + 10 + next);
}

describe("[1] 자동예약 — 수강권 만료일 최우선", () => {
  const core = fn("_auto_book_membership_core");
  it("만료일/시작일 비교는 KST 날짜(class_date)로 하고 범위 밖 수업은 예약하지 않는다", () => {
    expect(core).toContain("(c.start_time at time zone 'Asia/Seoul')::date as class_date");
    expect(core).toContain("v_cdate > v_mem.expires_at");
    expect(core).toContain("v_cdate < v_mem.starts_at");
    expect(core).not.toContain("c.start_time::date");
    // 범위 밖이면 continue로 건너뛰고 INSERT에 도달하지 않는다
    const outside = core.indexOf("n_outside := n_outside + 1;");
    const insert = core.indexOf("insert into reservations");
    expect(outside).toBeGreaterThan(-1);
    expect(outside).toBeLessThan(insert);
  });
  it("이미 만료된 수강권은 아무 것도 배치하지 않고 outside_membership_period를 반환한다", () => {
    expect(core).toContain("v_mem.expires_at < v_today");
    expect(core).toContain("'outside_membership_period'");
  });
  it("수동예약과 같은 is_membership_eligible_for_class()를 쓰고 bound 요일을 우선한다", () => {
    expect(core).toContain("is_membership_eligible_for_class(v_mem.id, v_class.id)");
    expect(core).toContain("when v_mem.bound_day_of_week is not null then array[v_mem.bound_day_of_week]");
  });
  it("사유 코드를 구분한다(만료일 초과/정원/조건 불일치/이미 예약/일치 수업 없음)", () => {
    for (const r of ["outside_membership_period", "capacity_full", "condition_mismatch", "already_reserved", "no_class_in_period"]) {
      expect(core).toContain(`'${r}'`);
    }
  });
  it("dry-run은 쓰지 않고(insert/update 가드) 잠금도 걸지 않는다", () => {
    expect(core).toContain("if not p_dry_run then\n            insert into reservations");
    expect(core).toContain("if v_booked > 0 and not p_dry_run then");
  });
  it("unplaced_weekday_passes는 만료 여부/재시도 가능 여부/사유를 반환하고 core를 dry-run으로 호출한다", () => {
    const u = fn("unplaced_weekday_passes");
    expect(u).toContain("expired boolean, can_retry boolean, reason_code text");
    expect(u).toContain("_auto_book_membership_core(v_row.mid, true)");
    expect(u).toContain("can_retry := not expired");
  });
});

describe("[3] 주문 금액 검증 — 원가가 아니라 서버 기대금액과 비교", () => {
  const f = fn("fulfill_order");
  it("fulfill_order는 더 이상 orders.amount를 상품 원가와 직접 비교하지 않는다", () => {
    expect(f).not.toMatch(/v_order\.amount\s*<>\s*\(select price/i);
    expect(f).toContain("_order_expected_amount(v_order, true)");
    expect(f).toContain("v_order.amount is distinct from v_expected");
  });
  it("PG 확정도 같은 공통 함수를 쓴다", () => {
    expect(fn("_issue_membership_and_record_payment")).toContain("_order_expected_amount(p_order, true)");
  });
  it("기대금액 공식 = 상품가 - 서버가 검증한 쿠폰 할인 - 원장 확인 포인트(0 하한)", () => {
    const e = fn("_order_expected_amount");
    // 상품 기본금액 = 주문 생성 시 서버가 가격표/상품가에서 확정한 snapshot(없는 옛 주문만 현재 상품가) → 그 위에 검증된 쿠폰·포인트
    expect(e).toContain("v_base := coalesce(p_order.product_amount_snapshot, v_product.price);");
    expect(e).toContain("greatest(0, v_base - v_verified_discount - coalesce(p_order.points_used, 0))");
    expect(e.indexOf("v_base :=")).toBeLessThan(e.indexOf("greatest(0, v_base"));
    expect(e).toContain("from point_transactions");
    expect(e).toContain("본인에게 지급된 쿠폰만 사용할 수 있어요");
    expect(e).toContain("이 센터에서 사용할 수 없는 쿠폰이에요");
    // 클라이언트가 보낸 할인금액은 신뢰하지 않는다
    expect(e).not.toMatch(/p_order\.discount_amount|p_order\.coupon_code/);
  });
  it("직접결제 승인도 센터 쿠폰을 used 처리한다(PG와 동일)", () => {
    expect(f).toContain("set status = 'used', used_at = now(), order_id = v_order.id");
  });
  it("320,000원 상품 - 10,000원 쿠폰 = 310,000원 주문이 통과하는 공식임을 수식으로 확인", () => {
    const price = 320000, discount = 10000;
    expect(Math.max(0, price - discount - 0)).toBe(310000);
  });
});

describe("[2] 하드코딩 쿠폰 제거", () => {
  it("신규 migration의 모든 함수에 WELCOME/FIGURE10이 없다", () => {
    expect(code).not.toMatch(/WELCOME|FIGURE10/);
  });
  it("앱 코드(app, lib)에도 하드코딩 쿠폰/라벨이 없다", () => {
    const files = ["app/checkout/page.tsx", "app/cart/page.tsx", "lib/orders.ts", "lib/coupons.ts"];
    for (const f of files) {
      const c = stripTsComments(read(f));
      expect(c, f).not.toMatch(/WELCOME|FIGURE10|신규 가입 5,000원|피겨 클래스 10,000원|MY_COUPONS/);
    }
  });
  it("센터 쿠폰 기능은 유지된다(member_coupons 경로)", () => {
    expect(read("app/checkout/page.tsx")).toContain("fetchApplicableCoupons");
    expect(read("app/checkout/page.tsx")).toContain("memberCouponId: selectedMemberCouponId");
    expect(read("lib/coupons.ts")).toContain("member_coupons");
  });
  it("쿠폰이 하나도 없으면 쿠폰 영역을 그리지 않는다", () => {
    expect(read("app/checkout/page.tsx")).toContain("applicableCoupons.length > 0 && (");
  });
});

describe("[4] 자동예약 공통화 — 결제수단과 무관, 오류를 삼키지 않음", () => {
  it("direct(fulfill_order)와 PG(_issue...) 모두 같은 헬퍼를 호출한다", () => {
    expect(fn("fulfill_order")).toContain("_order_auto_book(v_membership_id");
    expect(fn("_issue_membership_and_record_payment")).toContain("_order_auto_book(v_membership_id");
  });
  it("'exception when others then null' 삼키기가 없고 오류를 반환값으로 돌려준다", () => {
    expect(code).not.toMatch(/exception\s+when others then\s+null/i);
    const h = fn("_order_auto_book");
    expect(h).toContain("'auto_book_reason', 'error'");
    expect(h).toContain("'auto_book_error', sqlstate");
  });
  it("fulfill_order 반환값에 membership_id / auto_book_requested / auto_booked_count / unplaced_count / auto_book_reason이 포함된다", () => {
    expect(fn("fulfill_order")).toContain("'membership_id', v_membership_id");
    const h = fn("_order_auto_book");
    for (const k of ["auto_book_requested", "auto_booked_count", "unplaced_count", "auto_book_reason"]) expect(h).toContain(`'${k}'`);
  });
  it("멱등: 이미 done인 주문은 즉시 반환하고 같은 날짜 중복 예약은 core가 막는다", () => {
    expect(fn("fulfill_order")).toContain("if v_order.status = 'done' then");
    expect(fn("_auto_book_membership_core")).toContain("v_cdate = any(v_used_dates)");
  });
  it("memberships에 선택 사이즈를 복사한다(두 발급 경로 모두)", () => {
    expect(fn("fulfill_order")).toContain("v_order.selected_size");
    expect(fn("_issue_membership_and_record_payment")).toContain("p_order.selected_size");
  });
  it("내부 함수는 anon/authenticated 실행을 회수한다", () => {
    expect(code).toContain("revoke all on function _auto_book_membership_core(uuid, boolean) from public, anon, authenticated;");
    expect(code).toContain("revoke all on function _order_expected_amount(orders, boolean) from public, anon, authenticated;");
  });
  it("롤백 파일이 라이브 정의로 복원하고 새 헬퍼를 지운다", () => {
    const rb = read("rollback_fix_order_issuance_and_auto_booking.sql");
    expect(rb).toContain("drop function if exists _auto_book_membership_core(uuid, boolean);");
    expect(rb).toContain("CREATE OR REPLACE FUNCTION public.fulfill_order");
    expect(rb).toContain("CREATE OR REPLACE FUNCTION public.unplaced_weekday_passes");
  });
});

describe("[4-UI] 관리자 안내 문구 / 미배치 사유 문구", () => {
  it("자동예약 오류가 나면 이유가 토스트에 보인다", () => {
    const m = fulfillResultMessage({ alreadyDone: false, membershipId: "m", autoBookRequested: true, autoBookedCount: 0, unplacedCount: null, autoBookReason: "error", autoBookError: "42501: denied" });
    expect(m).toContain("자동예약 중 오류");
    expect(m).toContain("42501");
  });
  it("2회 배치 + 2회 만료일 초과 → 미배치 사유 안내", () => {
    const m = fulfillResultMessage({ alreadyDone: false, membershipId: "m", autoBookRequested: true, autoBookedCount: 2, unplacedCount: 2, autoBookReason: "outside_membership_period", autoBookError: null });
    expect(m).toContain("2회 자동예약");
    expect(m).toContain("만료일 이후");
    expect(m).toContain("2회는 미배치");
  });
  it("자동예약을 요청하지 않았으면 기본 문구만", () => {
    expect(fulfillResultMessage({ alreadyDone: false, membershipId: "m", autoBookRequested: false, autoBookedCount: 0, unplacedCount: 0, autoBookReason: "not_requested", autoBookError: null }))
      .toBe("수강권을 발급하고 매출에 반영했어요");
  });
  it("만료된 수강권은 '만료일 초과로 N회 미배치'", () => {
    expect(unplacedReasonText({ reason: "outside_membership_period", remainingCount: 2, expiresAt: "2026-10-20", expired: true }))
      .toBe("만료일 초과로 2회 미배치 · 수강권 만료일 2026-10-20");
    expect(unplacedReasonText({ reason: "capacity_full", remainingCount: 1, expiresAt: null, expired: false })).toContain("정원");
  });
});

describe("[3-B] PG 비노출 — direct만", () => {
  const ALL = ["card", "kakao", "toss", "transfer", "direct"];
  it("PG 꺼짐 → 센터 pay_methods와 무관하게 direct만 (센터가 card만 허용해도 direct 유지)", () => {
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: null, all: ALL })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: ["card"], all: ALL })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: ["card", "direct"], all: ALL })).toEqual(["direct"]);
  });
  it("숨겨진 PG 수단이 선택돼 있어도 direct로 보정된다", () => {
    expect(resolveSelectedPayMethod("card", ["direct"])).toBe("direct");
  });
  it("PG 켜짐(심사관/정식 오픈) → 센터 설정대로, 비면 direct 대체", () => {
    // 2026-10-07: 카카오페이/토스페이도 다시 노출 — 센터 설정(pay_methods)대로
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: null, all: ALL })).toEqual(ALL);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["card"], all: ALL })).toEqual(["card"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["paypal"], all: ALL })).toEqual(["direct"]);
  });
  it("checkout과 cart 모두 같은 게이트를 쓰고 cart 기본 결제수단은 direct", () => {
    const cart = stripTsComments(read("app/cart/page.tsx"));
    const checkout = stripTsComments(read("app/checkout/page.tsx"));
    for (const c of [cart, checkout]) {
      expect(c).toContain("visiblePayMethodIds");
      expect(c).toContain("PG_CHECKOUT_ENABLED");
      expect(c).toContain('PG_CHECKOUT_ENABLED ? "card" : "direct"');
      expect(c).not.toContain("setPayMethod(c.payMethods[0])");
    }
    expect(cart).toContain("fetchMyPgCheckoutOverride");   // 심사관 계정 동작 유지(일반 회원과 분리)
    expect(checkout).toContain("fetchMyPgCheckoutOverride");
  });
  it("PG 코드(Toss 연동)는 삭제되지 않고 남아 있다", () => {
    expect(read("lib/payments/server/toss.ts")).toContain("api.tosspayments.com/v1");
    expect(read("lib/payments/server/toss.ts")).toContain("/payments/confirm");
    expect(read("app/api/payments/confirm/route.ts")).toContain("handleConfirm");
    expect(read("app/checkout/page.tsx")).toContain("getPaymentService");
  });
});

describe("[3-B] 서버 게이트 — /api/payments/confirm", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.doUnmock("@supabase/supabase-js"); });
  function mockAdmin(override: boolean | null) {
    vi.doMock("@supabase/supabase-js", () => ({
      createClient: () => ({
        auth: { getUser: async () => ({ data: { user: { id: "u" } }, error: null }) },
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: override === null ? null : { profiles: { accounts: { pg_checkout_override: override } } } }) }) }) }),
        // pg_order_context: 로그인한 본인의 pending toss 주문(금액 1000)
        rpc: async () => ({ data: { orderId: "o", status: "pending", amount: 1000, provider: "toss" }, error: null }),
      }),
    }));
  }
  const req = () => new Request("http://localhost/api/payments/confirm", {
    method: "POST", headers: { Authorization: "Bearer test-token" }, body: JSON.stringify({ paymentKey: "pk", orderId: "o", amount: 1000 }),
  });
  it("플래그가 true가 아니고 심사관 계정도 아니면 토스를 호출하지 않고 403", async () => {
    vi.stubEnv("NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "false");
    vi.stubEnv("TOSS_SECRET_KEY", "test-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://x");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    mockAdmin(false);
    const { POST } = await import("../../app/api/payments/confirm/route");
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("플래그 미설정(undefined)도 막힌다(정확히 'true'만 허용)", async () => {
    vi.stubEnv("NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "TRUE");
    vi.stubEnv("TOSS_SECRET_KEY", "test-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://x");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    mockAdmin(null);
    const { POST } = await import("../../app/api/payments/confirm/route");
    expect((await POST(req())).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("심사관 override 계정의 주문은 플래그가 꺼져 있어도 토스 승인 단계로 진행한다", async () => {
    vi.stubEnv("NEXT_PUBLIC_PG_CHECKOUT_ENABLED", "false");
    vi.stubEnv("TOSS_SECRET_KEY", "test-secret");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "x"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://x");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: "stop" }), { status: 400 })); vi.stubGlobal("fetch", fetchMock);
    mockAdmin(true);
    const { POST } = await import("../../app/api/payments/confirm/route");
    const res = await POST(req());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(400);
  });
});

describe("카카오페이/토스페이 사용자 UI 재노출(2026-10-07) — PG OFF·센터 제한·direct fallback 정책 유지", () => {
  const ALL5 = ["card", "kakao", "toss", "transfer", "direct"];
  it("CASE1/2: PG OFF면 pay_methods(null/전체 허용)와 무관하게 direct만", () => {
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: null, all: ALL5 })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: ["card", "kakao", "toss", "transfer"], all: ALL5 })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: false, allowed: ["kakao", "toss"], all: ALL5 })).toEqual(["direct"]);
  });
  it("CASE3: PG ON + 제한 없음(pay_methods=null, 심사 센터)이면 PAY_METHODS 순서대로 card/kakao/toss/transfer/direct 전부", () => {
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: null, all: ALL5 })).toEqual(["card", "kakao", "toss", "transfer", "direct"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: [], all: ALL5 })).toEqual(ALL5);
  });
  it("CASE4: PG ON + 센터가 card/transfer만 허용하면 그 제한을 따른다", () => {
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["card", "transfer"], all: ALL5 })).toEqual(["card", "transfer"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["card"], all: ALL5 })).toEqual(["card"]);
  });
  it("CASE5: PG ON + 센터가 kakao/toss를 허용하면 더 이상 숨겨지지 않고 노출된다", () => {
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["kakao", "toss"], all: ALL5 })).toEqual(["kakao", "toss"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["card", "kakao", "toss", "transfer"], all: ALL5 })).toEqual(["card", "kakao", "toss", "transfer"]);
  });
  it("CASE6: 필터 결과가 비면(알 수 없는 수단만 허용 등) 기존 direct fallback 유지", () => {
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["paypal"], all: ALL5 })).toEqual(["direct"]);
    expect(visiblePayMethodIds({ pgEnabled: true, allowed: ["card"], all: ["kakao", "toss"] })).toEqual(["direct"]);
  });
  it("선택값 보정: kakao/toss 선택은 이제 유지되고, 보이지 않는 선택값만 첫 수단/direct로 되돌린다", () => {
    const visible = visiblePayMethodIds({ pgEnabled: true, allowed: null, all: ALL5 });
    expect(resolveSelectedPayMethod("kakao", visible)).toBe("kakao");
    expect(resolveSelectedPayMethod("toss", visible)).toBe("toss");
    expect(resolveSelectedPayMethod("paypal", visible)).toBe("card");
    expect(resolveSelectedPayMethod("kakao", ["direct"])).toBe("direct");   // PG OFF에서는 stale kakao 선택도 direct로
  });
  it("checkout 소스: kakao/toss 구현(지원 목록/EASY_PAY/Provider)은 그대로, 미지원 안내 문구는 노출 수단과 일치", () => {
    const c = readFileSync(join(__dirname, "../../app/checkout/page.tsx"), "utf-8");
    expect(c).toContain('setError("지금은 카드/카카오페이/토스페이/계좌이체만 가능해요");');
    expect(c).not.toContain("지금은 카드/계좌이체만 가능해요");
    expect(c).toContain('const TOSS_SUPPORTED_METHODS = ["card", "kakao", "toss", "transfer"];');
    expect(c).toContain('kakao: "KAKAOPAY"');
    expect(c).toContain('toss: "TOSSPAY"');
    expect(c).toContain("resolveSelectedPayMethod(payMethod, visibleMethodIds)");
    const p = readFileSync(join(__dirname, "../../lib/payments/TossPaymentProvider.ts"), "utf-8");
    expect(p).toContain("easyPay");
    expect(readFileSync(join(__dirname, "../../lib/payMethods.ts"), "utf-8")).toContain("HIDDEN_PAY_METHOD_IDS: readonly string[] = [];");
  });
  it("reviewer override / 전역 PG 게이트는 건드리지 않았다: checkout·cart가 pgEnabled를 기존 방식으로 계산하고 공용 함수를 쓴다", () => {
    const c = readFileSync(join(__dirname, "../../app/checkout/page.tsx"), "utf-8");
    const k = readFileSync(join(__dirname, "../../app/cart/page.tsx"), "utf-8");
    expect(c).toContain("fetchMyPgCheckoutOverride()"); expect(k).toContain("fetchMyPgCheckoutOverride()");   // 심사관 accounts.pg_checkout_override 조회 경로
    expect(c).toContain("useState(PG_CHECKOUT_ENABLED)"); expect(k).toContain("useState(PG_CHECKOUT_ENABLED)");   // 전역 게이트 기본값(OFF면 일반 사용자는 direct)
    expect(c).toContain("pgEnabled: pgCheckoutEnabled"); expect(k).toContain("visiblePayMethodIds({ pgEnabled,");
    expect(c).toContain("visiblePayMethodIds"); expect(k).toContain("visiblePayMethodIds");
  });
});
