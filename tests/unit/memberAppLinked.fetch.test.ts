/* UX-14 — 관리자 회원 목록의 "앱 계정 연결"과 "전화번호"가 서로 다른 상태로 계산되는지 fetchMemberBase 전체 경로로 검증(로컬 메모리 fixture, 네트워크 없음). */
import { describe, expect, it, vi } from "vitest";

const centerMembers = [
  // 전화번호 없음 + 저장 플래그 false 이지만 프로필이 앱 계정(account_id)을 가리킴 → 연결됨(감사에서 본 '통합테스트' 회원)
  { id: "cm1", profile_id: "p1", grade_id: null, registered_at: "2026-10-01", last_attended_at: null, app_linked: false, memo: null, status: "active", profiles: { name: "통합테스트", account_id: "acc-1", accounts: { address: null } }, member_grades: null },
  // 가족(추가) 프로필 — 같은 계정 소유, 전화번호는 계정에 있음
  { id: "cm2", profile_id: "p2", grade_id: null, registered_at: "2026-10-02", last_attended_at: null, app_linked: false, memo: null, status: "active", profiles: { name: "자녀", account_id: "acc-1", accounts: { address: null } }, member_grades: null },
  // 실제 미연결: 프로필이 계정을 가리키지 않고 저장 플래그도 없음
  { id: "cm3", profile_id: "p3", grade_id: null, registered_at: "2026-10-03", last_attended_at: null, app_linked: false, memo: null, status: "active", profiles: { name: "수기등록", account_id: null, accounts: null }, member_grades: null },
];
const phones: Record<string, string | null> = { p1: null, p2: "010-1111-2222", p3: null };

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const done = () => Promise.resolve({ data: table === "center_members" ? centerMembers : [], error: null, count: table === "center_members" ? centerMembers.length : 0 });
      for (const m of ["select", "eq", "in", "order", "range", "limit", "neq"]) chain[m] = () => chain;
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => done().then(res, rej);
      return chain;
    },
    rpc(fn: string, args: { p_profile_ids?: string[] }) {
      if (fn !== "fetch_member_phones_safe") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({ data: (args.p_profile_ids ?? []).map((id) => ({ profile_id: id, account_phone: phones[id] ?? null })), error: null });
    },
  },
}));

import { fetchMemberBase } from "../../lib/members";

describe("fetchMemberBase — 앱 연결과 전화번호는 별개 상태 (UX-14)", () => {
  it("연락처 없는 연결 회원 / 가족 프로필 / 실제 미연결 회원을 각각 구분한다", async () => {
    const rows = await fetchMemberBase("center-1");
    const by = Object.fromEntries(rows.map((r) => [r.profileId, r]));
    expect(by.p1).toMatchObject({ appLinked: true, phoneRegistered: false, phone: null });       // 번호 없음 ≠ 앱 미연결
    expect(by.p2).toMatchObject({ appLinked: true, phoneRegistered: true, phone: "010-1111-2222" });
    expect(by.p3).toMatchObject({ appLinked: false, phoneRegistered: false });                    // 실제 미연결만 미연결
  });
});
