-- ============================================================
-- 관리자 직접배치 / 무료 추가 배치 (P1 예약 UX 개선)
--
-- 배경:
--   회원 예약(MEMBER)과 별개로, 관리자가 날짜·수업을 직접 골라 회원을
--   배치하는 두 가지 방식을 구조화합니다.
--     1) 일반 직접배치 (ADMIN_ASSIGNMENT): 기존 미배치건/연결된 수강권 사용,
--        수강권 종류·예약시간 제한 무시, 취소 시 수강권/횟수 정확히 복구
--     2) 무료 추가 배치 (ADMIN_FREE): 수강권 차감 없음, 이용권 없어도 가능,
--        취소해도 복구할 것 없음
--
--   기존 회원 셀프예약(reserve_class/reserve_with_membership/cancel_reservation)과
--   기존 관리자 보강예약(manager_book_member)은 동작을 바꾸지 않고, 새로 추가하는
--   컬럼에 정확한 값을 채우도록만 확장합니다 (회귀 없음).
--
-- 적용 전제: schema.sql, reservation_functions.sql, add_notifications.sql,
--            add_notification_triggers.sql, fix_usable_memberships_shared.sql 적용 후 실행
-- 여러 번 실행해도 안전(모든 DDL은 if not exists / create or replace 사용).
--
-- 롤백 메모: 이 파일이 추가하는 컬럼/테이블/함수는 모두 새로 추가된 것이라,
--   문제가 생기면 아래 컬럼들을 DROP하고 기존 reserve_class/cancel_reservation/
--   manager_book_member/manager_set_attendance/트리거 정의를 이 파일 이전 버전
--   (reservation_functions.sql, add_notification_triggers.sql)으로 다시
--   create or replace 하면 됩니다. 기존 컬럼(status, membership_id 등)은
--   전혀 건드리지 않으므로 데이터 손실 없이 되돌릴 수 있습니다.
-- ============================================================


-- ------------------------------------------------------------
-- 1) reservations: 예약 타입/출처/관리자 배치 관련 컬럼 추가
--    (기존 컬럼과 중복되지 않도록: "어떤 수강권/미배치건을 썼는지"는
--     기존 membership_id 컬럼을 그대로 재사용합니다 — 새 FK를 만들지 않음)
-- ------------------------------------------------------------

alter table reservations
    add column if not exists reservation_type text not null default 'MEMBER'
        check (reservation_type in ('MEMBER', 'ADMIN_ASSIGNMENT', 'ADMIN_FREE')),
    add column if not exists reservation_source text not null default 'USER'
        check (reservation_source in ('USER', 'ADMIN', 'SYSTEM')),
    add column if not exists created_by_account_id uuid references accounts(id),
    add column if not exists admin_reason_code text
        check (admin_reason_code is null or admin_reason_code in (
            'MEMBER_REQUEST', 'MAKEUP_CLASS', 'TRIAL', 'EVENT',
            'SERVICE_COMPENSATION', 'CENTER_OPERATION', 'VIP_INVITATION',
            'ERROR_CORRECTION', 'OTHER'
        )),
    add column if not exists admin_reason_detail text
        check (admin_reason_detail is null or char_length(admin_reason_detail) <= 200),
    add column if not exists is_capacity_override boolean not null default false,
    add column if not exists membership_consumed boolean not null default true,
    add column if not exists cancelled_by uuid references accounts(id),
    add column if not exists cancel_reason text,
    add column if not exists cancelled_at timestamptz,
    add column if not exists updated_at timestamptz not null default now();

comment on column reservations.reservation_type is
    'MEMBER=회원 셀프예약 / ADMIN_ASSIGNMENT=관리자 일반 직접배치(수강권 차감) / ADMIN_FREE=관리자 무료 추가배치(차감 없음)';
comment on column reservations.reservation_source is 'USER=회원 본인 / ADMIN=관리자 / SYSTEM=자동예약 등 시스템';
comment on column reservations.membership_id is
    '사용한 수강권. 관리자 직접배치(ADMIN_ASSIGNMENT)의 "어떤 미배치건/수강권을 사용했는지"도 이 컬럼이 그대로 표현함(중복 컬럼 없음)';

