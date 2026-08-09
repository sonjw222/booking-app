/*
  임시 읽기 전용 진단(P2-20 goal2, 제거 예정) — TEST_USER_A의 historical duplicate
  memberships(특히 "E2E 테스트 수강권") 실제 규모와, usable_memberships_for_classes RPC의
  classId 개수별 실제 응답시간을 측정한다. 아무것도 쓰지 않는다(전부 select/rpc 조회).
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

describe("P1: memberships 실제 규모 진단", () => {
  it("TEST_USER_A 전체 memberships 실제 COUNT(*) (PostgREST 캡 우회, count:exact)", async () => {
    const admin = getFixtureAdminClient();
    const { count, error } = await admin.from("memberships").select("id", { count: "exact", head: true }).eq("profile_id", userA.profileId);
    if (error) throw new Error(error.message);
    console.log(`=== TEST_USER_A 전체 memberships 실제 count: ${count} ===`);
  });

  it("TEST_USER_A memberships 전수 조회(페이지네이션) 후 product_name/center_id/product_id/status 분포", async () => {
    const admin = getFixtureAdminClient();
    const rows: any[] = [];
    const PAGE_SIZE = 1000;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await admin
        .from("memberships")
        .select("id, product_id, product_name, center_id, status, remaining_count, expires_at, created_at")
        .eq("profile_id", userA.profileId)
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(error.message);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
      if (from > 20000) { console.log("=== 안전장치: 20000행 초과, 페이지네이션 중단 ==="); break; }
    }
    console.log(`=== TEST_USER_A memberships 전수 조회 완료: ${rows.length}건 ===`);

    const byProductName = new Map<string, number>();
    const byCenter = new Map<string, number>();
    const byProductId = new Map<string, number>();
    const byStatus = new Map<string, number>();
    let minCreated = "", maxCreated = "";
    for (const r of rows) {
      byProductName.set(r.product_name, (byProductName.get(r.product_name) ?? 0) + 1);
      byCenter.set(r.center_id, (byCenter.get(r.center_id) ?? 0) + 1);
      byProductId.set(String(r.product_id), (byProductId.get(String(r.product_id)) ?? 0) + 1);
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
      if (!minCreated || r.created_at < minCreated) minCreated = r.created_at;
      if (!maxCreated || r.created_at > maxCreated) maxCreated = r.created_at;
    }
    console.log("=== product_name별 분포(내림차순) ===");
    for (const [name, c] of [...byProductName.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  "${name}": ${c}건`);
    }
    console.log("=== center_id별 분포 ===");
    for (const [cid, c] of byCenter) console.log(`  center_id=${cid} | centerA와 일치=${cid === centerAId} | ${c}건`);
    console.log("=== status별 분포 ===");
    for (const [s, c] of byStatus) console.log(`  status=${s}: ${c}건`);
    console.log(`=== created_at 범위: ${minCreated} ~ ${maxCreated} ===`);

    console.log("=== product_id별 분포(상위 15) ===");
    for (const [pid, c] of [...byProductId.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  product_id=${pid}: ${c}건`);
    }

    // 구조적 식별 조건 확인: "E2E 테스트 수강권" 이름을 가진 행들이 전부 같은 product_id를
    // 가리키는지(=단일 get-or-create 상품) 확인 — 그렇다면 product_id 하나로도 안전하게 식별 가능.
    const e2eRows = rows.filter((r) => r.product_name === "E2E 테스트 수강권");
    const e2eProductIds = new Set(e2eRows.map((r) => String(r.product_id)));
    console.log(`=== "E2E 테스트 수강권" 행: ${e2eRows.length}건, distinct product_id: ${e2eProductIds.size}개 [${[...e2eProductIds].join(", ")}] ===`);
    const e2eCenterIds = new Set(e2eRows.map((r) => String(r.center_id)));
    console.log(`=== "E2E 테스트 수강권" distinct center_id: ${e2eCenterIds.size}개 [${[...e2eCenterIds].join(", ")}] ===`);
  });

  it("P1-7/8: E2E 테스트 수강권 상품 자체 확인 + 그 membership들을 참조하는 FK 테이블 존재 여부", async () => {
    const admin = getFixtureAdminClient();
    const { data: product, error: prodErr } = await admin
      .from("products").select("id, name, center_id, product_kind, created_at")
      .eq("center_id", centerAId).eq("name", "E2E 테스트 수강권 상품").maybeSingle();
    if (prodErr) throw new Error(prodErr.message);
    console.log(`=== "E2E 테스트 수강권 상품" product row: ${JSON.stringify(product)} ===`);
    if (!product) return;

    const { data: memRows, error: memErr } = await admin
      .from("memberships").select("id")
      .eq("profile_id", userA.profileId).eq("product_id", product.id).limit(2000);
    if (memErr) throw new Error(memErr.message);
    const membershipIds = (memRows ?? []).map((m) => m.id);
    console.log(`=== product_id=${product.id} 기준 TEST_USER_A membership 수(캡 2000): ${membershipIds.length} ===`);

    // FK 감사(코드 재확인 결과): membership_id를 직접 참조하는 테이블 =
    // admin_action_logs, payments, reservations, membership_transfers, product_passes, contracts.
    // locker_assignments/point_transactions/progress_records는 profile_id만 참조하므로
    // (이번 cleanup은 profiles를 지우지 않음) 이번엔 대상 아님 — 그래도 실측으로 0건 확인.
    const { count: aalCount } = await admin.from("admin_action_logs").select("id", { count: "exact", head: true }).eq("center_id", centerAId);
    console.log(`=== admin_action_logs centerA 전체(참고, membership 특정 불가 — GRANT 없음 가능): ${aalCount ?? "조회 실패(GRANT?)"} ===`);

    const { count: payCount, error: payErr } = await admin.from("payments").select("id", { count: "exact", head: true }).eq("profile_id", userA.profileId);
    console.log(`=== payments (TEST_USER_A 전체, membership_id 무관): ${payErr ? "ERROR:" + payErr.message : payCount} ===`);

    const { count: resCount, error: resErr } = await admin.from("reservations").select("id", { count: "exact", head: true }).eq("profile_id", userA.profileId);
    console.log(`=== reservations (TEST_USER_A 전체): ${resErr ? "ERROR:" + resErr.message : resCount} ===`);

    for (const [table, cols] of [
      ["membership_transfers", ["from_profile_id", "profile_id"]],
      ["product_passes", ["profile_id"]],
      ["contracts", ["profile_id"]],
    ] as const) {
      for (const col of cols) {
        const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).eq(col, userA.profileId);
        console.log(`=== ${table}.${col}=userA: ${error ? "ERROR:" + error.message : count} ===`);
      }
    }
  });
});

describe("P1-4/P1-8 추가: center 전체(profile_id 제한 없이) 규모 + FK 정확 스코프 확인", () => {
  it("centerA 전체에서 product_name='E2E 테스트 수강권' 총 건수 + profile_id별 분포(캡 우회)", async () => {
    const admin = getFixtureAdminClient();
    const { count, error } = await admin
      .from("memberships").select("id", { count: "exact", head: true })
      .eq("center_id", centerAId).eq("product_name", "E2E 테스트 수강권");
    if (error) throw new Error(error.message);
    console.log(`=== centerA 전체(profile_id 무관) "E2E 테스트 수강권" 실제 count: ${count} ===`);

    const rows: any[] = [];
    const PAGE_SIZE = 1000;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error: pErr } = await admin
        .from("memberships").select("id, profile_id, product_id")
        .eq("center_id", centerAId).eq("product_name", "E2E 테스트 수강권")
        .range(from, from + PAGE_SIZE - 1);
      if (pErr) throw new Error(pErr.message);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE_SIZE) break;
      if (from > 20000) { console.log("=== 안전장치: 20000행 초과, 중단 ==="); break; }
    }
    const byProfile = new Map<string, number>();
    for (const r of rows) byProfile.set(r.profile_id, (byProfile.get(r.profile_id) ?? 0) + 1);
    console.log(`=== centerA "E2E 테스트 수강권" profile_id별 분포(${byProfile.size}개 profile) ===`);
    for (const [pid, c] of [...byProfile.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  profile_id=${pid} | userA와 일치=${pid === userA.profileId}: ${c}건`);
    }
    (globalThis as any).__diagE2eMembershipIds = rows.map((r) => r.id);
  });

  it("실제 삭제 대상 membership_id로 FK 참조 테이블 정확 스코프 확인(에러 상세 포함)", async () => {
    const admin = getFixtureAdminClient();
    const ids: string[] = (globalThis as any).__diagE2eMembershipIds ?? [];
    console.log(`=== FK 정확 스코프 확인 대상 membership_id 수: ${ids.length} ===`);
    if (ids.length === 0) return;
    const sample = ids.slice(0, 500); // PostgREST in() 안전 상한

    for (const [table, col] of [
      ["membership_transfers", "membership_id"],
      ["product_passes", "linked_membership_id"],
      ["contracts", "membership_id"],
      ["payments", "membership_id"],
      ["reservations", "membership_id"],
    ] as const) {
      const { count, error } = await admin.from(table).select("id", { count: "exact", head: true }).in(col, sample);
      if (error) {
        console.log(`=== ${table}.${col} IN (sample ${sample.length}개): ERROR code=${(error as any).code} message=${error.message} details=${(error as any).details} hint=${(error as any).hint} ===`);
      } else {
        console.log(`=== ${table}.${col} IN (sample ${sample.length}개): ${count}건 ===`);
      }
    }
  });
});

describe("P2: usable_memberships_for_classes RPC 응답시간 측정(classId 개수별)", () => {
  it("centerA 실제 class id 확보(최근 것부터 최대 40개)", async () => {
    const admin = getFixtureAdminClient();
    const { data, error } = await admin
      .from("classes").select("id, start_time").eq("center_id", centerAId)
      .order("start_time", { ascending: false }).limit(40);
    if (error) throw new Error(error.message);
    const ids = (data ?? []).map((c) => c.id);
    console.log(`=== 확보한 class id 수: ${ids.length} ===`);
    (globalThis as any).__diagClassIds = ids;
  });

  it("classId 1/8/36개일 때 usable_memberships_for_classes RPC 응답시간(각 3회 측정)", async () => {
    const allIds: string[] = (globalThis as any).__diagClassIds ?? [];
    if (allIds.length === 0) { console.log("=== class id 확보 실패로 RPC 타이밍 측정 스킵 ==="); return; }
    for (const n of [1, 8, 36]) {
      const ids = allIds.slice(0, Math.min(n, allIds.length));
      const timings: number[] = [];
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const { data, error } = await supabase.rpc("usable_memberships_for_classes", { p_class_ids: ids, p_profile_id: userA.profileId });
        const elapsed = Date.now() - t0;
        timings.push(elapsed);
        if (error) {
          console.log(`=== n=${n}(실제 ${ids.length}) 시도 ${i + 1}: 에러 ${error.message} (${elapsed}ms) ===`);
        } else {
          console.log(`=== n=${n}(실제 ${ids.length}) 시도 ${i + 1}: ${elapsed}ms, 응답 행 수 ${(data ?? []).length} ===`);
        }
      }
      console.log(`=== n=${n} 요약: min=${Math.min(...timings)}ms max=${Math.max(...timings)}ms avg=${Math.round(timings.reduce((a, b) => a + b, 0) / timings.length)}ms ===`);
    }
  }, 120000);

  // P2 추가: lib/reservations.ts의 fetchUsableMembershipsByClass()가 실제로 하는 것과
  // 동일한 .range() 기반 클라이언트 페이지네이션 루프를 그대로 재현해, 단일 RPC 응답이
  // 1000행 캡에 걸릴 때 총 왕복 횟수/총 소요시간이 실제로 얼마나 되는지 측정한다.
  // (단일 미페이지네이션 RPC 호출은 항상 500ms대였지만, 그건 각 왕복이 1000행 캡에
  // 걸려 실제 총 행 수를 반영 못했을 수 있음 — 이 테스트가 그 실제 총 왕복 비용을 잰다.)
  it("classId 1/8/36개: fetchUsableMembershipsByClass와 동일한 .range() 페이지네이션 루프 재현", async () => {
    const allIds: string[] = (globalThis as any).__diagClassIds ?? [];
    if (allIds.length === 0) { console.log("=== class id 확보 실패로 페이지네이션 루프 측정 스킵 ==="); return; }
    for (const n of [1, 8, 36]) {
      const ids = allIds.slice(0, Math.min(n, allIds.length));
      const rows: any[] = [];
      const PAGE_SIZE = 1000;
      let pageCount = 0;
      const pageTimings: number[] = [];
      const tStart = Date.now();
      for (let from = 0; ; from += PAGE_SIZE) {
        const tp0 = Date.now();
        const { data: page, error } = await supabase
          .rpc("usable_memberships_for_classes", { p_class_ids: ids, p_profile_id: userA.profileId })
          .range(from, from + PAGE_SIZE - 1);
        const pElapsed = Date.now() - tp0;
        pageTimings.push(pElapsed);
        pageCount++;
        if (error) {
          console.log(`=== n=${n} 페이지네이션 루프 page ${pageCount}(from=${from}): 에러 ${error.message} (${pElapsed}ms) ===`);
          break;
        }
        rows.push(...(page ?? []));
        console.log(`=== n=${n} 페이지네이션 루프 page ${pageCount}(from=${from}): ${pElapsed}ms, 이 페이지 행 수 ${(page ?? []).length} ===`);
        if (!page || page.length < PAGE_SIZE) break;
        if (pageCount > 100) { console.log("=== 안전장치: 100페이지 초과, 루프 중단 ==="); break; }
      }
      const totalElapsed = Date.now() - tStart;
      console.log(`=== n=${n} 페이지네이션 루프 요약: 총 ${pageCount}페이지, 총 ${rows.length}행, 총 ${totalElapsed}ms (페이지별: [${pageTimings.join(", ")}]) ===`);
    }
  }, 180000);
});
