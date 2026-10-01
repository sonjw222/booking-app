/*
  2026-10-01 QA 배치 — 대여상품 차감/복원(SQL 계약), 반복수업 소개·그룹 시간 보존, manager_centers RLS.
  DB가 없는 환경이라 SQL은 주석 제거한 소스 텍스트로 계약을 확인하고, 순수 함수/클라이언트는 직접 실행한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
const selectEq = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: () => ({ select: () => ({ eq: (...a: unknown[]) => selectEq(...a) }) }),
  },
}));

import {
  buildGroupUpdates, updateClassGroup, createRecurringClasses, createRecurringClassesPerDay,
  formatGoodsUsageLabel,
} from "../../lib/classes";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("[5][6] 대여상품 — SQL 계약", () => {
  const sql = noComments(read("add_reservation_goods_usage.sql"));
  it("예약당 중복 사용 불가(unique) + 상태/사이즈 스냅샷 컬럼", () => {
    expect(sql).toContain("unique (reservation_id, goods_membership_id)");
    expect(sql).toContain("product_name_snapshot text not null");
    expect(sql).toContain("size_snapshot");
    expect(sql).toContain("check (status in ('pending', 'deducted', 'restored', 'skipped'))");
  });
  it("수강권 예약과 상품 차감이 한 함수(한 트랜잭션)에서 처리되고, 검증은 예약 생성 전에 끝난다", () => {
    const f = sql.slice(sql.indexOf("create or replace function reserve_with_goods"));
    expect(f.indexOf("raise exception '사용할 수 없는 상품이에요'")).toBeLessThan(f.indexOf("v_result := reserve_class(p_class_id, v_profile_id)"));
    expect(f).toContain("reserve_with_membership(p_class_id, v_profile_id, p_membership_id)");
    expect(f).toContain("for update");
    expect(f).toContain("remaining_count = remaining_count - 1");
  });
  it("대기예약은 차감하지 않고 pending, 승격 시 차감", () => {
    expect(sql).toContain("v_usage_state := 'pending'");
    expect(sql).toContain("elsif old.status = 'waitlisted' and new.status = 'confirmed'");
  });
  it("취소는 'deducted'만 정확히 1회 복원(재호출 시 중복 복원 없음)", () => {
    expect(sql).toContain("where reservation_id = new.id and status in ('deducted', 'pending')");
    expect(sql).toContain("if v_u.status = 'restored' and not v_u.unlimited then");
    expect(sql).toContain("new.status = 'cancelled' and old.status is distinct from 'cancelled'");
  });
  it("사이즈 출처 우선순위: 보유상품 선택 사이즈 → 프로필 shoe_size → 없음", () => {
    const i1 = sql.indexOf("v_goods.selected_size");
    const i2 = sql.indexOf("v_profile.shoe_size");
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(sql).toContain("v_size_source text := 'none'");
  });
  it("RLS: 본인/센터 관리자만 조회, 쓰기 정책 없음, anon 차단·명시적 GRANT", () => {
    expect(sql).toContain("alter table reservation_goods_usages enable row level security");
    expect(sql).not.toMatch(/create policy[^;]*for (insert|update|delete)/i);
    expect(sql).toContain("revoke all on table reservation_goods_usages from anon");
    expect(sql).toContain("grant select on table reservation_goods_usages to authenticated");
    expect(sql).toContain("revoke all on function reserve_with_goods(uuid, uuid, uuid, uuid) from public, anon");
  });
  it("기존 3-인자 reserve_class_with_goods는 시그니처 유지 + 새 함수로 위임(오버로드 신규 없음)", () => {
    expect(sql).toContain("create or replace function reserve_class_with_goods(");
    expect(sql).toContain("return reserve_with_goods(p_class_id, p_profile_id, null, p_goods_membership_id)");
  });
  it("롤백이 라이브 정의를 복원하고 트리거/새 함수를 제거한다", () => {
    const rb = read("rollback_add_reservation_goods_usage.sql");
    expect(rb).toContain("drop trigger if exists reservation_goods_sync on reservations;");
    expect(rb).toContain("drop function if exists reserve_with_goods(uuid, uuid, uuid, uuid);");
    expect(rb).toContain("reserve_class(p_class_id, p_profile_id)");
  });
});

describe("[6] 관리자 예약자 목록 표시", () => {
  it("'피겨화 대여 240mm' 형태, 사이즈 없으면 '사이즈 미입력', 복원된 건 숨김", () => {
    expect(formatGoodsUsageLabel([{ product_name_snapshot: "피겨화 대여", size_snapshot: "240mm", status: "deducted" }])).toBe("피겨화 대여 240mm");
    expect(formatGoodsUsageLabel([{ product_name_snapshot: "피겨화 대여", size_snapshot: null, status: "pending" }])).toBe("피겨화 대여 사이즈 미입력");
    expect(formatGoodsUsageLabel([{ product_name_snapshot: "피겨화 대여", size_snapshot: "240mm", status: "restored" }])).toBeNull();
    expect(formatGoodsUsageLabel(null)).toBeNull();
  });
  it("명단 화면이 이름 옆에 표시하고, 쿼리는 usages 테이블 미적용 환경에서 폴백한다", () => {
    expect(read("app/manager/classes/page.tsx")).toContain("{a.goodsLabel && <span className=\"roster-goods\">");
    expect(read("lib/classes.ts")).toContain("({ data, error } = await run(base));");
  });
});

describe("[7] 반복수업 소개(description) 보존", () => {
  beforeEach(() => { rpcMock.mockReset(); rpcMock.mockResolvedValue({ data: ["a", "b"], error: null }); });
  it("공통시간 반복: 모든 행에 description 복제", async () => {
    await createRecurringClasses("c1", { title: "정규반", description: "  초급 · 장비 지참  ", daysOfWeek: [1, 3], fromDate: "2026-10-05", toDate: "2026-10-14", start: "20:00", end: "21:00", capacity: 8 });
    const rows = rpcMock.mock.calls[0][1].p_rows as any[];
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.description === "초급 · 장비 지참")).toBe(true);
  });
  it("요일별 개별시간 반복: 월/수 서로 다른 시간이어도 모든 행에 description 복제", async () => {
    await createRecurringClassesPerDay("c1", {
      title: "정규반", description: "수업 소개", fromDate: "2026-10-05", toDate: "2026-10-14",
      days: [{ dow: 1, start: "20:00", end: "21:00", capacity: 8 }, { dow: 3, start: "18:00", end: "19:30", capacity: 6 }],
    });
    const rows = rpcMock.mock.calls[0][1].p_rows as any[];
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.description === "수업 소개")).toBe(true);
    expect(new Set(rows.map((r) => r.start_time.slice(11, 16))).size).toBe(2);   // 시간은 요일별로 유지
  });
  it("소개가 비면 null(빈 문자열 아님)", async () => {
    await createRecurringClasses("c1", { title: "t", description: "   ", daysOfWeek: [1], fromDate: "2026-10-05", toDate: "2026-10-05", start: "10:00", end: "11:00", capacity: 1 });
    expect((rpcMock.mock.calls[0][1].p_rows as any[])[0].description).toBeNull();
  });
  it("SQL: create_recurring_classes_safe가 JSON description을 classes.description에 저장한다", () => {
    const sql = noComments(read("fix_recurring_class_description_and_group_update.sql"));
    expect(sql).toContain("center_id, title, description, start_time");
    expect(sql).toContain("nullif(btrim(coalesce(r->>'description', '')), '')");
  });
  it("매니저 화면이 두 반복 생성 경로 모두에 form.description을 넘긴다", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("title: form.title, description: form.description, daysOfWeek: repDays");
    expect(page).toMatch(/createRecurringClassesPerDay\(activeCenterId, \{\s*title: form\.title,\s*description: form\.description/);
  });
  it("회원 예약 확인창은 description을 보여준다(기존 동작 유지)", () => {
    expect(read("app/reservation/page.tsx")).toContain("confirmClass.description");
  });
});

describe("[10] 모든 반복 수업에 적용 — 요일별 시간 보존", () => {
  // 월 20:00~21:00 / 수 18:00~19:30 (KST)
  const rows = [
    { id: "m1", start_time: "2026-10-05T11:00:00.000Z", end_time: "2026-10-05T12:00:00.000Z" },
    { id: "w1", start_time: "2026-10-07T09:00:00.000Z", end_time: "2026-10-07T10:30:00.000Z" },
    { id: "m2", start_time: "2026-10-12T11:00:00.000Z", end_time: "2026-10-12T12:00:00.000Z" },
  ];
  it("기본(시간 옵션 없음)은 각 수업의 기존 시작/종료를 그대로 유지한다", () => {
    const u = buildGroupUpdates(rows);
    expect(u.map((x) => [x.id, x.start_time, x.end_time])).toEqual(rows.map((r) => [r.id, r.start_time, r.end_time]));
    expect(u.every((x) => x.description === undefined)).toBe(true);
  });
  it("수업명만 바꿔도 수요일은 18:00을 유지한다(월요일 시간으로 덮어쓰지 않음)", async () => {
    selectEq.mockResolvedValue({ data: rows, error: null });
    rpcMock.mockReset(); rpcMock.mockResolvedValue({ data: ["m1", "w1", "m2"], error: null });
    await updateClassGroup("g1", "B", 8);
    const args = rpcMock.mock.calls[0];
    expect(args[0]).toBe("update_class_group_safe");
    expect(args[1].p_title).toBe("B");
    const wed = (args[1].p_updates as any[]).find((x) => x.id === "w1");
    expect(wed.start_time).toBe("2026-10-07T09:00:00.000Z");   // 18:00 KST
    expect(wed.end_time).toBe("2026-10-07T10:30:00.000Z");     // 19:30 KST
    const mon = (args[1].p_updates as any[]).find((x) => x.id === "m1");
    expect(mon.start_time).toBe("2026-10-05T11:00:00.000Z");   // 20:00 KST
  });
  it("소개를 함께 적용하면 모든 행에 description이 실리고 시간은 그대로", () => {
    const u = buildGroupUpdates(rows, { description: "새 소개" });
    expect(u.every((x) => x.description === "새 소개")).toBe(true);
    expect(u[1].start_time).toBe(rows[1].start_time);
  });
  it("명시적 '시간도 함께 변경' 옵션을 줄 때만 시간이 바뀐다(날짜는 각자 유지)", () => {
    const u = buildGroupUpdates(rows, { time: { start: "19:00", end: "20:00" } });
    expect(u.map((x) => x.start_time)).toEqual(["2026-10-05T19:00:00+09:00", "2026-10-07T19:00:00+09:00", "2026-10-12T19:00:00+09:00"]);
  });
  it("매니저 화면: 시간 옵션은 기본 OFF이고 안내 문구가 있다", () => {
    const page = read("app/manager/classes/page.tsx");
    expect(page).toContain("const [applyTimeToGroup, setApplyTimeToGroup] = useState(false);");
    expect(page).toContain("time: applyTimeToGroup ? { start: form.start, end: form.end, only: orig ? { start: orig.start, end: orig.end } : undefined } : undefined");
    expect(page).toContain("날짜·시간·수강권 정책은 수업별로 유지돼요");
    expect(page).toContain("시간도 함께 변경");
  });
  it("SQL: update_class_group_safe는 description 키가 있을 때만 갱신(시그니처 불변)", () => {
    const sql = noComments(read("fix_recurring_class_description_and_group_update.sql"));
    expect(sql).toContain("when u ? 'description'");
    expect(sql).toContain("else c.description");
    expect(sql).toContain("update_class_group_safe(p_group_id uuid, p_title text, p_capacity integer, p_updates jsonb)");
  });
});

describe("[8] 메모 필드 — 관리자 내부 메모 라벨", () => {
  const page = read("app/manager/classes/page.tsx");
  it("라벨이 '관리자 메모'이고 회원에게 표시되지 않는다는 안내가 있다", () => {
    expect(page).toContain("관리자 메모");
    expect(page).toContain("센터 운영자만 보는 내부 메모이며 회원에게 표시되지 않아요");
  });
  it("저장 로직(schedule_memos/class_id)은 그대로", () => {
    expect(read("lib/scheduleMemos.ts")).toContain("schedule_memos");
    expect(page).toContain("createClassMemo");
  });
});

describe("[9] manager_centers RLS — 재귀 제거 + 권한상승 방지(SQL 계약)", () => {
  const raw = read("fix_manager_centers_rls_recursion_final.sql");
  const sql = noComments(raw);
  const policies = sql.slice(sql.indexOf('drop policy if exists "매니저센터 생성"'), sql.indexOf("create or replace function manager_centers_protect_last_owner"));
  it("정책 본문에 manager_centers raw self-subquery가 없다", () => {
    expect(policies).not.toMatch(/from\s+manager_centers/i);
    expect(policies).not.toMatch(/select\s+1\s+from\s+centers/i);   // centers 참조도 헬퍼로
  });
  it("부트스트랩은 헬퍼 + 승인대기 센터만", () => {
    expect(policies).toContain("not manager_centers_has_any_row(center_id)");
    expect(policies).toContain("center_is_pending(center_id)");
  });
  it("다른 센터 role_id 주입 금지(INSERT/UPDATE 모두)", () => {
    expect((policies.match(/role_id_belongs_to_center\(role_id, center_id\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it("owner 역할 부여/오너 행 변경은 센터 오너만", () => {
    expect((policies.match(/not role_id_is_owner_for_center\(role_id, center_id\) or is_center_owner\(center_id\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
  it("본인 owner 승급은 센터에 다른 행이 없을 때(부트스트랩)만", () => {
    expect(policies).toContain("and role_id_is_owner_for_center(role_id, center_id)\n                and not manager_centers_has_any_row(center_id, id)");
  });
  it("마지막 활성 오너 삭제 금지 + staff.create/update/delete 권한 유지", () => {
    expect(policies).toContain("not manager_centers_is_last_active_owner(center_id, id)");
    for (const k of ["facility.staff.create", "facility.staff.update", "facility.staff.delete"]) expect(policies).toContain(`'${k}'`);
  });
  it("헬퍼는 SECURITY DEFINER + 고정 search_path, PUBLIC/anon 회수, authenticated만 허용", () => {
    const helpers = sql.slice(0, sql.indexOf('drop policy if exists "매니저센터 생성"'));
    expect((helpers.match(/security definer/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((helpers.match(/set search_path = public/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(helpers).toContain("revoke all on function manager_centers_has_any_row(uuid, uuid) from public, anon;");
    expect(helpers).toContain("grant execute on function center_is_pending(uuid) to authenticated, service_role;");
  });
  it("RLS를 끄지 않고 authenticated에 광범위 write를 열지 않는다", () => {
    expect(sql).not.toMatch(/disable row level security/i);
    expect(sql).not.toMatch(/grant\s+(all|insert|update|delete)[^;]*on\s+(table\s+)?manager_centers/i);
  });
  it("롤백은 적용 직전 정책으로 복원하고 새 헬퍼를 제거한다", () => {
    const rb = read("rollback_fix_manager_centers_rls_recursion_final.sql");
    expect(rb).toContain("drop function if exists manager_centers_is_last_active_owner(uuid, uuid);");
    expect(rb).toContain("select 1 from manager_centers mc2");
  });
  it("정책 이름이 기존 draft와 같아 draft를 중복 적용해도 같은 최종 형태로 덮인다(이 파일이 최종본)", () => {
    for (const n of ["매니저센터 생성", "오너 스태프 초대", "오너 스태프 수정", "오너 스태프 삭제"]) expect(sql).toContain(`create policy "${n}"`);
  });
});

describe("파일 정합성", () => {
  it("새 SQL은 기존 파일을 수정하지 않았고(add_public_storefront_products.sql 유지) 파일명에 기능이 드러난다", () => {
    expect(read("add_public_storefront_products.sql")).toContain("fetch_public_storefront_products");
    for (const f of [
      "fix_order_issuance_and_auto_booking.sql", "add_reservation_goods_usage.sql",
      "fix_recurring_class_description_and_group_update.sql", "fix_manager_centers_rls_recursion_final.sql",
    ]) {
      expect(read(f).length).toBeGreaterThan(500);
      expect(read("rollback_" + f).length).toBeGreaterThan(200);
    }
  });
  it("앱 코드에 stripTs 후 직접 결제수단 하드코딩 쿠폰이 없다", () => {
    expect(stripTs(read("app/cart/page.tsx"))).not.toMatch(/WELCOME|FIGURE10/);
  });
});