create index if not exists idx_reservations_type_source on reservations(reservation_type, reservation_source);


-- ------------------------------------------------------------
-- 2) 기존 데이터 안전 백필
--    기본값: MEMBER / USER (컬럼 추가 시 DEFAULT로 이미 채워짐)
--    단, membership_id가 NULL인 기존 예약은 manager_book_member(수강권 미지정)를
--    통해서만 만들어질 수 있었던 행이므로(reserve_class/reserve_with_membership/
--    reserve_class_with_goods는 항상 membership_id를 채움) 관리자 무료배치로
--    보존합니다 — 무조건 MEMBER로 덮어쓰지 않습니다.
-- ------------------------------------------------------------

update reservations
   set reservation_type = 'ADMIN_FREE',
       reservation_source = 'ADMIN',
       membership_consumed = false
 where membership_id is null
   and reservation_type = 'MEMBER';  -- 이미 이 마이그레이션을 실행한 적 있으면 재실행 안전

update reservations
   set membership_consumed = true
 where membership_id is not null
   and reservation_type = 'MEMBER';

-- created_by_account_id: MEMBER 예약은 소유 프로필의 계정이 곧 작성자(안전한 추정)
update reservations r
   set created_by_account_id = p.account_id
  from profiles p
 where p.id = r.profile_id
   and r.reservation_type = 'MEMBER'
   and r.created_by_account_id is null;
-- ADMIN_FREE로 보존된 과거 행은 어느 관리자가 만들었는지 알 수 없어 NULL로 남김
-- (docs/DATABASE.md에 확인 필요로 기록)


-- ------------------------------------------------------------
-- 3) 관리자 예약 작업 로그 (수정/삭제 불가, append-only)
-- ------------------------------------------------------------

create table if not exists admin_action_logs (
    id                   uuid primary key default gen_random_uuid(),
    center_id            uuid not null references centers(id),
    reservation_id       uuid not null references reservations(id),
    action_type          text not null check (action_type in
                          ('CREATE_ASSIGNMENT', 'CREATE_FREE', 'CANCEL_ASSIGNMENT', 'CANCEL_FREE')),
    reservation_type     text not null,
    reservation_source   text not null,
    admin_id             uuid not null references accounts(id),
    member_profile_id    uuid not null references profiles(id),
    class_id             uuid not null references classes(id),
    membership_id        uuid references memberships(id),
    source_unassigned_id uuid references memberships(id),  -- 배치에 사용된 미배치건/수강권 스냅샷(감사용, membership_id와 동일할 수 있음)
    reason_code          text,
    reason_detail        text,
    capacity_override    boolean not null default false,
    membership_consumed  boolean not null default false,
    member_name_snapshot text,
    class_title_snapshot text,
    class_start_snapshot timestamptz,
    before_state         jsonb,
    after_state          jsonb,
    created_at           timestamptz not null default now()
);

comment on table admin_action_logs is
    '관리자 직접배치/무료배치/취소 작업 로그. 일반 매니저 UI에서 수정·삭제 불가(RLS에 update/delete 정책 없음).';

create index if not exists idx_admin_action_logs_center on admin_action_logs(center_id, created_at desc);
create index if not exists idx_admin_action_logs_reservation on admin_action_logs(reservation_id);

alter table admin_action_logs enable row level security;

drop policy if exists "관리자 로그 조회" on admin_action_logs;
create policy "관리자 로그 조회"
    on admin_action_logs for select
    using (center_id in (select my_managed_center_ids()) or is_platform_admin());
-- insert/update/delete 정책은 의도적으로 만들지 않음: 아래 security definer RPC만 기록 가능,
-- 일반 매니저 role은 이 테이블을 절대 수정/삭제할 수 없음.


-- ------------------------------------------------------------
-- 4) 공용 헬퍼 (확장 가능한 구조로 분리 — 사용자 확정 정책)
-- ------------------------------------------------------------

