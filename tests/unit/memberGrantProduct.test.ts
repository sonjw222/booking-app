/*
  관리자 회원 상세 "수강권 지급 / 상품 지급"(2026-10-01) — 순수 로직, 클라이언트 RPC 호출, SQL 계약, 화면 구조.
  DB가 없는 환경이라 SQL은 주석 제거한 소스 텍스트로 확인한다(이 프로젝트 관례).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const fromMock = vi.fn();
const chain: any = {};
for (const m of ["select", "eq", "neq", "order", "single", "insert", "delete", "in"]) chain[m] = vi.fn(() => chain);
let chainResult: any = { data: [], error: null };
chain.then = (res: any) => res(chainResult);
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (...a: unknown[]) => { fromMock(...a); return chain; } },
}));

import {
  filterGrantProducts, grantBlockReason, grantSheetTitle, holdingLabel, productNeedsSize, suggestGrantSize,
  type GrantableProduct,
} from "../../lib/memberGrant";
import { grantProductToMember, fetchGrantableProducts } from "../../lib/sales";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");

const shoes: GrantableProduct = { id: "g1", name: "피겨화 대여 4회", price: 0, kind: "goods", sizes: ["230", "235", "240", "245"], weekdaySelectable: false, timeSelectable: false, onSale: true };
const pass: GrantableProduct = { id: "p1", name: "성인 정규 4회", price: 100000, kind: "pass", sizes: [], weekdaySelectable: false, timeSelectable: false, onSale: true };
const thursday: GrantableProduct = { ...pass, id: "p2", name: "목요일 전용", weekdaySelectable: true, timeSelectable: true };

describe("[2][3] 시트 목록 분리", () => {
  it("상품 지급 시트에는 goods만, 수강권 지급 시트에는 goods가 없다", () => {
    const all = [shoes, pass, thursday];
    expect(filterGrantProducts(all, "goods").map((p) => p.id)).toEqual(["g1"]);
    expect(filterGrantProducts(all, "pass").map((p) => p.id)).toEqual(["p1", "p2"]);
  });
  it("서버 쿼리도 kind별로 나뉜다: goods=활성 goods(판매중지 포함), pass=판매중 non-goods", async () => {
    fromMock.mockClear(); Object.values(chain).forEach((f: any) => f.mockClear?.());
    chainResult = { data: [], error: null };
    await fetchGrantableProducts("c1", "goods");
    expect(chain.eq).toHaveBeenCalledWith("product_kind", "goods");
    expect(chain.eq).not.toHaveBeenCalledWith("is_on_sale", true);
    expect(chain.eq).toHaveBeenCalledWith("is_active", true);
    Object.values(chain).forEach((f: any) => f.mockClear?.());
    await fetchGrantableProducts("c1", "pass");
    expect(chain.neq).toHaveBeenCalledWith("product_kind", "goods");
    expect(chain.eq).toHaveBeenCalledWith("is_on_sale", true);
  });
  it("시트 제목: '{회원명}님에게 상품 지급' / '수강권 지급'", () => {
    expect(grantSheetTitle("강연우", "goods")).toBe("강연우님에게 상품 지급");
    expect(grantSheetTitle("강연우", "pass")).toBe("강연우님에게 수강권 지급");
  });
});

describe("[3-B][5] 사이즈", () => {
  const base = { price: "0", scheduleDay: null, scheduleTime: null };
  it("사이즈가 있는 상품은 선택 전 지급 차단, 선택하면 통과", () => {
    expect(productNeedsSize(shoes)).toBe(true);
    expect(grantBlockReason({ ...base, product: shoes, selectedSize: null })).toBe("사이즈를 선택해주세요");
    expect(grantBlockReason({ ...base, product: shoes, selectedSize: "240" })).toBeNull();
  });
  it("사이즈가 없는 상품은 사이즈를 요구하지 않는다", () => {
    expect(grantBlockReason({ ...base, product: { ...shoes, sizes: [] }, selectedSize: null })).toBeNull();
  });
  it("프로필 shoe_size가 상품 sizes 중 하나면 기본 선택으로 제안(240mm → 240), 없으면 제안 안 함", () => {
    expect(suggestGrantSize(shoes, "240")).toBe("240");
    expect(suggestGrantSize(shoes, "240mm")).toBe("240");
    expect(suggestGrantSize(shoes, "250")).toBeNull();
    expect(suggestGrantSize(shoes, null)).toBeNull();
  });
  it("수강권 지급: 요일/시간 선택 UX는 그대로(요일 선택형은 요일·시간 없으면 차단, goods에는 적용 안 함)", () => {
    expect(grantBlockReason({ product: thursday, price: "100", selectedSize: null, scheduleDay: null, scheduleTime: null })).toBe("이용 요일을 선택해주세요");
    expect(grantBlockReason({ product: thursday, price: "100", selectedSize: null, scheduleDay: 4, scheduleTime: null })).toBe("이용 시간을 선택해주세요");
    expect(grantBlockReason({ product: thursday, price: "100", selectedSize: null, scheduleDay: 4, scheduleTime: "21:00" })).toBeNull();
    expect(grantBlockReason({ product: { ...shoes, weekdaySelectable: true }, price: "0", selectedSize: "240", scheduleDay: null, scheduleTime: null })).toBeNull();
  });
  it("가격 입력 검증", () => {
    expect(grantBlockReason({ ...base, product: pass, price: "", selectedSize: null })).toBe("가격을 숫자로 입력해주세요");
    expect(grantBlockReason({ ...base, product: pass, price: "-1", selectedSize: null })).toBe("가격을 숫자로 입력해주세요");
    expect(grantBlockReason({ ...base, product: undefined, selectedSize: null })).toBe("지급할 상품을 선택해주세요");
  });
});

describe("[4][8] 지급 호출/결과 표시", () => {
  beforeEach(() => { rpcMock.mockReset(); fromMock.mockClear(); });
  const input = { centerId: "c1", profileId: "pr1", productId: "g1", productName: "피겨화 대여 4회", price: 0, payMethod: "service" as const, paidAt: "2026-10-01T00:00:00Z", selectedSize: "240" };
  it("서버 원자 RPC로 지급하고 사이즈/가격/결제방법을 그대로 넘긴다(클라이언트가 insert/delete하지 않음)", async () => {
    rpcMock.mockResolvedValueOnce({ data: { membership_id: "m1" }, error: null });
    await grantProductToMember(input);
    expect(rpcMock).toHaveBeenCalledWith("manager_grant_product", expect.objectContaining({
      p_center_id: "c1", p_profile_id: "pr1", p_product_id: "g1", p_price: 0, p_pay_method: "service", p_selected_size: "240",
    }));
    expect(fromMock).not.toHaveBeenCalled();
  });
  it("서버 오류(권한/수량/사이즈 등)는 접두사를 떼어 그대로 던지고 레거시 경로로 폴백하지 않는다", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "P0001: 지급 가능한 수량이 없어요(판매 수량이 모두 소진됐어요)" } });
    await expect(grantProductToMember(input)).rejects.toThrow("지급 가능한 수량이 없어요");
    expect(fromMock).not.toHaveBeenCalled();
  });
  it("RPC가 아직 없는 환경(SQL 미적용)에서만 레거시 2단계로 폴백한다", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function public.manager_grant_product" } });
    chainResult = { data: null, error: { message: "stop-legacy" } };
    await expect(grantProductToMember(input)).rejects.toThrow();
    expect(fromMock).toHaveBeenCalledWith("products");
  });
  it("보유 항목 표시: '피겨화 대여 4회 · 3회 남음 · 240mm' (사이즈 없으면 생략, 무제한 표기)", () => {
    expect(holdingLabel({ name: "피겨화 대여 4회", remaining: 3, selectedSize: "240mm" })).toBe("피겨화 대여 4회 · 3회 남음 · 240mm");
    expect(holdingLabel({ name: "장비", remaining: null })).toBe("장비 · 무제한");
  });
});

describe("회원 상세 UX — 수강권/상품 섹션 분리", () => {
  const page = read("app/manager/members/page.tsx");
  it("통합 '수강권/상품 지급' 버튼은 없고 섹션별 + 수강권 지급 / + 상품 지급이 있다", () => {
    expect(page).not.toContain("수강권/상품 지급</button>");
    expect(page).toContain('openGrant(detail, "pass")}>+ 수강권 지급');
    expect(page).toContain('openGrant(detail, "goods")}>+ 상품 지급');
  });
  it("상품이 0개여도 '보유 상품 0' 섹션과 지급 버튼, 빈 상태 문구가 보인다(조건부 렌더 없음)", () => {
    expect(page).toContain("보유 상품 {goods.length}");
    expect(page).toContain("보유 중인 상품이 없어요");
    expect(page).toContain("보유 중인 수강권이 없어요");
    expect(page).not.toContain("{goods.length > 0 && (");
    expect(page).not.toContain("{passes.length > 0 && (");
  });
  it("지급 후 회원 상세가 즉시 새로고침된다", () => {
    expect(page).toContain("if (detail?.id === grantTarget.id) await openDetail(grantTarget)");
  });
  it("직접배치 메뉴(수업 관리)에는 상품 지급이 들어가지 않는다", () => {
    expect(read("app/manager/classes/page.tsx")).not.toContain("manager_grant_product");
    expect(read("app/manager/classes/page.tsx")).not.toContain("openGrant");
  });
  it("0원 지급 안내와 센터 직접 결제 안내(Toss 미실행) 문구", () => {
    expect(page).toContain("무상 지급은 매출 0원으로 기록돼요");
    expect(page).toContain("온라인 결제(Toss)는 실행되지 않아요");
    expect(page).toContain("서비스(무상 지급)");
  });
  it("/manager/goods는 상품 카탈로그 관리 역할 그대로(지급 UI 없음)", () => {
    const goodsPath = "app/manager/goods/page.tsx";
    expect(read(goodsPath)).not.toContain("grantProductToMember");
  });
});

describe("서버 RPC 계약 — add_manager_grant_product_rpc.sql", () => {
  const sql = noComments(read("add_manager_grant_product_rpc.sql"));
  it("권한: issue_pass AND pass.payment.create(또는 플랫폼 관리자), anon 차단", () => {
    expect(sql).toContain("has_permission(p_center_id, 'customer.member.issue_pass') and has_permission(p_center_id, 'pass.payment.create')");
    expect(sql).toContain("is_platform_admin()");
    expect(sql).toContain("from public, anon;");
  });
  it("[12] 다른 센터 회원/상품 지급 불가: center_members 소속 + products.center_id 검증", () => {
    expect(sql).toContain("cm.center_id = p_center_id and cm.profile_id = p_profile_id");
    expect(sql).toContain("where id = p_product_id and center_id = p_center_id");
  });
  it("[4] 상품 정의대로 지급: total/remaining 동일, 무제한이면 null, goods는 unlimited 기준", () => {
    expect(sql).toContain("v_count := case when v_unlimited then null else v_product.total_count end");
    expect(sql).toContain("v_is_goods then coalesce(v_product.unlimited, false)");
    expect(sql).toContain("'count', v_count, v_count, v_expires, v_starts, 'active'");
  });
  it("[4][5] 사이즈: sizes 정의 시 필수 + 목록 안의 값만, memberships.selected_size에 저장(새 컬럼 없음)", () => {
    expect(sql).toContain("raise exception '사이즈를 선택해주세요'");
    expect(sql).toContain("v_size = any(v_product.sizes)");
    expect(sql).toContain("bound_day_of_week, bound_start_time, selected_size");
    expect(sql).not.toMatch(/add column if not exists (?!selected_size)/);
  });
  it("[6][7] 0원=service(매출 0원), 유료=card/cash/transfer, goods는 revenue_category 'etc'", () => {
    expect(sql).toContain("when p_pay_method = 'service' then 'service' else 'new'");
    expect(sql).toContain("case when v_is_goods then 'etc' else 'membership' end");
    expect(sql).toContain("p_price = 0 and p_pay_method <> 'service'");
    expect(sql).not.toContain("payment_provider");   // Toss/PG를 실행하지 않는다
  });
  it("[11] 판매수량: 행 잠금 + 사전 점검(명확한 메시지), memberships 트리거가 동시성 최종 방어", () => {
    expect(sql).toContain("for update;");
    expect(sql).toContain("지급 가능한 수량이 없어요");
    expect(sql).toContain("v_sold >= v_product.max_quantity");
  });
  it("[14] 원자성: memberships와 payments를 한 함수에서 생성(수동 delete 롤백 없음), 자동예약 없음", () => {
    expect(sql).toContain("insert into memberships");
    expect(sql).toContain("insert into payments");
    expect(sql).not.toMatch(/delete from memberships/);
    expect(sql).not.toContain("auto_book");
  });
  it("판매중지 상품도 관리자 지급 허용(is_active만 확인), 지급자는 memo에 기록", () => {
    expect(sql).toContain("not coalesce(v_product.is_active, false)");
    expect(sql).not.toMatch(/is_on_sale/);
    expect(sql).toContain("'[관리자 지급'");
  });
  it("요일/시간 선택형 수강권은 서버에서도 요일(+시간) 필수, goods에는 적용 안 함", () => {
    expect(sql).toContain("if not v_is_goods and coalesce(v_product.weekday_selectable, false) then");
    expect(sql).toContain("이용 요일을 선택해주세요");
    expect(sql).toContain("이용 시간을 선택해주세요");
  });
  it("롤백 파일은 RPC만 제거", () => {
    expect(read("rollback_add_manager_grant_product_rpc.sql")).toContain("drop function if exists manager_grant_product(");
  });
  it("[9][10] 지급된 goods는 기존 예약 SQL로 4→3 차감/취소 시 3→4 복원(같은 selected_size 컬럼 사용)", () => {
    const g = noComments(read("add_reservation_goods_usage.sql"));
    expect(g).toContain("remaining_count = remaining_count - 1");
    expect(g).toContain("remaining_count = remaining_count + 1");
    expect(g).toContain("v_goods.selected_size");
  });
});
