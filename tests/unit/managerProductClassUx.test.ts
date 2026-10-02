/*
  관리자/수업/회원 예약 UX 배치(2026-10-02) — A 다중 삭제 / B 요일 선택형 구매 / C 반복 수업 수강권 전체 적용 / D 예약 카드 룸 / E 담당 강사 순서.
  DB 없이 순수 함수 + 가짜 supabase + 소스/SQL 계약으로 검증한다(실제 DB 동작은 SQL 적용 후 확인).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");

// ---- 가짜 supabase(체인 기록)
const calls: { table: string; op: string; payload?: unknown; filters: Record<string, unknown> }[] = [];
let updateResult: { data: { id: string }[] | null; error: { message: string } | null } = { data: [], error: null };
let trainerResult: { data: unknown[] | null; error: { code?: string; message: string } | null } = { data: [], error: null };
const trainerCalls: string[] = [];
const trainerQueue: { data: unknown[] | null; error: { code?: string; message: string } | null }[] = [];
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      const rec = { table, op: "", payload: undefined as unknown, filters: {} as Record<string, unknown> };
      const chain: any = {
        update(p: unknown) { rec.op = "update"; rec.payload = p; return chain; },
        select() { if (table === "class_trainers") return chain; return chain; },
        eq(k: string, v: unknown) { rec.filters[k] = v; return chain; },
        in(k: string, v: unknown) { rec.filters[k] = v; return chain; },
        order(col: string) { trainerCalls.push(col); return chain; },
        then(res: any) { calls.push(rec); return Promise.resolve(table === "class_trainers" ? (trainerQueue.shift() ?? trainerResult) : updateResult).then(res); },
      };
      return chain;
    },
  },
}));

import { bulkDeleteConfirmMessage, bulkDeleteToast, effectiveSelection, selectAllVisible, toggleSelected } from "../../lib/bulkSelect";
import { deleteProducts } from "../../lib/passes";
import { purchaseScheduleState } from "../../lib/purchaseSchedule";
import { buildGroupUpdates, fetchClassTrainers, passPolicyChanged, type GroupUpdateRow } from "../../lib/classes";
import { appendTrainerNames, formatInstructorNames, toggleTrainerSelection, trainerPreviewItems, TRAINER_PREVIEW_EMPTY } from "../../lib/instructorDisplay";
import { classListMetaText, confirmClassSubText, roomNameFromEmbed } from "../../lib/reservations";

beforeEach(() => { calls.length = 0; trainerCalls.length = 0; trainerQueue.length = 0; updateResult = { data: [], error: null }; trainerResult = { data: [], error: null }; });

/* ============================== A. 다중 삭제 ============================== */
describe("[A] 상품/수강권 다중 선택 삭제", () => {
  const ids = ["p1", "p2", "p3"];
  it("3개 중 2개 선택 → 그 2개만 is_active=false(소프트 삭제, 같은 센터 한정, 하나의 UPDATE)", async () => {
    updateResult = { data: [{ id: "p1" }, { id: "p3" }], error: null };
    const n = await deleteProducts("c1", ["p1", "p3"]);
    expect(n).toBe(2);
    expect(calls).toHaveLength(1);   // 한 문장 = 원자적
    expect(calls[0]).toMatchObject({ table: "products", op: "update", payload: { is_active: false }, filters: { center_id: "c1", id: ["p1", "p3"] } });
    expect(JSON.stringify(calls[0].filters)).not.toContain("p2");
  });
  it("수강권/상품 동일 함수 사용, 중복 id는 한 번만, 선택 0개면 아무 요청도 하지 않는다", async () => {
    updateResult = { data: [{ id: "p1" }], error: null };
    expect(await deleteProducts("c1", ["p1", "p1"])).toBe(1);
    calls.length = 0;
    expect(await deleteProducts("c1", [])).toBe(0);
    expect(calls).toHaveLength(0);
  });
  it("권한 없는 직원: RLS가 0행을 돌려주면 성공으로 보이지 않고 오류(새 우회 없음 — 단건 삭제와 같은 products UPDATE RLS)", async () => {
    updateResult = { data: [], error: null };
    await expect(deleteProducts("c1", ids)).rejects.toThrow(/권한이 없거나/);
  });
  it("일부만 처리된 응답이면 오류로 알린다(애매한 부분 성공 UI 금지)", async () => {
    updateResult = { data: [{ id: "p1" }], error: null };
    await expect(deleteProducts("c1", ids)).rejects.toThrow(/모두 삭제하지 못했어요/);
  });
  it("전체 선택 / 전체 해제 / 개수 / 필터로 숨겨진 항목은 선택에서 제외", () => {
    let sel = toggleSelected(new Set(), "p1");
    sel = toggleSelected(sel, "p2");
    expect(effectiveSelection(sel, ids)).toEqual(["p1", "p2"]);
    expect(toggleSelected(sel, "p1").has("p1")).toBe(false);
    expect([...selectAllVisible(ids)]).toEqual(ids);
    expect(effectiveSelection(selectAllVisible(ids), ["p1"])).toEqual(["p1"]);   // 검색으로 p2,p3가 숨겨지면 삭제 대상에서 빠진다
    expect(effectiveSelection(new Set(), ids)).toEqual([]);
    expect(bulkDeleteConfirmMessage(2)).toBe("선택한 2개 항목을 삭제할까요?");
    expect(bulkDeleteToast(2)).toBe("2개 삭제했어요");
  });
  for (const [label, file, canKey, deleteSym] of [
    ["상품 관리", "app/manager/goods/page.tsx", "canEditProduct", "handleDelete(p)"],
    ["수강권 관리", "app/manager/membership-rules/page.tsx", "canEditRules", "handleDeleteProduct(p)"],
  ] as const) {
    it(`${label}: 선택 모드 UI(권한 조건, 확인 후 삭제, 취소 시 무변경, 성공 후 초기화/새로고침/토스트) + 단건 삭제 유지`, () => {
      const page = read(file);
      expect(page).toContain(`{${canKey} && (\n            <BulkSelectBar`);
      expect(page).toContain("if (!(await globalThis.appConfirm(bulkDeleteConfirmMessage(selectedIds.length)))) return;");
      const handler = page.slice(page.indexOf("async function handleBulkDelete"), page.indexOf("async function handleBulkDelete") + 700);
      expect(handler.indexOf("appConfirm")).toBeLessThan(handler.indexOf("deleteProducts("));   // 확인 전에는 삭제하지 않는다
      expect(handler).toContain("exitSelect();");
      expect(handler).toContain("showToast(bulkDeleteToast(n));");
      expect(handler).toContain("await load();");
      expect(page).toContain(deleteSym);   // 개별 삭제 버튼 유지
      expect(page).toContain('type="checkbox"');
    });
  }
  it("BulkSelectBar: 평상시엔 '선택' 버튼만, 선택 모드에서 개수/전체 선택·해제/선택 삭제(0개면 비활성)/취소", () => {
    const bar = read("app/components/BulkSelectBar.tsx");
    expect(bar).toContain(">선택</button>");
    expect(bar).toContain("{selectedCount}개 선택");
    expect(bar).toContain('allSelected ? "전체 해제" : "전체 선택"');
    expect(bar).toContain("disabled={busy || selectedCount === 0} onClick={onDelete}>선택 삭제");
  });
  it("모바일: 체크 행은 카드 내용 위 독립 행(겹침 없음), 버튼 wrap", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.bulk-bar \{[^}]*flex-wrap:wrap/);
    expect(css).toMatch(/\.bulk-check-row \{[^}]*min-height:44px/);
  });
  it("lib: 하드 DELETE 없음(소프트 삭제만)", () => {
    const f = read("lib/passes.ts");
    const fn = f.slice(f.indexOf("export async function deleteProducts"), f.indexOf("export async function toggleProductSale"));
    expect(fn).not.toContain(".delete()");
    expect(fn).toContain("is_active: false");
  });
});

