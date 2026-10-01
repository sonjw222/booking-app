/*
  QA 센터 숨김/접근 검증 — QA 센터는 approved(예약 RPC가 요구)지만 일반 사용자/anon에게는 보이지 않아야 하고,
  QA 매니저/QA 회원은 정상 접근해야 한다. add_internal_qa_center_flag.sql이 Production에 적용돼 있어야 통과한다.
  실행: npm run qa:production:visibility (QA_TARGET_PROJECT_REF / QA_PRODUCTION_ACK=1 필요). 데이터를 만들지 않고 bootstrap만 한다.
*/
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { fetchMyCenters } from "../../../lib/manager";
import { getFixtureAdminClient, signOutTestSession, switchToTestUser } from "../../integration/setup";
import { bootstrapQa } from "../fixtures/bootstrap";
import type { QaFixtureState } from "../fixtures/center";

let state: QaFixtureState;
const anon = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

describe("QA 센터: approved + 일반 사용자에게 숨김", () => {
  beforeAll(async () => { ({ state } = await bootstrapQa()); });
  afterAll(async () => { await signOutTestSession(); });

  it("QA 센터는 approved + is_internal=true", async () => {
    const { data, error } = await getFixtureAdminClient().from("centers").select("status, is_internal").eq("id", state.centerId).single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ status: "approved", is_internal: true });
  });

  it("anon: centers/products/classes 직접 조회와 공개 storefront RPC에서 보이지 않는다", async () => {
    const c = anon();
    expect((await c.from("centers").select("id").eq("id", state.centerId)).data ?? []).toHaveLength(0);
    expect((await c.from("products").select("id").eq("center_id", state.centerId)).data ?? []).toHaveLength(0);
    expect((await c.from("classes").select("id").eq("center_id", state.centerId)).data ?? []).toHaveLength(0);
    const rpc = await c.rpc("fetch_public_storefront_products", { p_center_id: state.centerId });
    expect(rpc.error).toBeNull();
    expect(rpc.data ?? []).toHaveLength(0);
    const all = await c.rpc("fetch_public_storefront_products", { p_center_id: null });
    expect((all.data ?? []).some((p: any) => p.center_id === state.centerId)).toBe(false);
  });

  it("QA 센터와 관계없는 일반 로그인 계정(TEST_USER_B)은 센터 목록·상세·상품·구매 RPC에서 못 본다", async () => {
    if (!process.env.TEST_USER_B_EMAIL || !process.env.TEST_USER_B_PASSWORD) { console.warn("[QA] TEST_USER_B_* 없음 — 이 검사는 건너뜀"); return; }
    await switchToTestUser("TEST_USER_B_EMAIL", "TEST_USER_B_PASSWORD");
    expect(((await supabase.from("centers").select("id").eq("id", state.centerId)).data ?? [])).toHaveLength(0);
    expect(((await supabase.from("products").select("id").eq("center_id", state.centerId)).data ?? [])).toHaveLength(0);
    const rpc = await supabase.rpc("fetch_purchasable_products", { p_center_id: state.centerId });
    expect(rpc.data ?? []).toHaveLength(0);
    const list = await supabase.from("centers").select("id").eq("status", "approved");
    expect((list.data ?? []).some((c: any) => c.id === state.centerId)).toBe(false);
  });

  it("QA 매니저는 fetchMyCenters에서 QA 센터를 조회할 수 있다", async () => {
    await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
    const centers = await fetchMyCenters();
    expect(centers.some((c) => c.id === state.centerId)).toBe(true);
  });

  it("QA 회원은 QA 센터와 그 상품/수업을 정상 조회한다(예약 RPC가 요구하는 approved 상태 유지)", async () => {
    await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
    expect((await supabase.from("centers").select("id, status").eq("id", state.centerId)).data ?? []).toHaveLength(1);
    const rpc = await supabase.rpc("fetch_purchasable_products", { p_center_id: state.centerId });
    expect(rpc.error).toBeNull();
  });
});
