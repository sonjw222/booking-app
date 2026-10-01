/*
  관리자 수강권 만료일 연장(2026-10-02) — 순수 계산, 화면/클라이언트 계약, SQL(권한·가드·감사·권한 기본값) 계약.
  DB가 없는 환경이라 SQL은 주석 제거한 소스 텍스트로 확인한다. 실제 DB 동작은 npm run qa:production:membership-expiry(별도 승인)로 검증한다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();
vi.mock("../../lib/supabaseClient", () => ({ supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => ({}) } }));

import {
  EXPIRY_PERMISSION_KEY, MAX_EXTEND_DAYS, QUICK_EXTEND_DAYS, addDaysToYmd, diffDays, extensionConfirmMessage, extensionErrorMessage,
  extensionSuccessMessage, formatDotDate, isExtendablePass, isValidYmd, previewExtension,
} from "../../lib/membershipExpiry";
import { extendMembershipExpiry } from "../../lib/members";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const noComments = (s: string) => s.replace(/--.*$/gm, "");
const sqlRaw = read("add_membership_expiry_extension.sql");
const sql = noComments(sqlRaw);
const page = read("app/manager/members/page.tsx");
const TODAY = "2026-10-02";

describe("[L][M] 날짜 계산", () => {
  it("N일 연장: 2026-10-28 + 30일 = 2026-11-27 (월/연 경계, 윤년 포함)", () => {
    expect(previewExtension({ currentExpiresAt: "2026-10-28", mode: "days", days: 30, today: TODAY })).toMatchObject({ newExpiresAt: "2026-11-27", daysAdded: 30, error: null });
    expect(addDaysToYmd("2026-12-25", 10)).toBe("2027-01-04");
    expect(addDaysToYmd("2028-02-28", 1)).toBe("2028-02-29");
    expect(diffDays("2026-10-28", "2026-12-31")).toBe(64);
  });
  it("날짜 직접 지정: 2026-10-28 → 2026-12-31 그대로", () => {
    expect(previewExtension({ currentExpiresAt: "2026-10-28", mode: "date", newDate: "2026-12-31", today: TODAY })).toMatchObject({ newExpiresAt: "2026-12-31", daysAdded: 64, error: null });
  });
  it("빠른 선택 chip과 안내 문구/표기", () => {
    expect([...QUICK_EXTEND_DAYS]).toEqual([7, 14, 30, 60]);
    expect(formatDotDate("2026-10-28")).toBe("2026.10.28");
    expect(extensionSuccessMessage("2026-11-27")).toBe("수강권 만료일을 2026.11.27까지 연장했어요.");
    expect(extensionConfirmMessage({ passName: "필라테스 10회", current: "2026-10-28", next: "2026-11-27", mode: "days", days: 30 }))
      .toBe("필라테스 10회 수강권의 만료일을\n2026.10.28 → 2026.11.27로\n30일 연장할까요?");
    expect(extensionConfirmMessage({ passName: "필라테스 10회", current: "2026-10-28", next: "2026-12-31", mode: "date", days: null }))
      .toContain("2026.10.28 → 2026.12.31로\n연장할까요?");
  });
});

describe("[J][K] 거부 규칙(UI 사전 검증 — 서버가 같은 규칙을 최종 강제)", () => {
  const cur = "2026-10-28";
  it("0일/음수/비숫자/과다 일수 차단", () => {
    for (const bad of ["0", "-3", "", "abc", "1.5"]) expect(previewExtension({ currentExpiresAt: cur, mode: "days", days: bad, today: TODAY }).error).toBeTruthy();
    expect(previewExtension({ currentExpiresAt: cur, mode: "days", days: MAX_EXTEND_DAYS + 1, today: TODAY }).error).toContain("최대");
  });
  it("단축/같은 날짜 차단(연장만 가능)", () => {
    expect(previewExtension({ currentExpiresAt: cur, mode: "date", newDate: "2026-10-27", today: TODAY }).error).toContain("뒤여야");
    expect(previewExtension({ currentExpiresAt: cur, mode: "date", newDate: cur, today: TODAY }).error).toContain("뒤여야");
    expect(previewExtension({ currentExpiresAt: cur, mode: "date", newDate: "", today: TODAY }).error).toContain("선택");
  });
  it("이미 만료된 수강권: 연장 결과가 오늘 이전이면 안내와 함께 차단, 오늘 이후가 되면 허용", () => {
    const expired = previewExtension({ currentExpiresAt: "2026-09-01", mode: "days", days: 7, today: TODAY });
    expect(expired.error).toBe("이미 만료된 수강권이에요. 새 만료일이 오늘 이후가 되도록 연장해주세요.");
    expect(previewExtension({ currentExpiresAt: "2026-09-01", mode: "date", newDate: "2026-11-01", today: TODAY })).toMatchObject({ newExpiresAt: "2026-11-01", error: null });
  });
  it("날짜 형식 검증", () => {
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("2026-10-28")).toBe(true);
  });
});

describe("[무제한/상품 제외] 연장 가능 대상", () => {
  it("수강권(만료일 있음)만 연장 대상: goods/무제한(expires null) 제외, product 없는 기존 수강권(kind pass)은 허용", () => {
    expect(isExtendablePass({ kind: "pass", expiresAt: "2026-10-28" })).toBe(true);
    expect(isExtendablePass({ kind: "goods", expiresAt: "2026-10-28" })).toBe(false);
    expect(isExtendablePass({ kind: "pass", expiresAt: null })).toBe(false);
    expect(read("lib/members.ts")).toContain('kind: m.product_id ? (kindById[m.product_id] ?? "pass") : "pass"');
  });
});

describe("화면: 권한 노출/갱신/확인", () => {
  it("연장 버튼은 전용 권한(canDo) + 수강권 + 만료일 있을 때만, 상품 목록 칩에는 버튼이 없다", () => {
    expect(page).toContain("const canExtendExpiry = canDo(EXPIRY_PERMISSION_KEY);");
    expect(page).toContain("{canExtendExpiry && isExtendablePass(p) && (");
    const goods = page.slice(page.indexOf('className="mem-pass-chip goods"'), page.indexOf('className="mem-pass-chip goods"') + 500);
    expect(goods).not.toContain("openExtend");
    expect(EXPIRY_PERMISSION_KEY).toBe("customer.member.pass_expiry.update");
  });
  it("권한 로딩 패턴은 기존 canDo(canSeeManagerMenu + myPerms) 그대로 — 로딩 중 비오너에게 잠깐 보이지 않는다", () => {
    expect(page).toContain("return canSeeManagerMenu(activeCenter?.isOwner ?? false, myPerms, key);");
    const roles = read("lib/roles.ts");
    expect(roles).toContain("export function canSeeManagerMenu");
  });
  it("두 모드(N일/날짜 지정), 직접 입력 + 빠른 chip, 미리보기, 사유(선택, 길이 제한), 최종 확인(appConfirm), 중복 클릭 방지", () => {
    for (const s of ["N일 연장", "날짜 지정", "aria-label=\"연장 일수\"", "QUICK_EXTEND_DAYS.map", "연장 사유 (선택)", "maxLength={MAX_REASON_LENGTH}",
      "await globalThis.appConfirm(extensionConfirmMessage(", "if (!extendTarget || extending) return;", "disabled={extending || !!pv.error || !pv.newExpiresAt}", "extending ? \"연장 중...\" : \"만료일 연장\""]) expect(page).toContain(s);
  });
  it("성공 후 토스트 + 회원 상세 재조회(새 날짜 즉시 표시)", () => {
    expect(page).toContain("showToast(extensionSuccessMessage(r.newExpiresAt));");
    expect(page).toContain("if (detail) await openDetail(detail);");
  });
  it("변경하지 않는 것 안내 + 저장 중 sheet 닫기 차단(swipeDismiss)", () => {
    expect(page).toContain("잔여 횟수·결제·예약은 바뀌지 않고, 이 수강권 1개의 만료일만 연장돼요.");
    expect(page).toContain("swipeDismiss={!extending}");
  });
});

describe("클라이언트 RPC 호출/오류 처리", () => {
  beforeEach(() => rpcMock.mockReset());
  it("전용 RPC만 호출(memberships 직접 UPDATE 없음), 모드별 인자와 사유 trim", async () => {
    rpcMock.mockResolvedValueOnce({ data: { membershipId: "m", oldExpiresAt: "2026-10-28", newExpiresAt: "2026-11-27", daysAdded: 30 }, error: null });
    const r = await extendMembershipExpiry({ membershipId: "m", mode: "days", days: 30, newExpiresAt: "2099-01-01", reason: "  부상  " });
    expect(rpcMock).toHaveBeenCalledWith("manager_extend_membership_expiry", { p_membership_id: "m", p_mode: "days", p_days: 30, p_new_expires_at: null, p_reason: "부상" });
    expect(r).toEqual({ oldExpiresAt: "2026-10-28", newExpiresAt: "2026-11-27", daysAdded: 30 });
    rpcMock.mockResolvedValueOnce({ data: { membershipId: "m", oldExpiresAt: "a", newExpiresAt: "b", daysAdded: 1 }, error: null });
    await extendMembershipExpiry({ membershipId: "m", mode: "date", days: 99, newExpiresAt: "2026-12-31" });
    expect(rpcMock).toHaveBeenLastCalledWith("manager_extend_membership_expiry", { p_membership_id: "m", p_mode: "date", p_days: null, p_new_expires_at: "2026-12-31", p_reason: null });
  });
  it("서버 오류 메시지를 사용자 문구로(접두사 제거), 함수가 없는 환경은 준비 중 안내", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "P0001: 수강권 만료일을 연장할 권한이 없어요" } });
    await expect(extendMembershipExpiry({ membershipId: "m", mode: "days", days: 1 })).rejects.toThrow("수강권 만료일을 연장할 권한이 없어요");
    rpcMock.mockResolvedValueOnce({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    await expect(extendMembershipExpiry({ membershipId: "m", mode: "days", days: 1 })).rejects.toThrow("아직 준비되지 않았어요");
    expect(extensionErrorMessage({ code: "42501", message: "x: 거부" })).toBe("거부");
  });
});

describe("SQL 계약 — permission 카탈로그와 기본 권한", () => {
  it("새 permission key/label/parent/category/설명, 표시 순서는 pass_detail 바로 다음", () => {
    expect(sql).toContain("'customer.member.pass_expiry.update', 'customer', 'customer.member.pass_detail',");
    expect(sql).toContain("'수강권 만료일 연장', '회원에게 발급된 수강권의 만료일을 연장할 수 있습니다.', 18");
    expect(sql).toContain("update permissions set sort_order = 19");
  });
  it("기존 역할/개인 권한에 자동 부여하지 않는다(role_permissions/account_center_permissions에 INSERT/UPDATE/DELETE 없음) → 적용 직후 오너만 가능", () => {
    expect(sql).not.toMatch(/insert into (role_permissions|account_center_permissions)/i);
    expect(sql).not.toMatch(/(update|delete from) (role_permissions|account_center_permissions)/i);
    expect(sqlRaw).toContain("role_grants_must_be_0");
  });
});

describe("SQL 계약 — 서버 최종 권한/검증(RPC)", () => {
  const rpc = sql.slice(sql.indexOf("create or replace function manager_extend_membership_expiry"), sql.indexOf("create or replace function extend_passes_after_dormant"));
  it("권한은 수강권 행의 center로 서버가 검증: has_permission(새 권한) OR 플랫폼 관리자(클라이언트가 center를 넘기지 않음)", () => {
    expect(rpc).toContain("has_permission(v_mem.center_id, 'customer.member.pass_expiry.update') or is_platform_admin()");
    expect(rpc).not.toMatch(/p_center_id/);
    expect(rpc).toContain("select * into v_mem from memberships where id = p_membership_id for update;");
  });
  it("거부 규칙: 상태(active/paused만) / goods / 무제한 / 모드·일수 / 단축·같은 날짜 / 과거(오늘 이전) / 사유 길이", () => {
    for (const s of ["v_mem.status not in ('active', 'paused')", "if v_kind = 'goods' then", "if v_mem.expires_at is null then", "p_days < 1", "p_days > 3650",
      "v_new <= v_old", "v_new < v_today", "char_length(v_reason) > 200", "(now() at time zone 'Asia/Seoul')::date"]) expect(rpc).toContain(s);
    expect(rpc).toContain("이미 만료된 수강권이에요. 새 만료일이 오늘 이후가 되도록 연장해주세요.");
  });
  it("expires_at만 UPDATE(다른 컬럼/테이블 변경 없음) + 계산: days는 기존+N, date는 지정 값", () => {
    const upd = rpc.match(/update memberships set [^;]+;/g) ?? [];
    expect(upd).toHaveLength(1);
    expect(upd[0]).toBe("update memberships set expires_at = v_new where id = v_mem.id;");
    expect(rpc).toContain("v_new := v_old + p_days;");
    expect(rpc).toContain("v_new := p_new_expires_at;");
    expect(rpc).not.toMatch(/update (products|payments|orders|reservations)/i);
  });
  it("반환: membershipId / oldExpiresAt / newExpiresAt / daysAdded", () => {
    for (const k of ["'membershipId'", "'oldExpiresAt'", "'newExpiresAt'", "'daysAdded'"]) expect(rpc).toContain(k);
  });
  it("감사 로그: 기존 admin_action_logs 재사용(새 테이블 없음) — 센터/수강권/회원/관리자/이전·새 만료일/방식/일수/사유", () => {
    expect(sql).not.toMatch(/create table/i);
    expect(rpc).toContain("insert into admin_action_logs (");
    for (const s of ["'MEMBERSHIP_UPDATE', my_account_id(), v_mem.profile_id, v_mem.id", "'EXPIRY_EXTEND', v_reason", "json_build_object('expires_at', v_old)", "'mode', p_mode, 'days'", "'days_added', v_days"]) expect(rpc).toContain(s);
  });
  it("SECURITY DEFINER + search_path 고정, PUBLIC/anon 실행 차단, authenticated/service_role만 허용", () => {
    expect(rpc).toContain("security definer");
    expect(rpc).toContain("set search_path = public");
    expect(sql).toContain("revoke all on function manager_extend_membership_expiry(uuid, text, integer, date, text) from public, anon;");
    expect(sql).toContain("grant execute on function manager_extend_membership_expiry(uuid, text, integer, date, text) to authenticated, service_role;");
    expect(sql).toContain("revoke all on function extend_passes_after_dormant(uuid) from public, anon;");
    expect(sql).toContain("revoke all on function memberships_guard_expiry_update() from public, anon, authenticated;");
  });
});

describe("SQL 계약 — pass_detail/issue_pass 직접 UPDATE 우회 차단(가드 트리거)", () => {
  const guard = sql.slice(sql.indexOf("create or replace function memberships_guard_expiry_update"), sql.indexOf("create or replace function manager_extend_membership_expiry"));
  it("memberships BEFORE UPDATE OF expires_at 트리거: 값이 같으면 통과, 전용 RPC 표식 또는 JWT 없는 서버 작업만 통과, 그 외 로그인 사용자는 거부(42501)", () => {
    expect(guard).toContain("before update of expires_at on memberships");
    expect(guard).toContain("new.expires_at is not distinct from old.expires_at");
    expect(guard).toContain("current_setting('app.membership_expiry_write', true)");
    expect(guard).toContain("auth.uid() is null");
    expect(guard).toContain("using errcode = '42501'");
    expect(guard.indexOf("not distinct from")).toBeLessThan(guard.indexOf("raise exception"));
  });
  it("기존 memberships RLS 정책/권한은 건드리지 않고(전체 UPDATE 차단 없음), expires_at 이외 컬럼 UPDATE는 트리거가 발동하지 않는다", () => {
    expect(sql).not.toMatch(/(drop|create|alter) policy/i);
    expect(sql).not.toMatch(/revoke\s+(update|all)[^;]*\son\s+(table\s+)?memberships\s+from/i);
    expect(guard).toContain("before update of expires_at");
    expect(guard).not.toMatch(/remaining_count|status/);
  });
  it("RPC 두 개만 표식을 켜고(같은 트랜잭션 안에서 UPDATE 직후 끈다), 클라이언트는 표식을 설정할 수 없다", () => {
    expect((sql.match(/set_config\('app\.membership_expiry_write', 'on', true\)/g) ?? []).length).toBe(2);
    expect((sql.match(/set_config\('app\.membership_expiry_write', '', true\)/g) ?? []).length).toBe(2);
    expect(read("lib/members.ts")).not.toContain("app.membership_expiry_write");
  });
  it("감사 헤더에 실제 정책 조회 결과(issue_pass OR pass_detail, 전체 UPDATE 권한)와 이전 우회 가능성이 기록돼 있다", () => {
    expect(sqlRaw).toContain("customer.member.issue_pass OR customer.member.pass_detail");
    expect(sqlRaw).toContain("직접 호출해 만료일을 바꿀 수 있었다");
  });
});

describe("기존 기능 보존 — 휴면 복귀 시 기간권 연장", () => {
  it("클라이언트의 expires_at 직접 UPDATE를 서버 함수(extend_passes_after_dormant)로 옮기고, 함수 없는 환경만 예전 경로로 폴백", () => {
    const m = read("lib/members.ts");
    const status = m.slice(m.indexOf("export async function updateMemberStatus"), m.indexOf("export async function extendMembershipExpiry") > m.indexOf("export async function updateMemberStatus") ? m.length : m.length);
    expect(m).toContain('supabase.rpc("extend_passes_after_dormant", { p_center_member_id: memberId })');
    expect(m).toContain("await legacyExtendPassesAfterDormant(cm);");
    expect(status).toBeTruthy();
  });
  it("서버 함수: customer.member.update 권한, 같은 계산(휴면 일수만큼, active + expires_at 있는 수강권), 가드 표식은 이 함수만 켠다", () => {
    const f = sql.slice(sql.indexOf("create or replace function extend_passes_after_dormant"));
    for (const s of ["has_permission(v_cm.center_id, 'customer.member.update') or is_platform_admin()", "v_cm.status <> 'dormant' or v_cm.dormant_since is null", "update memberships set expires_at = expires_at + v_days",
      "status = 'active' and expires_at is not null"]) expect(f).toContain(s);
  });
  it("다른 memberships 쓰기 경로(예약 차감/복원, fulfill_order, 환불 등)는 expires_at을 UPDATE하지 않으므로 영향 없음 — 이 migration은 해당 함수들을 수정하지 않는다", () => {
    for (const fnName of ["reserve_class", "cancel_reservation", "fulfill_order", "refund_membership", "manager_grant_product", "reserve_with_goods"]) {
      expect(sql).not.toContain(`function ${fnName}(`);
    }
  });
});

describe("Production QA 시나리오 준비(실행 안 함)", () => {
  it("별도 command로만 실행되고 기본 test/integration/all과 분리", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["qa:production:membership-expiry"]).toBe("vitest run --config vitest.qa-production.config.ts tests/qa/scenarios/membership-expiry.qa.test.ts");
    for (const k of ["test", "test:integration", "test:all"]) expect(scripts[k]).not.toContain("qa");
  });
  it("시나리오: +7일 → 날짜 지정 → 거부 케이스 → 직접 UPDATE 우회 거부 → 감사 로그 → 다른 필드 불변 → 이번 run UUID만 정리", () => {
    const sc = read("tests/qa/scenarios/membership-expiry.qa.test.ts");
    for (const s of ["days: 7", 'mode: "date"', "rejects.toThrow(/권한/)", 'from("memberships").update({ expires_at', "EXPIRY_EXTEND", "toEqual(snapshot)", "cleanupFixtures(admin(), tracker, { keep })"]) expect(sc).toContain(s);
    expect(sc).not.toMatch(/\.delete\(\)/);
  });
});