/* ============================== B. 요일 선택형 구매 ============================== */
describe("[B] 요일/시간 선택형 수강권 구매", () => {
  const wd = { kind: "pass", weekdaySelectable: true, timeSelectable: false };
  const wdt = { kind: "pass", weekdaySelectable: true, timeSelectable: true };
  const monWed = { days: [1, 3], timesByDay: { 1: ["16:00", "20:00"], 3: ["16:00"] } };
  it("월/수 선택 가능: 선택 전 차단 → 요일만 선택하면 통과(day-only)", () => {
    expect(purchaseScheduleState(wd, monWed, false, null, null)).toMatchObject({ required: true, blocked: true, reason: "pick_day", message: "이용할 요일을 선택해 주세요." });
    expect(purchaseScheduleState(wd, monWed, false, 3, null)).toMatchObject({ blocked: false, reason: "ok" });
  });
  it("월요일만 가능한 상품도 요일 선택 UI가 필요(후보 1개)", () => {
    const monOnly = { days: [1], timesByDay: { 1: ["20:00"] } };
    expect(purchaseScheduleState(wd, monOnly, false, null, null).blocked).toBe(true);
    expect(purchaseScheduleState(wd, monOnly, false, 1, null).blocked).toBe(false);
  });
  it("요일+시간 선택형: 요일 → 시간 둘 다 골라야 통과, 시간 후보가 없는 요일은 구매 차단", () => {
    expect(purchaseScheduleState(wdt, monWed, false, 1, null)).toMatchObject({ blocked: true, reason: "pick_time", message: "이용할 시간을 선택해 주세요." });
    expect(purchaseScheduleState(wdt, monWed, false, 1, "20:00").blocked).toBe(false);
    expect(purchaseScheduleState(wdt, { days: [2], timesByDay: { 2: [] } }, false, 2, null)).toMatchObject({ blocked: true, reason: "no_times" });
  });
  it("후보 0개 → 조용히 숨기지 않고 명확한 안내 + 차단, 조회 실패도 '후보 없음'과 구분해 차단, 로딩 중도 차단", () => {
    const none = purchaseScheduleState(wd, { days: [], timesByDay: {} }, false, null, null);
    expect(none).toMatchObject({ blocked: true, reason: "no_options" });
    expect(none.message).toContain("센터에 문의");
    expect(purchaseScheduleState(wd, null, true, null, null)).toMatchObject({ blocked: true, reason: "load_failed" });
    expect(purchaseScheduleState(wd, null, false, null, null)).toMatchObject({ blocked: true, reason: "loading" });
  });
  it("일반 수강권/대여상품은 기존과 동일(선택 불필요)", () => {
    expect(purchaseScheduleState({ kind: "pass", weekdaySelectable: false, timeSelectable: false }, null, false, null, null)).toEqual({ required: false, blocked: false, message: null });
    expect(purchaseScheduleState({ kind: "goods", weekdaySelectable: true, timeSelectable: true }, null, false, null, null).required).toBe(false);
    expect(purchaseScheduleState(null, null, false, null, null).required).toBe(false);
  });
  it("checkout: 판정은 direct/PG 분기보다 먼저(handlePay 앞부분), 공개 목록 모델은 결제 차단, 구매용 상품 조회는 공개 대체를 쓰지 않는다", () => {
    const c = read("app/checkout/page.tsx");
    const fn = c.slice(c.indexOf("async function handlePay()"));
    expect(fn.indexOf("scheduleState.blocked")).toBeGreaterThan(-1);
    expect(fn.indexOf("scheduleState.blocked")).toBeLessThan(fn.indexOf('effectivePayMethod === "direct"'));
    expect(fn.indexOf("product.publicFallback")).toBeLessThan(fn.indexOf("scheduleState.blocked"));
    expect(c).toContain("fetchCenterProductsForPurchase(centerId)");
    expect(c).toContain("setScheduleOptionsFailed(true)");
    expect(c).toContain('["loading", "load_failed", "no_options", "no_times"].includes(scheduleState.reason)');
    expect(c.match(/selectedDayOfWeek: product\.weekdaySelectable \? selectedScheduleDay : undefined,/g)).toHaveLength(2);   // direct + PG 둘 다 주문에 전달
    const center = read("lib/center.ts");
    expect(center).toContain("publicFallback: true");
    const strict = center.slice(center.indexOf("export async function fetchCenterProductsForPurchase"), center.indexOf("async function fetchMemberCenterProducts"));
    expect(strict).not.toMatch(/42501/);   // 만료 토큰으로 공개 모델에 조용히 떨어지지 않는다
  });
  it("관리자 수강권 카드: 요일 선택형인데 요일 예약조건이 없으면 경고 배지", () => {
    expect(read("app/manager/membership-rules/page.tsx")).toContain("요일 선택형 · 예약조건 필요");
  });
  it("SQL: 주문 INSERT 시 요일/시간 선택을 서버가 강제(저장된 상품 설정이 source of truth)", () => {
    const sql = noComments(read("fix_manager_product_class_ux_20261002.sql"));
    const t = sql.slice(sql.indexOf("create or replace function orders_require_schedule_selection"), sql.indexOf("revoke all on function orders_require_schedule_selection"));
    for (const x of ["coalesce(weekday_selectable, false)", "v_kind = 'goods'", "if new.selected_day_of_week is null then", "r.day_of_week = new.selected_day_of_week",
      "if v_time then", "new.selected_start_time is null", "r.start_time = new.selected_start_time", "security definer", "set search_path = public"]) expect(t).toContain(x);
    expect(sql).toContain("before insert on orders");
  });
});

