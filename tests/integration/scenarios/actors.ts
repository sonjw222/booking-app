/*
  Automated Business Scenario E2E Batch(2026-09-18) — 요청 3번: Actor 설계.

  memberA/memberB는 기존 tests/integration/setup.ts의 TEST_USER_A/TEST_USER_B를 그대로
  재사용한다(새 계정 안 만듦). 대기 승격 순서 검증(SCN-P0-24)처럼 3명 이상의 독립적인
  "예약 주체"가 필요한 시나리오를 위한 memberC/memberD는 — 새 로그인 계정(새 Secret)을
  요구하는 대신, 기존 계정(TEST_USER_A) 안에 실제 앱이 지원하는 "가족/추가 프로필"
  기능(lib/profiles.ts의 addProfile(), app/profiles/page.tsx)으로 서브 프로필을 만들어
  충당한다 — capacity/waitlist 로직은 profile_id 단위로 동작하므로(schema.sql의
  unique_active_reservation 인덱스도 profile_id 기준) 실제 검증 목적에 완전히 부합하고,
  새 Secret/새 계정이 전혀 필요 없다.

  disposableMember(탈퇴 시나리오 전용)는 이 파일에 없음 — 실제 삭제를 수반하는 위험한
  작업이라 별도 파일(account-deletion 관련)에서, 그것도 이번 배치의 안전성 감사 결과에
  따라 별도로 다룬다(최종 보고서 참고).
*/
import { supabase } from "../../../lib/supabaseClient";
import { switchToTestUser, type TestUser } from "../setup";

export type Actor = TestUser & { role: string };

export async function memberA(): Promise<Actor> {
  const u = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  return { ...u, role: "memberA" };
}

export async function memberB(): Promise<Actor> {
  const u = await switchToTestUser("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD");
  return { ...u, role: "memberB" };
}

export async function managerA(): Promise<Actor> {
  const u = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  return { ...u, role: "managerA" };
}

export async function managerB(): Promise<Actor> {
  const u = await switchToTestUser("TEST_MANAGER_B_EMAIL", "TEST_MANAGER_B_PASSWORD");
  return { ...u, role: "managerB" };
}

// TEST_USER_A 계정 안에 "memberC"라는 이름의 서브 프로필을 get-or-create한다. 반드시
// memberA()로 로그인된 상태에서 호출해야 한다(addProfile과 동일하게 RLS가 "로그인한
// 계정 소유"만 허용 — 서비스 역할 우회 없음, 실제 회원이 가족 프로필을 추가하는 것과
// 완전히 동일한 경로).
export async function memberCSubProfile(ownerAccountId: string): Promise<Actor> {
  const { data: existing, error: findErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("account_id", ownerAccountId)
    .eq("name", "QA-memberC")
    .is("deleted_at", null)
    .maybeSingle();
  if (findErr) throw new Error(`memberC 서브 프로필 조회 실패: ${findErr.message}`);
  if (existing) return { accountId: ownerAccountId, profileId: (existing as any).id, role: "memberC" };

  const { data, error } = await supabase
    .from("profiles")
    .insert({ account_id: ownerAccountId, name: "QA-memberC", is_primary: false })
    .select("id")
    .single();
  if (error || !data) throw new Error(`memberC 서브 프로필 생성 실패: ${error?.message ?? "no data"}`);
  return { accountId: ownerAccountId, profileId: (data as any).id, role: "memberC" };
}

// memberD는 TEST_USER_B 계정 안의 서브 프로필 — memberC와 다른 소유 계정을 씀으로써
// "서로 다른 계정의 두 대기자"라는 좀 더 현실적인 구성을 만든다(굳이 필요하지 않은
// 시나리오는 memberC만 써도 됨).
export async function memberDSubProfile(ownerAccountId: string): Promise<Actor> {
  const { data: existing, error: findErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("account_id", ownerAccountId)
    .eq("name", "QA-memberD")
    .is("deleted_at", null)
    .maybeSingle();
  if (findErr) throw new Error(`memberD 서브 프로필 조회 실패: ${findErr.message}`);
  if (existing) return { accountId: ownerAccountId, profileId: (existing as any).id, role: "memberD" };

  const { data, error } = await supabase
    .from("profiles")
    .insert({ account_id: ownerAccountId, name: "QA-memberD", is_primary: false })
    .select("id")
    .single();
  if (error || !data) throw new Error(`memberD 서브 프로필 생성 실패: ${error?.message ?? "no data"}`);
  return { accountId: ownerAccountId, profileId: (data as any).id, role: "memberD" };
}
