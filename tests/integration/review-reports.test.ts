/*
  Release Blocker Cleanup Batch A — center_reviews 신고(review_reports) RLS/중복
  방지 검증. add_review_reports.sql이 적용된 뒤에만 전부 PASS한다 — 테이블/정책이
  아직 없으면 "relation ... does not exist" 류의 에러로 예상대로 실패한다(배포
  전이라 이번 실행에서는 통과 못함 — 배포 후 재실행 필요, 이 세션의 다른 배치들과
  동일한 관례).

  전용 임시 계정 3개(A=신고자, B=엉뚱한 명의 시도 대상, admin=운영자)를 매 실행
  새로 만들어 쓴다 — account-deletion-anonymization.test.ts / accounts-privilege-
  escalation.test.ts와 동일하게 별도 client 인스턴스로 로그인한다.
*/
import { describe, it, expect, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getFixtureAdminClient, requireEnv } from "./setup";

describe("center_reviews 신고(review_reports) RLS/중복 방지 (Release Blocker Cleanup Batch A)", () => {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `qa-report-a-${runId}@example.com`;
  const emailB = `qa-report-b-${runId}@example.com`;
  const emailAdmin = `qa-report-admin-${runId}@example.com`;
  const password = `Qa-report-pw-${runId}`;

  let authIdA = "", authIdB = "", authIdAdmin = "";
  let accountIdA = "", accountIdB = "", accountIdAdmin = "";
  let writerProfileId = "";
  let centerId = "";
  let reviewId = "";
  let reportIdByA = "";

  afterAll(async () => {
    // FK 순서: review_reports → center_reviews → center_roles(센터 생성 시 자동
    // 생성되는 기본 역할) → centers, 그리고 profiles(작성자) → accounts. 이 순서를
    // 안 지키면 삭제가 조용히 실패해 QA fixture가 남는다(실제로 겪은 문제 — 최초
    // 실행 때 center_roles/profiles를 안 지워 센터 1개+계정 1개가 남았었음, 이후
    // 수동으로 정리하고 이 순서로 고침).
    const admin = getFixtureAdminClient();
    if (reviewId) await admin.from("review_reports").delete().eq("review_id", reviewId).then(() => {}, () => {});
    if (reviewId) await admin.from("center_reviews").delete().eq("id", reviewId).then(() => {}, () => {});
    if (centerId) await admin.from("center_roles").delete().eq("center_id", centerId).then(() => {}, () => {});
    if (centerId) await admin.from("centers").delete().eq("id", centerId).then(() => {}, () => {});
    if (writerProfileId) await admin.from("profiles").delete().eq("id", writerProfileId).then(() => {}, () => {});
    for (const id of [accountIdA, accountIdB, accountIdAdmin]) {
      if (id) await admin.from("accounts").delete().eq("id", id).then(() => {}, () => {});
    }
    for (const id of [authIdA, authIdB, authIdAdmin]) {
      if (id) await admin.auth.admin.deleteUser(id).catch(() => {});
    }
  });

  it("전용 fixture 준비: 센터 + 후기 1건 + 신고자/타깃/운영자 계정", async () => {
    const admin = getFixtureAdminClient();

    const createdA = await admin.auth.admin.createUser({ email: emailA, password, email_confirm: true });
    if (createdA.error || !createdA.data.user) throw new Error(`계정 A 생성 실패: ${createdA.error?.message}`);
    authIdA = createdA.data.user.id;
    const createdB = await admin.auth.admin.createUser({ email: emailB, password, email_confirm: true });
    if (createdB.error || !createdB.data.user) throw new Error(`계정 B 생성 실패: ${createdB.error?.message}`);
    authIdB = createdB.data.user.id;
    const createdAdmin = await admin.auth.admin.createUser({ email: emailAdmin, password, email_confirm: true });
    if (createdAdmin.error || !createdAdmin.data.user) throw new Error(`운영자 계정 생성 실패: ${createdAdmin.error?.message}`);
    authIdAdmin = createdAdmin.data.user.id;

    const accA = await admin.from("accounts").insert({ auth_id: authIdA, name: "QA 신고자A", is_member: true }).select("id").single();
    if (accA.error || !accA.data) throw new Error(`accounts A 생성 실패: ${accA.error?.message}`);
    accountIdA = accA.data.id as string;
    const accB = await admin.from("accounts").insert({ auth_id: authIdB, name: "QA 타깃B", is_member: true }).select("id").single();
    if (accB.error || !accB.data) throw new Error(`accounts B 생성 실패: ${accB.error?.message}`);
    accountIdB = accB.data.id as string;
    const accAdmin = await admin.from("accounts").insert({ auth_id: authIdAdmin, name: "QA 운영자", is_member: true, is_platform_admin: true }).select("id").single();
    if (accAdmin.error || !accAdmin.data) throw new Error(`운영자 accounts 생성 실패: ${accAdmin.error?.message}`);
    accountIdAdmin = accAdmin.data.id as string;

    // 후기를 쓴 프로필 — 위 세 계정과 무관한 별도 fixture(리뷰 작성자 ≠ 신고자여도 무방,
    // 이번 테스트는 신고 쪽 RLS만 검증하면 됨).
    const writerProf = await admin.from("profiles").insert({ account_id: accountIdB, name: "QA 후기 작성자", is_primary: true }).select("id").single();
    if (writerProf.error || !writerProf.data) throw new Error(`작성자 profiles 생성 실패: ${writerProf.error?.message}`);
    writerProfileId = writerProf.data.id as string;

    const center = await admin.from("centers").insert({ name: `QA 신고테스트센터-${runId}`, status: "approved" }).select("id").single();
    if (center.error || !center.data) throw new Error(`centers 생성 실패: ${center.error?.message}`);
    centerId = center.data.id as string;

    const review = await admin.from("center_reviews").insert({
      center_id: centerId, profile_id: writerProfileId, rating: 3, content: "QA 테스트용 후기입니다.",
    }).select("id").single();
    if (review.error || !review.data) throw new Error(`center_reviews 생성 실패: ${review.error?.message}`);
    reviewId = review.data.id as string;
  });

  it("비로그인 상태로는 신고를 생성할 수 없다", async () => {
    // 일반 사용자 client는 review_reports에 SELECT 권한이 없으므로 insert().select()를
    // 쓰면 PostgREST가 return=representation을 위해 SELECT 가시성을 요구해 항상 실패
    // 응답이 온다(정책이 진짜 막은 게 아니라 조회 권한 부재로 인한 위양성). 그래서 여기서는
    // 순수 .insert()만 수행하고 성공 여부는 error로만 판단한다 — 프로덕션 lib/reviews.ts의
    // reportReview()와 동일한 패턴.
    const anonClient: SupabaseClient = createClient(url, anonKey);
    const attempt = await anonClient
      .from("review_reports")
      .insert({ review_id: reviewId, reporter_account_id: accountIdA, reason: "spam" });
    expect(attempt.error).toBeTruthy();
  });

  it("A가 B 명의로 신고를 생성할 수 없다", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientA
      .from("review_reports")
      .insert({ review_id: reviewId, reporter_account_id: accountIdB, reason: "spam" });
    expect(attempt.error).toBeTruthy();
  });

  it("A가 본인 명의로 정상 신고를 생성할 수 있다", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    // 순수 insert만 수행 — 일반 사용자에게는 SELECT 정책이 없어 .select()를 체이닝하면
    // return=representation 요구사항 때문에 42501로 실패한다(review_reports 설계상
    // 의도된 동작, add_review_reports.sql 참고). 생성된 행 id는 admin client로 후속 조회.
    const attempt = await clientA
      .from("review_reports")
      .insert({ review_id: reviewId, reporter_account_id: accountIdA, reason: "inappropriate", detail: "테스트 신고" });
    if (attempt.error) throw new Error(`정상 신고 실패: ${attempt.error.message}`);

    const admin = getFixtureAdminClient();
    const verify = await admin
      .from("review_reports")
      .select("id")
      .eq("review_id", reviewId)
      .eq("reporter_account_id", accountIdA)
      .single();
    if (verify.error || !verify.data) throw new Error(`생성된 신고 조회 실패: ${verify.error?.message}`);
    reportIdByA = verify.data.id as string;
  });

  it("동일 사용자가 같은 후기를 다시 신고하면 실패한다", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientA
      .from("review_reports")
      .insert({ review_id: reviewId, reporter_account_id: accountIdA, reason: "abuse" });
    expect(attempt.error).toBeTruthy();
    expect(attempt.error?.code).toBe("23505");
  });

  it("존재하지 않는 후기를 신고하면 실패한다", async () => {
    const clientB: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientB.auth.signInWithPassword({ email: emailB, password });
    if (signIn.error) throw new Error(`B 로그인 실패: ${signIn.error.message}`);

    const attempt = await clientB
      .from("review_reports")
      .insert({ review_id: "00000000-0000-0000-0000-000000000000", reporter_account_id: accountIdB, reason: "spam" });
    expect(attempt.error).toBeTruthy();
  });

  it("일반 사용자는 신고 목록을 조회할 수 없다", async () => {
    const clientA: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientA.auth.signInWithPassword({ email: emailA, password });
    if (signIn.error) throw new Error(`A 로그인 실패: ${signIn.error.message}`);

    const { data, error } = await clientA.from("review_reports").select("id").eq("id", reportIdByA);
    // RLS가 SELECT 정책 자체를 안 줬으므로 에러가 아니라 "조용히 0건"으로 와야 한다.
    expect(error).toBeFalsy();
    expect(data ?? []).toHaveLength(0);
  });

  it("운영자는 신고 목록을 조회할 수 있다", async () => {
    const clientAdmin: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientAdmin.auth.signInWithPassword({ email: emailAdmin, password });
    if (signIn.error) throw new Error(`운영자 로그인 실패: ${signIn.error.message}`);

    const { data, error } = await clientAdmin.from("review_reports").select("id, status").eq("id", reportIdByA);
    if (error) throw new Error(`운영자 조회 실패: ${error.message}`);
    expect(data?.length).toBe(1);
    expect(data?.[0]?.status).toBe("pending");
  });

  it("운영자는 신고 상태를 변경할 수 있다", async () => {
    const clientAdmin: SupabaseClient = createClient(url, anonKey);
    const signIn = await clientAdmin.auth.signInWithPassword({ email: emailAdmin, password });
    if (signIn.error) throw new Error(`운영자 로그인 실패: ${signIn.error.message}`);

    const { error } = await clientAdmin
      .from("review_reports")
      .update({ status: "reviewed", reviewed_at: new Date().toISOString(), reviewed_by: accountIdAdmin })
      .eq("id", reportIdByA);
    if (error) throw new Error(`상태 변경 실패: ${error.message}`);

    const admin = getFixtureAdminClient();
    const verify = await admin.from("review_reports").select("status").eq("id", reportIdByA).single();
    expect(verify.data?.status).toBe("reviewed");
  });
});