/* ============================== C. 반복 수업 수강권 전체 적용 ============================== */
type Cls = { id: string; center: string; group: string | null; mode: "all" | "selected"; products: string[]; start: string; end: string; title: string };
const mk = (id: string, mode: "all" | "selected", products: string[], group = "g1", dayHour = "11"): Cls =>
  ({ id, center: "c1", group, mode, products, title: "A", start: `2026-10-${id.padStart(2, "0")}T${dayHour}:00:00.000Z`, end: `2026-10-${id.padStart(2, "0")}T12:00:00.000Z` });
// SQL update_class_group_safe의 수강권 처리 규칙을 옮긴 모델(키가 있는 행만, 같은 group/center, 검증 후 한 번에 교체)
function rpcModel(all: Cls[], groupId: string, updates: GroupUpdateRow[], centerProducts: string[] = ["P1", "P2", "P3"]): string[] {
  for (const u of updates) {
    if ("pass_selection_mode" in u) {
      if (u.pass_selection_mode === "selected") {
        if (!u.allowed_product_ids || u.allowed_product_ids.length === 0) throw new Error("예약 가능 수강권을 1개 이상 선택해주세요");
        if (u.allowed_product_ids.some((p) => !centerProducts.includes(p))) throw new Error("이 센터의 수강권만 선택할 수 있어요");
      }
    }
  }
  const ids: string[] = [];
  for (const u of updates) {
    const c = all.find((x) => x.id === u.id);
    if (!c || c.group !== groupId) continue;
    c.start = u.start_time; c.end = u.end_time;
    if ("pass_selection_mode" in u) {
      c.mode = u.pass_selection_mode!;
      c.products = u.pass_selection_mode === "selected" ? [...new Set(u.allowed_product_ids)] : [];
    }
    ids.push(c.id);
  }
  return ids;
}
const rows = (g: Cls[]) => g.map((c) => ({ id: c.id, start_time: c.start, end_time: c.end }));

