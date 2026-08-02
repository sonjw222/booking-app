/*
  일회성 진단(읽기 전용 + self-cleaning) — A1 SQL 실행 승인 직전 최종 안전 점검.
  1) 16개 permission key가 실제 permissions 카탈로그에 있는지 확인.
  2) 3개 테이블이 여전히 "RLS 활성 + 정책 0건"인지 재확인(INSERT 시도로 간접 확인,
     성공하면 즉시 삭제 — 이전에 이미 검증된 안전한 패턴).
  결과 확인 후 이 파일은 삭제한다.
*/
import { beforeAll, describe, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

const REQUIRED_KEYS = [
  "facility.salary.own.view",
  "facility.salary.other.view",
  "facility.salary.own.update",
  "facility.salary.other.update",
  "customer.lead.view",
  "customer.lead.create",
  "customer.lead.update",
  "customer.lead.delete",
  "message.sms.view",
  "message.sms.send",
  "message.sms.update",
  "message.sms.delete",
  "message.push.view",
  "message.push.send",
  "message.push.update",
  "message.push.delete",
];

let managerA: TestUser;
let centerAId: string;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);
}, 30000);

describe("DIAG-FINAL: A1 실행 승인 직전 안전 점검", () => {
  it("permissions 카탈로그에 16개 key 전부 존재하는지", async () => {
    const { data, error } = await supabase
      .from("permissions")
      .select("key")
      .in("key", REQUIRED_KEYS);
    if (error) throw new Error("permissions 조회 실패: " + error.message);
    const found = new Set((data ?? []).map((r: any) => r.key));
    const missing = REQUIRED_KEYS.filter((k) => !found.has(k));
    // eslint-disable-next-line no-console
    console.log(`[DIAG-FINAL] permissions catalog: found ${found.size}/${REQUIRED_KEYS.length}, missing=[${missing.join(", ")}]`);
  });

  it("staff_salaries/leads/messages가 여전히 정책 0건(RLS 활성)인지", async () => {
    async function probe<T extends Record<string, unknown>>(table: string, row: T) {
      const { data, error } = await supabase.from(table).insert(row).select("id");
      const insertedId = (data as { id: string }[] | null)?.[0]?.id;
      if (insertedId) {
        await supabase.from(table).delete().eq("id", insertedId);
      }
      // eslint-disable-next-line no-console
      console.log(`[DIAG-FINAL] ${table} owner INSERT: ${error ? `BLOCKED (${error.code ?? "?"}: ${error.message})` : "SUCCEEDED (정책이 이미 생겼을 수 있음!)"}`);
    }
    await probe("staff_salaries", { center_id: centerAId, account_id: managerA.accountId, employment_type: "fulltime", base_salary: 1 });
    await probe("leads", { center_id: centerAId, name: "diag-final" });
    await probe("messages", { center_id: centerAId, channel: "sms", content: "diag-final" });
  });
});
