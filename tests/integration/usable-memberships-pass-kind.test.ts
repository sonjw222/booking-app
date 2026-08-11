/*
  Track 6 재검증 — "예약창 '적용 가능한 수강권' 목록에 상품까지 같이 표시된다"는 보고의
  실제 원인 확인.

  app/reservation/page.tsx의 JSX를 코드 추적한 결과, 보유 수강권(usablePassesByClass)과
  구매 가능 상품(purchasableByClass)은 이미 서로 다른 영역에 분리 렌더링되고 있어 UI
  구조 자체는 문제가 없었다. 남은 유력한 원인은 usable_memberships_for_classes() RPC가
  실제로 product_kind='goods'(대여품 등, 예약용 수강권이 아님)까지 "사용 가능한 수강권"
  으로 잘못 반환하고 있을 가능성 — 이 테스트가 실제 라이브 DB로 그 여부를 직접 확인한다.
*/
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../lib/supabaseClient";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  createFutureTestClass,
  cleanupTestClass,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";

const MANAGER_A = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };

let managerA: TestUser;
let centerAId: string;
let classId: string;
let goodsProductId: string;
let goodsMembershipId: string;

beforeAll(async () => {
  managerA = await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  centerAId = await getOrCreateOwnedTestCenter(managerA);

  const cls = await createFutureTestClass(centerAId, { title: "USABLE-PASS-KIND 테스트 수업", hoursFromNow: 240 });
  classId = cls.id;

  // get-or-create(2026-08 공유 센터 오염 진단 후 도입) — afterAll이 매번 지우긴 하지만, CI가
  // 중간 취소되면(GitHub Actions concurrency.cancel-in-progress, 또는 사람이 새 실행을 다시
  // 트리거) afterAll 자체가 실행되지 않아 정리되지 않은 채 남는다. 실측 진단에서 이 상품/
  // 수강권이 45건 넘게 고아 상태로 쌓여 있는 것을 확인했다 — beforeAll을 self-healing하게
  // 만들어 남아있으면 재사용하고, afterAll이 정상 실행되는 한 여전히 매번 깨끗하게 지워진다.
  const admin = getFixtureAdminClient();
  const { data: existingProduct, error: findProdErr } = await admin
    .from("products")
    .select("id")
    .eq("center_id", centerAId).eq("name", "USABLE-PASS-KIND 테스트 대여품").eq("product_kind", "goods")
    .maybeSingle();
  if (findProdErr) throw new Error("goods 상품 조회 실패: " + findProdErr.message);
  if (existingProduct) {
    goodsProductId = existingProduct.id;
  } else {
    const { data: product, error: prodErr } = await supabase
      .from("products")
      .insert({ center_id: centerAId, name: "USABLE-PASS-KIND 테스트 대여품", price: 1000, product_kind: "goods" })
      .select("id").single();
    if (prodErr || !product) throw new Error("goods 상품 생성 실패: " + prodErr?.message);
    goodsProductId = (product as any).id;
  }

  const { data: existingMem, error: findMemErr } = await admin
    .from("memberships")
    .select("id")
    .eq("profile_id", managerA.profileId).eq("center_id", centerAId).eq("product_id", goodsProductId)
    .limit(1);
  if (findMemErr) throw new Error("goods membership 조회 실패: " + findMemErr.message);
  if (existingMem && existingMem.length > 0) {
    goodsMembershipId = existingMem[0].id;
    const { error: refreshErr } = await supabase
      .from("memberships")
      .update({
        remaining_count: 1,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        status: "active",
      })
      .eq("id", goodsMembershipId);
    if (refreshErr) throw new Error("goods membership 갱신 실패: " + refreshErr.message);
  } else {
    const { data: mem, error: memErr } = await supabase
      .from("memberships")
      .insert({
        profile_id: managerA.profileId, center_id: centerAId, product_id: goodsProductId,
        product_name: "USABLE-PASS-KIND 테스트 대여품", pass_type: "count",
        total_count: 1, remaining_count: 1,
        expires_at: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        status: "active",
      })
      .select("id").single();
    if (memErr || !mem) throw new Error("goods membership 생성 실패: " + memErr?.message);
    goodsMembershipId = (mem as any).id;
  }
}, 30000);

afterAll(async () => {
  await switchToTestUser(MANAGER_A.email, MANAGER_A.password);
  const errors: string[] = [];
  try { if (goodsMembershipId) await supabase.from("memberships").delete().eq("id", goodsMembershipId); } catch (e: any) { errors.push(e.message); }
  try { if (goodsProductId) await supabase.from("products").delete().eq("id", goodsProductId); } catch (e: any) { errors.push(e.message); }
  try { await cleanupTestClass(classId, []); } catch (e: any) { errors.push(e.message); }
  if (errors.length > 0) throw new Error("정리 실패:\n" + errors.join("\n"));
}, 30000);

describe("Track 6: usable_memberships_for_classes()가 goods(비예약용) 상품을 '사용 가능한 수강권'에서 실제로 제외하는가", () => {
  it("product_kind='goods'인 membership은 이 수업의 사용 가능한 수강권 목록에 나타나지 않는다", async () => {
    const { data, error } = await supabase.rpc("usable_memberships_for_classes", {
      p_class_ids: [classId], p_profile_id: managerA.profileId,
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as any[];
    const hasGoods = rows.some((r) => r.membership_id === goodsMembershipId);
    expect(hasGoods).toBe(false);
  });
});