describe("[C] 반복 수업: 변경한 예약 가능 수강권을 그룹 전체에 적용", () => {
  it("passPolicyChanged: 집합 비교(순서/중복 무시), all끼리는 항상 동일, 모드 변경은 변경", () => {
    expect(passPolicyChanged({ mode: "selected", productIds: ["P1", "P2"] }, { mode: "selected", productIds: ["P2", "P1", "P1"] })).toBe(false);
    expect(passPolicyChanged({ mode: "selected", productIds: ["P1"] }, { mode: "selected", productIds: ["P2", "P3"] })).toBe(true);
    expect(passPolicyChanged({ mode: "selected", productIds: ["P1"] }, { mode: "selected", productIds: ["P1", "P2"] })).toBe(true);
    expect(passPolicyChanged({ mode: "all", productIds: [] }, { mode: "all", productIds: [] })).toBe(false);
    expect(passPolicyChanged({ mode: "selected", productIds: ["P1"] }, { mode: "all", productIds: [] })).toBe(true);
    expect(passPolicyChanged({ mode: "all", productIds: [] }, { mode: "selected", productIds: ["P1"] })).toBe(true);
  });
  it("selected → 다른 selected: A/B/C/D 모두 [P2,P3](각자 달랐던 기존 설정 덮어씀)", () => {
    const g = [mk("5", "selected", ["P1"]), mk("7", "selected", ["P1", "P3"]), mk("12", "all", []), mk("14", "selected", ["P2"])];
    const ids = rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "selected", productIds: ["P2", "P3"] } } }));
    expect(ids).toHaveLength(4);
    for (const c of g) { expect(c.mode).toBe("selected"); expect(c.products.sort()).toEqual(["P2", "P3"]); }
  });
  it("selected → all: 모두 mode=all + 허용 수강권 행 비움", () => {
    const g = [mk("5", "selected", ["P1"]), mk("7", "selected", ["P2"])];
    rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "all", productIds: [] } } }));
    expect(g.every((c) => c.mode === "all" && c.products.length === 0)).toBe(true);
  });
  it("all → selected: 모두 mode=selected + 선택한 수강권", () => {
    const g = [mk("5", "all", []), mk("7", "all", [])];
    rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "selected", productIds: ["P1"] } } }));
    expect(g.every((c) => c.mode === "selected" && c.products.join() === "P1")).toBe(true);
  });
  it("수강권을 바꾸지 않은 저장(다른 공통 필드만): passPolicy 키가 행에 실리지 않아 그룹의 기존 수강권 설정이 그대로 보존된다", () => {
    const g = [mk("5", "selected", ["P1"]), mk("7", "selected", ["P2", "P3"]), mk("12", "all", [])];
    const ups = buildGroupUpdates(rows(g), { changes: { capacity: 12 } });
    expect(ups.every((u) => !("pass_selection_mode" in u) && !("allowed_product_ids" in u))).toBe(true);
    rpcModel(g, "g1", ups);
    expect(g.map((c) => [c.mode, c.products.join()])).toEqual([["selected", "P1"], ["selected", "P2,P3"], ["all", ""]]);
  });
  it("전체 적용 OFF: 그룹 RPC를 부르지 않고 편집한 수업만(화면 계약) — 단건 갱신 경로", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("if (applyToGroup && editGroupId) {");
    expect(page).toContain("const result = await updateClass(editId, { ...form, cancelDeadlineMin: deadlineToMin(), bookingDeadlineMin: bookDeadlineToMin(), passSelectionMode: passMode });");
    expect(page).toContain("if (!groupCarriedPassPolicy) await setClassProducts(editId, resolved.productIds);");
  });
  it("그룹 10개에도 전체 적용, 각 수업의 시간(요일별로 다른 시각)은 보존", () => {
    const g = Array.from({ length: 10 }, (_, i) => mk(String(i + 1), "selected", ["P1"], "g1", i % 2 === 0 ? "11" : "09"));
    const before = g.map((c) => c.start);
    const ids = rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "selected", productIds: ["P3"] } } }));
    expect(ids).toHaveLength(10);
    expect(g.every((c) => c.products.join() === "P3")).toBe(true);
    expect(g.map((c) => c.start)).toEqual(before);
  });
  it("다른 그룹/센터 수업은 건드리지 않는다, 잘못된 입력(selected인데 0개 / 다른 센터 수강권)은 전체 거부", () => {
    const g = [mk("5", "selected", ["P1"]), mk("7", "selected", ["P1"], "other")];
    rpcModel(g, "g1", buildGroupUpdates(rows(g).filter((r) => r.id === "5"), { changes: { passPolicy: { mode: "selected", productIds: ["P2"] } } }));
    expect(g[1].products).toEqual(["P1"]);
    expect(() => rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "selected", productIds: [] } } }))).toThrow(/1개 이상/);
    expect(() => rpcModel(g, "g1", buildGroupUpdates(rows(g), { changes: { passPolicy: { mode: "selected", productIds: ["OTHER-CENTER"] } } }))).toThrow(/이 센터의 수강권/);
  });
  it("담당 강사 그룹 적용 회귀: 같은 저장에서 setClassTrainersForGroup(groupIds, selectedTrainers) 그대로 호출", () => {
    expect(read("app/manager/classes/page.tsx")).toContain("await setClassTrainersForGroup(groupIds, selectedTrainers);");
  });
  it("페이지: 원본 수강권 설정을 서버값으로 기록하고(집합 비교), 모를 때는 사용자가 손댔는지로 판단", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("origPassRef.current = { mode: freshMode");
    expect(page).toContain("passPolicyChanged(origPassRef.current, nextPolicy) : userEditedRef.current");
    expect(page).toContain("if (passChanged) changes.passPolicy = nextPolicy;");
  });
  it("SQL: update_class_group_safe는 라이브 정의 + 선택 키만 추가 — 검증 후 한 트랜잭션에서 정책 갱신 + 허용 수강권 교체", () => {
    const sql = noComments(read("fix_manager_product_class_ux_20261002.sql"));
    const f = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.update_class_group_safe"), sql.indexOf("revoke all on function update_class_group_safe"));
    for (const x of ["has_permission(v_center_id, v_key)", "recurring_group_id = p_group_id", "u ? 'pass_selection_mode'", "p.product_kind = 'pass'", "p.center_id = v_center_id",
      "jsonb_array_length(v_row->'allowed_product_ids'), 0) = 0", "delete from class_allowed_products cap", "insert into class_allowed_products (class_id, product_id)", "SET search_path TO 'public'",
      "booking_deadline_min = case when u ? 'booking_deadline_min'", "pass_selection_mode = case when u ? 'pass_selection_mode' then u->>'pass_selection_mode' else c.pass_selection_mode end"]) expect(f).toContain(x);
    expect(f.indexOf("이 센터의 수강권만 선택할 수 있어요")).toBeLessThan(f.indexOf("with upd as"));   // 검증이 먼저(부분 적용 없음)
    expect(sql).toContain("revoke all on function update_class_group_safe(uuid, text, integer, jsonb) from public, anon;");
  });
});

