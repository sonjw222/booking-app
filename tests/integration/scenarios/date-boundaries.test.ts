/*
  Automated Business Scenario E2E Batch(2026-09-18) — Phase 3: 날짜/시간 경계.
  SCN-P1-20/21(수강권 만료 경계 — 당일/전날), SCN-P1-22(예약 가능 마감시각 경계),
  SCN-P1-24(자정 경계, 기존 createKstSameDayFutureClass 재사용).

  ⚠ 원칙: "임의의 규칙을 만들지 말고 실제 KST 구현 기준으로 검증"(요청 원문). 이 파일의
  모든 경계값은 실제 배포된 reserve_class()/cancel_reservation() 본문(git 시간순으로
  확인한 최종본 — add_rolling_month_product_expiry.sql, fix_same_day_cancel_deadline_
  regression.sql)에서 그대로 가져왔다:
  - 수강권 유효성: "m.expires_at is null or m.expires_at >= current_date" — 당일까지는
    유효, 다음날부터 무효.
  - 예약 마감: booking_deadline_min이 없으면 calc_deadline(..., 'book')을 쓰고, 그마저
    없으면 v_book_deadline := v_class.start_time(사실상 마감 없음). resetStaleTestCenterSettings
    가 설정하는 group_book_days_before=1/group_book_time="22:00"이 실제 계산에 쓰이는
    값이다(add_center_settings.sql 스키마와 wire_settings.sql의 calc_deadline 배선).
  - 정확히 "그 초"를 맞추는 대신(플레이키함), "명백히 마감 전"과 "명백히 마감 후" 두
    구간으로 나눠 검증한다 — 초 단위 경계값 자체보다 "그 규칙이 실제로 지켜지는가"가
    이 배치의 목적에 더 부합한다(요청 5번 invariant 중심 검증 원칙과 동일 맥락).
*/
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { supabase } from "../../../lib/supabaseClient";
import { getOrCreateOwnedTestCenter, cleanupTestClassAdmin, getFixtureAdminClient, createKstSameDayFutureClass } from "../setup";
import { managerA as loginManagerA, memberA as loginMemberA, memberCSubProfile } from "./actors";
import { runScenario } from "./reporter";

