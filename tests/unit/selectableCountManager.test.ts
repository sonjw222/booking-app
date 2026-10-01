/*
  2026-10-01 — 구매 횟수 선택형(회차별 가격표) 관리자 측: 가격표 검증/자동 채우기, 목록 표기, 상품·수강권 저장(RPC/실패 정리/미적용 환경),
  회원 상세 지급(횟수 옵션/기본 가격/RPC 인자), 화면 연결(가격 방식 토글·편집기·검색/필터·"+ 수강권" 항상 노출), 고정 상품 회귀.
  순수 함수/모킹 호출은 실제 실행하고, 화면 구조는 소스 계약으로 확인한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
let insertResult: any = { data: { id: "p-new" }, error: null };
let deleteResult: any = { error: null };
const chain: any = {};
for (const m of ["select", "eq", "neq", "order", "in"]) chain[m] = vi.fn(() => chain);
chain.insert = (...a: unknown[]) => { insertMock(...a); return chain; };
chain.update = (...a: unknown[]) => { updateMock(...a); return chain; };
chain.delete = (...a: unknown[]) => { deleteMock(...a); return { eq: () => Promise.resolve(deleteResult) }; };
chain.single = () => Promise.resolve(insertResult);
chain.then = (res: any) => res(insertResult);
vi.mock("../../lib/supabaseClient", () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => chain },
}));

import { validateGoodsForm, goodsListLabel, nextUnlimitedForMode, draftsFromTiers, fillDraftsFromUnit } from "../../lib/goodsForm";
import { fillTiersFromUnit, draftsToTiers, validateTierDrafts, priceSummary, countOptionLabel } from "../../lib/selectableCount";
import { saveProductCountPrices, createProduct, updateProduct } from "../../lib/passes";
import { defaultGrantPrice, grantBlockReason, grantCountOptions, type GrantableProduct } from "../../lib/memberGrant";
import { grantProductToMember } from "../../lib/sales";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

const shoeTiers = [{ count: 1, price: 6000 }, { count: 6, price: 34000 }, { count: 12, price: 65000 }];
const passTiers = [{ count: 1, price: 80000 }, { count: 4, price: 300000 }, { count: 12, price: 640000 }];
const selectableGoods: GrantableProduct = { id: "g1", name: "피겨화 대여", price: 6000, kind: "goods", sizes: ["230", "240"], weekdaySelectable: false, timeSelectable: false, onSale: true, countSelectable: true, countPrices: shoeTiers };
const selectablePass: GrantableProduct = { id: "p1", name: "10월 스케줄링 수강권", price: 80000, kind: "pass", sizes: [], weekdaySelectable: false, timeSelectable: false, onSale: true, countSelectable: true, countPrices: passTiers };
const fixed: GrantableProduct = { id: "g2", name: "헬멧 대여권", price: 20000, kind: "goods", sizes: [], weekdaySelectable: false, timeSelectable: false, onSale: true };

describe("가격표 검증/자동 채우기 (관리자 폼)", () => {
  it("1~12회 자동 채우기: 기준 6,000원 → 6,000·12,000…72,000, 모든 행 체크", () => {
    const rows = fillDraftsFromUnit(6000, draftsFromTiers([]));
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({ count: 1, price: "6000", enabled: true });
    expect(rows[11]).toEqual({ count: 12, price: "72000", enabled: true });
    expect(fillTiersFromUnit(0)).toEqual([]);
  });
  it("자동 채우기 후 행별 수정이 저장 값(authoritative): 6회 36,000 → 34,000, 12회 65,000", () => {
    const rows = fillDraftsFromUnit(6000, draftsFromTiers([]));
    rows[5].price = "34000"; rows[11].price = "65000";
    const tiers = draftsToTiers(rows);
    expect(tiers.find((t) => t.count === 6)!.price).toBe(34000);
    expect(tiers.find((t) => t.count === 12)!.price).toBe(65000);
    expect(tiers.find((t) => t.count === 5)!.price).toBe(30000);
  });
  it("체크 해제한 회차는 저장되지 않는다(판매 안 함) — 1·6·12회만 판매 가능", () => {
    const rows = draftsFromTiers(shoeTiers);
    expect(rows.filter((r) => r.enabled).map((r) => r.count)).toEqual([1, 6, 12]);
    expect(draftsToTiers(rows)).toEqual(shoeTiers);
  });
  it("저장된 가격표가 12회를 넘으면 그 회차까지 행이 늘어난다(20회 등 확장)", () => {
    expect(draftsFromTiers([{ count: 20, price: 100000 }])).toHaveLength(20);
  });
  it("검증: 행 0개/가격 0/중복 거부, 정상 통과 + 무제한 동시 불가", () => {
    expect(validateTierDrafts([])).toBe("판매할 횟수와 가격을 1개 이상 입력해주세요");
    expect(validateTierDrafts([{ count: 1, price: "", enabled: true }])).toContain("0원보다 크게");
    expect(validateTierDrafts([{ count: 1, price: "100", enabled: true }, { count: 1, price: "200", enabled: true }])).toBe("같은 횟수를 두 번 등록할 수 없어요");
    expect(validateTierDrafts(draftsFromTiers(shoeTiers))).toBeNull();
    const base = { mode: "selectable" as const, unlimited: false, price: 0, totalCount: 0, tiers: draftsFromTiers(passTiers) };
    expect(validateGoodsForm(base)).toBeNull();
    expect(validateGoodsForm({ ...base, unlimited: true })).toContain("무제한");
    expect(validateGoodsForm({ ...base, tiers: [] })).toBe("판매할 횟수와 가격을 1개 이상 입력해주세요");
  });
  it("고정 상품 기존 검증 유지(무제한이 아니면 횟수 필수)", () => {
    expect(validateGoodsForm({ mode: "fixed", unlimited: false, price: 24000, totalCount: 0 })).toBe("횟수를 입력해주세요");
    expect(validateGoodsForm({ mode: "fixed", unlimited: false, price: 24000, totalCount: 4 })).toBeNull();
    expect(validateGoodsForm({ mode: "fixed", unlimited: true, price: 24000, totalCount: 0 })).toBeNull();
    expect(nextUnlimitedForMode("selectable", true)).toBe(false);
    expect(nextUnlimitedForMode("fixed", true)).toBe(true);
  });
});

describe("목록 표기", () => {
  it("선택형 goods/pass: '1~12회 선택 · N원부터', 가격표 없으면 '가격표 미설정'", () => {
    expect(goodsListLabel({ price: 6000, unlimited: false, totalCount: null, countSelectable: true, countPrices: shoeTiers })).toBe("1~12회 선택 · 6,000원부터");
    expect(goodsListLabel({ price: 80000, unlimited: false, totalCount: null, countSelectable: true, countPrices: passTiers })).toBe("1~12회 선택 · 80,000원부터");
    expect(goodsListLabel({ price: 6000, unlimited: false, totalCount: null, countSelectable: true, countPrices: [] })).toBe("가격표 미설정");
  });
  it("고정 상품 표기 회귀 없음", () => {
    expect(goodsListLabel({ price: 24000, unlimited: false, totalCount: 4, countSelectable: false, countPrices: [] })).toBe("24,000원 · 4회");
    expect(goodsListLabel({ price: 20000, unlimited: true, totalCount: null, countSelectable: false, countPrices: [] })).toBe("20,000원 · 무제한");
    expect(priceSummary({ price: 24000, countSelectable: false, totalCount: 4 })).toBe("4회 · 24,000원");
  });
  it("드롭다운 옵션 라벨 '4회 · 300,000원'", () => expect(countOptionLabel({ count: 4, price: 300000 })).toBe("4회 · 300,000원"));
});

describe("가격표 저장 (lib/passes)", () => {
  beforeEach(() => { rpcMock.mockReset(); insertMock.mockClear(); updateMock.mockClear(); deleteMock.mockClear(); insertResult = { data: { id: "p-new" }, error: null }; deleteResult = { error: null }; });
  it("saveProductCountPrices는 set_product_count_prices RPC에 {count, price} 배열을 보낸다(null이면 빈 배열=고정 복귀)", async () => {
    rpcMock.mockResolvedValue({ error: null });
    await saveProductCountPrices("p1", shoeTiers);
    expect(rpcMock).toHaveBeenCalledWith("set_product_count_prices", { p_product_id: "p1", p_tiers: shoeTiers });
    await saveProductCountPrices("p1", null);
    expect(rpcMock).toHaveBeenLastCalledWith("set_product_count_prices", { p_product_id: "p1", p_tiers: [] });
  });
  it("RPC가 없는 환경(SQL 미적용)은 조용히 고정 상품으로 저장하지 않고 안내 오류", async () => {
    rpcMock.mockResolvedValue({ error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(saveProductCountPrices("p1", shoeTiers)).rejects.toThrow("add_selectable_count_pricing.sql");
  });
  it("선택형 상품 생성: 상품 insert는 최저가·총 횟수 없음·무제한 아님으로 만들고 가격표 RPC로 전환", async () => {
    rpcMock.mockResolvedValue({ error: null });
    const id = await createProduct("c1", "피겨화 대여", 0, 0, "goods", true, { countSelectable: true, countPrices: shoeTiers });
    expect(id).toBe("p-new");
    const row = insertMock.mock.calls[0][0];
    expect(row.price).toBe(6000);
    expect(row.total_count).toBeNull();
    expect(row.unlimited).toBe(false);
    expect(row).not.toHaveProperty("min_purchase_count");
    expect(rpcMock).toHaveBeenCalledWith("set_product_count_prices", { p_product_id: "p-new", p_tiers: shoeTiers });
  });
  it("수강권(pass)도 같은 경로: 80,000원부터, 가격표 저장", async () => {
    rpcMock.mockResolvedValue({ error: null });
    await createProduct("c1", "10월 스케줄링 수강권", 0, 0, "pass", false, { countSelectable: true, countPrices: passTiers, groupLabel: "자유이용", weekdaySelectable: true });
    const row = insertMock.mock.calls[0][0];
    expect(row.product_kind).toBe("pass");
    expect(row.price).toBe(80000);
    expect(row.group_label).toBe("자유이용");           // 기존 설정은 그대로
    expect(row.weekday_selectable).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });
  it("가격표 저장이 실패하면 방금 만든 상품을 삭제(정리)하고 오류를 던진다 — 가격표 없는 상품이 남아 팔리지 않음", async () => {
    rpcMock.mockResolvedValue({ error: { code: "P0001", message: "P0001: 같은 횟수를 두 번 등록할 수 없어요" } });
    await expect(createProduct("c1", "x", 0, 0, "goods", false, { countSelectable: true, countPrices: shoeTiers })).rejects.toThrow("같은 횟수");
    expect(deleteMock).toHaveBeenCalled();
  });
  it("선택형 + 가격표 없음 → 서버 호출 전에 거부", async () => {
    await expect(createProduct("c1", "x", 0, 0, "goods", false, { countSelectable: true, countPrices: [] })).rejects.toThrow("1개 이상");
    expect(insertMock).not.toHaveBeenCalled();
  });
  it("[고정 회귀] 선택형 옵션 없이 만들면 RPC를 호출하지 않고 기존 price/total_count 그대로", async () => {
    await createProduct("c1", "헬멧 대여권", 20000, 5, "goods", false);
    const row = insertMock.mock.calls[0][0];
    expect(row.price).toBe(20000);
    expect(row.total_count).toBe(5);
    expect(rpcMock).not.toHaveBeenCalled();
  });
  it("수정: 선택형이면 가격표 저장, 선택형→고정 복귀 시에만 가격표 해제, 옵션 미지정이면 RPC 없음", async () => {
    rpcMock.mockResolvedValue({ error: null });
    insertResult = { error: null };
    await updateProduct("p1", "n", 0, 0, false, { countSelectable: true, countPrices: passTiers });
    expect(updateMock.mock.calls[0][0].price).toBe(80000);
    expect(rpcMock).toHaveBeenLastCalledWith("set_product_count_prices", { p_product_id: "p1", p_tiers: passTiers });
    rpcMock.mockClear();
    await updateProduct("p1", "n", 20000, 5, false, { countSelectable: false, wasCountSelectable: true });
    expect(rpcMock).toHaveBeenCalledWith("set_product_count_prices", { p_product_id: "p1", p_tiers: [] });
    rpcMock.mockClear();
    await updateProduct("p1", "n", 20000, 5, false, { countSelectable: false, wasCountSelectable: false });
    await updateProduct("p1", "n", 20000, 5, false);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});

describe("관리자 직접 지급 — 가격표 사용 (pass/goods 공통)", () => {
  beforeEach(() => { rpcMock.mockReset(); });
  it("지급 횟수 후보 = 가격표에 등록된 회차만, 고정 상품은 없음", () => {
    expect(grantCountOptions(selectableGoods)).toEqual([1, 6, 12]);
    expect(grantCountOptions(selectablePass)).toEqual([1, 4, 12]);
    expect(grantCountOptions(fixed)).toEqual([]);
  });
  it("가격 기본값 = 해당 회차 tier 가격(unit×count 아님), 고정은 상품가, 없는 회차는 null", () => {
    expect(defaultGrantPrice(selectableGoods, 6)).toBe(34000);
    expect(defaultGrantPrice(selectablePass, 4)).toBe(300000);
    expect(defaultGrantPrice(selectableGoods, 5)).toBeNull();
    expect(defaultGrantPrice(fixed, null)).toBe(20000);
  });
  it("횟수 미선택/가격표에 없는 횟수는 차단, 사이즈와 횟수 모두 요구(goods)", () => {
    const base = { price: "34000", scheduleDay: null, scheduleTime: null };
    expect(grantBlockReason({ ...base, product: selectableGoods, selectedSize: "240", selectedCount: null })).toBe("지급할 횟수를 선택해주세요");
    expect(grantBlockReason({ ...base, product: selectableGoods, selectedSize: "240", selectedCount: 5 })).toBe("지급할 횟수를 선택해주세요");
    expect(grantBlockReason({ ...base, product: selectableGoods, selectedSize: null, selectedCount: 6 })).toBe("사이즈를 선택해주세요");
    expect(grantBlockReason({ ...base, product: selectableGoods, selectedSize: "240", selectedCount: 6 })).toBeNull();
    expect(grantBlockReason({ ...base, product: selectablePass, selectedSize: null, selectedCount: 4 })).toBeNull();
  });
  it("0원 지급(서비스)도 횟수는 그대로 전달, 선택형은 p_selected_count를 RPC로 보낸다", async () => {
    rpcMock.mockResolvedValue({ data: { membership_id: "m1" }, error: null });
    await grantProductToMember({ centerId: "c1", profileId: "pr1", productId: "g1", productName: "피겨화 대여", price: 0, payMethod: "service", paidAt: "2026-10-01T00:00:00Z", selectedSize: "240", selectedCount: 6 });
    expect(rpcMock).toHaveBeenCalledWith("manager_grant_product", expect.objectContaining({ p_selected_count: 6, p_selected_size: "240", p_price: 0, p_pay_method: "service" }));
  });
  it("고정 상품은 selectedCount를 보내지 않는다(null)", async () => {
    rpcMock.mockResolvedValue({ data: {}, error: null });
    await grantProductToMember({ centerId: "c1", profileId: "pr1", productId: "g2", productName: "헬멧", price: 20000, payMethod: "cash", paidAt: "2026-10-01T00:00:00Z" });
    expect(rpcMock.mock.calls[0][1].p_selected_count).toBeNull();
  });
  it("RPC가 없는 환경에서 선택형 지급은 레거시 경로로 폴백하지 않고 오류", async () => {
    rpcMock.mockResolvedValue({ error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(grantProductToMember({ centerId: "c1", profileId: "pr1", productId: "g1", productName: "x", price: 100, payMethod: "cash", paidAt: "2026-10-01T00:00:00Z", selectedCount: 6 })).rejects.toThrow("적용 후 지급");
  });
});

describe("화면 연결 (소스 계약)", () => {
  const goods = read("app/manager/goods/page.tsx");
  const rules = read("app/manager/membership-rules/page.tsx");
  const members = read("app/manager/members/page.tsx");
  it("goods/수강권 두 화면 모두 가격 방식 토글 + 회차별 가격 편집기 + 저장 시 가격표 검증", () => {
    for (const src of [goods, rules]) {
      expect(src).toContain("구매자가 횟수 선택");
      expect(src).toContain("<CountPriceEditor");
      expect(src).toContain("draftsToTiers(pTiers)");
      expect(src).toContain("validateGoodsForm(");
    }
    expect(goods).toContain("고정 횟수 상품");
    expect(rules).toContain("고정 횟수/고정 가격");
  });
  it("편집기: 기준 1회 가격 + 기본 가격 채우기 + 회차 체크/가격 입력 + 안내문구", () => {
    const ed = read("app/components/CountPriceEditor.tsx");
    expect(ed).toContain("기본 가격 채우기");
    expect(ed).toContain("기준 1회 가격");
    expect(ed).toContain('type="checkbox"');
    expect(ed).toContain("가격이 등록된 횟수 중에서 고릅니다");
  });
  it("선택형 모드에서는 총 횟수/무제한 입력을 숨긴다(고정 모드에서만 렌더)", () => {
    expect(goods).toMatch(/pMode === "fixed" \? \(\s*<>[\s\S]*총 횟수[\s\S]*\) : \(\s*<CountPriceEditor/);
    expect(rules).toMatch(/pMode === "fixed" \? \(\s*<>[\s\S]*총 횟수[\s\S]*\) : \(\s*<CountPriceEditor/);
  });
  it("수강권 설정의 기존 설정(그룹/요일·시간 선택/공개범위/쿠폰/예약조건/복제)은 그대로", () => {
    for (const k of ["pGroupLabel", "pWeekdaySelectable", "pTimeSelectable", "pVisType", "pCouponEligible", "openDuplicateSheet", "예약조건 추가", "fetchRules"]) expect(rules).toContain(k);
  });
  it("복제/수정 프리필에 가격표가 포함된다(복제본은 새 상품)", () => {
    expect(rules).toContain("setPTiers(draftsFromTiers(p.countPrices))");
    expect(rules).toContain("setEditWasSelectable(false); // 복제본");
  });
  it("수강권 설정 검색/필터: 수강권 검색 + 동적 group chip(종류 chip 없음) + 초기화, state가 load()와 독립", () => {
    expect(rules).toContain('placeholder="수강권 검색"');
    expect(rules).toContain("uniqueGroupLabels(products)");
    expect(rules).toContain("filterCatalog(products, { ...EMPTY_CATALOG_FILTER, group: groupFilter, query })");
    expect(rules).not.toMatch(/kind=\{/);   // 종류 chip 미사용
    expect(rules).toContain("필터 초기화");
    const load = rules.slice(rules.indexOf("const load = useCallback"), rules.indexOf("useEffect(() => { load(); }, [load]);"));
    expect(load).not.toContain("setQuery");
    expect(load).not.toContain("setGroupFilter");
  });
  it('"+ 수강권" 버튼은 검색/필터와 무관하게 항상 노출(헤더)', () => {
    const at = rules.lastIndexOf('<div className="title">수강권 설정</div>');   // 메인 헤더(센터 없음 early-return 헤더가 아님)
    const header = rules.slice(at, at + 420);
    expect(header).toContain("+ 수강권");
    expect(header).not.toContain("query");
  });
  it("상품 관리는 이름/설명 검색만(종류 chip 없음), 목록 순서 유지", () => {
    expect(goods).toContain('placeholder="상품 검색"');
    expect(goods).toContain("filterCatalog(");
    expect(goods).not.toMatch(/kind=\{/);
  });
  it("회원 상세 지급 시트: 횟수 옵션 라벨은 '4회 · 300,000원', 가격 기본값은 tier 가격(관리자가 바꾼 값은 유지)", () => {
    expect(members).toContain("countOptionLabel({ count: n, price: tierPriceFor(sel!, n) ?? 0 })");
    expect(members).toContain("Number(grantPrice) === dpPrev");
  });
  it("SQL 계약: 서버 RPC/가격표 테이블/주문 snapshot은 add_selectable_count_pricing.sql에 있다(unit price 컬럼 없음)", () => {
    const sql = read("add_selectable_count_pricing.sql").replace(/--.*$/gm, "");
    expect(sql).toContain("create table if not exists product_count_prices");
    expect(sql).toContain("create or replace function set_product_count_prices");
    expect(sql).not.toMatch(/min_purchase_count|max_purchase_count|unit_price/);
  });
});
