/*
  add_email_signup_precheck.sql의 consume_email_check_attempt() 판정 로직(10분 윈도우, 20회
  임계값: "20회 미만이면 허용+기록, 20회 이상이면 거부")을 그대로 옮긴 순수 함수로 경계값을
  검증한다.

  주의: 이것은 실제 Postgres RPC를 실행하는 통합 테스트가 아니다(이 프로젝트의 unit 테스트는
  DB 없이 도는 것이 관례 — vitest.config.ts 참고). 실제 원자성(동시 요청 직렬화)은
  pg_advisory_xact_lock 사용 여부를 tests/unit/emailSignupPrecheckSql.staticCheck.test.ts가
  SQL 텍스트로 정적 검토한다. 여기서는 그 잠금이 보장하는 "직렬화된 한 번에 하나씩 처리"
  가정 하에서 판정 로직 자체(카운트 임계값 비교)가 스펙대로 정확히 20/21에서 갈리는지만
  숫자로 고정한다.
*/
import { describe, expect, it } from "vitest";

// add_email_signup_precheck.sql의 consume_email_check_attempt 본문을 그대로 옮긴 순수 함수.
// recentCount = 이번 요청 "이전"까지 이 IP 해시로 10분 안에 기록된 행 수.
function consumeAttempt(recentCount: number): boolean {
  if (recentCount >= 20) return false;
  return true; // 이 분기에서만 실제로 insert(기록)가 일어난다
}

describe("rate limit 판정 경계값(10분/20회)", () => {
  it("0~19번째 요청(recentCount 0~19)은 허용된다 — 총 20개까지 기록 가능", () => {
    for (let recentCount = 0; recentCount < 20; recentCount++) {
      expect(consumeAttempt(recentCount)).toBe(true);
    }
  });

  it("21번째 요청(recentCount === 20, 이미 20개 기록됨)은 차단된다", () => {
    expect(consumeAttempt(20)).toBe(false);
  });

  it("그 이후(recentCount > 20)도 계속 차단된다", () => {
    expect(consumeAttempt(21)).toBe(false);
    expect(consumeAttempt(100)).toBe(false);
  });

  it("한 IP 해시가 10분 윈도우 안에서 가질 수 있는 기록 행의 최댓값은 20이다", () => {
    let stored = 0;
    for (let i = 0; i < 25; i++) {
      if (consumeAttempt(stored)) stored++;
    }
    expect(stored).toBe(20);
  });
});
