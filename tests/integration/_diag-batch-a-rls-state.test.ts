/*
  일회성 진단 스크립트 — SEC-009 작업 중 staff_salaries insert가 예상과 다르게
  "new row violates row-level security policy" 에러로 실패한 것을 발견해, Batch A 5개
  테이블 전부의 실제 RLS 활성화 상태(정책 존재 여부와는 별개 — pg_policies는 PostgREST로
  조회 불가하므로 insert 시도의 에러 메시지로 간접 판정)를 확인하기 위한 진단 전용 파일이다.
  각 테이블에 대해 오너 권한으로 최소 1행 insert를 시도하고, 성공하면 즉시 삭제해 흔적을
  남기지 않는다. 결과 확인 후 이 파일 자체를 삭제한다(정식 회귀 테스트 아님).
*/
import { afterAll, beforeAll, describe, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
}, 30000);

async function probe(table: string, row: Record<string, unknown>) {
  const { data, error } = await supabase.from(table).insert(row).select("id");
  const insertedId = (data as { id: string }[] | null)?.[0]?.id;
  if (insertedId) {
    await supabase.from(table).delete().eq("id", insertedId);
  }
  // eslint-disable-next-line no-console
  console.log(`[DIAG] ${table}: ${error ? `BLOCKED (${error.code ?? "?"}: ${error.message})` : "INSERT SUCCEEDED (RLS not enforced)"}`);
}

describe("DIAG: Batch A 실제 RLS 상태 확인", () => {
  it("staff_salaries", async () => {
    await probe("staff_salaries", { center_id: centerAId, account_id: managerA.accountId, employment_type: "fulltime", base_salary: 1 });
  });
  it("contracts", async () => {
    await probe("contracts", { center_id: centerAId, profile_id: managerA.profileId, content: "diag", status: "pending" });
  });
  it("leads", async () => {
    await probe("leads", { center_id: centerAId, name: "diag" });
  });
  it("messages", async () => {
    await probe("messages", { center_id: centerAId, channel: "sms", content: "diag" });
  });
  it("notification_logs", async () => {
    await probe("notification_logs", { center_id: centerAId, channel: "sms", cost: 0 });
  });
});

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
});
