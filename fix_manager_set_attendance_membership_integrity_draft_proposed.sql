-- ============================================================
-- SEC-115(P1, 금전/데이터 무결성 — 접근권한 문제 아님): manager_set_attendance()
-- 대기(waitlisted) 예약의 수강권 차감/복구 부정확
--
-- ⚠ SEC-101/SEC-112(manager_centers self-join/self-promote)와는 완전히 별개다.
-- 이 파일은 그 배치가 이미 처리하는 "누가 my_managed_center_ids()에 들어오는가"
-- 문제를 전혀 건드리지 않는다 — "이미 정당한 매니저 권한이 있는 사람이 이 함수를
-- 쓸 때 수강권 잔여횟수 계산이 실제로 맞는가"만 다룬다. 이 파일이 수정하는 함수의
-- 50~52행 권한 검사(v_class.center_id in my_managed_center_ids() or is_platform_admin())는
-- 그대로 둔다.
--
-- [확인된 사실 — 코드 감사]
--   reserve_class()/reserve_with_membership()가 만드는 예약은 waitlisted든
--   confirmed든 관계없이 membership_id를 채운다(대기도 "어느 수강권으로 대기
--   중인지"는 기록해야 하므로). 실제 remaining_count 차감은 confirmed일 때만
--   일어난다(waitlisted는 차감 없음 — reserve_with_membership의 최신 정의는
--   이를 membership_consumed 컬럼에 각각 true/false로 정확히 반영한다).
--
--   그런데 manager_set_attendance()의 p_status='cancelled' 분기는
--   "v_res.membership_id is not null" 하나만 보고 무조건 remaining_count + 1을
--   했다 — waitlisted든 confirmed든 membership_id가 있으면 둘 다 해당된다.
--   즉 한 번도 차감된 적 없는 대기 예약을 취소해도 +1이 발생한다.
--
--   이건 이론적 시나리오가 아니라 실제 관리자 화면의 기본 동작이다:
--   app/manager/classes/page.tsx의 예약자 목록에서 대기(waitlisted) 행에는
--   "예약취소" 버튼만 노출되고(출석/노쇼/되돌리기 버튼은 waitlisted에서 숨김,
--   1735행 `a.status !== "waitlisted"` 가드), 그 취소 확인창 문구는
--   "사용한 수강권 횟수가 1회 복구돼요"라고 매번 안내한다(532행) — 대기 예약
--   취소에도 똑같이 뜬다. 즉 관리자가 정상적으로 대기예약을 정리할 때마다
--   차감된 적 없는 수강권에 잔여횟수가 매번 잘못 +1씩 쌓인다.
--
--   추가로: manager_set_attendance()는 waitlisted→attended/no_show만 막고
--   waitlisted→confirmed 직접 전환은 막지 않는다(37/61행 확인). 이 전환은
--   현재 관리자 UI에서 절대 호출되지 않지만(위와 같은 이유로 waitlisted 행엔
--   "되돌리기"(→confirmed) 버튼 자체가 없음), RPC를 직접 호출하면(이미 그
--   센터 매니저 권한이 있는 사람이) 수강권 차감 없이 대기를 확정으로 만들 수
--   있다 — cancel_reservation()의 정상 대기승격 로직(다음 대기자를 확정하며
--   membership 유효성 확인 후 정확히 1회 차감)을 완전히 우회한다.
--
-- [고친 것]
--   1) 차감 복구 조건을 "membership_id is not null"에서 "status = 'confirmed'"로
--      교체 — 이미 cancel_reservation()이 정확히 이 방식을 쓰고 있다(같은
--      저장소 안의 검증된 기존 패턴을 그대로 재사용, 새로 발명하지 않음).
--   2) waitlisted → confirmed 직접 전환도 attended/no_show와 같은 이유로 차단
--      (확정 승격은 반드시 cancel_reservation()의 대기승격 경로로만 — 그
--      경로만 membership 유효성 확인 + 정확한 차감을 함께 보장한다).
--   3) set search_path = public 추가(하드닝, 다른 SECURITY DEFINER 함수와
--      동일 조치 — SEC-117 참고).
--
-- [영향받는 기존 데이터] 없음(함수 재정의만).
-- [기존 데이터 소급 정정 안 함] 이 SQL은 과거에 이미 잘못 +1된 remaining_count를
--   찾아 고치지 않는다(그건 데이터 변경이라 사용자 승인 없이는 금지 — CLAUDE.md
--   3번 규칙). 필요하면 별도로 "얼마나 쌓였는지" 조회용 read-only 진단 쿼리를
--   먼저 만들고 사용자와 상의할 것을 권장(최종 보고서 참고).
-- [위험도] 낮음 — 정상 경로(confirmed 예약 취소 시 복구, waitlisted 예약 취소)는
--   기존과 동일하게 동작(전자는 복구, 후자는 이제 복구 안 함 — 이게 고치려는
--   버그 자체). attended/no_show ↔ confirmed 전환은 영향 없음.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_res      record;
    v_class    record;
    v_restored boolean := false;
    v_admin_id uuid;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    -- 대기 중인 예약은 출석/결석으로 표시할 수 없다(기존과 동일).
    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    -- [SEC-115 신규] 대기 → 확정 직접 전환 차단. 확정 승격은 반드시
    -- cancel_reservation()의 대기승격 경로로만(그 경로만 membership 유효성
    -- 확인 + 정확한 차감을 함께 수행한다). 여기서 바로 confirmed로 바꾸면
    -- 수강권 차감 없이 자리를 확정시키는 결과가 된다.
    if v_res.status = 'waitlisted' and p_status = 'confirmed' then
        raise exception '대기 예약은 이 화면에서 바로 확정으로 바꿀 수 없어요 — 정원이 비면 자동으로 승격돼요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        -- [SEC-115 핵심 수정] "membership_id is not null"이 아니라 "실제로 차감된
        -- 적이 있는가(status = 'confirmed')"를 봐야 한다. attended/no_show도
        -- 원래 confirmed에서 전환된 것이므로 차감된 상태 그대로 포함된다.
        -- waitlisted는 애초에 차감이 없었으므로 복구도 없다(cancel_reservation()과
        -- 동일한 기준).
        if v_res.status in ('confirmed', 'attended', 'no_show') and v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;

        update reservations
           set status = p_status,
               cancelled_by = v_admin_id,
               cancelled_at = now(),
               updated_at = now()
         where id = p_reservation_id;
    else
        update reservations
           set status = p_status, updated_at = now()
         where id = p_reservation_id;
    end if;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;

revoke all on function manager_set_attendance(uuid, text) from public;
revoke all on function manager_set_attendance(uuid, text) from anon;
grant execute on function manager_set_attendance(uuid, text) to authenticated;

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select pg_get_functiondef('manager_set_attendance(uuid, text)'::regprocedure);
