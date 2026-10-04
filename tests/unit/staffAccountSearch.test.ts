/* 스태프 초대 검색 개인정보 축소(2026-10-04) — 클라이언트/UI/SQL 정적 계약. DB 동작은 tests/sql/staff-account-search-privacy.test.mjs(PGlite). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const rpcCalls: [string, any][] = [];
let rpcResult: { data: any; error: any } = { data: [], error: null };
const fromCalls: string[] = [];
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return rpcResult; },
    from: (t: string) => { fromCalls.push(t); throw new Error("accounts 등 테이블 직접 조회 금지"); },
  },
}));
import { searchAccounts, STAFF_SEARCH_NEED_FULL_PHONE } from "../../lib/roles";
import { isFullKrMobile, krPhoneDigits } from "../../lib/krPhone";

beforeEach(() => { rpcCalls.length = 0; fromCalls.length = 0; rpcResult = { data: [], error: null }; });

describe("lib/roles.searchAccounts — RPC만, 센터 ID 전달, 전체 번호만", () => {
  it("완전한 번호(하이픈/+82 포함)는 search_staff_candidates(p_center_id, p_phone)만 호출, accounts 직접 조회 없음", async () => {
    rpcResult = { data: [{ account_id: "a1", name: "손지윤", phone: "010-****-5051", already_staff: false, staff_status: null }], error: null };
    for (const q of ["01023265051", "010-2326-5051", "+82 10-2326-5051"]) {
      const r = await searchAccounts("c1", q);
      expect(r).toEqual([{ id: "a1", name: "손지윤", phone: "010-****-5051", alreadyStaff: false, staffStatus: null }]);
    }
    expect(rpcCalls.map((c) => c[0])).toEqual(Array(3).fill("search_staff_candidates"));
    expect(rpcCalls[0][1]).toEqual({ p_center_id: "c1", p_phone: "01023265051" });
    expect(fromCalls).toEqual([]);
  });
  it("이름/번호 일부/짧은 입력/빈 입력은 서버를 호출하지 않고 '휴대폰 번호 전체' 안내", async () => {
    for (const q of ["손지윤", "5051", "010-2326", "010232650", "", "   ", "a@b.com"]) await expect(searchAccounts("c1", q)).rejects.toThrow(STAFF_SEARCH_NEED_FULL_PHONE);
    expect(rpcCalls).toHaveLength(0);
    expect(STAFF_SEARCH_NEED_FULL_PHONE).toContain("휴대폰 번호 전체");
  });
  it("이미 스태프 정보(alreadyStaff/staffStatus)를 전달하고, 합성 이름은 '이름 미등록', 권한/로그인 오류 메시지는 그대로, 함수 없음은 업데이트 안내", async () => {
    rpcResult = { data: [{ account_id: "a2", name: "92wr87mcz5", phone: "010-****-5051", already_staff: true, staff_status: "pending" }], error: null };
    expect(await searchAccounts("c1", "01023265051")).toEqual([{ id: "a2", name: "이름 미등록", phone: "010-****-5051", alreadyStaff: true, staffStatus: "pending" }]);
    rpcResult = { data: null, error: { code: "P0001", message: "스태프를 추가할 권한이 없어요" } };
    await expect(searchAccounts("c1", "01023265051")).rejects.toThrow("스태프를 추가할 권한이 없어요");
    rpcResult = { data: null, error: { code: "PGRST202", message: "not found" } };
    await expect(searchAccounts("c1", "01023265051")).rejects.toThrow("사용할 수 없어요");
  });
  it("정규화 helper는 서버 kr_phone_digits와 같은 규칙", () => {
    for (const [i, o] of [["010-1234-5678", "01012345678"], ["+82 10-1234-5678", "01012345678"], ["+82-010-1234-5678", "01012345678"], ["821012345678", "01012345678"], ["abc", ""]]) expect(krPhoneDigits(i)).toBe(o);
    expect(isFullKrMobile("010-1234-5678")).toBe(true); expect(isFullKrMobile("1234")).toBe(false); expect(isFullKrMobile("0212345678")).toBe(false);
  });
  it("소스: ilike/or(name…) 전역 검색, accounts 직접 select가 없다", () => {
    const fn = read("lib/roles.ts").slice(read("lib/roles.ts").indexOf("export async function searchAccounts"));
    const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
    expect(body).toContain('supabase.rpc("search_staff_candidates", { p_center_id: centerId, p_phone: phone.trim() })');
    expect(body).not.toMatch(/\.from\(|ilike|\.or\(/);
  });
});

describe("스태프 추가 화면", () => {
  const page = read("app/manager/staff/page.tsx");
  it("전체 휴대폰 번호 검색임을 안내하고 centerId로 검색, 이미 스태프면 추가 버튼 비노출", () => {
    expect(page).toContain("휴대폰 번호 전체");
    expect(page).toContain("이름이나 번호 일부로는 검색되지 않아요");
    expect(page).toContain("searchAccounts(centerId, searchKw)");
    expect(page).toContain("a.alreadyStaff");
    expect(page).toContain("이미 이 센터의 스태프예요");
    expect(page).not.toContain('placeholder="이름 또는 전화번호"');
    expect(page).toContain("inviteStaff(centerId, accountId, inviteRoleId)");   // 신규 후보의 기존 초대 흐름 유지
  });
});

describe("SQL 정적 계약", () => {
  const sql = read("fix_staff_account_search_privacy_20261004.sql").replace(/--.*$/gm, "");
  it("RPC: SECURITY DEFINER + search_path 고정 + PUBLIC/anon 회수 + 센터별 권한 + 정규화 정확 일치 + 병합/비활성 제외 + 마스킹 + 중복 거부", () => {
    expect(sql).toMatch(/security definer\s+set search_path = public/);
    expect(sql).toContain("revoke all on function public.search_staff_candidates(uuid, text) from public, anon;");
    expect(sql).toContain("has_permission(p_center_id, 'facility.staff.create')");
    expect(sql).toContain("public.kr_phone_digits(a.phone) = v_digits");
    expect(sql).toContain("a.merged_into is null");
    expect(sql).toContain("a.deactivated_at is null");
    expect(sql).toContain("left(v_digits, 3) || '-****-' || right(v_digits, 4)");
    expect(sql).toContain("같은 번호로 가입한 계정이 여러 개예요");
    expect(sql).toContain("auth.uid() is null");
    expect(sql.slice(0, sql.indexOf("create policy"))).not.toMatch(/\bi?like\b/i);
  });
  it("accounts '계정 조회': 전역 owner/staff.create 절 제거, 관계 기반 4개 유지, rollback은 직전 광범위 정책 복원", () => {
    const pol = sql.slice(sql.indexOf("create policy"));
    expect(pol).not.toMatch(/facility\.staff\.create|is_owner|role_permissions|center_roles/);
    for (const keep of ["auth_id = auth.uid()", "account_auth_identities", "from manager_centers mc", "join center_members cm"]) expect(pol).toContain(keep);
    const rb = read("rollback_fix_staff_account_search_privacy_20261004.sql");
    expect(rb).toContain("facility.staff.create");
    expect(rb).toContain("보안상 위험한 rollback");
    expect(rb).toContain("drop function if exists public.search_staff_candidates(uuid, text);");
  });
  it("범위: 이 migration은 RPC 1개 + accounts 정책 1개만(다른 테이블/함수/정책 변경 없음)", () => {
    expect([...sql.matchAll(/create or replace function public\.(\w+)/g)].map((m) => m[1])).toEqual(["search_staff_candidates"]);
    expect([...sql.matchAll(/(?:create|drop) policy (?:if exists )?"([^"]+)"/g)].map((m) => m[1])).toEqual(["계정 조회", "계정 조회"]);
    expect(sql).not.toMatch(/alter table|create table|create trigger|update public\.|delete from|insert into/);
  });
});
