/* 격리 PostgREST + 실제 SQL/RLS(저장소 마이그레이션 적용)에서 "일반 회원 세션"으로 UX 감사 후속 기능이 쓰는 조회·RPC를 검증한다.
   - service role로 성공한 것을 일반 회원 권한 검증으로 대신하지 않는다: 모든 단언은 authenticated/anon JWT로 한다(시드 준비만 SQL).
   - 실행: tests/rls-real/run.sh up && npm run test:rls-real   (Docker/Colima 필요, 운영·공유 DEV 접속 없음)
   한계: 운영 DB의 "실제" 정책·GRANT가 아니라 저장소 SQL을 적용한 재구성이다(어떤 draft 마이그레이션이 운영에 적용됐는지는 이 저장소만으로 알 수 없다). */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = process.env.RLS_REST_URL ?? "http://127.0.0.1:3203";
const SECRET = "qa-secret-qa-secret-qa-secret-1234567890";
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (role: string, sub?: string) => { const h = b64({ alg: "HS256", typ: "JWT" }), p = b64({ role, iss: "qa", exp: 4102444800, ...(sub ? { sub, aud: "authenticated" } : {}) }); return `${h}.${p}.${createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url")}`; };
const U = { A: "11111111-1111-1111-1111-111111111111", B: "22222222-2222-2222-2222-222222222222", M: "33333333-3333-3333-3333-333333333333" };
const ID = {
  centerPub: "c0a00000-0000-0000-0000-00000000c0a0", centerPriv: "c0b00000-0000-0000-0000-00000000c0b0",
  pA1: "a1000000-0000-0000-0000-0000000000a1", pA2: "a2000000-0000-0000-0000-0000000000a2", pB1: "b1000000-0000-0000-0000-0000000000b1",
  prodFree: "e1000000-0000-0000-0000-0000000000e1", prodOther: "e2000000-0000-0000-0000-0000000000e2", prodPriv: "e3000000-0000-0000-0000-0000000000e3", prodRestricted: "e4000000-0000-0000-0000-0000000000e4",
  clsSel: "d1000000-0000-0000-0000-0000000000d1", clsAll: "d2000000-0000-0000-0000-0000000000d2", clsPriv: "d3000000-0000-0000-0000-0000000000d3",
  memB: "f2000000-0000-0000-0000-0000000000f2",
};

function clientFor(sub: string | null): SupabaseClient {
  // supabase-js는 /rest/v1/ 접두를 붙이지만 PostgREST는 루트에서 서비스하므로 경로만 맞춰 준다(요청 내용·JWT는 그대로).
  const rootFetch: typeof fetch = (input, init) => fetch(String(input).replace("/rest/v1/", "/"), init);
  return createClient(URL_, jwt("anon"), { global: { fetch: rootFetch, headers: sub ? { Authorization: `Bearer ${jwt("authenticated", sub)}` } : {} }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}
// lib/*가 쓰는 supabase 싱글턴을 "지금 로그인한 사용자"의 실제 JWT 클라이언트로 바꿔 끼운다(세션 유무만 로컬로 흉내).
let current: { client: SupabaseClient; sub: string | null } = { client: clientFor(null), sub: null };
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (t: string) => current.client.from(t),
    rpc: (f: string, a?: Record<string, unknown>) => current.client.rpc(f, a),
    auth: {
      getSession: async () => ({ data: { session: current.sub ? { user: { id: current.sub } } : null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() { /* 테스트 스텁 */ } } } }),
    },
  },
}));
// 시드/상태 준비 전용(권한 검증이 아니다) — 로컬 격리 DB 컨테이너에만 접속한다.
const sql = (q: string) => execFileSync("docker", ["exec", "qa-rls-pg", "psql", "-U", "postgres", "-d", "qa", "-tAc", q], { encoding: "utf8" }).trim();
const as = (sub: string | null) => { current = { client: clientFor(sub), sub }; return current.client; };

import { fetchMembershipOrigins } from "../../lib/membershipOrigin";
import { fetchViewerClassState } from "../../lib/classViewer";
import { fetchCenterClassDetail } from "../../lib/classDetail";

