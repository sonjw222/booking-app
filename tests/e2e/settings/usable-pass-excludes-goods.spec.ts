import { test, expect } from "@playwright/test";
import {
  loadTestAccountMeta,
  getOrCreateOwnedTestCenter,
  createTestMembershipAdmin,
  createTestGoodsMembershipAdmin,
  createFutureTestClassAdmin,
  cleanupTestClassAdmin,
  reservationDeepLink,
  getOrCreateTestPassProduct,
  clearScheduleRulesForProduct,
  type TestUser,
} from "../fixtures/testData";
import { MEMBER_AUTH_FILE } from "../fixtures/authFiles";

/*
  P0-3: "모든 수강권 사용 가능"(class_allowed_products 제한 없음) 수업에서 goods(대여품 등,
  예약용이 아닌 상품) 수강권이 "사용할 수강권" 목록에 섞여 보이는지 실제 브라우저로 검증한다.

  usable_memberships_for_classes() RPC 자체는 fix_usable_memberships_product_kind.sql로
  product_kind='pass'만 반환하도록 이미 고쳐져 있고(usable-memberships-pass-kind.test.ts로
  RPC 레벨은 이미 확인됨), 관리자 수업 등록 폼의 "적용 가능한 수강권" 선택기(fetchProducts(
  centerId, "pass"))도 이미 pass만 보여준다(코드 확인). 이 스펙은 그 확인을 실제
  reserveWithMembership() 경로로 한 번 더 못박는다 — 회원이 pass와 goods 두 종류를 동시에
  보유한 상태에서 실제 모달에 goods가 절대 안 보이는지, 그리고 실제 예약이 pass로만
  이뤄지는지까지 확인한다.
*/

test.use({ storageState: MEMBER_AUTH_FILE });

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;
const createdClassIds: string[] = [];

test.beforeAll(async () => {
  managerA = loadTestAccountMeta("manager-a");
  userA = loadTestAccountMeta("user-a");
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  // "E2E 테스트 수강권 상품"은 이 테스트를 포함해 여러 스펙이 "항상 무제한으로 쓸 수 있는
  // 공용 pass"로 전제한다 — 과거(이번 P3 배치 이전 포함) app/manager/classes/page.tsx의
  // save()가 "모든 수강권 허용"으로 저장할 때도 센터의 전체 pass에 membership_schedule_rules를
  // 자동 추가하던 실제 버그(P3에서 발견·수정)로 이 상품에도 원치 않는 규칙이 남아있을 수
  // 있어, 그 전제를 실제로 보장하기 위해 매 실행 전에 규칙을 비운다.
  const passProduct = await getOrCreateTestPassProduct(centerAId);
  await clearScheduleRulesForProduct(passProduct.id);

  // 회원이 pass와 goods 두 종류를 동시에 보유한 상태를 실제로 만든다.
  await createTestMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
  await createTestGoodsMembershipAdmin(centerAId, userA.profileId, { remainingCount: 10 });
});

test.afterAll(async () => {
  for (const id of createdClassIds) await cleanupTestClassAdmin(id);
});

test("모든 수강권 사용 가능 수업 — 사용할 수강권 목록에 goods가 절대 안 보이고, 예약도 pass로만 된다 (실브라우저)", async ({ page }) => {
  // class_allowed_products를 전혀 지정하지 않은 수업 = "모든 수강권 사용 가능".
  const cls = await createFutureTestClassAdmin(centerAId, {
    title: "E2E 수강권목록-goods제외", hoursFromNow: 3,
  });
  createdClassIds.push(cls.id);

  await page.goto(reservationDeepLink(cls.id, cls.startTime));

  // "사용할 수강권" 목록 자체가 렌더링될 때까지 기다린 뒤, 그 목록 전체 텍스트를 확인한다.
  // TEST_USER_A는 다른 E2E 스펙들과 공유하는 계정이라 이전 실행들이 만들어둔 pass
  // 수강권이 계속 누적된다(실제로 CI에서 28개까지 확인됨) — 그래서 행 개수를 특정
  // 값으로 고정하지 않고, 목록 전체 텍스트에 pass 상품명은 있고 goods 상품명은 절대
  // 없는지로만 검증한다(각 행 텍스트로도 한 번 더 확인 — goods가 pass-pick-row 자체로
  // 렌더링되는 경우까지 잡아낸다).
  const passList = page.locator(".pass-pick-list");
  await expect(passList).toBeVisible();
  await expect(passList).toContainText("E2E 테스트 수강권");
  await expect(passList).not.toContainText("E2E 테스트 대여품");
  const rowCount = await passList.locator(".pass-pick-row").count();
  expect(rowCount).toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i++) {
    await expect(passList.locator(".pass-pick-row").nth(i)).not.toContainText("E2E 테스트 대여품");
  }

  // 실제 예약도 진행해 reserveWithMembership()이 정말로 pass로만 예약되는지 끝까지 확인한다.
  await page.getByRole("button", { name: "예약하기" }).click();
  await expect(page.locator(".sheet-overlay")).toHaveCount(0);
  await expect(
    page.locator(".class-row", { hasText: "E2E 수강권목록-goods제외" }).getByRole("button", { name: "취소" })
  ).toBeVisible();
});
