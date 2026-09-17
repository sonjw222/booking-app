/*
  릴리스 폴리시 배치 8차(2026-09-17): 관리자 알림 "전체 삭제"(3-2)와 "고정/고정 해제"(3-3)
  회귀 가드.
  - pinned는 add_notification_pin.sql로 추가한 실제 컬럼 — 여기서는 서비스 역할 client로
    알림 fixture 행을 직접 만들고, 일반(RLS 적용) 세션으로 lib/notifications.ts의 함수를
    그대로 호출해 정합성을 확인한다.
  - 전체 삭제가 다른 계정(센터)의 알림까지 지우면 안 된다(격리 회귀 가드,
    notification-center-isolation.test.ts와 같은 취지를 delete 경로에도 적용).
  ⚠ 이 파일은 실제 Supabase 테스트 프로젝트(.env.test.local 또는 CI Secrets)가 필요해
    로컬에 자격증명이 없는 환경에서는 실행할 수 없다 — 기존 tests/integration의 다른
    파일들과 동일한 제약(docs/AUTOMATED_QA.md 참고).
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import { deleteAllNotifications, fetchNotifications, setNotificationPinned } from "../../lib/notifications";
import {
  switchToTestUser, signOutTestSession, type TestUser, getFixtureAdminClient,
  describeAdminQueryError,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
const MANAGER_B = { email: "TEST_MANAGER_B_EMAIL", password: "TEST_MANAGER_B_PASSWORD" };

let managerA: TestUser;
let managerB: TestUser;
const seededIds: string[] = [];

async function seedNotification(accountId: string, title: string): Promise<string> {
  const admin = getFixtureAdminClient();
  const { data, error } = await admin
    .from("notifications")
    .insert({ recipient_account_id: accountId, kind: "announcement", title, body: "", pinned: false })
    .select("id")
    .single();
  if (error || !data) throw new Error(describeAdminQueryError("notifications", error));
  seededIds.push((data as any).id);
  return (data as any).id as string;
}

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  await signOutTestSession();
  managerB = await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
  await signOutTestSession();
}, 30000);

afterAll(async () => {
  // 혹시 테스트가 delete-all 전에 실패해 남은 행이 있으면 서비스 역할로 정리.
  if (seededIds.length > 0) {
    const admin = getFixtureAdminClient();
    await admin.from("notifications").delete().in("id", seededIds).then(() => {}, () => {});
  }
  await signOutTestSession();
}, 30000);

describe("관리자 알림 고정/전체 삭제", () => {
  it("고정 토글이 서버에 영구 저장된다(React state/localStorage 아님)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const id = await seedNotification(managerA.accountId, "P8 고정 테스트");

    await setNotificationPinned(id, true);
    const { data: row1 } = await supabase.from("notifications").select("pinned").eq("id", id).single();
    expect((row1 as any)?.pinned).toBe(true);

    // 세션을 완전히 끊고 다시 로그인해도(=클라이언트 상태를 전부 버려도) 유지되는지 확인
    // — 이게 "영구 저장"의 실질적 증거(로컬 state/localStorage였다면 여기서 사라짐).
    await signOutTestSession();
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const list = await fetchNotifications();
    const found = list.find((n) => n.id === id);
    expect(found?.pinned).toBe(true);

    await setNotificationPinned(id, false);
  }, 20000);

  it("고정된 알림이 목록 최상단에 온다(고정 우선, 그다음 최신순)", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const olderId = await seedNotification(managerA.accountId, "P8 정렬-오래된 일반 알림");
    await new Promise((r) => setTimeout(r, 1100)); // created_at 초 단위 정렬 차이를 보장
    const newerId = await seedNotification(managerA.accountId, "P8 정렬-최신 일반 알림");
    await setNotificationPinned(olderId, true); // 더 오래됐지만 고정이라 최상단이어야 함

    const list = await fetchNotifications();
    const olderIdx = list.findIndex((n) => n.id === olderId);
    const newerIdx = list.findIndex((n) => n.id === newerId);
    expect(olderIdx).toBeGreaterThanOrEqual(0);
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeLessThan(newerIdx);

    await setNotificationPinned(olderId, false);
  }, 20000);

  it("전체 삭제는 본인(내 계정) 알림만 지우고, pinned 알림도 포함하며, 다른 계정 알림은 건드리지 않는다", async () => {
    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    const pinnedId = await seedNotification(managerA.accountId, "P8 전체삭제-고정됨");
    const normalId = await seedNotification(managerA.accountId, "P8 전체삭제-일반");
    await setNotificationPinned(pinnedId, true);

    await switchToTestUser(MANAGER_B.email, MANAGER_B.password);
    const otherAccountId = await seedNotification(managerB.accountId, "P8 전체삭제-다른계정(격리 확인용)");

    await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
    await deleteAllNotifications();

    const { data: remainA } = await supabase
      .from("notifications").select("id").in("id", [pinnedId, normalId]);
    expect((remainA ?? []).length).toBe(0); // pinned 포함 전부 삭제됨

    // 서비스 역할로 확인: B 계정의 알림은 그대로 살아있어야 한다(격리).
    const admin = getFixtureAdminClient();
    const { data: remainB, error } = await admin
      .from("notifications").select("id").eq("id", otherAccountId);
    if (error) throw new Error(describeAdminQueryError("notifications", error));
    expect((remainB ?? []).length).toBe(1);
    await admin.from("notifications").delete().eq("id", otherAccountId);
  }, 20000);
});