/* ============================== D. 예약 카드 룸 ============================== */
describe("[D] 회원 예약 카드 룸 표시", () => {
  it("roomNameFromEmbed: 객체/배열 임베드 모두 처리, 없으면 빈 문자열", () => {
    expect(roomNameFromEmbed({ name: "A링크" })).toBe("A링크");
    expect(roomNameFromEmbed([{ name: "A링크" }])).toBe("A링크");
    expect(roomNameFromEmbed(null)).toBe("");
    expect(roomNameFromEmbed([])).toBe("");
    expect(roomNameFromEmbed({})).toBe("");
  });
  it("meta: 센터 · 강사 · 룸, 없는 항목은 구분자째 생략(빈 '· ·' 없음)", () => {
    expect(classListMetaText("A10TION 피겨팀", "손지윤", "A링크")).toBe("A10TION 피겨팀 · 손지윤 · A링크");
    expect(classListMetaText("A10TION 피겨팀", null, "A링크")).toBe("A10TION 피겨팀 · A링크");
    expect(classListMetaText("A10TION 피겨팀", "손지윤", "")).toBe("A10TION 피겨팀 · 손지윤");
    expect(classListMetaText("A10TION 피겨팀", "", undefined)).toBe("A10TION 피겨팀");
    expect(classListMetaText(null, null, "A링크")).toBe("A링크");
    expect(classListMetaText(undefined, "", "")).toBe("");
    expect(classListMetaText("센터", "강", "룸")).not.toMatch(/· ·|^ ·|· $/);
  });
  it("긴 센터/강사/룸 이름도 그대로 이어붙이고(자르지 않음) CSS가 줄바꿈 + 3줄 말줄임", () => {
    const long = classListMetaText("매우매우긴센터이름".repeat(3), "홍길동, 김철수 외 2명", "디엣지 아이스링크 A링크 3층 메인홀");
    expect(long.split(" · ")).toHaveLength(3);
    expect(read("app/globals.css")).toMatch(/\.member-reservation \.class-row-place \{[^}]*overflow-wrap: anywhere[^}]*-webkit-line-clamp: 3/);
  });
  it("확인 시트 부제: 룸 없으면 앞 구분자 없이 날짜 시간만", () => {
    expect(confirmClassSubText("A링크", "2026-10-05", "20:00")).toBe("A링크 · 2026-10-05 20:00");
    expect(confirmClassSubText("", "2026-10-05", "20:00")).toBe("2026-10-05 20:00");
    expect(confirmClassSubText(undefined, "2026-10-05", "20:00")).toBe("2026-10-05 20:00");
  });
  it("카드는 별도 룸 줄 대신 meta 한 줄을 쓰고, 새 색상을 추가하지 않는다(기존 토큰)", () => {
    const css = read("app/globals.css");
    const rule = css.slice(css.indexOf(".member-reservation .class-row-place { overflow-wrap"), css.indexOf(".member-reservation .class-row-place { overflow-wrap") + 260);
    expect(rule).not.toMatch(/#[0-9a-f]{3,8}|rgb\(/i);
  });
});

