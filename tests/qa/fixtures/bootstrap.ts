/*
  QA 센터 + QA 매니저(owner) + QA 회원 준비를 한 번에 — 모든 시나리오가 재사용한다(idempotent).
  로그인은 기존 통합 테스트의 get-or-create 헬퍼(switchToTestUser)를 그대로 쓴다: auth.users에 SQL INSERT 하지 않는다.
*/
import { getFixtureAdminClient, switchToTestUser, type TestUser } from "../../integration/setup";
import { auditQaAccountRelations, ensureQaCenter, ensureQaMember, type QaFixtureState } from "./center";
import { writeQaState } from "./state";

export async function bootstrapQa(): Promise<{ state: QaFixtureState; manager: TestUser; member: TestUser; warnings: string[] }> {
  const admin = getFixtureAdminClient();
  const manager = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  const centerId = await ensureQaCenter(admin, manager.accountId);
  // 마지막에 로그인한 계정이 남으므로 QA 회원을 마지막에 로그인한다(시나리오는 회원 세션으로 실제 앱 경로를 호출).
  const member = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
  await ensureQaMember(admin, centerId, member.profileId);
  const warnings = await auditQaAccountRelations(admin, centerId, { managerAccountId: manager.accountId, memberProfileId: member.profileId });
  const state: QaFixtureState = { centerId, managerAccountId: manager.accountId, memberAccountId: member.accountId, memberProfileId: member.profileId };
  writeQaState(state);
  for (const w of warnings) console.warn(`[QA 경고] ${w}`);
  return { state, manager, member, warnings };
}
