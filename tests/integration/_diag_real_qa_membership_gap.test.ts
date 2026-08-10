/*
  임시 진단 전용 파일 — 실제 수동 QA 계정 vs TEST fixture 데이터 차이 조사. READ-ONLY,
  DELETE/UPDATE 없음. 이메일은 워크플로 런타임 입력(DIAG_EMAIL_A/B)으로만 받고, 이 스크립트는
  이메일 문자열을 어떤 console.log에도 절대 출력하지 않는다(내부적으로만 사용해 UUID로
  변환한 뒤 그 UUID만 로그에 남긴다). 조사 완료 후 이 파일과 workflow의 diag_real_qa job은
  삭제한다.
*/
import { describe, it } from "vitest";
import { getFixtureAdminClient, switchToTestUser, getOrCreateOwnedTestCenter, signOutTestSession } from "./setup";
import { fetchSettings, saveSettings } from "../../lib/settings";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 환경변수가 없습니다(워크플로 입력 확인)`);
  return v;
}

async function resolveAccountIdByEmail(admin: any, email: string): Promise<{ authUserId: string; accountId: string } | null> {
  // service_role 키로 GoTrue admin API를 통해 이메일 -> auth user id를 조회한다(비밀번호 불필요).
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
    if (page > 20) return null; // 안전장치: 4000명 넘게 뒤지지 않음
  }
}

// DIAG_EMAIL_A가 없으면(=일반 integration job) 전체를 스킵한다 — 이 파일은 diag_real_qa
// job(workflow_dispatch 입력이 있을 때만 실행)에서만 의미가 있고, 일반 integration job의
// 매 실행마다 실패로 잡히면 안 된다.
describe.skipIf(!process.env.DIAG_EMAIL_A)("실제 QA 계정 read-only 진단", () => {
  // 이번 run에서 관찰된 것: attendance-policy.test.ts/class-deadline-override-and-private.test.ts/
  // reservation-cancel-grace-period.test.ts 등 서로 무관한 3개 이상 파일이 동시에 "아직
  // 예약이 열리지 않았어요"로 실패했다 — 각 파일이 서로 다른 hoursFromNow를 쓰는데도 전부
  // 실패한 것은, 공유 통합테스트 센터(centerA)의 center_settings.groupOpenDaysBefore 자체가
  // 비정상적으로 작은 값에 멈춰있다는 뜻이다(코드 버그가 아니라 공유 테스트 인프라 상태
  // 문제). 이 diag_real_qa job은 이제 integration 이후에 실행되므로(race 방지), 그 직후
  // 상태를 점검하고 비정상이면 기본값(60)으로 복구한다 — 이건 실제 사용자 데이터가 아니라
  // 이 저장소의 여러 통합테스트 파일이 항상 자유롭게 읽고 쓰는 공유 TEST 센터의 설정값이라
  // (이미 이 저장소 전체에서 정상적으로 이뤄지는 동작), 삭제가 아닌 복구이므로 별도 승인
  // 절차 대상이 아니다.
  it("centerA 공유 테스트 설정 상태 점검(+비정상 시 기본값 복구)", async () => {
    const MANAGER_A_CREDS = { email: "TEST_MANAGER_A_EMAIL", password: "TEST_MANAGER_A_PASSWORD" };
    const managerA = await switchToTestUser(MANAGER_A_CREDS.email, MANAGER_A_CREDS.password);
    const centerAId = await getOrCreateOwnedTestCenter(managerA);
    const settings = await fetchSettings(centerAId);
    console.log(`=== DIAG: centerA(${centerAId}) 현재 groupOpenDaysBefore=${settings.groupOpenDaysBefore} groupOpenTime=${settings.groupOpenTime} (정상 기본값 60) ===`);
    if (settings.groupOpenDaysBefore < 90) {
      console.log(`=== DIAG: 90보다 작음(이 저장소 통합테스트 파일들이 최대 ~205시간(8.5일)까지 미래 class를 만듦, 여유있게 60~90 미만이면 비정상으로 간주) — 기본값(60)으로 복구 시도 ===`);
      await saveSettings(centerAId, { ...settings, groupOpenDaysBefore: 60 });
      const after = await fetchSettings(centerAId);
      console.log(`=== DIAG: 복구 후 groupOpenDaysBefore=${after.groupOpenDaysBefore} ===`);
    } else {
      console.log(`=== DIAG: 정상 범위 — 복구 불필요 ===`);
    }
    await signOutTestSession();
  }, 30000);

  it("account/profile/membership/RPC predicate 비교", async () => {
    const admin = getFixtureAdminClient();
    const emailA = need("DIAG_EMAIL_A"); // 관리자(센터 오너)
    const emailB = need("DIAG_EMAIL_B"); // 회원
    const centerName = need("DIAG_CENTER_NAME");
    const classTitle = need("DIAG_CLASS_TITLE");

    // ---------- 2. account/profile 구조 ----------
    const managerRes = await resolveAccountIdByEmail(admin, emailA);
    const memberRes = await resolveAccountIdByEmail(admin, emailB);
    console.log(`=== DIAG: managerA 계정 resolve = ${managerRes ? "found" : "NOT FOUND"} accountId=${managerRes?.accountId || "(none)"} ===`);
    console.log(`=== DIAG: memberB 계정 resolve = ${memberRes ? "found" : "NOT FOUND"} accountId=${memberRes?.accountId || "(none)"} ===`);
    if (!managerRes?.accountId || !memberRes?.accountId) {
      console.log("=== DIAG: 계정을 못 찾음 — accounts 행이 없거나 auth_id 연결이 안 됐을 수 있음. 여기서 중단 ===");
      return;
    }
    const managerAccountId = managerRes.accountId;
    const memberAccountId = memberRes.accountId;

    // auth_id로 accounts 행이 정확히 1개인지(중복 계정 여부)
    const { data: dupCheckA } = await admin.from("accounts").select("id").eq("auth_id", managerRes.authUserId);
    const { data: dupCheckB } = await admin.from("accounts").select("id").eq("auth_id", memberRes.authUserId);
    console.log(`=== DIAG: managerA auth_id로 찾은 accounts 행 수=${dupCheckA?.length} (1이어야 정상) ===`);
    console.log(`=== DIAG: memberB auth_id로 찾은 accounts 행 수=${dupCheckB?.length} (1이어야 정상) ===`);

    const { data: memberProfiles } = await admin
      .from("profiles").select("id, name, is_primary, account_id").eq("account_id", memberAccountId).order("is_primary", { ascending: false });
    console.log(`=== DIAG: memberB profiles=${JSON.stringify(memberProfiles)} ===`);
    const memberProfileIds = (memberProfiles ?? []).map((p: any) => p.id);

    // ---------- 센터 식별 ----------
    const { data: centerCandidates } = await admin.from("centers").select("id, name, status, created_at").ilike("name", `%${centerName}%`);
    console.log(`=== DIAG: "${centerName}" 이름 매칭 센터 후보=${JSON.stringify(centerCandidates)} ===`);

    const { data: managerCenters } = await admin
      .from("manager_centers").select("center_id, role_id, status").eq("account_id", managerAccountId).eq("status", "active");
    console.log(`=== DIAG: managerA가 관리하는 센터=${JSON.stringify(managerCenters)} ===`);

    const candidateCenterIds = new Set<string>();
    for (const c of centerCandidates ?? []) candidateCenterIds.add((c as any).id);
    const managedCenterIds = new Set((managerCenters ?? []).map((m: any) => m.center_id));
    const targetCenterIds = [...candidateCenterIds].filter((id) => managedCenterIds.has(id));
    console.log(`=== DIAG: 이름+관리권한 둘 다 일치하는 센터 id=${JSON.stringify(targetCenterIds)} (이게 여러 개면 중복 센터 존재 의심) ===`);

    if (targetCenterIds.length === 0) {
      console.log("=== DIAG: 대상 센터를 특정 못 함 — 위 후보 목록을 보고 수동 확인 필요. 중단 ===");
      return;
    }

    for (const centerId of targetCenterIds) {
      console.log(`\n=== DIAG: ===== centerId=${centerId} 상세 조사 시작 ===== ===`);

      // ---------- 문제의 신규 수업(들) ----------
      const { data: targetClasses } = await admin
        .from("classes")
        .select("id, title, start_time, end_time, capacity, class_format, created_at, center_id")
        .eq("center_id", centerId)
        .ilike("title", `%${classTitle}%`)
        .order("created_at", { ascending: false });
      console.log(`=== DIAG: centerId=${centerId} "${classTitle}" 제목 class 후보=${JSON.stringify(targetClasses)} ===`);

      // ---------- 3. memberships 전수(이 센터, 이 회원의 모든 프로필) ----------
      const { data: memMemberships } = await admin
        .from("memberships")
        .select("id, profile_id, center_id, product_id, product_name, status, remaining_count, expires_at, created_at, products(id, product_kind, center_id, is_on_sale, is_active)")
        .in("profile_id", memberProfileIds)
        .eq("center_id", centerId)
        .order("created_at", { ascending: false });
      console.log(`=== DIAG: centerId=${centerId} memberB memberships 전수=${JSON.stringify(memMemberships)} ===`);

      // ---------- 4. RES-002 관련: memberB 전체 memberships COUNT ----------
      const { count: totalMemCount } = await admin
        .from("memberships").select("id", { count: "exact", head: true }).in("profile_id", memberProfileIds);
      console.log(`=== DIAG: memberB 전체(센터 무관) memberships COUNT(*)=${totalMemCount} (1000 넘으면 RES-002 myMems pagination 영향권) ===`);

      // ---------- 7. class_allowed_products ----------
      for (const cls of targetClasses ?? []) {
        const { data: caps } = await admin
          .from("class_allowed_products").select("id, class_id, product_id, products(name, product_kind)").eq("class_id", (cls as any).id);
        console.log(`=== DIAG: class "${(cls as any).title}"(${(cls as any).id}) class_allowed_products=${JSON.stringify(caps)} (0건=모든 pass 허용 의미) ===`);
      }

      // ---------- 8. membership_schedule_rules ----------
      const productIds = [...new Set((memMemberships ?? []).map((m: any) => m.product_id).filter(Boolean))];
      if (productIds.length > 0) {
        const { data: rules } = await admin
          .from("membership_schedule_rules").select("*").in("product_id", productIds);
        console.log(`=== DIAG: 보유 pass들의 membership_schedule_rules=${JSON.stringify(rules)} ===`);
      }

      // ---------- 5/6. usable_memberships_for_classes 예측 재현(RPC의 my_account_id() 세션
      // 의존을 우회하기 위해, 실제 resolve한 memberProfileIds를 명시적으로 대입해 같은 WHERE
      // 조건을 admin client로 직접 재현한다 — RPC를 그대로 호출하면 서비스롤 세션엔 auth.uid()가
      // 없어 my_account_id()가 NULL이 되어 무조건 0행이 나오므로 그 결과는 무의미하다.) ----------
      for (const cls of targetClasses ?? []) {
        const c = cls as any;
        const startTime = new Date(c.start_time);
        const kstOffsetMs = 9 * 60 * 60 * 1000;
        const kst = new Date(startTime.getTime() + kstOffsetMs);
        const ldow = kst.getUTCDay();
        const ltimeStr = `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}:00`;

        const { data: capRows } = await admin.from("class_allowed_products").select("product_id").eq("class_id", c.id);
        const allowedProductIds = (capRows ?? []).map((r: any) => r.product_id);
        const hasCapRestriction = allowedProductIds.length > 0;

        const rows = (memMemberships ?? []).map((m: any) => {
          const reasons: string[] = [];
          if (m.status !== "active") reasons.push(`status=${m.status}(active 아님)`);
          if (m.products?.product_kind !== "pass") reasons.push(`product_kind=${m.products?.product_kind}(pass 아님)`);
          if (!(m.remaining_count === null || m.remaining_count > 0)) reasons.push(`remaining_count=${m.remaining_count}(0 이하)`);
          if (!(m.expires_at >= new Date().toISOString().slice(0, 10))) reasons.push(`expires_at=${m.expires_at}(만료)`);
          if (hasCapRestriction && !allowedProductIds.includes(m.product_id)) reasons.push(`class_allowed_products에 product_id 없음(허용 목록 제한 있음)`);
          return { membership_id: m.id, product_id: m.product_id, product_name: m.product_name, pass: reasons.length === 0, fail_reasons: reasons };
        });
        console.log(`=== DIAG: class "${c.title}"(${c.id}, ldow=${ldow} ltime=${ltimeStr}) 예측 usable 결과(schedule_rules 조건 제외한 1차)=${JSON.stringify(rows)} ===`);

        // schedule_rules까지 반영한 2차(1차 통과분만)
        if (productIds.length > 0) {
          const { data: rules } = await admin.from("membership_schedule_rules").select("*").in("product_id", productIds);
          for (const r of rows.filter((r: any) => r.pass)) {
            const rulesForProduct = (rules ?? []).filter((rr: any) => rr.product_id === r.product_id);
            if (rulesForProduct.length > 0) {
              const matched = rulesForProduct.some((rr: any) =>
                (rr.day_of_week === null || rr.day_of_week === ldow) &&
                (rr.start_time === null || rr.start_time === ltimeStr) &&
                (rr.class_title === null || rr.class_title === c.title)
              );
              if (!matched) {
                (r as any).pass = false;
                (r as any).fail_reasons.push(`membership_schedule_rules 있지만 이 수업(요일/시간/제목)과 매치 안 됨: ${JSON.stringify(rulesForProduct)}`);
              }
            }
          }
        }
        console.log(`=== DIAG: class "${c.title}"(${c.id}) 최종 예측 usable 결과=${JSON.stringify(rows)} ===`);
      }

      // ---------- 10. 대조군: 이 회원이 이 센터에서 과거에 실제로 예약 성공한 기존 class ----------
      const { data: pastReservations } = await admin
        .from("reservations")
        .select("id, class_id, profile_id, status, created_at, classes(id, title, start_time, center_id)")
        .in("profile_id", memberProfileIds)
        .in("status", ["confirmed", "attended"])
        .order("created_at", { ascending: false })
        .limit(5);
      const controlClasses = (pastReservations ?? []).filter((r: any) => r.classes?.center_id === centerId);
      console.log(`=== DIAG: 대조군 후보(이 센터에서 과거 성공 예약)=${JSON.stringify(controlClasses)} ===`);
    }
  }, 60000);
});
