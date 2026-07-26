-- ============================================================
-- 관리자 보강 예약
--
-- 하는 일:
--   manager_book_member(수업id, 프로필id, 수강권id, 차감여부)
--   → 수강권의 요일/시간 예약조건을 검사하지 않고 예약 생성
--   예: 화요일반 수강권 회원을 이번 주만 목요일반에 넣어주기
--   - 횟수 차감 여부 선택 가능 (무료 보강이면 끄기)
--   - 정원 초과여도 관리자 판단으로 등록 (결과에 표시)
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================


-- ============================================================
-- 관리자 보강 예약 (make-up booking)
--   매니저가 수강권 조건과 무관하게 회원을 특정 수업에 예약
--   예: 화요일반 수강권 회원을 사정상 목요일반에 1회 넣어주기
--   - 수강권 예약조건(요일/시간/수업명) 검사를 건너뜀
--   - 횟수 차감 여부는 선택 (p_deduct)
--   - 정원 초과여도 관리자 판단으로 넣을 수 있음 (경고만)
-- ============================================================

create or replace function manager_book_member(
    p_class_id      uuid,
    p_profile_id    uuid,
    p_membership_id uuid default null,
    p_deduct        boolean default true
)
returns json
language plpgsql
security definer
as $$
declare
    v_class     record;
    v_mem       record;
    v_confirmed int;
    v_existing  int;
begin
    select * into v_class from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 권한: 그 센터 매니저만
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수업에 예약할 권한이 없어요';
    end if;

    -- 이미 예약되어 있는지
    select count(*) into v_existing
    from reservations
    where class_id = p_class_id
      and profile_id = p_profile_id
      and status in ('confirmed', 'waitlisted', 'attended');
    if v_existing > 0 then
        raise exception '이미 이 수업에 예약되어 있어요';
    end if;

    -- 수강권 지정 시 유효성만 확인 (예약조건은 검사하지 않음 = 보강 허용)
    if p_membership_id is not null then
        select * into v_mem from memberships
        where id = p_membership_id and profile_id = p_profile_id
        for update;
        if not found then
            raise exception '수강권을 찾을 수 없어요';
        end if;
        if p_deduct and v_mem.remaining_count is not null and v_mem.remaining_count <= 0 then
            raise exception '남은 횟수가 없어요';
        end if;
    end if;

    -- 정원 확인 (초과해도 진행하되 결과에 표시)
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    insert into reservations (class_id, profile_id, membership_id, status)
    values (p_class_id, p_profile_id, p_membership_id, 'confirmed');

    -- 횟수 차감
    if p_membership_id is not null and p_deduct then
        update memberships
           set remaining_count = remaining_count - 1
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object(
        'booked', true,
        'over_capacity', v_confirmed >= v_class.capacity,
        'deducted', (p_membership_id is not null and p_deduct)
    );
end;
$$;



-- ============================================================
-- 완료!
--   일정 → 수업 클릭 → 예약자 → "+ 회원 추가 (보강 예약)"
-- ============================================================
