// Integration 전체가 공유하는 센터의 예약 정책을 테스트 친화적인 기준값으로 고정한다.
// E2E의 "일일 예약 제한" 시나리오가 원래 설정(예: 1회 제한)을 복구한 뒤 Integration이
// 이어서 실행되면, 예약 정책 자체를 검증하지 않는 수십 개 테스트까지 그 제한에 막힌다.
// suite 시작 전에 필요한 두 필드만 격리하고, 종료 시 사용자의 원래 설정으로 되돌린다.
import "./loadEnv";

export default async function setupIntegrationBookingPolicy() {
  const {
    switchToTestUser,
    getOrCreateOwnedTestCenter,
    getFixtureAdminClient,
  } = await import("./setup");

  const manager = await switchToTestUser(
    "TEST_MANAGER_A_EMAIL",
    "TEST_MANAGER_A_PASSWORD"
  );
  const centerId = await getOrCreateOwnedTestCenter(manager);
  const admin = getFixtureAdminClient();

  const { data: original, error: readError } = await admin
    .from("center_settings")
    .select("daily_book_limit_enabled, daily_book_limit")
    .eq("center_id", centerId)
    .maybeSingle();
  if (readError) {
    throw new Error(`Integration 예약 정책 조회 실패: ${readError.message}`);
  }

  const { error: baselineError } = await admin
    .from("center_settings")
    .upsert(
      {
        center_id: centerId,
        daily_book_limit_enabled: false,
        daily_book_limit: null,
      },
      { onConflict: "center_id" }
    );
  if (baselineError) {
    throw new Error(`Integration 예약 정책 격리 실패: ${baselineError.message}`);
  }

  return async () => {
    const { error: restoreError } = await admin
      .from("center_settings")
      .upsert(
        {
          center_id: centerId,
          daily_book_limit_enabled: original?.daily_book_limit_enabled ?? false,
          daily_book_limit: original?.daily_book_limit ?? null,
        },
        { onConflict: "center_id" }
      );
    if (restoreError) {
      throw new Error(`Integration 예약 정책 원복 실패: ${restoreError.message}`);
    }
  };
}