-- 권한 검사: 지금은 manager_book_member와 동일하게
-- "해당 센터의 활성 매니저 OR 플랫폼 운영자"만 확인합니다.
-- TODO(향후): schedule.admin_assign / schedule.admin_free 같은 세부 permission key가
-- 생기면 이 함수 안에서 has_permission()을 추가로 확인하도록 확장하면 됩니다.
-- 이번 범위에서는 새 permission key를 추가하지 않습니다.
create or replace function can_manage_center_reservations(p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select p_center_id in (select my_managed_center_ids()) or is_platform_admin();
$$;

-- 회원 자격 검사: 지금은 기존 reserve_class(회원 셀프예약)와 동일하게
-- profile 존재 여부 외에는 차단하지 않습니다 (center_members.status에는
-- '이용정지'/'탈퇴'/'삭제' 개념 자체가 없고, 기존 셀프예약도 확인하지 않음).
-- TODO(향후): 이용정지/탈퇴/삭제/휴면 회원 차단 정책이 결정되면 이 함수 안에서
-- center_members.status 등을 확인하도록 확장. docs/TODO.md 참고.
create or replace function is_profile_assignable(p_profile_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists (select 1 from profiles where id = p_profile_id);
$$;


-- ------------------------------------------------------------
-- 5) 관리자 직접배치 / 무료 추가 배치 RPC
-- ------------------------------------------------------------

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
    v_class          record;
    v_mem            record;
    v_confirmed      int;
    v_is_override    boolean := false;
    v_reason_detail  text;
    v_reservation_id uuid;
    v_admin_id       uuid;
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

    -- 중복 예약 확인 (타입 무관, 활성 예약 1건만 허용)
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 이 수업에 예약된 회원이에요';
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

    if v_confirmed >= v_class.capacity and not p_force_capacity then
        return json_build_object('needs_capacity_confirm', true);
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


create or replace function admin_cancel_reservation(
    p_reservation_id uuid,
    p_cancel_reason  text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_res      record;
    v_class    record;
    v_admin_id uuid;
    v_restored boolean := false;
    v_reason   text;
begin
    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.reservation_type not in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        raise exception '이 예약은 관리자 취소 대상이 아니에요';
    end if;

    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_admin_id := my_account_id();
    if not can_manage_center_reservations(v_class.center_id) then
        raise exception '관리자 권한이 없어요';
    end if;

    -- 중복 취소 방지 (같은 예약을 두 번 취소해도 복구가 두 번 일어나지 않도록)
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    v_reason := nullif(trim(coalesce(p_cancel_reason, '')), '');
    if v_reason is not null and char_length(v_reason) > 200 then
        v_reason := left(v_reason, 200);
    end if;

    update reservations
       set status = 'cancelled',
           cancelled_by = v_admin_id,
           cancel_reason = v_reason,
           cancelled_at = now(),
           updated_at = now()
     where id = p_reservation_id;

    -- ADMIN_ASSIGNMENT + 실제 차감된 경우에만 수강권 복구. ADMIN_FREE는 복구할 것이 없음.
    if v_res.reservation_type = 'ADMIN_ASSIGNMENT'
       and v_res.membership_consumed
       and v_res.membership_id is not null then
        update memberships set remaining_count = remaining_count + 1
        where id = v_res.membership_id and remaining_count is not null;
        v_restored := true;
    end if;

    insert into admin_action_logs (
        center_id, reservation_id, action_type, reservation_type, reservation_source,
        admin_id, member_profile_id, class_id, membership_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, class_title_snapshot, class_start_snapshot, before_state, after_state
    )
    select
        v_class.center_id, v_res.id,
        case when v_res.reservation_type = 'ADMIN_ASSIGNMENT' then 'CANCEL_ASSIGNMENT' else 'CANCEL_FREE' end,
        v_res.reservation_type, v_res.reservation_source,
        v_admin_id, v_res.profile_id, v_res.class_id, v_res.membership_id,
        v_res.admin_reason_code, v_reason, v_res.is_capacity_override, v_restored,
        coalesce(pr.nickname, pr.name, '회원'), v_class.title, v_class.start_time,
        json_build_object('status', v_res.status),
        json_build_object('status', 'cancelled', 'restored', v_restored)
    from profiles pr where pr.id = v_res.profile_id;

    return json_build_object('cancelled', true, 'restored', v_restored);
end;
$$;


-- ------------------------------------------------------------
-- 6) 기존 함수 확장 — 반환값·기존 로직은 그대로, 새 컬럼만 채움 (회귀 없음)
-- ------------------------------------------------------------

-- 회원 셀프예약: reservation_type='MEMBER', reservation_source='USER' 명시,
-- 확정만 실제 차감이므로 membership_consumed는 confirmed일 때만 true.
create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer
as $$
declare
    v_profile_id    uuid;
    v_class         record;
    v_membership    record;
    v_confirmed     int;
    v_status        text;
    v_wait_order    int;
    v_reservation_id uuid;
    v_day_of_week   int;
    v_local_date    date;
    v_local_time    time;
begin
    if p_profile_id is not null then
        select id into v_profile_id from profiles
        where id = p_profile_id and account_id = my_account_id();
    else
        select id into v_profile_id from profiles
        where account_id = my_account_id() and is_primary = true
        limit 1;
    end if;
    if v_profile_id is null then
        raise exception '로그인이 필요하거나 프로필을 찾을 수 없어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    declare
        v_book_deadline timestamptz;
    begin
        v_book_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'book');
        if v_book_deadline is null then
            v_book_deadline := v_class.start_time - make_interval(mins => v_class.booking_deadline_min);
        end if;
        if now() > v_book_deadline then
            raise exception '예약 마감시간이 지났어요';
        end if;
    end;

    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
    order by m.expires_at asc
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (
            class_id, profile_id, membership_id, status,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, v_profile_id, v_membership.id, 'confirmed',
            'MEMBER', 'USER', my_account_id(), true
        )
        returning id into v_reservation_id;
    else
        v_status := 'waitlisted';
        select coalesce(max(waitlist_order), 0) + 1 into v_wait_order
        from reservations where class_id = p_class_id and status = 'waitlisted';

        insert into reservations (
            class_id, profile_id, membership_id, status, waitlist_order,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order,
            'MEMBER', 'USER', my_account_id(), false
        )
        returning id into v_reservation_id;
    end if;

    return json_build_object('status', v_status, 'reservation_id', v_reservation_id);
