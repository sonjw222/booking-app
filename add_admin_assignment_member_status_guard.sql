-- ============================================================
-- P1-10: 관리자 직접배치에서 이용정지(휴면)/탈퇴 회원은 별도 권한이 있어야만 배치 가능
--
-- 배경: is_profile_assignable()은 지금까지 profile 존재 여부만 확인했다(2026-07-30 결정 —
-- center_members.status에 "이용정지"/"탈퇴" 개념 자체가 없어 범위를 좁혀뒀음, add_admin_
-- assignment.sql 주석 참고). 이제 두 신호가 실제로 생겼다:
--   - "탈퇴" = accounts.deactivated_at is not null (add_account_deactivation.sql, P1-18)
--   - "휴면" = center_members.status = 'dormant' (기존 스키마)
-- 사용자 결정(2026-08-15): 이 두 상태의 회원은 기본적으로 직접배치를 막되, 새 권한
-- customer.member.assign_any_status를 가진 스태프(기본: 오너만, has_permission()이 오너를
-- 자동 통과시킴)는 예외적으로 배치할 수 있게 한다 — 예: 스튜디오 오너는 탈퇴/휴면 회원도
-- 사정상 직접배치 가능, 일반 강사는 활성 회원만.
--
-- "이 센터 회원이 아직 아님"(center_members 행 자체가 없음, 예: 체험 회원 최초 배치)은
-- 이 검사 대상이 아니다 — 신규/워크인 배치를 막으면 안 됨. 'expired'(수강권만 만료, 회원
-- 자격은 유지) 상태도 막지 않는다 — 재등록 배치가 흔한 정상 케이스라서.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

insert into permissions (key, category, parent_key, label, description, sort_order) values
('customer.member.assign_any_status', 'customer', 'customer.member.view',
 '이용정지/탈퇴/휴면 회원 직접배치',
 '이용정지(휴면), 탈퇴 상태인 회원도 관리자 직접배치·무료 추가배치의 대상으로 지정할 수 있습니다. 스튜디오 오너는 이 권한 없이도 항상 가능합니다.',
 18)
on conflict (key) do nothing;

