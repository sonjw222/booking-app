// 읽기 전용 사전검사(vitest globalSetup). DB 쓰기·권한 변경·자동 복구 없음 — SELECT/listUsers만 사용한다.
// 하나라도 어긋나면 테스트 시작 전에 BLOCKED로 중단하고, 아무것도 고치지 않는다(사람이 확인해야 한다).
import "./loadEnv";

const ACK = "I-ACK-SHARED-DEV-ADMIN-TOGGLE";
const QA_PLAN_PREFIX = "QA 테스트 제한 플랜-";

export default async function privilegedPreflight() {
  if (process.env.ALLOW_PRIVILEGED_DEV_TESTS !== "1" || process.env.PRIVILEGED_DEV_TESTS_ACK !== ACK) {
    throw new Error(
      "BLOCKED: 이 수동 스위트는 공유 DEV 계정을 임시로 플랫폼 관리자로 승격하고 전역 기본 요금제를 바꾼다. " +
        `ALLOW_PRIVILEGED_DEV_TESTS=1 과 PRIVILEGED_DEV_TESTS_ACK=${ACK} 를 사람이 명시해야 시작한다(일반 CI는 설정하지 않는다).`
    );
  }
  const { getFixtureAdminClient } = await import("./setup");
  const admin = getFixtureAdminClient();

  // 1) 승격 대상 공유 계정(MANAGER_A/MANAGER_B/USER_B)이 이미 플랫폼 관리자이면 중단 — 이전 실행의 잔여이거나 의도된 운영 계정일 수 있다.
  const emails = new Set(
    ["TEST_MANAGER_A_EMAIL", "TEST_MANAGER_B_EMAIL", "TEST_USER_B_EMAIL"].map((n) => (process.env[n] ?? "").toLowerCase()).filter(Boolean)
  );
  const authIds: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("BLOCKED: 사전검사 계정 조회 실패(읽기): " + error.message);
    for (const u of data.users) if (u.email && emails.has(u.email.toLowerCase())) authIds.push(u.id);
    if (data.users.length < 200) break;
  }
  if (authIds.length === 0) throw new Error("BLOCKED: 공유 테스트 계정을 찾지 못해 승격 상태를 확인할 수 없다");
  const { data: accounts, error: accErr } = await admin.from("accounts").select("id,is_platform_admin").in("auth_id", authIds);
  if (accErr) throw new Error("BLOCKED: accounts 조회 실패(읽기): " + accErr.message);
  const elevated = (accounts ?? []).filter((a) => a.is_platform_admin === true);
  if (elevated.length > 0) {
    throw new Error(`BLOCKED: 공유 테스트 계정 ${elevated.length}개가 이미 is_platform_admin=true 이다. 자동으로 복구하지 않는다 — 원인 확인 후 사람이 처리하라.`);
  }

  // 2) 전역 기본 요금제가 정확히 1개이고 QA 플랜이 아니어야 한다. 오염되어 있어도 자동으로 바꾸지 않는다.
  const { data: defaults, error: planErr } = await admin.from("subscription_plans").select("id,name").eq("is_default", true);
  if (planErr) throw new Error("BLOCKED: subscription_plans 조회 실패(읽기): " + planErr.message);
  if ((defaults ?? []).length !== 1) throw new Error(`BLOCKED: 전역 기본 요금제가 ${(defaults ?? []).length}개이다(정확히 1개여야 함). 자동으로 변경하지 않는다.`);
  if (String(defaults![0].name).startsWith(QA_PLAN_PREFIX)) {
    throw new Error("BLOCKED: 전역 기본 요금제가 QA 테스트 플랜으로 오염되어 있다. 자동으로 변경하지 않는다 — 사람이 확인·복구하라.");
  }
}