end;
$$;


-- 지정 수강권 예약 (예약 확인 팝업에서 사용) — 동일하게 확장
create or replace function reserve_with_membership(
    p_class_id      uuid,
    p_profile_id    uuid,
    p_membership_id uuid
)
returns json
language plpgsql
security definer
as $$
declare
    v_class     record;
    v_mem       record;
    v_confirmed int;
    v_status    text;
    v_order     int;
    v_reservation_id uuid;
begin
    if not exists (
        select 1 from profiles where id = p_profile_id and account_id = my_account_id()
    ) then
        raise exception '본인 계정의 프로필만 예약할 수 있어요';
    end if;

    select * into v_class from classes where id = p_class_id for update;
    if not found then raise exception '수업을 찾을 수 없어요'; end if;
    if v_class.status = 'cancelled' then raise exception '폐강된 수업이에요'; end if;
    if v_class.status = 'closed' then raise exception '예약이 마감된 수업이에요'; end if;

    select m.* into v_mem
    from memberships m
    where m.id = p_membership_id
      and m.center_id = v_class.center_id
      and m.status = 'active'
      and m.remaining_count > 0
      and m.expires_at >= current_date
      and m.profile_id in (select id from profiles where account_id = my_account_id())
    for update;
    if not found then
        raise exception '사용할 수 없는 수강권이에요';
    end if;

    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = p_profile_id
          and status in ('confirmed', 'waitlisted', 'attended')
    ) then
        raise exception '이미 예약한 수업이에요';
    end if;

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    if v_confirmed >= v_class.capacity then
        select coalesce(max(waitlist_order), 0) + 1 into v_order
        from reservations where class_id = p_class_id and status = 'waitlisted';
        v_status := 'waitlisted';
        insert into reservations (
            class_id, profile_id, membership_id, status, waitlist_order,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status, v_order,
            'MEMBER', 'USER', my_account_id(), false
        )
        returning id into v_reservation_id;
    else
        v_status := 'confirmed';
        insert into reservations (
            class_id, profile_id, membership_id, status,
            reservation_type, reservation_source, created_by_account_id, membership_consumed
        )
        values (
            p_class_id, p_profile_id, p_membership_id, v_status,
            'MEMBER', 'USER', my_account_id(), true
        )
        returning id into v_reservation_id;
        update memberships set remaining_count = remaining_count - 1
        where id = p_membership_id and remaining_count is not null;
    end if;

    return json_build_object('status', v_status, 'waitlist_order', v_order);
