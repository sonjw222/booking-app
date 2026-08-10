/*
  임시 진단 전용 파일(P1-15 사후 검증) — READ-ONLY, DELETE/UPDATE/INSERT 없음. 사용자가
  cleanup_p1_15_stale_schedule_rules_draft_proposed.sql을 Supabase SQL Editor에서 적용
  완료(C-1: remaining_target_rules=0)했다고 보고함. 이 스크립트는 실제 QA 계정/센터
  데이터로 (1) "수강권" 상품의 membership_schedule_rules가 정말 0건인지 독립 재확인하고,
  (2) 회원이 실제 보유한 memberships가 "테스트" class에서 이제 usable로 예측되는지
  재계산한다. 이메일은 워크플로 런타임 입력(DIAG_EMAIL_A/B)으로만 받고 로그에 절대
  출력하지 않는다. 진단 완료 후 이 파일은 삭제한다.
*/
import { describe, it } from "vitest";
import { getFixtureAdminClient } from "./setup";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 환경변수가 없습니다(워크플로 입력 확인)`);
  return v;
}

async function resolveAccountIdByEmail(admin: any, email: string): Promise<{ authUserId: string; accountId: string } | null> {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await (admin as any).auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`auth.admin.listUsers 실패: ${error.message}`);
    const users = data?.users ?? [];
    const found = users.find((u: any) => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (found) {
      const { data: acc, error: accErr } = await admin.from("accounts").select("id").eq("auth_id", found.id).maybeSingle();
      if (accErr) throw new Error(`accounts 조회 실패: ${accErr.message}`);
      if (!acc) return { authUserId: found.id, accountId: "" };
      return { authUserId: found.id, accountId: (acc as any).id };
    }
    if (users.length < perPage) return null;
    page += 1;
    if (page > 20) return null;
  }
}

describe.skipIf(!process.env.DIAG_EMAIL_A)("P1-15 사후 검증(read-only)", () => {
  it("schedule_rules 삭제 확인 + 실제 memberships usable 예측 재계산", async () => {
    const admin = getFixtureAdminClient();
    const emailB = need("DIAG_EMAIL_B");
    const restrictedProductId = "f6010b96-f83a-4f23-8205-9897aa8b6621"; // "수강권" 상품
    const targetClassId = "a894bb13-f82a-49b1-b7a7-f659899ce1a8"; // "테스트" class

    // 1) membership_schedule_rules 독립 재확인(사용자의 SQL Editor 확인과 별개로)
    const { data: rules, error: rulesErr } = await admin
      .from("membership_schedule_rules").select("id, day_of_week, start_time, class_title").eq("product_id", restrictedProductId);
    if (rulesErr) throw new Error(`membership_schedule_rules 조회 실패: ${rulesErr.message}`);
    console.log(`=== DIAG: "수강권" 상품(${restrictedProductId}) 남은 membership_schedule_rules 건수=${rules?.length ?? "ERROR"} 상세=${JSON.stringify(rules)} ===`);

    // 2) 실제 회원의 memberships 재확인
    const memberRes = await resolveAccountIdByEmail(admin, emailB);
    if (!memberRes?.accountId) {
      console.log("=== DIAG: memberB 계정을 못 찾음 — 중단 ===");
      return;
    }
    const { data: profiles } = await admin.from("profiles").select("id").eq("account_id", memberRes.accountId);
    const profileIds = (profiles ?? []).map((p: any) => p.id);

    const { data: memberships, error: memErr } = await admin
      .from("memberships")
      .select("id, profile_id, product_id, status, remaining_count, expires_at, created_at")
      .in("profile_id", profileIds)
      .eq("product_id", restrictedProductId);
    if (memErr) throw new Error(`memberships 조회 실패: ${memErr.message}`);
    console.log(`=== DIAG: memberB의 "수강권" memberships 건수=${memberships?.length ?? 0} ===`);

    // 3) "테스트" class 정보 재확인(요일/시간/제목)
    const { data: cls, error: clsErr } = await admin.from("classes").select("id, title, start_time").eq("id", targetClassId).maybeSingle();
    if (clsErr) throw new Error(`class 조회 실패: ${clsErr.message}`);
    if (!cls) {
      console.log("=== DIAG: 대상 class를 못 찾음(삭제/변경됐을 수 있음) — 중단 ===");
      return;
    }
    const startTime = new Date(cls.start_time);
    const kst = new Date(startTime.getTime() + 9 * 3600 * 1000);
    const ldow = kst.getUTCDay();
    const ltimeStr = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}:00`;
    console.log(`=== DIAG: class "${cls.title}"(${cls.id}) ldow=${ldow} ltime=${ltimeStr} ===`);

    // 4) class_allowed_products 확인("모든 수강권 허용" 유지되고 있는지)
    const { data: caps } = await admin.from("class_allowed_products").select("product_id").eq("class_id", targetClassId);
    console.log(`=== DIAG: class_allowed_products 건수=${caps?.length ?? 0} (0건=모든 수강권 허용) ===`);

    // 5) 각 membership이 이제 usable로 예측되는지 재계산(원인이었던 predicate만 재확인 —
    // usable_memberships_for_classes RPC와 동일 조건)
    for (const m of memberships ?? []) {
      const statusOk = m.status === "active";
      const remainingOk = m.remaining_count === null || m.remaining_count > 0;
      const expiresOk = m.expires_at >= new Date().toISOString().slice(0, 10);
      const capOk = (caps?.length ?? 0) === 0 || (caps ?? []).some((c: any) => c.product_id === restrictedProductId);
      const scheduleOk = (rules?.length ?? 0) === 0 || (rules ?? []).some((r: any) =>
        (r.day_of_week === null || r.day_of_week === ldow) &&
        (r.start_time === null || r.start_time === ltimeStr) &&
        (r.class_title === null || r.class_title === cls.title)
      );
      const usable = statusOk && remainingOk && expiresOk && capOk && scheduleOk;
      console.log(`=== DIAG: membership ${m.id} usable예측=${usable} (status=${statusOk} remaining=${remainingOk} expires=${expiresOk} classAllowed=${capOk} scheduleRule=${scheduleOk}) ===`);
    }
  }, 60000);
});
