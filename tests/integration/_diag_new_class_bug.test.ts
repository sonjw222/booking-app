/*
  임시 읽기 전용 진단(신규 수업 "사용 가능한 수강권 없음" 버그, 제거 예정) — 아무것도
  쓰지 않는다(딱 하나, 진단용 신규 class 1건만 admin client로 insert — 회귀 테스트가
  실제 UI로 재현하기 전에 가설을 빠르게 좁히기 위한 예비 조사).

  가설(app/manager/classes/page.tsx 주석/기존 fixture 코드 감사로 발견,
  lib/fixtures testData.ts의 clearScheduleRulesForProduct 코멘트 참고):
  과거 관리자 화면이 "모든 수강권 허용"으로 수업을 저장할 때도 센터의 전체 pass 상품에
  membership_schedule_rules를 자동으로 추가하던 버그가 있었다(현재 코드는 고쳐졌다 —
  app/manager/classes/page.tsx/lib/classes.ts 어디에도 membership_schedule_rules를
  건드리는 코드가 없음을 grep으로 재확인함). 그 버그가 살아있던 동안 쌓인 stale
  membership_schedule_rules 행이 여전히 남아있다면, usable_memberships_for_classes()의
  "이 product에 하나라도 schedule rule이 있으면 정확히 매칭하는 class만 허용" 조건 때문에
  그 시각 조건에 안 맞는 모든 새 class가 탈락한다 — 새로 만든 class일수록 과거의 우연한
  rule 시각과 안 맞을 확률이 높다.
*/
import { describe, it, beforeAll } from "vitest";
import {
  switchToTestUser,
  getOrCreateOwnedTestCenter,
  getFixtureAdminClient,
  type TestUser,
} from "./setup";
import { supabase } from "../../lib/supabaseClient";

let managerA: TestUser;
let userA: TestUser;
let centerAId: string;

beforeAll(async () => {
  managerA = await switchToTestUser("TEST_MANAGER_A_EMAIL", "TEST_MANAGER_A_PASSWORD");
  centerAId = await getOrCreateOwnedTestCenter(managerA);
  userA = await switchToTestUser("TEST_USER_A_EMAIL", "TEST_USER_A_PASSWORD");
}, 30000);