end;
$$;


-- 관리자 보강예약(기존 기능, 그대로 유지): 이미 "수강권+차감", "수강권+무차감",
-- "수강권 없음" 세 가지를 지원하므로 새 3-타입 체계에 그대로 대응시켜 태깅만 추가.
-- booked/over_capacity/deducted 반환값과 기존 로직은 전혀 바뀌지 않음.
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
    v_type      text;
    v_consumed  boolean;
begin
    select * into v_class from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 수업에 예약할 권한이 없어요';
    end if;

    select count(*) into v_existing
    from reservations
    where class_id = p_class_id
      and profile_id = p_profile_id
      and status in ('confirmed', 'waitlisted', 'attended');
    if v_existing > 0 then
        raise exception '이미 이 수업에 예약되어 있어요';
    end if;

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

    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status in ('confirmed', 'attended');

    v_consumed := (p_membership_id is not null and p_deduct);
    v_type := case when v_consumed then 'ADMIN_ASSIGNMENT' else 'ADMIN_FREE' end;

    insert into reservations (
        class_id, profile_id, membership_id, status,
        reservation_type, reservation_source, created_by_account_id,
        membership_consumed, is_capacity_override
    )
    values (
        p_class_id, p_profile_id, p_membership_id, 'confirmed',
        v_type, 'ADMIN', my_account_id(),
        v_consumed, (v_confirmed >= v_class.capacity)
    );

    if v_consumed then
        update memberships
           set remaining_count = remaining_count - 1
         where id = p_membership_id
           and remaining_count is not null;
    end if;

    return json_build_object(
        'booked', true,
        'over_capacity', v_confirmed >= v_class.capacity,
        'deducted', v_consumed
    );
end;
$$;


-- 회원 셀프 취소: 기존 로직 그대로, cancelled_by/cancelled_at/updated_at만 채움
create or replace function cancel_reservation(p_reservation_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_res         record;
    v_class       record;
    v_next        record;
    v_next_mem    record;
    v_promoted    boolean := false;
    v_skip_refund boolean := false;
    v_account_id  uuid;
begin
    select * into v_res from reservations
    where id = p_reservation_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이에요';
    end if;

    v_account_id := my_account_id();

    select * into v_class from classes where id = v_res.class_id;
    if found then
        declare
            v_cancel_deadline timestamptz;
            v_deduct_late boolean := false;
            v_is_late boolean := false;
        begin
            v_cancel_deadline := calc_deadline(v_class.center_id, v_class.class_format, v_class.start_time, 'cancel');
            if v_cancel_deadline is null then
                v_cancel_deadline := v_class.start_time - make_interval(mins => v_class.cancel_deadline_min);
            end if;
            v_is_late := now() > v_cancel_deadline;

            select coalesce(deduct_on_late_cancel, false) into v_deduct_late
            from center_settings where center_id = v_class.center_id;

            if v_is_late and not v_deduct_late then
                raise exception '취소 마감시간이 지났어요';
            end if;
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    update reservations
       set status = 'cancelled',
           cancelled_by = v_account_id,
           cancelled_at = now(),
           updated_at = now()
     where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        for v_next in
            select * from reservations
            where class_id = v_res.class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null,
                    membership_consumed = true, updated_at = now()
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_promoted := true;
                exit;
            end if;
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;


-- 매니저 출결 처리 (v4): v3 로직 그대로 + cancelled_by/cancelled_at/updated_at 채움
create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
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

    v_admin_id := my_account_id();

    if p_status = 'cancelled' then
        if v_res.membership_id is not null then
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


-- ------------------------------------------------------------
-- 7) 알림 트리거: reservation_type에 따라 문구/수신자 분기
--    (기존 MEMBER 흐름은 완전히 동일 — 새 트리거는 admin 타입만 분기 추가)
-- ------------------------------------------------------------

