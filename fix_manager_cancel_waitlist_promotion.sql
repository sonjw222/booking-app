-- ============================================================
-- manager_set_attendance() 예약취소 시 대기자 자동승격 누락 수정
--
-- 배경: 회원이 /my-reservations에서 직접 취소하면 cancel_reservation()이 불려서
--   대기자 자동승격이 정상 동작한다(무제한 수강권 대기자 포함 — 2026-09-02 실측
--   확인). 그런데 매니저가 대시보드 로스터(/manager/classes)에서 "예약취소" 버튼을
--   누르면 manager_set_attendance()가 불리는데, 이 함수는 취소된 예약의 수강권
--   횟수만 복구할 뿐 같은 수업의 대기자를 승격시키는 로직이 아예 없었다(2026-09-02
--   실측 확인 — QA대기수업에서 확정자를 매니저가 취소했더니 대기자가 승격되지
--   않고 그대로 "대기1"로 남음, 새로고침 후에도 동일).
--
--   이건 무제한 수강권에 국한된 문제가 아니라 매니저가 취소 버튼을 누르는 모든
--   경우에 해당하는 기존 결함이다(fix_permission_manager_set_attendance.sql,
--   2026-08-21부터 존재 — 이번 기간권/무제한권 배치와 무관).
--
-- 이 파일은 fix_permission_manager_set_attendance.sql의 라이브 정의를 그대로 두고
-- "확정 슬롯이 실제로 빈 경우"(취소 전 상태가 confirmed/attended/no_show)에만
-- cancel_reservation()과 동일한 대기자 승격 루프를 추가한다. 나머지 로직(권한 체크,
-- 상태 전환 제약, 횟수 복구)은 전혀 건드리지 않는다.
--
-- 여러 번 실행해도 안전(idempotent).
-- ============================================================

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
    v_next     record;
    v_next_mem record;
    v_promoted boolean := false;
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
    if not (has_permission(v_class.center_id, 'schedule.attendance') or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    if v_res.status = 'waitlisted' and p_status in ('attended', 'no_show') then
        raise exception '대기 중인 예약은 출석/결석으로 표시할 수 없어요 — 먼저 확정돼야 해요';
    end if;

    if v_res.status = 'waitlisted' and p_status = 'confirmed' then
        raise exception '대기 예약은 이 화면에서 바로 확정으로 바꿀 수 없어요 — 정원이 비면 자동으로 승격돼요';
    end if;

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
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

        -- 확정 슬롯이 실제로 빈 경우(취소 전 상태가 confirmed/attended/no_show)에만
        -- 대기자 승격 시도. cancel_reservation()과 동일하게 무제한 횟수
        -- (remaining_count null)/무제한 기간(expires_at null)도 "쓸 수 있음"으로 판정.
        if v_res.status in ('confirmed', 'attended', 'no_show') then
            for v_next in
                select * from reservations
                where class_id = v_res.class_id and status = 'waitlisted'
                order by waitlist_order asc
                for update
            loop
                select * into v_next_mem from memberships
                where id = v_next.membership_id
                  and (remaining_count is null or remaining_count > 0)
                  and (expires_at is null or expires_at >= current_date)
                for update;

                if found then
                    update reservations
                    set status = 'confirmed', waitlist_order = null
                    where id = v_next.id;

                    update memberships set remaining_count = remaining_count - 1
                    where id = v_next_mem.id;

                    v_promoted := true;
                    exit;
                end if;
            end loop;
        end if;
    else
        update reservations
           set status = p_status, updated_at = now()
         where id = p_reservation_id;
    end if;

    return json_build_object('status', p_status, 'restored', v_restored, 'waitlist_promoted', v_promoted);
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select proname, pg_get_functiondef(oid) like '%waitlist_promoted%' as has_promotion_logic
from pg_proc where proname = 'manager_set_attendance';