/* ============================== E. 담당 강사 순서 ============================== */
describe("[E] 담당 강사 선택 순서", () => {
  it("A→B 선택 / B→A 선택 / 해제 후 재선택은 맨 뒤", () => {
    let o: string[] = [];
    o = toggleTrainerSelection(o, "연우"); expect(o).toEqual(["연우"]);
    o = toggleTrainerSelection(o, "지윤"); expect(o).toEqual(["연우", "지윤"]);
    o = toggleTrainerSelection(o, "연우"); expect(o).toEqual(["지윤"]);
    o = toggleTrainerSelection(o, "연우"); expect(o).toEqual(["지윤", "연우"]);
    expect(toggleTrainerSelection(toggleTrainerSelection([], "지윤"), "연우")).toEqual(["지윤", "연우"]);
  });
  it("실시간 미리보기: 0명 안내문, 1명 '1. 이름', 복수는 번호 순서, 이름 모르는 계정 건너뜀(번호 연속)", () => {
    const names = { a: "강연우", b: "손지윤", c: "김하나" };
    expect(TRAINER_PREVIEW_EMPTY).toBe("담당 강사를 선택하면 표시 순서를 미리 볼 수 있어요");
    expect(trainerPreviewItems([], names)).toEqual([]);
    expect(trainerPreviewItems(["b"], names)).toEqual([{ position: 1, accountId: "b", name: "손지윤" }]);
    expect(trainerPreviewItems(["a", "b", "c"], names).map((i) => `${i.position}.${i.name}`)).toEqual(["1.강연우", "2.손지윤", "3.김하나"]);
    expect(trainerPreviewItems(["b", "x", "a"], names).map((i) => `${i.position}.${i.name}`)).toEqual(["1.손지윤", "2.강연우"]);
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("표시 순서 미리보기");
    expect(page).toContain("trainerPreviewItems(selectedTrainers,");
    expect(page).toContain("setSelectedTrainers((prev) => toggleTrainerSelection(prev, s.accountId));");
  });
  it("회원/관리자 표시: 서버가 준 행 순서 그대로 이름 배열 → 첫 2명이 선택 순서, 3명 이상은 '외 N명'", () => {
    const t: Record<string, string[]> = {};
    appendTrainerNames(t, [{ class_id: "k1", name: "강연우" }, { class_id: "k1", name: "손지윤" }, { class_id: "k1", name: "김하나" }, { class_id: "k2", name: "손지윤" }, { class_id: "k2", name: null }]);
    expect(t.k1).toEqual(["강연우", "손지윤", "김하나"]);
    expect(formatInstructorNames(t.k1)).toBe("강연우, 손지윤 외 1명");
    expect(formatInstructorNames(t.k2)).toBe("손지윤");
    const rv = read("app/reservation/page.tsx");
    expect(rv).toContain('confirmClass.instructorNames.join(", ")');
    expect(read("lib/classes.ts")).toContain("appendTrainerNames(instructorNamesByClass, trainerRows as any)");   // 관리자 목록
    expect(read("lib/reservations.ts")).toContain("appendTrainerNames(instructorNamesByClass, res.data as any)");   // 회원 예약 화면
  });
  it("fetchClassTrainers: sort_order → id 순서로 조회, 컬럼 미적용(42703) 환경은 순서 없이 폴백", async () => {
    trainerResult = { data: [{ account_id: "b" }, { account_id: "a" }], error: null };
    expect(await fetchClassTrainers("k1")).toEqual(["b", "a"]);
    expect(trainerCalls).toEqual(["sort_order", "id"]);
    // 첫 조회가 42703(컬럼 없음)이면 순서 없이 다시 조회해 목록은 보여준다
    trainerCalls.length = 0;
    trainerQueue.push({ data: null, error: { code: "42703", message: "no col" } }, { data: [{ account_id: "z" }], error: null });
    expect(await fetchClassTrainers("k1")).toEqual(["z"]);
  });
  it("SQL: class_trainers.sort_order(+backfill/index), setter 3종과 class_trainer_names가 선택 순서를 저장/반환, 권한 모델 유지", () => {
    const sql = noComments(read("fix_manager_product_class_ux_20261002.sql"));
    expect(sql).toContain("alter table class_trainers add column if not exists sort_order integer not null default 0;");
    expect(sql).toContain("row_number() over (partition by class_id order by id) - 1");
    expect(sql).toContain("create index if not exists idx_class_trainers_class_order on class_trainers (class_id, sort_order);");
    expect(sql).not.toMatch(/drop constraint|unique \(class_id, account_id\)/i);   // 기존 unique 제약 유지(건드리지 않음)
    for (const fn of ["set_class_trainers_safe", "set_class_trainers_bulk_safe", "set_class_trainers_for_group_safe"]) {
      const f = sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`), sql.indexOf(`revoke all on function ${fn}(`));
      expect(f).toContain("with ordinality");
      expect(f).toContain("sort_order");
      expect(f).toContain("has_permission(v_center_id, ");
      expect(f).toContain("SET search_path TO 'public'");
      expect(sql).toContain(`revoke all on function ${fn}(`);
    }
    // 단일/그룹/반복 생성(bulk) 모두 입력 배열 순서(첫 위치 기준 dedup)를 0..n-1로 저장
    expect(sql.match(/row_number\(\) over \(order by min\(x\.ord\)\) - 1/g)).toHaveLength(3);
    const names = sql.slice(sql.indexOf("create or replace function class_trainer_names"), sql.indexOf("-- [C]"));
    expect(names).toContain("order by ct.class_id, ct.sort_order, ct.id");
    expect(names).toContain("returns table(class_id uuid, account_id uuid, name text)");
    expect(names).toContain("auth.uid() is not null");
  });
  it("반복 생성(bulk)/그룹 적용/단일 저장 클라이언트가 같은 선택 배열을 그대로 보낸다", () => {
    const c = read("lib/classes.ts");
    expect(c).toContain('rpc("set_class_trainers_safe", {\n    p_class_id: classId, p_account_ids: accountIds,');
    expect(c).toContain('rpc("set_class_trainers_bulk_safe"');
    expect(c).toContain('rpc("set_class_trainers_for_group_safe"');
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("await setClassTrainersBulk(newIds, selectedTrainers)");
    expect(page).toContain("await setClassTrainers(editId, selectedTrainers);");
  });
});

describe("[SQL] 단일 migration / rollback 구조", () => {
  const raw = read("fix_manager_product_class_ux_20261002.sql");
  const sql = noComments(raw);
  const rb = noComments(read("rollback_fix_manager_product_class_ux_20261002.sql"));
  it("BEGIN/COMMIT, 모든 SECURITY DEFINER에 search_path 고정, 교체 RPC는 PUBLIC/anon 실행 회수", () => {
    expect(sql.trim().startsWith("BEGIN;")).toBe(true);
    expect(sql).toContain("COMMIT;");
    for (const sig of ["set_class_trainers_safe(uuid, uuid[])", "set_class_trainers_bulk_safe(uuid[], uuid[])", "set_class_trainers_for_group_safe(uuid[], uuid[])", "update_class_group_safe(uuid, text, integer, jsonb)"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon;`);
      expect(sql).toContain(`grant execute on function ${sig} to authenticated, service_role;`);
    }
    expect(sql).toContain("revoke all on function orders_require_schedule_selection() from public, anon, authenticated;");
    expect(sql).not.toMatch(/create table|drop table|truncate/i);
  });
  it("옛 migration 통째 복붙 없이 6개 함수만 교체(트리거 함수 포함 7개 이하)", () => {
    const names = [...sql.matchAll(/create or replace function (?:public\.)?(\w+)\(/gi)].map((m) => m[1]).sort();
    expect(names).toEqual(["class_trainer_names", "orders_require_schedule_selection", "set_class_trainers_bulk_safe", "set_class_trainers_for_group_safe", "set_class_trainers_safe", "update_class_group_safe"]);
  });
  it("rollback: 적용 전 라이브 정의 복원(sort_order/수강권 키/ORDER BY 없음), 트리거 제거, 컬럼 삭제는 주석", () => {
    expect(rb).toContain("drop trigger if exists orders_require_schedule_selection on orders;");
    for (const fn of ["update_class_group_safe", "set_class_trainers_safe", "set_class_trainers_bulk_safe", "set_class_trainers_for_group_safe", "class_trainer_names"]) expect(rb).toContain(`FUNCTION public.${fn}(`);
    expect(rb).not.toContain("allowed_product_ids");
    expect(rb).not.toContain("with ordinality");
    expect(rb).not.toContain("order by ct.class_id, ct.sort_order");
    expect(read("rollback_fix_manager_product_class_ux_20261002.sql")).toContain("-- alter table class_trainers drop column if exists sort_order;");
  });
  it("적용 전/후 read-only 검증 포함", () => {
    for (const x of ["sort_order_column_must_be_1", "backfill_complete_must_be_true", "duplicate_positions_must_be_0", "schedule_trigger_must_be_1", "names_ordered_must_be_true", "group_rpc_has_pass_policy_must_be_true", "group_rpc_anon_must_be_false", "trainers_anon_must_be_false"]) expect(raw).toContain(x);
    expect(raw).toContain("적용 전 확인(읽기 전용)");
  });
});

describe("[SQL] 강사 bulk/group RPC — 교차 센터/교차 그룹 class id 주입 차단", () => {
  const sql = noComments(read("fix_manager_product_class_ux_20261002.sql"));
  const fnBody = (name: string) => {
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    expect(start).toBeGreaterThan(-1);
    return sql.slice(start, sql.indexOf("$function$;", sql.indexOf("AS $function$", start) + 5));
  };
  const bulk = fnBody("set_class_trainers_bulk_safe");
  const group = fnBody("set_class_trainers_for_group_safe");
  const single = fnBody("set_class_trainers_safe");

  // SQL 검증 분기를 옮긴 순수 모델(아래 소스 계약 테스트가 SQL과의 일치를 보증)
  type C = { id: string; center: string; group: string | null };
  const DB: C[] = [
    { id: "a1", center: "A", group: "g1" }, { id: "a2", center: "A", group: "g1" }, { id: "a3", center: "A", group: "g1" },
    { id: "a9", center: "A", group: "g2" }, { id: "b1", center: "B", group: "g3" }, { id: "n1", center: "A", group: null },
  ];
  function validate(ids: (string | null)[], needGroup: boolean): { ok: true; center: string } | { ok: false; error: string } {
    const uniq = [...new Set(ids)];
    const rows = DB.filter((c) => uniq.includes(c.id));
    if (rows.length !== uniq.length) return { ok: false, error: "수업을 찾을 수 없어요" };
    if (new Set(rows.map((r) => r.center)).size !== 1) return { ok: false, error: "같은 센터의 수업만 한 번에 지정할 수 있어요" };
    if (needGroup && (rows.some((r) => r.group === null) || new Set(rows.map((r) => r.group)).size !== 1)) return { ok: false, error: "같은 반복 수업 그룹의 수업만 한 번에 지정할 수 있어요" };
    return { ok: true, center: rows[0].center };
  }

  it("bulk: 같은 센터 3개 → 성공(중복 id는 제거)", () => {
    expect(validate(["a1", "a2", "a3"], false)).toEqual({ ok: true, center: "A" });
    expect(validate(["a1", "a1", "a2"], false)).toEqual({ ok: true, center: "A" });
  });
  it("bulk: 다른 센터 id 1개 섞기 → 전체 거부 / 존재하지 않는 id·null → 전체 거부", () => {
    expect(validate(["a1", "a2", "b1"], false)).toMatchObject({ ok: false, error: "같은 센터의 수업만 한 번에 지정할 수 있어요" });
    expect(validate(["b1", "a1"], false)).toMatchObject({ ok: false });   // 첫 id의 센터가 아니어도 거부
    expect(validate(["a1", "zzz"], false)).toMatchObject({ ok: false, error: "수업을 찾을 수 없어요" });
    expect(validate(["a1", null], false)).toMatchObject({ ok: false, error: "수업을 찾을 수 없어요" });
  });
  it("group: 같은 recurring_group → 성공 / 다른 센터 → 거부 / 같은 센터 다른 그룹 → 거부 / 그룹 없음(null) 섞임 → 거부", () => {
    expect(validate(["a1", "a2", "a3"], true)).toEqual({ ok: true, center: "A" });
    expect(validate(["a1", "b1"], true)).toMatchObject({ ok: false, error: "같은 센터의 수업만 한 번에 지정할 수 있어요" });
    expect(validate(["a1", "a9"], true)).toMatchObject({ ok: false, error: "같은 반복 수업 그룹의 수업만 한 번에 지정할 수 있어요" });
    expect(validate(["a1", "n1"], true)).toMatchObject({ ok: false, error: "같은 반복 수업 그룹의 수업만 한 번에 지정할 수 있어요" });
  });

  it("SQL bulk: 모든 수업 존재 + 같은 센터를 INSERT보다 먼저 확인, 권한(schedule.own.group.create)은 그 센터 기준, 검증된 id 집합으로만 INSERT", () => {
    expect(bulk).toContain("select array_agg(distinct x) into v_ids from unnest(p_class_ids) x;");
    expect(bulk).toContain("from classes where id = any(v_ids);");
    expect(bulk).toContain("if v_found <> array_length(v_ids, 1) then");
    expect(bulk).toContain("if v_centers <> 1 then");
    expect(bulk).toContain("has_permission(v_center_id, 'schedule.own.group.create')");
    expect(bulk).toContain("unnest(v_ids) as cid");
    expect(bulk).not.toContain("unnest(p_class_ids) as cid");
    expect(bulk.indexOf("if v_centers <> 1 then")).toBeLessThan(bulk.indexOf("has_permission("));
    expect(bulk.indexOf("has_permission(")).toBeLessThan(bulk.indexOf("insert into class_trainers"));
    expect(bulk).not.toContain("p_class_ids[1]");
  });
  it("SQL group: 존재/같은 센터/같은 그룹(null 불가) 검증이 DELETE보다 먼저, own/other 판정도 검증된 v_ids로만, DELETE/INSERT 모두 v_ids", () => {
    for (const x of ["if v_found <> array_length(v_ids, 1) then", "if v_centers <> 1 then", "if v_no_group or v_groups <> 1 then", "count(distinct recurring_group_id)"]) expect(group).toContain(x);
    const del = group.indexOf("delete from class_trainers");
    for (const x of ["if v_found <> array_length", "if v_centers <> 1", "if v_no_group or v_groups <> 1", "has_permission("]) expect(group.indexOf(x)).toBeLessThan(del);
    expect(group).toContain("delete from class_trainers where class_id = any(v_ids);");
    expect(group).toContain("class_id = any(v_ids) and account_id = my_account_id()");
    expect(group).toContain("unnest(v_ids) as cid");
    expect(group).not.toMatch(/any\(p_class_ids\)|unnest\(p_class_ids\) as cid|p_class_ids\[1\]/);   // 원본 배열은 중복 제거에만 쓰고 이후 모두 검증된 v_ids
    expect(group).toContain("'.group.update'");
  });
  it("거부 시 기존 class_trainers 불변: 예외는 항상 첫 DELETE/INSERT보다 앞(함수는 한 트랜잭션이라 예외 시 전부 롤백)", () => {
    for (const body of [bulk, group]) {
      const firstWrite = Math.min(...["delete from class_trainers", "insert into class_trainers"].map((x) => body.indexOf(x)).filter((i) => i > -1));
      for (const m of ["수업을 찾을 수 없어요", "같은 센터의 수업만", "담당 강사를 지정할 권한이 없어요"]) expect(body.lastIndexOf(m, firstWrite)).toBeGreaterThan(-1);
    }
  });
  it("단일 set_class_trainers_safe는 수업 자체의 center 기준 검사 그대로(불필요한 변경 없음), 3개 모두 anon 실행 회수 + search_path 고정", () => {
    expect(single).toContain("select center_id, class_format into v_center_id, v_format from classes where id = p_class_id;");
    expect(single).not.toContain("v_ids");
    for (const sig of ["set_class_trainers_safe(uuid, uuid[])", "set_class_trainers_bulk_safe(uuid[], uuid[])", "set_class_trainers_for_group_safe(uuid[], uuid[])"]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon;`);
    }
    for (const b of [bulk, group, single]) expect(b).toContain("SET search_path TO 'public'");
  });
  it("적용 후 검증 SQL에 같은 센터/같은 그룹 검증 존재 확인 추가, rollback은 적용 전 라이브 정의(검증 없음)로 복원", () => {
    const raw = read("fix_manager_product_class_ux_20261002.sql");
    expect(raw).toContain("setter_bulk_same_center_must_be_true");
    expect(raw).toContain("setter_group_same_group_must_be_true");
    const rb = noComments(read("rollback_fix_manager_product_class_ux_20261002.sql"));
    expect(rb).toContain("FUNCTION public.set_class_trainers_bulk_safe(");
    expect(rb).not.toContain("같은 센터의 수업만");
    expect(rb).not.toContain("array_agg(distinct x)");
  });
  it("앱 호출부는 그룹 수업 id만 넘긴다(setClassTrainersForGroup는 updateClassGroup이 돌려준 그룹 id, bulk는 방금 만든 id)", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("await setClassTrainersForGroup(groupIds, selectedTrainers);");
    expect(page).toContain("setClassTrainersBulk(newIds, selectedTrainers)");
  });
});

describe("[B] 요일 선택형 수강권 예약조건 미설정 — 관리자 UX", () => {
  const page = read("app/manager/membership-rules/page.tsx");
  it("공용 안내 문구 + 기존 예약조건 추가 시트를 재사용하는 openRuleSheet(새 UI 없음)", () => {
    expect(page).toContain('const WEEKDAY_NEEDS_RULES_MESSAGE = "요일 선택형 수강권은 예약조건을 1개 이상 등록해야 회원이 구매할 수 있어요.";');
    expect(page).toContain("async function openRuleSheet(p: Product)");
    expect(page).toContain('<button className="prog-add-sub-btn" onClick={() => openRuleSheet(p)}>');
    expect((page.match(/setRuleFor\(p\)/g) ?? []).length).toBe(1);   // 시트를 여는 코드는 한 곳(중복 UI 없음)
  });
  it("카드: 요일 선택형 + 요일 예약조건 0개면 '회원이 구매할 수 없는 상태' 안내 + 예약조건 추가 버튼(권한 있을 때)", () => {
    expect(page).toContain("p.weekdaySelectable && computeSelectableSchedule(rules).days.length === 0");
    expect(page).toContain("회원이 구매할 수 없는 상태예요.");
    expect(page).toContain("{canEditRules && (");
    expect(page).toContain('onClick={() => openRuleSheet(p)}>예약조건 추가</button>');
  });
  it("수정 저장 직후: 요일 예약조건이 0개면 안내 토스트 + 예약조건 추가 시트를 바로 연다(요일/시간은 관리자가 직접 선택)", () => {
    expect(page).toContain("const needRules = pWeekdaySelectable && computeSelectableSchedule(rulesByProduct[editingId] ?? []).days.length === 0;");
    expect(page).toContain('showToast(needRules ? WEEKDAY_NEEDS_RULES_MESSAGE : "수강권을 수정했어요");');
    expect(page).toContain("if (fresh) await openRuleSheet(fresh);");
  });
  it("새 상품 생성은 기존 '생성 → 예약조건 추가' 구조 유지: 생성 후 요일 조건이 없으면 안내 + 시트 연결", () => {
    expect(page).toContain("const createdNeedsRules = pWeekdaySelectable && !!made && !createdHasDayRule;");
    const createAt = page.indexOf("const newProductId = await createProduct(");
    expect(createAt).toBeGreaterThan(-1);
    expect(page.indexOf("createdNeedsRules", createAt)).toBeGreaterThan(createAt);
    expect(page).toContain("showToast(WEEKDAY_NEEDS_RULES_MESSAGE);");
  });
  it("조건 추가 시트에도 같은 안내를 보여준다 / 실제 요일·시간 값은 코드·SQL에 하드코딩하지 않는다", () => {
    expect(page).toContain("{WEEKDAY_NEEDS_RULES_MESSAGE} 회원이 고를 요일(과 시간)을 직접 선택해 추가해주세요.");
    const sql = read("fix_manager_product_class_ux_20261002.sql");
    expect(sql).not.toContain("d60c46cb-2f8b-43ae-8c3c-b46c6e50b9d6");   // 문제 상품 id 하드코딩 없음
    expect(sql).not.toMatch(/insert into membership_schedule_rules/i);
  });
});