create or replace function trg_notify_reservation_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;

    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    if new.reservation_type in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        -- 관리자 배치: 회원에게는 무료/사유/관리자명/정원초과 등 내부 정보 노출 안 함
        if v_account is not null and new.status = 'confirmed' then
            perform push_notification(
                v_account, 'admin_assigned', '관리자가 예약을 등록했습니다',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                -- 회원 알림 metadata에는 reservation_type(무료/일반 구분)을 넣지 않음 —
                -- 회원이 자기 알림을 직접 조회해도 무료 추가 배치 여부를 알 수 없어야 함
                jsonb_build_object('reservation_id', new.id, 'class_id', new.class_id, 'action', 'assigned')
            );
        end if;
        -- 관리자가 만든 예약이므로 다른 매니저에게 별도 "새 예약" 알림은 생략(소음 방지)
        return new;
    end if;

    -- 회원 본인 확인 알림 (기존과 동일)
    if v_account is not null then
        if new.status = 'confirmed' then
            perform push_notification(
                v_account, 'reservation_confirmed', '예약이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        elsif new.status = 'waitlisted' then
            perform push_notification(
                v_account, 'reservation_waitlisted', '대기자로 등록됐어요',
                v_title || ' · 자리가 나면 알려드릴게요',
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;
    end if;

    -- 매니저 알림 (확정 예약만; 대기는 소음이라 제외)
    if new.status = 'confirmed' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'new_reservation', '새 예약이 있어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;


create or replace function trg_notify_reservation_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
    v_title text;
    v_start timestamptz;
    v_account uuid;
    v_who text;
    m record;
begin
    if new.status = old.status then
        return new;
    end if;

    select c.center_id, c.title, c.start_time into v_center, v_title, v_start
      from classes c where c.id = new.class_id;
    select pr.account_id, coalesce(pr.nickname, pr.name, '회원')
      into v_account, v_who
      from profiles pr where pr.id = new.profile_id;

    if new.status = 'cancelled' and new.reservation_type in ('ADMIN_ASSIGNMENT', 'ADMIN_FREE') then
        if v_account is not null then
            perform push_notification(
                v_account, 'admin_cancelled', '관리자가 예약을 취소했습니다',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id, 'class_id', new.class_id, 'action', 'cancelled')
            );
        end if;
        return new;
    end if;

    -- 대기 → 확정 (기존과 동일, 타입 무관)
    if old.status = 'waitlisted' and new.status = 'confirmed' then
        if v_account is not null then
            perform push_notification(
                v_account, 'waitlist_promoted', '대기하던 수업이 확정됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;

    elsif new.status = 'cancelled' then
        if v_account is not null then
            perform push_notification(
                v_account, 'reservation_canceled', '예약이 취소됐어요',
                v_title || ' · ' || to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/my-reservations',
                jsonb_build_object('reservation_id', new.id)
            );
        end if;
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'reservation_canceled', '예약이 취소됐어요',
                v_who || '님 · ' || v_title || ' ' ||
                    to_char(v_start at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;

    elsif new.status = 'no_show' then
        for m in
            select account_id from manager_centers
             where center_id = v_center and status = 'active'
        loop
            perform push_notification(
                m.account_id, 'no_show', '노쇼가 발생했어요',
                v_who || '님이 ' || v_title || ' 수업에 오지 않았어요',
                v_center, '/manager/classes',
                jsonb_build_object('reservation_id', new.id)
            );
        end loop;
    end if;

    return new;
end;
$$;

-- 트리거 자체는 이미 존재(add_notification_triggers.sql)하므로 재생성 불필요 —
-- 함수 본문만 create or replace로 교체되며 트리거는 그대로 이 새 본문을 사용함.

-- ============================================================
-- 끝. admin_assign_reservation / admin_cancel_reservation RPC와
-- reservation_type/reservation_source가 준비되었습니다.
-- ============================================================