create or replace function admin_assign_reservation(
    p_class_id        uuid,
    p_profile_id      uuid,
    p_assignment_type text,                 -- 'ADMIN_ASSIGNMENT' | 'ADMIN_FREE'
    p_membership_id   uuid default null,
    p_reason_code     text default null,
    p_reason_detail   text default null,
    p_force_capacity  boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_class            record;
    v_mem              record;
    v_confirmed        int;
    v_is_override      boolean := false;
    v_reason_detail    text;
    v_reservation_id   uuid;
    v_admin_id         uuid;
    v_target_withdrawn boolean;
    v_target_status    text;
begin
    if p_assignment_type not in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        raise exception '잘못된 배치 방식이에요';
    end if;
    if p_reason_code is not null and p_reason_code not in (
        'MEMBER_REQUEST', 'MAKEUP_CLASS', 'TRIAL', 'EVENT',
        'SERVICE_COMPENSATION', 'CENTER_OPERATION', 'VIP_INVITATION',
        'ERROR_CORRECTION', 'OTHER'
    ) then
        raise exception '잘못된 배치 사유예요';
    end if;

    v_admin_id := my_account_id();

    -- 수업 확인 (행 잠금으로 동시 배치 경쟁 방지)
    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if v_class.status = 'cancelled' then
        raise exception '수업이 취소되었어요';
    end if;
    if v_class.status = 'closed' then
        raise exception '현재 배치할 수 없는 수업이에요';
    end if;
    if v_class.start_time <= now() then
        raise exception '수업이 이미 시작되었어요';
    end if;

    -- 권한 확인 (해당 센터 관리자만)
    if not can_manage_center_reservations(v_class.center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    -- 회원 확인
    if not is_profile_assignable(p_profile_id) then
        raise exception '해당 회원을 찾을 수 없어요';
    end if;

    -- [P1-10] 탈퇴/휴면 회원은 customer.member.assign_any_status 권한이 있어야 배치 가능
    -- (오너는 has_permission()이 자동 통과). 이 센터 회원이 아직 아니거나(체험 최초 배치)
    -- 수강권만 만료(expired)인 경우는 대상이 아님 — 항상 배치 가능.
    select
        (a.deactivated_at is not null),
        cm.status
    into v_target_withdrawn, v_target_status
    from profiles pr
    join accounts a on a.id = pr.account_id
    left join center_members cm on cm.center_id = v_class.center_id and cm.profile_id = pr.id
    where pr.id = p_profile_id;

    if (coalesce(v_target_withdrawn, false) or v_target_status = 'dormant')
       and not has_permission(v_class.center_id, 'customer.member.assign_any_status') then
        raise exception '이용정지·탈퇴·휴면 회원은 이 권한이 있어야 직접배치할 수 있어요';
    end if;

    -- 중복 예약 확인 (타입 무관, 활성 예약 1건만 허용)
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 이 수업에 예약된 회원이에요';
    end if;

    -- [P2] 프라이빗 수업 동시 진행 제한 — 관리자 직접배치도 이 설정을 피해가지 않는다.
    if v_class.class_format = 'private' then
        declare
            v_pmc_enabled boolean;
            v_pmc_limit   int;
            v_concurrent  int;
        begin
            select private_max_concurrent_enabled, private_max_concurrent
              into v_pmc_enabled, v_pmc_limit
            from center_settings where center_id = v_class.center_id;

            if coalesce(v_pmc_enabled, false) and v_pmc_limit is not null then
                select count(*) into v_concurrent
                from classes c2
                join reservations r2 on r2.class_id = c2.id and r2.status = 'confirmed'
                where c2.center_id = v_class.center_id
                  and c2.class_format = 'private'
                  and c2.id <> v_class.id
                  and c2.status <> 'cancelled'
                  and c2.start_time < v_class.end_time
                  and c2.end_time > v_class.start_time;

                if v_concurrent >= v_pmc_limit then
                    raise exception '같은 시간대에 진행 가능한 프라이빗 수업이 이미 다 찼어요(최대 %건)', v_pmc_limit;
                end if;
            end if;
        end;
    end if;

    -- 배치 방식별 수강권 처리 (수강권 종류/예약조건 제한은 두 방식 모두 무시)
    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        if p_membership_id is null then
            raise exception '사용할 수강권을 선택해주세요';
        end if;
        select * into v_mem from memberships
        where id = p_membership_id and profile_id = p_profile_id
        for update;
        if not found then
            raise exception '수강권을 찾을 수 없어요';
        end if;
    else
        -- ADMIN_FREE: 클라이언트가 무엇을 보내든 신뢰하지 않고 서버가 무조건 무시
        p_membership_id := null;
    end if;

    -- 정원 확인 (최종 생성 시점 기준 재검증 — 동시 요청 대비)
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        -- [P2] 프라이빗(1:1) 수업은 정원 초과 강제 배치 자체를 허용하지 않는다 —
        -- 그룹 수업의 "정원 초과 배치 확인" 흐름과 달리 override가 없다.
        if v_class.class_format = 'private' then
            raise exception '이미 다른 회원이 예약한 프라이빗 수업이라 추가로 배치할 수 없어요';
        end if;
        if not p_force_capacity then
            return json_build_object('needs_capacity_confirm', true);
        end if;
    end if;
    v_is_override := v_confirmed >= v_class.capacity;

    -- 배치 사유 검증 (서버 재검증 — 클라이언트 검증만 믿지 않음)
    if p_assignment_type = 'ADMIN_FREE' and p_reason_code is null then
        raise exception '무료 추가 배치 사유를 선택해주세요';
    end if;
    if v_is_override and p_reason_code is null then
        raise exception '정원 초과 배치 사유를 입력해주세요';
    end if;
    v_reason_detail := nullif(trim(coalesce(p_reason_detail, '')), '');
    if p_reason_code = 'OTHER' and v_reason_detail is null then
        raise exception '기타 사유를 입력해주세요';
    end if;
    if v_reason_detail is not null and char_length(v_reason_detail) > 200 then
        v_reason_detail := left(v_reason_detail, 200);
    end if;

    -- 예약 생성 (관리자 배치는 정원과 무관하게 항상 confirmed)
    insert into reservations (
        class_id, profile_id, membership_id, status,
        reservation_type, reservation_source, created_by_account_id,
        admin_reason_code, admin_reason_detail, is_capacity_override, membership_consumed
    ) values (
        p_class_id, p_profile_id, p_membership_id, 'confirmed',
        p_assignment_type, 'ADMIN', v_admin_id,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT')
    ) returning id into v_reservation_id;

    if p_assignment_type = 'ADMIN_ASSIGNMENT' then
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    -- 작업 로그 (예약 생성과 같은 트랜잭션 — 함수 전체가 원자적이라 부분 성공 없음)
    insert into admin_action_logs (
        center_id, reservation_id, action_type, reservation_type, reservation_source,
        admin_id, member_profile_id, class_id, membership_id, source_unassigned_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, class_title_snapshot, class_start_snapshot, after_state
    )
    select
        v_class.center_id, v_reservation_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then 'CREATE_ASSIGNMENT' else 'CREATE_FREE' end,
        p_assignment_type, 'ADMIN',
        v_admin_id, p_profile_id, p_class_id, p_membership_id,
        case when p_assignment_type = 'ADMIN_ASSIGNMENT' then p_membership_id else null end,
        p_reason_code, v_reason_detail, v_is_override, (p_assignment_type = 'ADMIN_ASSIGNMENT'),
        coalesce(pr.nickname, pr.name, '회원'), v_class.title, v_class.start_time,
        json_build_object('reservation_id', v_reservation_id, 'status', 'confirmed')
    from profiles pr where pr.id = p_profile_id;

    return json_build_object(
        'reservation_id', v_reservation_id,
        'status', 'confirmed',
        'over_capacity', v_is_override
    );
end;
$$;