let reachable = false;
beforeAll(async () => { try { reachable = (await fetch(URL_)).ok; } catch { reachable = false; } });
const d = (name: string, fn: () => void) => describe(name, () => { fn(); });

d("격리 PostgREST(실제 RLS) — UX 감사 후속", () => {
  let grantedMembershipId = "";
  it("환경 확인: 격리 PostgREST가 떠 있어야 한다(tests/rls-real/run.sh up)", () => { expect(reachable, "PostgREST에 접속할 수 없어요 — run.sh up 먼저").toBe(true); });

  it("관리자(센터 오너) 무료 지급: 실제 RPC manager_grant_product(서비스·0원) 성공, 일반 회원은 같은 RPC를 쓸 수 없다", async () => {
    const asMember = as(U.A);
    const denied = await asMember.rpc("manager_grant_product", { p_center_id: ID.centerPub, p_profile_id: ID.pA1, p_product_id: ID.prodFree, p_price: 0, p_pay_method: "service" });
    expect(denied.error, "일반 회원이 관리자 지급 RPC를 호출할 수 있으면 안 된다").not.toBeNull();
    const asManager = as(U.M);
    // 지급 전제: 회원이 이 센터의 회원이어야 한다(관리자 '회원 추가' = center_members 등록, 서버가 RLS로 허용하는지도 함께 확인)
    const added = await asManager.from("center_members").insert({ center_id: ID.centerPub, profile_id: ID.pA1, app_linked: true });
    expect(added.error).toBeNull();
    const ok = await asManager.rpc("manager_grant_product", { p_center_id: ID.centerPub, p_profile_id: ID.pA1, p_product_id: ID.prodFree, p_price: 0, p_pay_method: "service", p_memo: "[QA] 무료 지급" });
    expect(ok.error).toBeNull();
    const mem = await as(U.A).from("memberships").select("id, remaining_count, total_count, status").eq("profile_id", ID.pA1);
    expect(mem.error).toBeNull();
    expect(mem.data).toHaveLength(1);
    grantedMembershipId = (mem.data as { id: string }[])[0].id;
    expect((mem.data as { remaining_count: number }[])[0].remaining_count).toBe(3);
  });

  it("일반 회원 A: 본인 결제 기록(서비스·0원)을 읽을 수 있고 lib가 '무료 지급'으로 분류한다", async () => {
    as(U.A);
    const pay = await current.client.from("payments").select("membership_id, sale_type, total_amount").eq("membership_id", grantedMembershipId);
    expect(pay.error).toBeNull();
    expect(pay.data).toEqual([{ membership_id: grantedMembershipId, sale_type: "service", total_amount: 0 }]);
    expect((await fetchMembershipOrigins([grantedMembershipId]))[grantedMembershipId]).toBe("free_grant");
  });

  it("다른 계정(B)의 수강권·결제는 A에게 보이지 않고, 읽지 못한 건은 '무료'로 잘못 분류되지 않는다(unknown)", async () => {
    as(U.A);
    const mem = await current.client.from("memberships").select("id").eq("id", ID.memB);
    expect(mem.data).toEqual([]);
    const pay = await current.client.from("payments").select("id").eq("membership_id", ID.memB);
    expect(pay.data).toEqual([]);                                                       // RLS는 오류가 아니라 빈 결과를 준다
    const origins = await fetchMembershipOrigins([ID.memB, grantedMembershipId]);
    expect(origins[ID.memB]).toBe("unknown");                                           // 못 읽음 ≠ 무료
    expect(origins[grantedMembershipId]).toBe("free_grant");
    as(U.B);
    expect((await fetchMembershipOrigins([ID.memB]))[ID.memB]).toBe("paid");              // 본인 건은 유료로 분류
    expect((await fetchMembershipOrigins([grantedMembershipId]))[grantedMembershipId]).toBe("unknown");   // B는 A의 무료 지급 기록을 읽지 못함
  });

  it("usable_memberships_for_classes: 본인·가족 프로필·타 계정 범위", async () => {
    const a = as(U.A);
    const own = await a.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsSel, ID.clsAll], p_profile_id: ID.pA1 });
    expect(own.error).toBeNull();
    const rows = own.data as { class_id: string; membership_id: string; is_mine: boolean }[];
    expect(rows.map((r) => `${r.class_id}:${r.membership_id}`).sort()).toEqual([`${ID.clsAll}:${grantedMembershipId}`, `${ID.clsSel}:${grantedMembershipId}`].sort());
    expect(rows.every((r) => r.is_mine)).toBe(true);
    // 가족 프로필로 조회: 수강권은 계정 단위 공유라 같은 목록이고 is_mine만 false
    const fam = await a.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsSel], p_profile_id: ID.pA2 });
    expect((fam.data as { membership_id: string; is_mine: boolean }[]).map((r) => [r.membership_id, r.is_mine])).toEqual([[grantedMembershipId, false]]);
    // 다른 계정의 프로필 id를 넘겨도 B의 수강권이 새지 않는다
    const spoof = await a.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsAll], p_profile_id: ID.pB1 });
    expect((spoof.data as { membership_id: string }[]).map((r) => r.membership_id)).not.toContain(ID.memB);
    // B: 전체 허용 수업에는 본인 수강권만, 지정 수업(무료권만 허용)에는 쓸 수 없다
    const b = as(U.B);
    const bAll = await b.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsAll], p_profile_id: ID.pB1 });
    expect((bAll.data as { membership_id: string }[]).map((r) => r.membership_id)).toEqual([ID.memB]);
    const bSel = await b.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsSel], p_profile_id: ID.pB1 });
    expect(bSel.data).toEqual([]);
  });

  it("실제 lib(fetchViewerClassState): A=usable, B=mismatch(유효 수강권이 있지만 이 수업엔 못 씀), 수강권 없는 계정=none, 비로그인=anon", async () => {
    as(U.A);
    const a = await fetchViewerClassState(ID.centerPub, ID.clsSel);
    expect(a.kind).toBe("member");
    if (a.kind === "member") { expect(a.profiles.map((p) => p.status)).toEqual(["usable", "usable"]); expect(a.profiles).toHaveLength(2); }
    as(U.B);
    const b = await fetchViewerClassState(ID.centerPub, ID.clsSel);
    if (b.kind === "member") expect(b.profiles.map((p) => p.status)).toEqual(["mismatch"]); else throw new Error("B는 member여야 한다");
    as(U.M);
    const m = await fetchViewerClassState(ID.centerPub, ID.clsSel);
    if (m.kind === "member") expect(m.profiles.map((p) => p.status)).toEqual(["none"]); else throw new Error("M은 member여야 한다");
    as(null);
    expect((await fetchViewerClassState(ID.centerPub, ID.clsSel)).kind).toBe("anon");
  });

  it("비로그인(anon): 결제·수강권은 빈 결과, 수강권 RPC는 빈 결과 또는 거부 — 어느 쪽이든 데이터가 새지 않는다", async () => {
    const anon = as(null);
    expect((await anon.from("payments").select("id")).data ?? []).toEqual([]);
    expect((await anon.from("memberships").select("id")).data ?? []).toEqual([]);
    const rpc = await anon.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsAll], p_profile_id: ID.pA1 });
    expect(rpc.error ? [] : rpc.data).toEqual([]);
  });

  it("공개 수업 상세가 비공개 센터·제한 상품을 노출하지 않는다", async () => {
    for (const sub of [null, U.A, U.B]) {
      const c = as(sub);
      expect((await c.from("centers").select("id").eq("id", ID.centerPriv)).data).toEqual([]);          // 미승인 센터는 읽히지 않는다
      expect((await c.from("classes").select("id").eq("id", ID.clsPriv)).data).toEqual([]);
      expect((await c.from("products").select("id").eq("id", ID.prodPriv)).data).toEqual([]);
      expect(await fetchCenterClassDetail(ID.centerPriv, ID.clsPriv)).toBeNull();
    }
    const anon = as(null);
    const pub = await anon.from("classes").select("id").eq("id", ID.clsSel);
    expect(pub.data).toEqual([{ id: ID.clsSel }]);                                                       // 공개 센터 수업은 비로그인에게 열린다
    const store = await anon.rpc("fetch_public_storefront_products", { p_center_id: null });
    expect(store.error).toBeNull();
    const ids = (store.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(ID.prodFree);
    expect(ids).not.toContain(ID.prodPriv);          // 미승인 센터 상품
    expect(ids).not.toContain(ID.prodRestricted);    // 지정 회원 전용 상품
    const detail = await fetchCenterClassDetail(ID.centerPub, ID.clsSel);
    expect(detail?.allowedPasses.kind).toBe("login_required");                                           // 비로그인에게 허용 수강권 목록은 숨겨진다(빈 목록을 '모두 가능'으로 보지 않음)
  });

  it("예약 → 내 예약 반영 → 정확히 1회 차감 → 취소 → 정확한 복구, 중복·동시 요청에서도 이중 처리 없음", async () => {
    const a = as(U.A);
    const remaining = async () => ((await a.from("memberships").select("remaining_count").eq("id", grantedMembershipId)).data as { remaining_count: number }[])[0].remaining_count;
    expect(await remaining()).toBe(3);
    // 동시 두 요청(중복 클릭): 정확히 하나만 성공
    const [r1, r2] = await Promise.all([
      a.rpc("reserve_with_membership", { p_class_id: ID.clsSel, p_profile_id: ID.pA1, p_membership_id: grantedMembershipId }),
      a.rpc("reserve_with_membership", { p_class_id: ID.clsSel, p_profile_id: ID.pA1, p_membership_id: grantedMembershipId }),
    ]);
    expect([r1.error, r2.error].filter((e) => e === null)).toHaveLength(1);
    const mine = await a.from("reservations").select("id, status, membership_id").eq("class_id", ID.clsSel).eq("profile_id", ID.pA1).in("status", ["confirmed", "waitlisted"]);
    expect(mine.data).toHaveLength(1);                                    // 내 예약에 반영, 중복 예약 없음
    expect(await remaining()).toBe(2);                                    // 정확히 1회 차감
    // 순차 재시도도 거부되고 차감이 늘지 않는다
    const again = await a.rpc("reserve_with_membership", { p_class_id: ID.clsSel, p_profile_id: ID.pA1, p_membership_id: grantedMembershipId });
    expect(again.error).not.toBeNull();
    expect(await remaining()).toBe(2);
    // 다른 계정은 이 예약을 볼 수 없고 취소할 수도 없다
    const reservationId = (mine.data as { id: string }[])[0].id;
    expect((await as(U.B).from("reservations").select("id").eq("id", reservationId)).data).toEqual([]);
    expect((await as(U.B).rpc("cancel_reservation", { p_reservation_id: reservationId })).error).not.toBeNull();
    expect(await remaining()).toBe(2);
    // 정책상 허용된 취소(수업 3일 전): 정확히 1회 복구, 중복 취소는 이중 복구하지 않는다
    const cancel = await as(U.A).rpc("cancel_reservation", { p_reservation_id: reservationId });
    expect(cancel.error).toBeNull();
    const cancelTwice = await as(U.A).rpc("cancel_reservation", { p_reservation_id: reservationId });
    expect(cancelTwice.error).not.toBeNull();
    expect(await remaining()).toBe(3);
    expect(((await as(U.A).from("reservations").select("status").eq("id", reservationId)).data as { status: string }[])[0].status).toBe("cancelled");
  });
  it("프로필 공유 정책(add_shared_passes 기준 — fix_usable_memberships_shared.sql): 가족 프로필로도 예약되고 UI 판정과 서버 판정이 같다", async () => {
    const a = as(U.A);
    const remaining = async () => ((await a.from("memberships").select("remaining_count").eq("id", grantedMembershipId)).data as { remaining_count: number }[])[0].remaining_count;
    const before = await remaining();
    // UI 판정: 가족 프로필(pA2)도 usable
    const view = await fetchViewerClassState(ID.centerPub, ID.clsAll);
    if (view.kind !== "member") throw new Error("member여야 한다");
    expect(view.profiles.find((p) => p.profile.id === ID.pA2)?.status).toBe("usable");
    // 서버 판정: 같은 수강권으로 가족 프로필 예약 성공, 1회 차감
    const ok = await a.rpc("reserve_with_membership", { p_class_id: ID.clsAll, p_profile_id: ID.pA2, p_membership_id: grantedMembershipId });
    expect(ok.error).toBeNull();
    expect(await remaining()).toBe(before - 1);
    const res = await a.from("reservations").select("id, profile_id, status").eq("class_id", ID.clsAll).eq("profile_id", ID.pA2).in("status", ["confirmed", "waitlisted"]);
    expect(res.data).toHaveLength(1);
    const cancel = await a.rpc("cancel_reservation", { p_reservation_id: (res.data as { id: string }[])[0].id });
    expect(cancel.error).toBeNull();
    expect(await remaining()).toBe(before);
  });

  it("허용되지 않은 사용은 서버가 거부하고 횟수를 차감하지 않는다: 타 계정 프로필·타 계정 수강권", async () => {
    const a = as(U.A);
    const remaining = async () => ((await a.from("memberships").select("remaining_count").eq("id", grantedMembershipId)).data as { remaining_count: number }[])[0].remaining_count;
    const before = await remaining();
    // A가 B의 프로필로 자기 수강권을 쓰려는 경우
    const spoofProfile = await a.rpc("reserve_with_membership", { p_class_id: ID.clsAll, p_profile_id: ID.pB1, p_membership_id: grantedMembershipId });
    expect(spoofProfile.error).not.toBeNull();
    // B가 A의 수강권을 쓰려는 경우(본인 프로필로)
    const stolen = await as(U.B).rpc("reserve_with_membership", { p_class_id: ID.clsAll, p_profile_id: ID.pB1, p_membership_id: grantedMembershipId });
    expect(stolen.error).not.toBeNull();
    // A가 B의 수강권을 쓰려는 경우
    const theirs = await as(U.A).rpc("reserve_with_membership", { p_class_id: ID.clsAll, p_profile_id: ID.pA1, p_membership_id: ID.memB });
    expect(theirs.error).not.toBeNull();
    expect(await remaining()).toBe(before);
    expect(sql(`select remaining_count from memberships where id='${ID.memB}'`)).toBe("10");
    expect(sql(`select count(*) from reservations where class_id='${ID.clsAll}' and status in ('confirmed','waitlisted')`)).toBe("0");   // 실패한 예약이 남지 않음
  });

  it("[현재 동작 기록] 옛 귀속 컬럼(bound_profile_id)이 채워진 수강권: 예약 목록(usable)과 서버 예약 판정이 일치하는지", async () => {
    sql(`update memberships set bound_profile_id='${ID.pA1}' where id='${grantedMembershipId}'`);
    try {
      const a = as(U.A);
      const usable = await a.rpc("usable_memberships_for_classes", { p_class_ids: [ID.clsAll], p_profile_id: ID.pA2 });
      const listedForFamily = (usable.data as { membership_id: string }[]).some((r) => r.membership_id === grantedMembershipId);
      const book = await a.rpc("reserve_with_membership", { p_class_id: ID.clsAll, p_profile_id: ID.pA2, p_membership_id: grantedMembershipId });
      // 목록에 보이는 것과 서버가 허용하는 것이 같아야 한다(목록 O → 예약 성공, 목록 X → 예약 거부)
      expect(book.error === null).toBe(listedForFamily);
      if (book.error === null) {
        const rid = (await a.from("reservations").select("id").eq("class_id", ID.clsAll).eq("profile_id", ID.pA2).in("status", ["confirmed"])).data as { id: string }[];
        await a.rpc("cancel_reservation", { p_reservation_id: rid[0].id });
      }
      console.log(`[bound_profile_id 채워진 수강권] 가족 프로필: 목록=${listedForFamily ? "표시" : "숨김"}, 서버=${book.error ? "거부" : "허용"}`);
    } finally { sql(`update memberships set bound_profile_id=null where id='${grantedMembershipId}'`); }
  });
});