function newRunId(): string {
  return `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe("SCN-P1-20/21/22/24: 날짜/시간 경계(KST)", () => {
  let centerAId: string;
  let memberAProfileId: string;
  let memberCProfileId: string;
  let originalWaitlistWeeklyLimit: number | null = null;
  let originalGroupBookDaysBefore: number | null = null;
  let originalGroupBookTime: string | null = null;
  let originalAllowSameDayBooking: boolean | null = null;
  const pendingClassIds: string[] = [];
  const pendingMembershipIds: string[] = [];

  beforeAll(async () => {
    const managerA = await loginManagerA();
    centerAId = await getOrCreateOwnedTestCenter(managerA);

    const admin = getFixtureAdminClient();
    const { data: existingSettings, error: readErr } = await admin
      .from("center_settings")
      .select("waitlist_weekly_limit, group_book_days_before, group_book_time, allow_same_day_booking")
      .eq("center_id", centerAId)
      .single();
    if (readErr) throw new Error(`테스트 센터 설정 조회 실패: ${readErr.message}`);
    originalWaitlistWeeklyLimit = (existingSettings as any).waitlist_weekly_limit;
    originalGroupBookDaysBefore = (existingSettings as any).group_book_days_before;
    originalGroupBookTime = (existingSettings as any).group_book_time;
    originalAllowSameDayBooking = (existingSettings as any).allow_same_day_booking;

    const memberA = await loginMemberA();
    memberAProfileId = memberA.profileId;
    // ⚠ 하드닝: memberA는 43개 기존 파일이 남긴 leftover 수강권이 매우 많아서(Phase 2에서
    // 실측 확인) "이 수강권은 만료돼서 못 쓴다"를 검증하는 P1-21 같은 시나리오에 부적합하다
    // — 만료된 수강권을 써도 memberA는 다른 leftover 유효 수강권으로 예약이 그냥 성공해버려
    // 거짓 실패(정확히는 이 파일 첫 구현에서 "실패해야 하는데 성공함"으로 재현됨)가 난다.
    // memberC(전용 서브프로필, 다른 파일이 손댄 적 없음)를 대신 쓴다.
    const memberC = await memberCSubProfile(memberA.accountId);
    memberCProfileId = memberC.profileId;

    // ⚠ 추가 하드닝(Fix Batch 2026-09-18): memberC는 여러 시나리오 파일이 공유
    // createTestMembership()(product_name="통합테스트 수강권" get-or-create)으로 함께
    // 쓴다 — 어느 파일의 실행이 중간에 끊기면(타임아웃 등) 그 파일 자신의 afterEach가
    // 못 돌아 이 행이 남을 수 있고, 그러면 "memberC는 유효한 수강권이 없다"를 전제하는
    // 이 파일의 SCN-P1-21이 거짓 실패한다(실측 재현됨 — 이 리팩터 과정에서 두 번
    // 발견). 다른 파일의 종료 시점 정리에 기대지 않고, 이 파일 시작 시점에 직접 한 번
    // 더 쓸어낸다.
    await admin
      .from("memberships")
      .delete()
      .eq("profile_id", memberCProfileId)
      .eq("product_name", "통합테스트 수강권");
  }, 60000);

  afterAll(async () => {
    const admin = getFixtureAdminClient();
    if (originalWaitlistWeeklyLimit !== null) {
      await admin.from("center_settings").update({ waitlist_weekly_limit: originalWaitlistWeeklyLimit }).eq("center_id", centerAId);
    }
    if (originalGroupBookDaysBefore !== null && originalGroupBookTime !== null) {
      await admin
        .from("center_settings")
        .update({ group_book_days_before: originalGroupBookDaysBefore, group_book_time: originalGroupBookTime })
        .eq("center_id", centerAId);
    }
    if (originalAllowSameDayBooking !== null) {
      await admin.from("center_settings").update({ allow_same_day_booking: originalAllowSameDayBooking }).eq("center_id", centerAId);
    }
  }, 30000);

  afterEach(async () => {
    while (pendingClassIds.length > 0) {
      const id = pendingClassIds.pop()!;
      await cleanupTestClassAdmin(id);
    }
    if (pendingMembershipIds.length > 0) {
      const admin = getFixtureAdminClient();
      const ids = pendingMembershipIds.splice(0, pendingMembershipIds.length);
      await admin.from("memberships").delete().in("id", ids);
    }
  }, 30000);

  async function issueMembershipWithExpiry(profileId: string, expiresAtDateStr: string, remainingCount = 5) {
    await loginManagerA();
    const admin = getFixtureAdminClient();
    const runId = newRunId();
    // ⚠ 하드닝: 기존 createTestMembership()은 (profile_id, center_id, product_id is null,
    // product_name="통합테스트 수강권")으로 get-or-create해서 여러 파일이 공유하는 단일
    // 행을 재사용한다 — 이 시나리오는 "정확히 이 만료일을 가진 독립적인 행"이 필요하므로
    // (다른 파일의 재사용 대상과 섞이면 안 됨) product_name에 runId를 넣어 매번 새 행을
    // 직접 insert한다. 매니저 세션에서 insert하므로 RLS(customer.member.issue_pass)도
    // 만족한다(Phase 1 하드닝에서 확인한 것과 동일 경로).
    const { data, error } = await admin
      .from("memberships")
      .insert({
        profile_id: profileId,
        center_id: centerAId,
        product_name: `QA-경계-${runId}`,
        pass_type: "count",
        total_count: remainingCount,
        remaining_count: remainingCount,
        expires_at: expiresAtDateStr,
        status: "active",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`경계값 수강권 생성 실패: ${error?.message ?? "no data"}`);
    pendingMembershipIds.push((data as any).id);
    return (data as any).id as string;
  }

  function kstDateStr(offsetDays: number): string {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000);
    return kst.toISOString().slice(0, 10);
  }

  it("SCN-P1-20: 수강권 만료일이 오늘(KST)인 경우 — 아직 유효해서 예약 성공", async () => {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-만료당일-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 8,
        class_format: "group",
      })
      .select("id")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);

    // expires_at은 "오늘(KST) 그 날짜"만 비교한다(m.expires_at >= current_date, date 타입
    // 비교라 시각은 무관) — DB서버(Supabase, UTC)의 current_date 기준과 KST 자정 부근에서
    // 미묘하게 어긋날 수 있어 안전하게 "오늘의 KST 날짜"를 그대로 쓴다. memberC를 쓰는
    // 이유는 beforeAll 주석 참고(memberA는 leftover 수강권 오염 위험).
    await issueMembershipWithExpiry(memberCProfileId, kstDateStr(0));

    await runScenario("SCN-P1-20", ["memberC"], async (assertions) => {
      await loginMemberA();
      const res = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: memberCProfileId });
      assertions.push({
        name: "만료일=오늘인 수강권으로 예약 성공(expires_at >= current_date 경계 포함)",
        passed: !res.error && (res.data as any)?.status === "confirmed",
        detail: JSON.stringify({ data: res.data, error: res.error?.message }),
      });
      expect(res.error).toBeNull();
      expect((res.data as any).status).toBe("confirmed");
    });
  }, 60000);

  it("SCN-P1-21: 수강권 만료일이 어제(KST)인 경우 — 이미 만료돼서 예약 실패", async () => {
    const runId = newRunId();
    await loginManagerA();
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-만료전날-${runId}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 8,
        class_format: "group",
      })
      .select("id")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);

    await issueMembershipWithExpiry(memberCProfileId, kstDateStr(-1));

    await runScenario("SCN-P1-21", ["memberC"], async (assertions) => {
      await loginMemberA();
      const res = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: memberCProfileId });
      assertions.push({
        name: "만료일=어제인 수강권은 사용 불가(memberC는 다른 유효 수강권이 없음) → 예약 실패",
        passed: !!res.error,
        detail: res.error?.message,
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.message).toContain("사용할 수 있는 수강권이 없어요");
    });
  }, 60000);

  it("SCN-P1-22: 예약 가능 마감시각 경계 — 마감 전(먼 미래 수업)은 성공, 마감 후(임박 수업)는 실패", async () => {
    // group_book_days_before=1, group_book_time="22:00"(resetStaleTestCenterSettings 기준
    // 값, beforeAll에서 getOrCreateOwnedTestCenter가 이미 이 값으로 되돌려둠) — "수업 시작
    // 1일 전 22:00까지 예약 가능"이라는 뜻. 48시간 뒤 수업은 마감이 명백히 미래(성공해야
    // 함), 지금부터 2시간 뒤 시작하는 수업은 "1일 전 22:00" 마감이 이미 명백히 지났음
    // (성공/실패 두 구간을 초 단위로 정밀하게 겨냥하지 않고, 결과가 해석 여지 없이
    // 명백한 지점만 검증 — 파일 상단 주석 참고).
    const runIdFar = newRunId();
    const runIdSoon = newRunId();
    await loginManagerA();
    const { data: clsFar, error: farErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-마감전-${runIdFar}`,
        start_time: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 49 * 3600 * 1000).toISOString(),
        capacity: 8,
        class_format: "group",
      })
      .select("id")
      .single();
    if (farErr || !clsFar) throw new Error(`수업 생성 실패: ${farErr?.message}`);
    pendingClassIds.push((clsFar as any).id);

    // ⚠ MWHABIT Business Logic Fix Batch(2026-09-18) 이후 수정: 당일예약 허용 버그가
    // 고쳐지면서(fix_same_day_booking_deadline.sql), "2시간 뒤 시작하는 당일 수업"은
    // 더 이상 날짜 기반(1일 전 22시) 마감으로 거부되지 않는다 — allow_same_day_booking
    // 기본값 true라 수업 시작 전까지 정상 예약된다(정확히 SCN-P1-24-ON이 검증하는 동작).
    // 그래서 이 시나리오("마감 자체가 지난 경우")는 당일예약 정책과 뒤섞이지 않도록,
    // 개별 수업에 명시적 booking_deadline_min 오버라이드(시작 5시간 전)를 줘서 "지금이
    // 이미 그 오버라이드 마감을 지난" 상태를 직접 만든다 — 센터 기본 설정이나 당일예약
    // 허용 여부와 무관하게 항상 거부돼야 하는, 더 명확한 마감 경계 테스트가 된다.
    const { data: clsSoon, error: soonErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-마감후-${runIdSoon}`,
        start_time: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
        end_time: new Date(Date.now() + 3 * 3600 * 1000).toISOString(),
        capacity: 8,
        class_format: "group",
        booking_deadline_min: 300, // 시작 5시간 전 마감 — 2시간 뒤 시작이므로 마감은 3시간 전에 이미 지남
      })
      .select("id")
      .single();
    if (soonErr || !clsSoon) throw new Error(`수업 생성 실패: ${soonErr?.message}`);
    pendingClassIds.push((clsSoon as any).id);

    await issueMembershipWithExpiry(memberAProfileId, kstDateStr(60));

    await runScenario("SCN-P1-22", ["memberA"], async (assertions) => {
      await loginMemberA();
      const resFar = await supabase.rpc("reserve_class", { p_class_id: (clsFar as any).id, p_profile_id: null });
      assertions.push({
        name: "마감 전(48시간 뒤 수업) 예약 성공",
        passed: !resFar.error && (resFar.data as any)?.status === "confirmed",
        detail: JSON.stringify({ data: resFar.data, error: resFar.error?.message }),
      });
      expect(resFar.error).toBeNull();

      const resSoon = await supabase.rpc("reserve_class", { p_class_id: (clsSoon as any).id, p_profile_id: null });
      assertions.push({
        name: "마감 후(개별 수업 마감 오버라이드가 이미 지난 임박 수업) 예약 거부",
        passed: !!resSoon.error,
        detail: resSoon.error?.message,
      });
      expect(resSoon.error).not.toBeNull();
      expect(resSoon.error?.message).toContain("마감");
    });
  }, 60000);

  // ============================================================
  // MWHABIT Business Logic Fix Batch(2026-09-18) — 당일예약 허용 버그 수정 후 regression.
  // 이전 버전(SCN-P1-24a-BUGFOUND)은 "기본 설정에서 당일예약이 항상 거부된다"는 버그를
  // 재현하는 테스트였다. fix_same_day_booking_deadline.sql 적용 후에는 이 기대가
  // 뒤집힌다 — expectation을 약화해 버그를 숨기는 게 아니라, 실제로 수정된 동작(허용
  // ON이면 성공)을 있는 그대로 검증하도록 테스트 자체를 "expected behavior PASS"로
  // 전환한다(요청 원문: "테스트 자체가 제품 버그를 숨기도록 expectation을 변경하지
  // 말 것" — 이건 버그를 숨기는 게 아니라 고쳐진 사실을 반영하는 것).
  //
  // ⚠ 이 SQL은 이 세션에서 Supabase에 직접 실행되지 않았다(직접 SQL 실행 수단 없음).
  // 아래 테스트들은 SQL이 실제로 적용된 이후에 PASS로 전환될 것으로 설계됐다 — SQL
  // 미적용 상태에서 이 파일을 실행하면 의도적으로 FAIL한다(그게 정상이다 — 수정 전
  // 실제 버그가 여전히 살아있다는 증거). 최종 보고서에 정확한 실행 결과를 기록한다.
  // ============================================================

  it("SCN-P1-24-ON: 당일예약 허용 ON(기본 설정, group_book_days_before=1) → 당일예약 성공 [FIX 검증]", async () => {
    await loginManagerA();
    const cls = await createKstSameDayFutureClass(centerAId, { capacity: 8, title: `QA-당일ON-${newRunId()}` });
    pendingClassIds.push(cls.id);
    await issueMembershipWithExpiry(memberAProfileId, kstDateStr(60));

    await runScenario("SCN-P1-24-ON", ["memberA"], async (assertions) => {
      await loginMemberA();
      const res = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      assertions.push({
        name: "[FIX] group_book_days_before=1(기본값) + allow_same_day_booking=true → 당일예약 성공(수정 전에는 항상 거부됐음)",
        passed: !res.error && (res.data as any)?.status === "confirmed",
        detail: JSON.stringify({ data: res.data, error: res.error?.message, classStart: cls.startTime }),
      });
      expect(res.error).toBeNull();
      expect((res.data as any).status).toBe("confirmed");
    });
  }, 60000);

  it("SCN-P1-24-OFF: 당일예약 허용 OFF → 당일예약 차단 [FIX 검증 — 최소 테스트]", async () => {
    const admin = getFixtureAdminClient();
    await admin.from("center_settings").update({ allow_same_day_booking: false }).eq("center_id", centerAId);

    await loginManagerA();
    const cls = await createKstSameDayFutureClass(centerAId, { capacity: 8, title: `QA-당일OFF-${newRunId()}` });
    pendingClassIds.push(cls.id);
    await issueMembershipWithExpiry(memberAProfileId, kstDateStr(60));

    await runScenario("SCN-P1-24-OFF", ["memberA"], async (assertions) => {
      await loginMemberA();
      const res = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
      assertions.push({
        name: "[FIX] allow_same_day_booking=false → 당일예약은 명시적으로 차단됨('당일 예약은 허용되지 않아요')",
        passed: !!res.error && !!res.error?.message.includes("당일"),
        detail: JSON.stringify({ data: res.data, error: res.error?.message }),
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.message).toContain("당일");
    });

    await admin.from("center_settings").update({ allow_same_day_booking: true }).eq("center_id", centerAId);
  }, 60000);

  it("SCN-P1-24-STARTED: 수업 시작 이후에는 당일예약 허용 여부와 무관하게 차단됨 [FIX 검증 — 기존 제한 유지 확인]", async () => {
    const runId = newRunId();
    await loginManagerA();
    // 당일예약이 100% 허용된 설정에서도, 이미 시작된 수업은 여전히 막혀야 한다(요청 조건:
    // "마감시간/수업 시작 이후 예약 등 기존 제한은 유지"). 5분 전에 시작한 수업을 직접
    // 만든다.
    const { data: cls, error: clsErr } = await supabase
      .from("classes")
      .insert({
        center_id: centerAId,
        title: `QA-당일시작후-${runId}`,
        start_time: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        end_time: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        capacity: 8,
        class_format: "group",
      })
      .select("id")
      .single();
    if (clsErr || !cls) throw new Error(`수업 생성 실패: ${clsErr?.message}`);
    pendingClassIds.push((cls as any).id);
    await issueMembershipWithExpiry(memberAProfileId, kstDateStr(60));

    await runScenario("SCN-P1-24-STARTED", ["memberA"], async (assertions) => {
      await loginMemberA();
      const res = await supabase.rpc("reserve_class", { p_class_id: (cls as any).id, p_profile_id: null });
      assertions.push({
        name: "[FIX] 이미 시작된 수업은 당일예약 허용과 무관하게 차단됨('수업이 시작되었습니다')",
        passed: !!res.error && !!res.error?.message.includes("시작"),
        detail: JSON.stringify({ data: res.data, error: res.error?.message }),
      });
      expect(res.error).not.toBeNull();
      expect(res.error?.message).toContain("시작");
    });
  }, 60000);

  it.each([0, 1, 2])(
    "SCN-P1-24-DAYS-%i: allow_same_day_booking=true면 group_book_days_before 값과 무관하게 당일예약이 항상 성공한다 [FIX 검증 — 경계값]",
    async (daysBefore) => {
      const admin = getFixtureAdminClient();
      await admin.from("center_settings").update({ group_book_days_before: daysBefore }).eq("center_id", centerAId);

      await loginManagerA();
      const cls = await createKstSameDayFutureClass(centerAId, { capacity: 8, title: `QA-당일경계값-${daysBefore}-${newRunId()}` });
      pendingClassIds.push(cls.id);
      await issueMembershipWithExpiry(memberAProfileId, kstDateStr(60));

      await runScenario(`SCN-P1-24-DAYS-${daysBefore}`, ["memberA"], async (assertions) => {
        await loginMemberA();
        const res = await supabase.rpc("reserve_class", { p_class_id: cls.id, p_profile_id: null });
        assertions.push({
          name: `[FIX] group_book_days_before=${daysBefore}이어도 당일예약 허용 ON이면 성공(수정 전에는 days_before>=1이면 무조건 실패했음)`,
          passed: !res.error && (res.data as any)?.status === "confirmed",
          detail: JSON.stringify({ daysBefore, data: res.data, error: res.error?.message }),
        });
        expect(res.error).toBeNull();
        expect((res.data as any).status).toBe("confirmed");
      });
    },
    60000
  );
});
