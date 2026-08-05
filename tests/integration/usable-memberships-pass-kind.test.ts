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

  const { data: product, error: prodErr } = await supabase
    .from("products")
    .insert({ center_id: centerAId, name: "USABLE-PASS-KIND 테스트 대여품", price: 1000, product_kind: "goods" })
    .select("id").single();
  if (prodErr || !product) throw new Error("goods 상품 생성 실패: " + prodErr?.message);
  goodsProductId = (product as any).id;

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