describe("진단: membership_schedule_rules 규모 및 centerA 상품별 분포", () => {
  it("centerA 소속 products의 membership_schedule_rules 전체 규모", async () => {
    const admin = getFixtureAdminClient();
    const { data: products, error: prodErr } = await admin
      .from("products").select("id, name, product_kind").eq("center_id", centerAId);
    if (prodErr) throw new Error(prodErr.message);
    const productIds = (products ?? []).map((p) => p.id);
    console.log(`=== centerA products 수: ${productIds.length} ===`);
    if (productIds.length === 0) return;

    const byProduct = new Map<string, number>();
    const CHUNK = 80;
    let total = 0;
    for (let i = 0; i < productIds.length; i += CHUNK) {
      const chunk = productIds.slice(i, i + CHUNK);
      const { data: rules, error } = await admin
        .from("membership_schedule_rules")
        .select("id, product_id, day_of_week, start_time, class_title")
        .in("product_id", chunk);
      if (error) throw new Error(error.message);
      for (const r of rules ?? []) {
        byProduct.set(r.product_id, (byProduct.get(r.product_id) ?? 0) + 1);
        total++;
      }
    }
    console.log(`=== centerA products 소속 membership_schedule_rules 총 건수: ${total} ===`);
    const nameById = new Map((products ?? []).map((p) => [p.id, p.name]));
    for (const [pid, count] of [...byProduct.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  product_id=${pid} name="${nameById.get(pid)}" rules=${count}건`);
    }
  });

  it("TEST_USER_A의 centerA 유효 pass-kind memberships + 각 product의 schedule_rules 여부", async () => {
    const admin = getFixtureAdminClient();
    const today = new Date().toISOString().slice(0, 10);
    const { data: mems, error } = await admin
      .from("memberships")
      .select("id, product_id, product_name, status, remaining_count, expires_at")
      .eq("profile_id", userA.profileId)
      .eq("center_id", centerAId)
      .eq("status", "active")
      .gte("expires_at", today);
    if (error) throw new Error(error.message);
    console.log(`=== TEST_USER_A centerA 유효(status=active, 안 만료) memberships: ${(mems ?? []).length}건 ===`);

    const withProduct = (mems ?? []).filter((m) => m.product_id);
    console.log(`=== 그 중 product_id 있는(schedule_rules 영향 가능) 것: ${withProduct.length}건 ===`);

    // N+1 대신 distinct product_id만 모아 한 번에 배치 조회(이전 시도가 127건을 하나씩
    // 조회하다 20초 타임아웃으로 실패함 — 진단 스크립트 자체의 버그였음, 앱 버그 아님).
    const distinctProductIds = [...new Set(withProduct.map((m) => m.product_id))];
    console.log(`=== distinct product_id 수: ${distinctProductIds.length} ===`);

    const { data: prods, error: prodErr } = await admin
      .from("products").select("id, name, product_kind").in("id", distinctProductIds);
    if (prodErr) throw new Error(prodErr.message);
    const prodById = new Map((prods ?? []).map((p) => [p.id, p]));

    const { data: rules, error: rErr } = await admin
      .from("membership_schedule_rules")
      .select("id, product_id, day_of_week, start_time, class_title")
      .in("product_id", distinctProductIds);
    if (rErr) throw new Error(rErr.message);
    const rulesByProduct = new Map<string, any[]>();
    for (const r of rules ?? []) {
      const arr = rulesByProduct.get(r.product_id) ?? [];
      arr.push(r);
      rulesByProduct.set(r.product_id, arr);
    }

    for (const pid of distinctProductIds) {
      const p = prodById.get(pid);
      const rs = rulesByProduct.get(pid) ?? [];
      const count = withProduct.filter((m) => m.product_id === pid).length;
      console.log(`  product_id=${pid} name="${p?.name}"(kind=${p?.product_kind}) membership건수=${count} schedule_rules=${rs.length}건 ${JSON.stringify(rs)}`);
    }
  }, 30000);
});

describe("진단: 기존 class vs 신규 class RPC 비교", () => {
  it("centerA의 기존(이미 존재하는) 미래 class 1개 확보 + 신규 class 1개 생성 후 RPC 비교", async () => {
    const admin = getFixtureAdminClient();
    const nowIso = new Date().toISOString();
    const { data: existingClasses, error: exErr } = await admin
      .from("classes")
      .select("id, title, start_time, class_format")
      .eq("center_id", centerAId)
      .gt("start_time", nowIso)
      .order("start_time", { ascending: true })
      .limit(5);
    if (exErr) throw new Error(exErr.message);
    console.log(`=== centerA 기존 미래 class 샘플(최대 5개): ${JSON.stringify(existingClasses ?? [])} ===`);

    // 신규 class: admin client로 직접 insert(이 진단 전용 — 최종 회귀 테스트는 반드시 UI로 생성)
    // 다른 어떤 stale rule과도 우연히 안 맞도록 아주 특이한 미래 시각(초 단위까지 현재시각 기반)을 쓴다.
    const uniqueStart = new Date(Date.now() + 90 * 24 * 3600 * 1000 + (Date.now() % 86400000));
    const uniqueEnd = new Date(uniqueStart.getTime() + 60 * 60 * 1000);
    const { data: newClass, error: insErr } = await admin
      .from("classes")
      .insert({
        center_id: centerAId,
        title: "DIAG-NEWCLASS-BUG 진단용",
        start_time: uniqueStart.toISOString(),
        end_time: uniqueEnd.toISOString(),
        capacity: 8,
        class_format: "group",
      })
      .select("id, title, start_time")
      .single();
    if (insErr || !newClass) throw new Error(`진단용 신규 class 생성 실패: ${insErr?.message}`);
    console.log(`=== 신규 진단용 class 생성: ${JSON.stringify(newClass)} ===`);

    // class_allowed_products는 service_role SQL GRANT가 없어(이미 문서화된 별도 gap,
    // docs/TODO.md 참고) admin client로는 permission denied가 남 — RLS는 "auth.uid() is
    // not null"로 완전히 허용적이므로 로그인된 일반 세션(supabase, 현재 userA)으로 대신 조회.
    const { data: cap, error: capErr } = await supabase.from("class_allowed_products").select("*").eq("class_id", newClass.id);
    if (capErr) throw new Error(capErr.message);
    console.log(`=== 신규 class의 class_allowed_products: ${(cap ?? []).length}건(0건이어야 "모든 수강권 허용") ${JSON.stringify(cap ?? [])} ===`);

    const existingIds = (existingClasses ?? []).map((c) => c.id);
    const { data: existingCap, error: existingCapErr } = await supabase
      .from("class_allowed_products").select("*").in("class_id", existingIds);
    if (existingCapErr) throw new Error(existingCapErr.message);
    console.log(`=== 기존 class 5개의 class_allowed_products: ${(existingCap ?? []).length}건 ${JSON.stringify(existingCap ?? [])} ===`);

    const classIds = [newClass.id, ...(existingClasses ?? []).map((c) => c.id)];
    const { data: rpcRows, error: rpcErr } = await supabase.rpc("usable_memberships_for_classes", {
      p_class_ids: classIds,
      p_profile_id: userA.profileId,
    });
    if (rpcErr) throw new Error(`RPC 호출 실패: ${rpcErr.message}`);
    console.log(`=== usable_memberships_for_classes 응답 총 ${(rpcRows ?? []).length}행 ===`);
    const byClass = new Map<string, number>();
    for (const r of (rpcRows ?? []) as any[]) byClass.set(r.class_id, (byClass.get(r.class_id) ?? 0) + 1);
    console.log(`  신규 class(${newClass.id}) usable membership 수: ${byClass.get(newClass.id) ?? 0}`);
    for (const c of existingClasses ?? []) {
      console.log(`  기존 class(${c.id}, title="${c.title}", start=${c.start_time}) usable membership 수: ${byClass.get(c.id) ?? 0}`);
    }

    // 정리: 이 진단용 class는 즉시 삭제(공유 테스트센터 오염 방지)
    await admin.from("class_allowed_products").delete().eq("class_id", newClass.id);
    await admin.from("classes").delete().eq("id", newClass.id);
    console.log(`=== 진단용 class 정리 완료 ===`);
  }, 30000);
});
