/*
  1:1 문의(inquiry_threads/inquiry_messages) 접근 격리 회귀 테스트.
  사용자가 요청한 "회원/관리자 문의 접근 격리" 통합테스트 — 기존에는 이 항목에 대한 자동
  테스트가 전혀 없었다(코드 리딩으로만 RLS 정책 존재를 확인했을 뿐). 실제 RLS가 다른
  회원/다른 센터 관리자의 열람을 막는지 직접 검증한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { switchToTestUser, getOrCreateOwnedTestCenter, type TestUser } from "./setup";
import { openThread, sendMessage } from "../../lib/inquiries";

const USER_A = { email: "TEST_USER_A_EMAIL", password: "TEST_USER_A_PASSWORD" };
const USER_B = { email: "TEST_USER_B_EMAIL", password: "TEST_USER_B_PASSWORD" };
const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

let userA: TestUser;
let managerA: TestUser;
let centerAId: string;
let threadId: string;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  userA = await switchToTestUser(USER_A.email, USER_A.password);
  threadId = await openThread(centerAId);
  await sendMessage(threadId, "격리 테스트용 문의 메시지");
}, 30000);

afterAll(async () => {
  // 문의방/메시지는 DELETE 권한이 일반 계정에 없어(append-only 성격) 별도 정리는 하지 않는다
  // — 기존 문의 관련 테스트 관례와 동일.
});

describe("문의 접근 격리: 본인 것이 아닌 문의방은 RLS로 조회되지 않는다", () => {
  it("다른 회원(USER_B)은 USER_A의 문의방을 목록/직접조회 모두에서 볼 수 없다", async () => {
    await switchToTestUser(USER_B.email, USER_B.password);
    const { data, error } = await supabase
      .from("inquiry_threads").select("id").eq("id", threadId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("다른 회원(USER_B)은 그 문의방의 메시지도 조회할 수 없다", async () => {
    await switchToTestUser(USER_B.email, USER_B.password);
    const { data, error } = await supabase
      .from("inquiry_messages").select("id").eq("thread_id", threadId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("이 센터를 관리하지 않는 매니저(MANAGER_B)는 이 문의방을 볼 수 없다", async () => {
    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const { data, error } = await supabase
      .from("inquiry_threads").select("id").eq("id", threadId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("본인(USER_A)은 자기 문의방을 정상 조회할 수 있다", async () => {
    await switchToTestUser(USER_A.email, USER_A.password);
    const { data, error } = await supabase
      .from("inquiry_threads").select("id").eq("id", threadId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("이 센터를 관리하는 매니저(MANAGER_A)는 이 문의방을 정상 조회할 수 있다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const { data, error } = await supabase
      .from("inquiry_threads").select("id").eq("id", threadId);
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });
});
