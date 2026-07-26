-- ============================================================
-- 예약 처리 함수 (Supabase SQL Editor에서 실행)
-- schema.sql 실행 후에 이 파일을 실행하세요.
--
-- 왜 함수로 만드나요?
--   "잔여 1석에 두 명이 동시에 예약" 같은 상황에서 정원 초과가
--   나지 않으려면, 정원 확인과 예약 생성이 한 번에(원자적으로)
--   처리되어야 해요. 프론트에서 따로따로 하면 구멍이 생깁니다.
-- ============================================================


-- ------------------------------------------------------------
-- 0. 헬퍼 함수 (아래 정책들이 사용하므로 가장 먼저 정의)
-- ------------------------------------------------------------

-- 헬퍼: 지금 로그인한 계정이 매니저로 있는 센터 id 목록 (승인된 것만)
create or replace function my_managed_center_ids()
returns setof uuid
language sql stable
security definer
set search_path = public
as $$
    -- security definer: 정책 안에서 호출돼도 manager_centers RLS를 다시 타지 않음
    select center_id from manager_centers
    where account_id = my_account_id() and status = 'active';
$$;

-- 헬퍼: 특정 센터에서 내가 해당 권한을 가지고 있는지
--   · 오너 역할(is_owner=true)이면 모든 권한 통과
--   · 아니면 role_permissions에 그 권한이 있어야 통과
create or replace function has_permission(p_center_id uuid, p_permission text)
returns boolean
language sql stable
as $$
    -- 판정 우선순위:
    --   1) 오너(is_owner)면 항상 허용 (개인 deny도 무시)
    --   2) 개인 예외에 deny 있으면 차단
    --   3) 개인 예외에 allow 있으면 허용
    --   4) 역할 권한에 있으면 허용
    --   5) 아니면 차단
    with me as (
        select mc.id as mc_id, r.is_owner, mc.role_id
        from manager_centers mc
        join center_roles r on r.id = mc.role_id
        where mc.account_id = my_account_id()
          and mc.center_id = p_center_id
          and mc.status = 'active'
        limit 1
    )
    select coalesce((
        select
            case
                when m.is_owner then true
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'deny'
                ) then false
                when exists (
                    select 1 from account_center_permissions acp
                    where acp.manager_center_id = m.mc_id
                      and acp.permission_key = p_permission
                      and acp.grant_type = 'allow'
                ) then true
                when exists (
                    select 1 from role_permissions rp
                    where rp.role_id = m.role_id
                      and rp.permission_key = p_permission
                ) then true
                else false
            end
        from me m
    ), false);
$$;

-- 매니저는 자기 센터 수업을 생성/수정/삭제 가능


-- ------------------------------------------------------------
-- ------------------------------------------------------------
-- 1. 예약하기 함수
--    사용법(프론트): supabase.rpc('reserve_class', { p_class_id: '...' })
--    반환: { status: 'confirmed' | 'waitlisted', reservation_id: ... }
--    실패 시 예외 발생 (프론트에서 error.message로 받음)
-- ------------------------------------------------------------
-- ============================================================
-- 설정 기반 마감시각 계산 헬퍼
--   center_settings 의 "수업 N일 전 HH:MM 까지" 규칙을
--   실제 timestamptz(마감 시각)로 변환한다.
--   그룹/프라이빗(class_format)에 따라 다른 설정을 사용.
--   p_kind: 'book'(예약) 또는 'cancel'(취소)
--   설정 행이 없으면 null 반환 → 호출부에서 classes 고정값으로 폴백
-- ============================================================
create or replace function calc_deadline(
    p_center_id uuid,
    p_class_format text,
    p_start_time timestamptz,
    p_kind text
)
returns timestamptz
language plpgsql stable
as $$
declare
    v_settings record;
    v_days int;
    v_time time;
    v_class_date date;
    v_deadline_date date;
begin
    select * into v_settings from center_settings where center_id = p_center_id;
    if not found then
        return null;   -- 설정 없음 → 폴백
    end if;

    -- 형태 + 종류에 맞는 (일수, 시각) 선택
    if p_class_format = 'private' then
        if p_kind = 'book' then
            v_days := v_settings.private_book_days_before;
            v_time := v_settings.private_book_time;
        else
            v_days := v_settings.private_cancel_days_before;
            v_time := v_settings.private_cancel_time;
        end if;
    else
        if p_kind = 'book' then
            v_days := v_settings.group_book_days_before;
            v_time := v_settings.group_book_time;
        else
            v_days := v_settings.group_cancel_days_before;
            v_time := v_settings.group_cancel_time;
        end if;
    end if;

    -- 수업일(한국시간) 기준 N일 전 날짜의 HH:MM (한국시간) 을 마감으로
    v_class_date := (p_start_time at time zone 'Asia/Seoul')::date;
    v_deadline_date := v_class_date - make_interval(days => v_days);

    -- 한국시간의 (날짜 + 시각) 을 timestamptz 로
    return ((v_deadline_date::text || ' ' || v_time::text) || '+09')::timestamptz;
end;
$$;


create or replace function reserve_class(p_class_id uuid, p_profile_id uuid default null)
returns json
language plpgsql
security definer  -- RLS를 우회해서 함수 안에서 검증을 직접 수행
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
    -- (1) 예약할 프로필 결정
    --     p_profile_id 를 넘기면 그 프로필, 안 넘기면 본인 대표 프로필
    if p_profile_id is not null then
        -- 내 계정 소유의 프로필인지 확인
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

    -- (2) 수업 정보 확인 (행 잠금으로 동시 예약 경쟁 방지)
    select * into v_class from classes where id = p_class_id for update;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 한국시간 기준 날짜/시간/요일 (서버는 UTC라서 변환 필수!)
    v_local_date := (v_class.start_time at time zone 'Asia/Seoul')::date;
    v_local_time := (v_class.start_time at time zone 'Asia/Seoul')::time;
    v_day_of_week := extract(dow from (v_class.start_time at time zone 'Asia/Seoul'))::int;

    -- (2-1) 폐강/마감된 수업인지 확인
    if v_class.status = 'cancelled' then
        raise exception '폐강된 수업이에요';
    end if;
    if v_class.status = 'closed' then
        raise exception '예약이 마감된 수업이에요';
    end if;

    -- (2-2) 승인된 센터인지 확인 (승인대기 센터는 예약 불가)
    if not exists (
        select 1 from centers where id = v_class.center_id and status = 'approved'
    ) then
        raise exception '아직 승인되지 않은 센터예요';
    end if;

    -- (2-3) 예약 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고,
    --   없으면 기존 classes.booking_deadline_min(분 단위)로 폴백
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

    -- (3) 센터 휴무일 확인
    if exists (
        select 1 from center_holidays
        where center_id = v_class.center_id
          and holiday_date = v_local_date
    ) then
        raise exception '센터 휴무일이라 예약할 수 없어요';
    end if;

    -- (4) 중복 예약 확인
    if exists (
        select 1 from reservations
        where class_id = p_class_id and profile_id = v_profile_id
          and status in ('confirmed', 'waitlisted')
    ) then
        raise exception '이미 예약(또는 대기)한 수업이에요';
    end if;

    -- (5) 사용 가능한 수강권 찾기
    --     조건: 해당 센터 + 잔여횟수 있음 + 기간 유효
    --     수강권에 요일/시간 조건(membership_schedule_rules)이 있으면 그 조건도 통과해야 함
    select m.* into v_membership
    from memberships m
    where m.profile_id = v_profile_id
      and m.center_id = v_class.center_id
      and m.remaining_count > 0
      and m.expires_at >= current_date
      -- 수업에 예약가능 수강권이 지정돼 있으면(class_allowed_products), 그 목록에 포함돼야 함
      and (
            not exists (select 1 from class_allowed_products cap where cap.class_id = v_class.id)
            or m.product_id in (select cap.product_id from class_allowed_products cap where cap.class_id = v_class.id)
      )
      and (
            -- 조건이 하나도 없으면 통과 (상품에 규칙이 없거나, product_id 미연결)
            m.product_id is null
            or not exists (select 1 from membership_schedule_rules r where r.product_id = m.product_id)
            -- 조건이 있으면 하나라도 매칭돼야 통과
            or exists (
                select 1 from membership_schedule_rules r
                where r.product_id = m.product_id
                  and (r.day_of_week is null or r.day_of_week = v_day_of_week)
                  and (r.start_time is null or r.start_time = v_local_time)
                  and (r.class_title is null or v_class.title like '%' || r.class_title || '%')
            )
      )
    order by m.expires_at asc   -- 만료 임박한 수강권부터 사용
    limit 1
    for update;

    if not found then
        raise exception '이 수업에 사용할 수 있는 수강권이 없어요 (잔여횟수/기간/예약조건을 확인해주세요)';
    end if;

    -- (6) 정원 확인 → 확정 또는 대기
    select count(*) into v_confirmed
    from reservations
    where class_id = p_class_id and status = 'confirmed';

    if v_confirmed < v_class.capacity then
        -- 확정 예약: 수강권 1회 차감
        v_status := 'confirmed';
        update memberships set remaining_count = remaining_count - 1
        where id = v_membership.id;

        insert into reservations (class_id, profile_id, membership_id, status)
        values (p_class_id, v_profile_id, v_membership.id, 'confirmed')
        returning id into v_reservation_id;
    else
        -- 대기 등록: 차감하지 않고 순번만 부여 (확정 전환될 때 차감)
        v_status := 'waitlisted';
        select coalesce(max(waitlist_order), 0) + 1 into v_wait_order
        from reservations where class_id = p_class_id and status = 'waitlisted';

        insert into reservations (class_id, profile_id, membership_id, status, waitlist_order)
        values (p_class_id, v_profile_id, v_membership.id, 'waitlisted', v_wait_order)
        returning id into v_reservation_id;
    end if;

    return json_build_object('status', v_status, 'reservation_id', v_reservation_id);
end;
$$;


-- ------------------------------------------------------------
-- 2. 예약 취소 함수
--    사용법: supabase.rpc('cancel_reservation', { p_reservation_id: '...' })
--    - 확정 예약 취소 시: 수강권 1회 환급 + 대기 1순위 자동 확정 전환
--    - 대기 취소 시: 그냥 취소
-- ------------------------------------------------------------
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
    v_skip_refund boolean := false;   -- 마감 후 취소 + 차감옵션 시 환급 건너뜀
begin
    -- 내 계정 소유 프로필의 예약인지 확인 + 잠금
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

    -- 취소 마감시간 확인
    --   센터 설정(N일 전 HH:MM)이 있으면 그걸 쓰고, 없으면 classes 고정값 폴백.
    --   설정 14번(deduct_on_late_cancel)이 켜져 있으면, 마감 후 취소라도
    --   차단하지 않고 "횟수 차감"으로 진행한다.
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
                -- 마감 지났고, 차감 옵션도 꺼져 있으면 취소 불가
                raise exception '취소 마감시간이 지났어요';
            end if;
            -- 마감 지났지만 차감 옵션이 켜져 있으면: 취소는 허용하되 환급 안 함
            v_skip_refund := v_is_late and v_deduct_late;
        end;
    end if;

    -- 취소 처리
    update reservations set status = 'cancelled' where id = p_reservation_id;

    if v_res.status = 'confirmed' then
        -- 수강권 환급 (단, 마감 후 취소 + 차감옵션이면 환급하지 않음 = 횟수 차감)
        if not v_skip_refund then
            update memberships set remaining_count = remaining_count + 1
            where id = v_res.membership_id;
        end if;

        -- 대기자를 순번대로 확인하면서 '확정 가능한 첫 사람'을 승격시킨다.
        --   그냥 1순위를 무조건 승격시키면, 그 사람의 수강권이 그새 소진/만료된 경우
        --   remaining_count 가 음수가 되거나 만료 수강권으로 예약이 잡히는 문제가 생김.
        for v_next in
            select * from reservations
            where class_id = v_res.class_id and status = 'waitlisted'
            order by waitlist_order asc
            for update
        loop
            -- 이 대기자의 수강권이 아직 쓸 수 있는지 확인 (잔여횟수 + 유효기간)
            select * into v_next_mem from memberships
            where id = v_next.membership_id
              and remaining_count > 0
              and expires_at >= current_date
            for update;

            -- 주의: record 변수는 'is not null' 판정이 불안정합니다.
            --   (모든 필드가 null인지로 평가되어 의도와 다르게 동작)
            --   PL/pgSQL 표준인 FOUND 를 사용해야 합니다.
            if found then
                update reservations
                set status = 'confirmed', waitlist_order = null
                where id = v_next.id;

                update memberships set remaining_count = remaining_count - 1
                where id = v_next_mem.id;

                v_promoted := true;
                -- TODO(2차): 승격된 회원에게 푸시 알림 발송
                exit;  -- 한 자리만 났으므로 한 명만 승격
            end if;
            -- 수강권을 못 쓰는 대기자는 건너뛰고 다음 순번 확인
        end loop;
    end if;

    return json_build_object('cancelled', true, 'waitlist_promoted', v_promoted);
end;
$$;


-- ------------------------------------------------------------
-- 3. 예약 인원수 조회용 뷰
--    reservations 테이블은 보안(RLS) 때문에 남의 예약을 볼 수 없어요.
--    하지만 "예약 5/10" 표시를 위해 인원수는 알아야 하죠.
--    이 뷰는 개인정보 없이 수업별 확정 인원수만 노출합니다.
-- ------------------------------------------------------------
create or replace view class_reservation_counts as
select class_id, count(*)::int as confirmed_count
from reservations
where status = 'confirmed'
group by class_id;

grant select on class_reservation_counts to authenticated;


-- ------------------------------------------------------------
-- 4. 조회용 RLS 정책 (예약 화면에 필요한 읽기 권한)
--    이미 만든 정책과 이름이 겹치면 그 줄은 건너뛰어도 돼요.
-- ------------------------------------------------------------

-- 수업/센터 조회: 승인된 센터만 회원에게 노출 (승인대기 센터는 안 보임)
--                 단, 내가 매니저인 센터는 승인 전에도 보임
alter table classes enable row level security;
drop policy if exists "승인된 센터 수업 조회" on classes;
create policy "승인된 센터 수업 조회"
    on classes for select using (
        center_id in (select id from centers where status = 'approved')
        or center_id in (select my_managed_center_ids())
    );

alter table centers enable row level security;
drop policy if exists "승인된 센터 조회" on centers;
create policy "승인된 센터 조회"
    on centers for select using (
        status = 'approved'
        or id in (select my_managed_center_ids())
        -- 가입 직후 승인대기 상태인 내 센터도 보이게
        or id in (select center_id from manager_centers where account_id = my_account_id())
        -- 플랫폼 운영자는 승인 심사를 위해 모든 센터(대기/반려 포함)를 볼 수 있어야 함
        or is_platform_admin()
    );

alter table center_holidays enable row level security;
drop policy if exists "로그인 사용자 휴무일 조회" on center_holidays;
create policy "로그인 사용자 휴무일 조회"
    on center_holidays for select using (auth.role() = 'authenticated');

-- 내 센터 색상 설정 조회/수정
alter table member_center_colors enable row level security;
drop policy if exists "본인 색상 설정 관리" on member_center_colors;
create policy "본인 색상 설정 관리"
    on member_center_colors for all
    using (account_id = my_account_id())
    with check (account_id = my_account_id());


-- ------------------------------------------------------------
-- 5. 매니저용 정책
--    매니저는 자기 센터의 수업/휴무일을 등록·수정할 수 있어야 함
-- ------------------------------------------------------------


-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 수업 관리" on classes;
drop policy if exists "매니저 수업 생성" on classes;
create policy "매니저 수업 생성"
    on classes for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 수업 수정" on classes;
create policy "매니저 수업 수정"
    on classes for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 수업 삭제" on classes;
create policy "매니저 수업 삭제"
    on classes for delete
    using (center_id in (select my_managed_center_ids()));

-- 매니저는 자기 센터 휴무일 관리 가능
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 휴무일 관리" on center_holidays;
drop policy if exists "매니저 휴무일 생성" on center_holidays;
create policy "매니저 휴무일 생성"
    on center_holidays for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 휴무일 수정" on center_holidays;
create policy "매니저 휴무일 수정"
    on center_holidays for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 휴무일 삭제" on center_holidays;
create policy "매니저 휴무일 삭제"
    on center_holidays for delete
    using (center_id in (select my_managed_center_ids()));

-- 매니저는 자기 센터 정보 수정 가능
drop policy if exists "매니저 센터 수정" on centers;
create policy "매니저 센터 수정"
    on centers for update
    using (id in (select my_managed_center_ids()) or is_platform_admin())
    with check (id in (select my_managed_center_ids()) or is_platform_admin());

-- ------------------------------------------------------------
-- 승인 상태 보호: status 변경은 플랫폼 운영자만 가능
--   (매니저가 자기 센터를 스스로 승인하는 것을 막음)
-- ------------------------------------------------------------
create or replace function guard_center_status_change()
returns trigger
language plpgsql
security definer
as $$
begin
    if new.status is distinct from old.status and not is_platform_admin() then
        raise exception '센터 승인 상태는 플랫폼 운영자만 변경할 수 있어요';
    end if;
    return new;
end;
$$;

drop trigger if exists trg_guard_center_status on centers;
create trigger trg_guard_center_status
    before update on centers
    for each row
    execute function guard_center_status_change();


-- 수업 담당 강사 배정
alter table class_trainers enable row level security;
drop policy if exists "수업 강사 조회" on class_trainers;
create policy "수업 강사 조회"
    on class_trainers for select using (auth.role() = 'authenticated');
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 강사 배정" on class_trainers;
drop policy if exists "매니저 강사 생성" on class_trainers;
create policy "매니저 강사 생성"
    on class_trainers for insert
    with check (class_id in (select id from classes where center_id in (select my_managed_center_ids())));

drop policy if exists "매니저 강사 수정" on class_trainers;
create policy "매니저 강사 수정"
    on class_trainers for update
    using (class_id in (select id from classes where center_id in (select my_managed_center_ids())))
    with check (class_id in (select id from classes where center_id in (select my_managed_center_ids())));

drop policy if exists "매니저 강사 삭제" on class_trainers;
create policy "매니저 강사 삭제"
    on class_trainers for delete
    using (class_id in (select id from classes where center_id in (select my_managed_center_ids())));

-- 역할/권한: 내 센터 것만 (수정은 오너만)
alter table center_roles enable row level security;
drop policy if exists "내 센터 역할 조회" on center_roles;
create policy "내 센터 역할 조회"
    on center_roles for select
    using (center_id in (select center_id from manager_centers where account_id = my_account_id()));
-- 주의: for all 로 만들면 SELECT 에도 이 조건이 걸립니다.
--   같은 명령에 정책이 여러 개면 전부 통과해야 하므로,
--   위의 "내 센터 역할 조회"(select)가 있어도 이 조건에 막혀 조회가 안 됩니다.
--   특히 role_id 가 아직 없는 가입 직후에는 has_permission 이 false 라 교착이 생깁니다.
--   → 쓰기(insert/update/delete)에만 권한 조건을 겁니다.
drop policy if exists "오너만 역할 관리" on center_roles;
drop policy if exists "오너만 역할 생성" on center_roles;
create policy "오너만 역할 생성"
    on center_roles for insert
    with check (has_permission(center_id, 'role.manage'));

drop policy if exists "오너만 역할 수정" on center_roles;
create policy "오너만 역할 수정"
    on center_roles for update
    using (has_permission(center_id, 'role.manage'))
    with check (has_permission(center_id, 'role.manage'));

drop policy if exists "오너만 역할 삭제" on center_roles;
create policy "오너만 역할 삭제"
    on center_roles for delete
    using (has_permission(center_id, 'role.manage'));

alter table role_permissions enable row level security;
drop policy if exists "내 센터 권한 조회" on role_permissions;
create policy "내 센터 권한 조회"
    on role_permissions for select
    using (role_id in (select id from center_roles where center_id in
           (select center_id from manager_centers where account_id = my_account_id())));
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "오너만 권한 부여" on role_permissions;
drop policy if exists "오너만 권한 부여 생성" on role_permissions;
create policy "오너만 권한 부여 생성"
    on role_permissions for insert
    with check (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')));

drop policy if exists "오너만 권한 부여 수정" on role_permissions;
create policy "오너만 권한 부여 수정"
    on role_permissions for update
    using (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')))
    with check (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')));

drop policy if exists "오너만 권한 부여 삭제" on role_permissions;
create policy "오너만 권한 부여 삭제"
    on role_permissions for delete
    using (role_id in (select id from center_roles where has_permission(center_id, 'role.manage')));

-- 센터별 회원정보 항목
alter table center_member_fields enable row level security;
drop policy if exists "센터 항목 조회" on center_member_fields;
create policy "센터 항목 조회"
    on center_member_fields for select using (auth.role() = 'authenticated');
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 항목 관리" on center_member_fields;
drop policy if exists "매니저 항목 생성" on center_member_fields;
create policy "매니저 항목 생성"
    on center_member_fields for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 항목 수정" on center_member_fields;
create policy "매니저 항목 수정"
    on center_member_fields for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 항목 삭제" on center_member_fields;
create policy "매니저 항목 삭제"
    on center_member_fields for delete
    using (center_id in (select my_managed_center_ids()));

-- 회원이 센터에 입력한 값: 본인 + 그 센터 매니저만
alter table profile_center_fields enable row level security;
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "본인 입력값 관리" on profile_center_fields;
drop policy if exists "본인 입력값 생성" on profile_center_fields;
create policy "본인 입력값 생성"
    on profile_center_fields for insert
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "본인 입력값 수정" on profile_center_fields;
create policy "본인 입력값 수정"
    on profile_center_fields for update
    using (profile_id in (select my_profile_ids()))
    with check (profile_id in (select my_profile_ids()));

drop policy if exists "본인 입력값 삭제" on profile_center_fields;
create policy "본인 입력값 삭제"
    on profile_center_fields for delete
    using (profile_id in (select my_profile_ids()));
drop policy if exists "매니저 회원정보 조회" on profile_center_fields;
create policy "매니저 회원정보 조회"
    on profile_center_fields for select
    using (center_id in (select my_managed_center_ids()));

-- 상품
alter table products enable row level security;
drop policy if exists "상품 조회" on products;
create policy "상품 조회"
    on products for select
    using (center_id in (select id from centers where status = 'approved')
           or center_id in (select my_managed_center_ids()));
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 상품 관리" on products;
drop policy if exists "매니저 상품 생성" on products;
create policy "매니저 상품 생성"
    on products for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상품 수정" on products;
create policy "매니저 상품 수정"
    on products for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상품 삭제" on products;
create policy "매니저 상품 삭제"
    on products for delete
    using (center_id in (select my_managed_center_ids()));

alter table product_passes enable row level security;
drop policy if exists "내 상품권 조회" on product_passes;
create policy "내 상품권 조회"
    on product_passes for select
    using (profile_id in (select my_profile_ids()));

-- 상담 채널
alter table center_contacts enable row level security;
drop policy if exists "상담채널 조회" on center_contacts;
create policy "상담채널 조회"
    on center_contacts for select using (auth.role() = 'authenticated');
-- for all → insert/update/delete 로 분리
--   (같은 테이블에 select 정책이 따로 있는데 for all 을 쓰면
--    SELECT 시 두 정책을 모두 통과해야 해서 조회가 막힙니다)
drop policy if exists "매니저 상담채널 관리" on center_contacts;
drop policy if exists "매니저 상담채널 생성" on center_contacts;
create policy "매니저 상담채널 생성"
    on center_contacts for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상담채널 수정" on center_contacts;
create policy "매니저 상담채널 수정"
    on center_contacts for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 상담채널 삭제" on center_contacts;
create policy "매니저 상담채널 삭제"
    on center_contacts for delete
    using (center_id in (select my_managed_center_ids()));

-- 스케줄 템플릿 / 알림 규칙: 매니저 전용
alter table schedule_templates enable row level security;
drop policy if exists "매니저 템플릿 관리" on schedule_templates;
create policy "매니저 템플릿 관리"
    on schedule_templates for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

alter table notification_rules enable row level security;
drop policy if exists "매니저 알림규칙 관리" on notification_rules;
create policy "매니저 알림규칙 관리"
    on notification_rules for all
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

-- ============================================================
-- 끝. 이제 프론트에서 supabase.rpc('reserve_class', ...) 로 예약하면
-- 정원 확인 → 수강권 조건 검증 → 차감 → 확정/대기 처리가 한 번에 됩니다.
-- ============================================================


-- ============================================================
-- 회원관리 관련 정책 (center_members, member_grades)
--   회원 개인정보가 담기므로 반드시 센터 단위로 격리해야 함
-- ============================================================

alter table member_grades enable row level security;

drop policy if exists "매니저 등급 조회" on member_grades;
create policy "매니저 등급 조회"
    on member_grades for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 생성" on member_grades;
create policy "매니저 등급 생성"
    on member_grades for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 수정" on member_grades;
create policy "매니저 등급 수정"
    on member_grades for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 등급 삭제" on member_grades;
create policy "매니저 등급 삭제"
    on member_grades for delete
    using (center_id in (select my_managed_center_ids()));


alter table center_members enable row level security;

-- 매니저는 자기 센터 회원만, 회원 본인은 자기 행만 볼 수 있음
drop policy if exists "센터회원 조회" on center_members;
create policy "센터회원 조회"
    on center_members for select
    using (
        center_id in (select my_managed_center_ids())
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 센터회원 등록" on center_members;
create policy "매니저 센터회원 등록"
    on center_members for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 센터회원 수정" on center_members;
create policy "매니저 센터회원 수정"
    on center_members for update
    using (has_permission(center_id, 'customer.member.update'))
    with check (has_permission(center_id, 'customer.member.update'));

drop policy if exists "매니저 센터회원 삭제" on center_members;
create policy "매니저 센터회원 삭제"
    on center_members for delete
    using (center_id in (select my_managed_center_ids()));


-- 매니저가 자기 센터 회원의 프로필(이름 등)을 볼 수 있어야 함
--   기존 "본인 프로필만 관리" 정책만으론 남의 프로필이 안 보여서
--   회원 목록에 이름이 안 나옴
drop policy if exists "매니저 센터회원 프로필 조회" on profiles;
create policy "매니저 센터회원 프로필 조회"
    on profiles for select
    using (
        account_id = my_account_id()
        or id in (
            select cm.profile_id from center_members cm
            where cm.center_id in (select my_managed_center_ids())
        )
        -- 예약자 프로필도 조회 가능해야 수업별 예약자 명단이 보임
        or id in (
            select r.profile_id from reservations r
            join classes c on c.id = r.class_id
            where c.center_id in (select my_managed_center_ids())
        )
    );


-- ============================================================
-- 권한 카탈로그 조회 (permissions)
--   모든 센터가 공유하는 고정 목록이라 로그인 사용자면 읽기 허용.
--   쓰기는 없음(우리가 SQL로만 관리).
-- ============================================================

alter table permissions enable row level security;

drop policy if exists "권한 카탈로그 조회" on permissions;
create policy "권한 카탈로그 조회"
    on permissions for select
    using (auth.uid() is not null);


-- ============================================================
-- 스태프 초대: 오너가 다른 계정을 자기 센터에 매니저/강사로 추가
--   manager_centers 는 "본인 것만" 정책이라 남을 초대할 수 없음.
--   → 오너가 자기 센터에 스태프를 넣을 수 있는 정책 추가
-- ============================================================

drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (has_permission(center_id, 'facility.staff.create'));

drop policy if exists "오너 스태프 조회" on manager_centers;
create policy "오너 스태프 조회"
    on manager_centers for select
    using (
        account_id = my_account_id()
        or center_id in (select my_managed_center_ids())
    );

drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        account_id = my_account_id()
        or has_permission(center_id, 'facility.staff.update')
    )
    with check (
        account_id = my_account_id()
        or has_permission(center_id, 'facility.staff.update')
    );

drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        account_id = my_account_id()
        or has_permission(center_id, 'facility.staff.delete')
    );


-- ============================================================
-- 스태프 초대용: 오너가 초대할 상대의 계정을 이름/전화로 찾을 수 있어야 함
--   accounts 는 "본인 것만" 정책이라 남을 검색할 수 없음.
--   → 오너에게만 최소 정보(id, name, phone) 조회를 허용
-- ============================================================

drop policy if exists "본인 계정만 접근" on accounts;

drop policy if exists "본인 계정 수정" on accounts;
create policy "본인 계정 수정"
    on accounts for update
    using (auth_id = auth.uid())
    with check (auth_id = auth.uid());

drop policy if exists "본인 계정 삭제" on accounts;
create policy "본인 계정 삭제"
    on accounts for delete
    using (auth_id = auth.uid());

-- 조회: 본인 + (오너인 경우) 스태프 초대/관리를 위한 검색
drop policy if exists "계정 조회" on accounts;
create policy "계정 조회"
    on accounts for select
    using (
        auth_id = auth.uid()
        -- 내 센터의 스태프 계정
        or id in (
            select mc.account_id from manager_centers mc
            where mc.center_id in (select my_managed_center_ids())
        )
        -- 내 센터 회원의 계정 (회원관리에서 전화번호 표시)
        or id in (
            select p.account_id from profiles p
            join center_members cm on cm.profile_id = p.id
            where cm.center_id in (select my_managed_center_ids())
        )
        -- 스태프 등록 권한이 있으면 계정 검색 가능 (초대 대상 찾기)
        or exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id
            where mc.account_id = my_account_id()
              and mc.status = 'active'
              and (r.is_owner = true
                   or exists (select 1 from role_permissions rp
                              where rp.role_id = r.id
                                and rp.permission_key = 'facility.staff.create'))
        )
    );


-- ============================================================
-- 개인별 권한 예외 (account_center_permissions)
--   오너만 조회/설정 가능 (facility.role_permission 권한)
-- ============================================================

alter table account_center_permissions enable row level security;

drop policy if exists "개인권한 조회" on account_center_permissions;
create policy "개인권한 조회"
    on account_center_permissions for select
    using (
        manager_center_id in (
            select id from manager_centers
            where center_id in (select my_managed_center_ids())
        )
    );

drop policy if exists "개인권한 생성" on account_center_permissions;
create policy "개인권한 생성"
    on account_center_permissions for insert
    with check (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );

drop policy if exists "개인권한 수정" on account_center_permissions;
create policy "개인권한 수정"
    on account_center_permissions for update
    using (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    )
    with check (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );

drop policy if exists "개인권한 삭제" on account_center_permissions;
create policy "개인권한 삭제"
    on account_center_permissions for delete
    using (
        manager_center_id in (
            select mc.id from manager_centers mc
            where has_permission(mc.center_id, 'facility.role_permission')
        )
    );


-- ============================================================
-- 매출/지출/포인트 정책 (payments, expenses, point_transactions)
--   매출 데이터는 민감하므로 센터 단위로 격리.
--   조회/등록은 매출 권한(pass.payment 계열)이 있어야 함.
-- ============================================================

alter table payments enable row level security;

-- 매니저: 자기 센터 매출 조회 (매출 조회 권한)
drop policy if exists "매니저 매출 조회" on payments;
create policy "매니저 매출 조회"
    on payments for select
    using (
        has_permission(center_id, 'pass.sales.view')
        -- 회원 본인은 자기 결제 내역 조회 가능
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 매출 등록" on payments;
create policy "매니저 매출 등록"
    on payments for insert
    with check (has_permission(center_id, 'pass.payment.create'));

drop policy if exists "매니저 매출 수정" on payments;
create policy "매니저 매출 수정"
    on payments for update
    using (has_permission(center_id, 'pass.payment.update'))
    with check (has_permission(center_id, 'pass.payment.update'));

drop policy if exists "매니저 매출 삭제" on payments;
create policy "매니저 매출 삭제"
    on payments for delete
    using (has_permission(center_id, 'pass.payment.delete'));


alter table expenses enable row level security;

drop policy if exists "매니저 지출 조회" on expenses;
create policy "매니저 지출 조회"
    on expenses for select
    using (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 등록" on expenses;
create policy "매니저 지출 등록"
    on expenses for insert
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 수정" on expenses;
create policy "매니저 지출 수정"
    on expenses for update
    using (center_id in (select my_managed_center_ids()))
    with check (center_id in (select my_managed_center_ids()));

drop policy if exists "매니저 지출 삭제" on expenses;
create policy "매니저 지출 삭제"
    on expenses for delete
    using (center_id in (select my_managed_center_ids()));


alter table point_transactions enable row level security;

drop policy if exists "포인트 조회" on point_transactions;
create policy "포인트 조회"
    on point_transactions for select
    using (
        center_id in (select my_managed_center_ids())
        or profile_id in (select my_profile_ids())
    );

drop policy if exists "매니저 포인트 등록" on point_transactions;
create policy "매니저 포인트 등록"
    on point_transactions for insert
    with check (center_id in (select my_managed_center_ids()));


-- ============================================================
-- 센터 운영 설정 (center_settings)
--   조회: 로그인 사용자 누구나 (예약 화면이 이 설정을 참고)
--   수정: 운영정보 설정 권한(facility.operation) 있는 사람만
-- ============================================================

alter table center_settings enable row level security;

drop policy if exists "설정 조회" on center_settings;
create policy "설정 조회"
    on center_settings for select
    using (auth.uid() is not null);

drop policy if exists "매니저 설정 생성" on center_settings;
create policy "매니저 설정 생성"
    on center_settings for insert
    with check (has_permission(center_id, 'facility.operation'));

drop policy if exists "매니저 설정 수정" on center_settings;
create policy "매니저 설정 수정"
    on center_settings for update
    using (has_permission(center_id, 'facility.operation'))
    with check (has_permission(center_id, 'facility.operation'));


-- ============================================================
-- 진도표 카테고리 (progress_categories)
--   센터마다 기술 목록을 계층으로 구성 (점프 > 왈츠점프 등)
--   조회: 로그인 사용자 (회원도 자기 진도에서 기술명을 봐야 함)
--   편집: 진도표 관리 권한(customer.progress) 있는 사람만
-- ============================================================

alter table progress_categories enable row level security;

drop policy if exists "진도 카테고리 조회" on progress_categories;
create policy "진도 카테고리 조회"
    on progress_categories for select
    using (auth.uid() is not null);

drop policy if exists "진도 카테고리 생성" on progress_categories;
create policy "진도 카테고리 생성"
    on progress_categories for insert
    with check (has_permission(center_id, 'customer.progress'));

drop policy if exists "진도 카테고리 수정" on progress_categories;
create policy "진도 카테고리 수정"
    on progress_categories for update
    using (has_permission(center_id, 'customer.progress'))
    with check (has_permission(center_id, 'customer.progress'));

drop policy if exists "진도 카테고리 삭제" on progress_categories;
create policy "진도 카테고리 삭제"
    on progress_categories for delete
    using (has_permission(center_id, 'customer.progress'));


-- ============================================================
-- 진도 기록 (progress_records)
--   조회: 진도 권한 있는 매니저 + 본인(회원)
--   기록: 진도표 관리 권한 있는 사람만
-- ============================================================

alter table progress_records enable row level security;

drop policy if exists "진도 기록 조회" on progress_records;
create policy "진도 기록 조회"
    on progress_records for select
    using (
        profile_id in (select my_profile_ids())
        or category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );

drop policy if exists "진도 기록 생성" on progress_records;
create policy "진도 기록 생성"
    on progress_records for insert
    with check (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );

drop policy if exists "진도 기록 삭제" on progress_records;
create policy "진도 기록 삭제"
    on progress_records for delete
    using (
        category_id in (
            select id from progress_categories
            where has_permission(center_id, 'customer.progress')
        )
    );


-- ============================================================
-- 수강권 예약조건 (membership_schedule_rules)
--   조회: 로그인 사용자 (예약 시 조건 확인 + 회원이 상품 조건 확인)
--   편집: 수강권 관리 권한(pass.update) 있는 사람만
-- ============================================================

alter table membership_schedule_rules enable row level security;

drop policy if exists "예약조건 조회" on membership_schedule_rules;
create policy "예약조건 조회"
    on membership_schedule_rules for select
    using (auth.uid() is not null);

drop policy if exists "예약조건 생성" on membership_schedule_rules;
create policy "예약조건 생성"
    on membership_schedule_rules for insert
    with check (
        product_id in (
            select id from products
            where has_permission(center_id, 'pass.update')
        )
    );

drop policy if exists "예약조건 삭제" on membership_schedule_rules;
create policy "예약조건 삭제"
    on membership_schedule_rules for delete
    using (
        product_id in (
            select id from products
            where has_permission(center_id, 'pass.update')
        )
    );


-- ============================================================
-- 수강권 발급/수정 정책 (memberships)
--   회원 본인은 조회만(기존), 매니저는 수강권 발급 권한으로 생성/수정
--   (결제 등록 시 수강권 자동 발급이 이 정책을 통과해야 함)
-- ============================================================

drop policy if exists "매니저 수강권 발급" on memberships;
create policy "매니저 수강권 발급"
    on memberships for insert
    with check (has_permission(center_id, 'customer.member.issue_pass'));

drop policy if exists "매니저 수강권 수정" on memberships;
create policy "매니저 수강권 수정"
    on memberships for update
    using (has_permission(center_id, 'customer.member.issue_pass'))
    with check (has_permission(center_id, 'customer.member.issue_pass'));

drop policy if exists "매니저 수강권 조회" on memberships;
create policy "매니저 수강권 조회"
    on memberships for select
    using (
        profile_id in (select my_profile_ids())
        or has_permission(center_id, 'customer.member.view')
    );


-- ============================================================
-- 매니저 회원 검색용: 대표 프로필 조회 허용
--   신규 회원을 센터에 등록하려면, 아직 센터에 없는 사람의
--   대표 프로필을 검색할 수 있어야 함. (센터를 운영하는 매니저만)
--   대표 프로필(is_primary=true)의 이름만 노출되므로 범위 제한적.
-- ============================================================

drop policy if exists "매니저 대표프로필 검색" on profiles;
create policy "매니저 대표프로필 검색"
    on profiles for select
    using (
        is_primary = true
        and exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );


-- ============================================================
-- 매니저 회원 검색용: 계정 전화번호 조회 허용
--   신규 회원을 전화번호로 검색해 등록하려면 필요.
--   센터를 운영 중인 매니저만.
-- ============================================================

drop policy if exists "매니저 계정 검색" on accounts;
create policy "매니저 계정 검색"
    on accounts for select
    using (
        exists (
            select 1 from manager_centers mc
            where mc.account_id = my_account_id() and mc.status = 'active'
        )
    );


-- ============================================================
-- 수업별 예약 가능 수강권 (class_allowed_products)
--   조회: 로그인 사용자 (예약 시 확인 + 회원이 수업 조건 확인)
--   편집: 수업 관리 권한(schedule.class 계열) — 오너 포함
-- ============================================================

alter table class_allowed_products enable row level security;

drop policy if exists "수업수강권 조회" on class_allowed_products;
create policy "수업수강권 조회"
    on class_allowed_products for select
    using (auth.uid() is not null);

drop policy if exists "수업수강권 생성" on class_allowed_products;
create policy "수업수강권 생성"
    on class_allowed_products for insert
    with check (
        class_id in (
            select id from classes where center_id in (select my_managed_center_ids())
        )
    );

drop policy if exists "수업수강권 삭제" on class_allowed_products;
create policy "수업수강권 삭제"
    on class_allowed_products for delete
    using (
        class_id in (
            select id from classes where center_id in (select my_managed_center_ids())
        )
    );


-- ============================================================
-- 매니저: 자기 센터 수업의 취소/노쇼 예약 기록 삭제 허용
--   (수업 삭제 시 과거 예약 기록이 FK로 막는 문제 해결)
--   확정/대기/출석 예약은 삭제 대상 아님 → 여전히 보호됨
-- ============================================================

drop policy if exists "매니저 취소예약 정리" on reservations;
create policy "매니저 취소예약 정리"
    on reservations for delete
    using (
        status in ('cancelled', 'no_show')
        and class_id in (
            select id from classes where center_id in (select my_managed_center_ids())
        )
    );


-- ============================================================
-- 수업 삭제 (매니저용, security definer)
--   - 권한: 그 수업 센터를 관리하는 매니저만
--   - 취소/노쇼 예약 기록을 먼저 지우고 수업 삭제
--   - 확정/대기/출석 예약이 있으면 막음 (안내)
--   - 삭제 후, 그 제목 수업이 더 없으면 예약조건도 정리
-- ============================================================

create or replace function delete_class_safe(p_class_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where id = p_class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    -- 권한 확인 (오너는 has_permission이 자동 통과)
    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    -- 확정/대기/출석 예약이 있으면 삭제 불가
    select count(*) into v_active from reservations
    where class_id = p_class_id and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    -- 취소/노쇼 기록 정리 후 수업 삭제
    delete from reservations where class_id = p_class_id;
    delete from classes where id = p_class_id;

    -- 같은 제목 수업이 더 없으면 예약조건 정리
    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;

-- 반복수업 그룹 삭제 (security definer)
create or replace function delete_class_group_safe(p_group_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_center_id uuid;
    v_title     text;
    v_active    int;
begin
    select center_id, title into v_center_id, v_title
    from classes where recurring_group_id = p_group_id limit 1;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '이 수업을 삭제할 권한이 없어요';
    end if;

    select count(*) into v_active from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id)
      and status in ('confirmed','waitlisted','attended');
    if v_active > 0 then
        raise exception '확정·대기·출석 예약이 있어 삭제할 수 없어요 (%건). 먼저 처리해주세요', v_active;
    end if;

    delete from reservations
    where class_id in (select id from classes where recurring_group_id = p_group_id);
    delete from classes where recurring_group_id = p_group_id;

    if not exists (select 1 from classes where center_id = v_center_id and title = v_title) then
        delete from membership_schedule_rules
        where class_title = v_title
          and product_id in (select id from products where center_id = v_center_id);
    end if;

    return json_build_object('deleted', true);
end;
$$;


-- ============================================================
-- 회원 개인 메모: 본인 예약의 메모 수정 허용
--   본인 프로필의 예약만 update 가능 (member_memo 용도)
-- ============================================================

drop policy if exists "본인 예약 메모 수정" on reservations;
create policy "본인 예약 메모 수정"
    on reservations for update
    using (profile_id in (select my_profile_ids()))
    with check (profile_id in (select my_profile_ids()));


-- ============================================================
-- 예약 + (선택) 보유 상품 함께 사용
--   기존 reserve_class 를 확장: p_goods_membership_id 를 넘기면
--   그 상품(대여 등) 잔여횟수도 1 차감. 무제한(remaining_count is null)이면 차감 안 함.
--   수업이 allow_goods=false면 상품 사용 무시.
-- ============================================================

create or replace function reserve_class_with_goods(
    p_class_id uuid,
    p_profile_id uuid default null,
    p_goods_membership_id uuid default null
)
returns json
language plpgsql
security definer
as $$
declare
    v_result json;
    v_profile_id uuid;
    v_allow_goods boolean;
    v_goods record;
begin
    -- 1) 기존 예약 로직 그대로 수행 (수강권 차감 + 예약 생성)
    v_result := reserve_class(p_class_id, p_profile_id);

    -- 2) 상품을 함께 선택했으면 차감 처리
    if p_goods_membership_id is not null then
        -- 예약에 쓰인 프로필 확인
        if p_profile_id is not null then
            select id into v_profile_id from profiles
            where id = p_profile_id and account_id = my_account_id();
        else
            select id into v_profile_id from profiles
            where account_id = my_account_id() and is_primary = true limit 1;
        end if;

        -- 수업이 상품 사용을 허용하는지
        select allow_goods into v_allow_goods from classes where id = p_class_id;

        if v_allow_goods then
            -- 본인 상품이고 잔여 있는지 확인 후 차감
            select * into v_goods from memberships
            where id = p_goods_membership_id
              and profile_id = v_profile_id
            for update;

            if found then
                -- 무제한(null)이 아니고 잔여가 있으면 1 차감
                if v_goods.remaining_count is not null and v_goods.remaining_count > 0 then
                    update memberships set remaining_count = remaining_count - 1
                    where id = p_goods_membership_id;
                end if;
            end if;
        end if;
    end if;

    return v_result;
end;
$$;


-- ============================================================
-- 휴무일 지정 (수업 자동 삭제 + 예약자 처리)
--   p_force = false: 그날 수업에 살아있는 예약이 있으면 삭제 안 하고
--                    needs_confirm=true 반환 (매니저 확인 필요)
--   p_force = true : 예약 취소 + 수업 삭제 후 휴무일 등록
--   반복수업이어도 "그 날짜"의 수업만 삭제됨 (날짜별로 행이 분리돼 있음)
-- ============================================================

create or replace function add_holiday_safe(
    p_center_id uuid,
    p_date date,
    p_reason text default null,
    p_force boolean default false
)
returns json
language plpgsql
security definer
as $$
declare
    v_class_ids  uuid[];
    v_active_cnt int;
begin
    -- 권한 확인 (센터 관리자/오너)
    if not has_permission(p_center_id, 'schedule.own.group.delete') and not is_platform_admin() then
        raise exception '휴무일을 지정할 권한이 없어요';
    end if;

    -- 그날 그 센터의 수업 id 모음 (KST 기준 날짜)
    select array_agg(id) into v_class_ids
    from classes
    where center_id = p_center_id
      and (start_time at time zone 'Asia/Seoul')::date = p_date;

    -- 살아있는 예약 수 (확정/대기/출석)
    v_active_cnt := 0;
    if v_class_ids is not null then
        select count(*) into v_active_cnt
        from reservations
        where class_id = any(v_class_ids)
          and status in ('confirmed','waitlisted','attended');
    end if;

    -- 예약이 있는데 강제 아님 → 확인 요청
    if v_active_cnt > 0 and not p_force then
        return json_build_object(
            'needs_confirm', true,
            'class_count', coalesce(array_length(v_class_ids, 1), 0),
            'reservation_count', v_active_cnt
        );
    end if;

    -- 수업 삭제 (예약 기록 먼저 정리)
    if v_class_ids is not null then
        delete from reservations where class_id = any(v_class_ids);
        delete from classes where id = any(v_class_ids);
    end if;

    -- 휴무일 등록 (이미 있으면 무시)
    insert into center_holidays (center_id, holiday_date, reason)
    values (p_center_id, p_date, p_reason)
    on conflict do nothing;

    return json_build_object(
        'needs_confirm', false,
        'deleted_classes', coalesce(array_length(v_class_ids, 1), 0),
        'cancelled_reservations', v_active_cnt
    );
end;
$$;


-- ============================================================
-- 주문 처리 완료 (수강권/상품 자동 발급 + 매출 자동 연동)
--   매니저가 주문관리에서 "처리 완료" 시, 또는 나중에 실제 결제 성공 시 호출.
--   하는 일:
--     1) order를 done 처리
--     2) 그 회원에게 수강권/상품(membership) 자동 발급
--     3) payments에 매출 기록 (매출관리에 자동 반영)
--   이미 done인 주문은 중복 발급 안 함.
-- ============================================================

create or replace function fulfill_order(p_order_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_order      record;
    v_product    record;
    v_membership_id uuid;
    v_count      int;
    v_kind       text;
    v_expires    date;
begin
    -- 주문 조회 + 잠금
    select * into v_order from orders where id = p_order_id for update;
    if not found then
        raise exception '주문을 찾을 수 없어요';
    end if;

    -- 권한: 이 센터 매니저/오너만
    if not (v_order.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 주문을 처리할 권한이 없어요';
    end if;

    -- 이미 완료된 주문이면 중복 발급 방지
    if v_order.status = 'done' then
        return json_build_object('already_done', true);
    end if;

    -- 상품 정보 (횟수/종류)
    v_count := null; v_kind := 'pass';
    if v_order.product_id is not null then
        select * into v_product from products where id = v_order.product_id;
        if found then
            v_count := v_product.total_count;
            v_kind := v_product.product_kind;
        end if;
    end if;

    -- 유효기간 기본 60일
    v_expires := (now() + interval '60 days')::date;

    -- 1) 수강권/상품 발급
    insert into memberships (
        profile_id, center_id, product_id, product_name,
        pass_type, total_count, remaining_count, expires_at, status
    ) values (
        v_order.profile_id, v_order.center_id, v_order.product_id, v_order.product_name,
        'count', v_count, v_count, v_expires, 'active'
    ) returning id into v_membership_id;

    -- 2) 매출 기록 (결제수단은 주문의 pay_method 기준으로 대략 분류)
    insert into payments (
        center_id, profile_id, membership_id,
        sale_type, revenue_category,
        card_amount, cash_amount, transfer_amount, point_amount,
        total_amount, unpaid_amount, paid_at, status, memo
    ) values (
        v_order.center_id, v_order.profile_id, v_membership_id,
        'new', 'membership',
        case when v_order.pay_method in ('card','kakao','toss') then v_order.amount else 0 end,
        0,
        case when v_order.pay_method = 'transfer' then v_order.amount else 0 end,
        0,
        v_order.amount, 0, now(), 'paid',
        '앱 주문 자동 발급'
    );

    -- 3) 센터 회원목록에 자동 등록 (없으면 추가, 만료회원이면 복귀)
    perform ensure_center_member(v_order.center_id, v_order.profile_id);

    -- 3-1) 회원이 자동예약을 선택했고 요일반 수강권이면 자동 예약
    if coalesce(v_order.auto_book, false) then
        begin
            perform auto_book_membership(v_membership_id);
        exception when others then
            null;  -- 자동예약 실패해도 발급 자체는 성공 처리
        end;
    end if;

    -- 4) 주문 완료 처리
    update orders set status = 'done', paid_at = now() where id = p_order_id;

    return json_build_object(
        'already_done', false,
        'membership_id', v_membership_id,
        'amount', v_order.amount
    );
end;
$$;


-- ============================================================
-- 매니저 출결 처리 (출석/결석/노쇼/예약취소)
--   p_status: 'attended' | 'no_show' | 'confirmed' | 'cancelled'
--   - cancelled 로 바꾸면: 차감됐던 수강권 횟수 1 복구 (해당 membership)
--   - 다른 상태에서 cancelled 로 갈 때만 복구 (이미 취소된 건 재복구 안 함)
--   - 매니저(그 센터 관리 권한)만 실행
-- ============================================================

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
as $$
declare
    v_res     record;
    v_class   record;
    v_restored boolean := false;
begin
    if p_status not in ('attended', 'no_show', 'confirmed', 'cancelled') then
        raise exception '잘못된 상태예요';
    end if;

    select * into v_res from reservations where id = p_reservation_id for update;
    if not found then
        raise exception '예약을 찾을 수 없어요';
    end if;

    -- 권한: 그 수업이 속한 센터의 매니저인지
    select * into v_class from classes where id = v_res.class_id;
    if not found then
        raise exception '수업을 찾을 수 없어요';
    end if;
    if not (v_class.center_id in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 예약을 처리할 권한이 없어요';
    end if;

    -- 예약취소로 변경 시, 아직 취소 상태가 아니었다면 횟수 복구
    if p_status = 'cancelled' and v_res.status <> 'cancelled' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id
               and remaining_count is not null;
            v_restored := true;
        end if;
    end if;

    -- 취소됐던 걸 다시 확정으로 되돌리면 재차감 (선택)
    if v_res.status = 'cancelled' and p_status = 'confirmed' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count - 1
             where id = v_res.membership_id
               and remaining_count is not null
               and remaining_count > 0;
        end if;
    end if;

    update reservations set status = p_status where id = p_reservation_id;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;


-- ============================================================
-- 수강권 환불 (회원 셀프)
--   조건: 결제 24시간 이내 + 미사용(횟수 미차감)
--   처리: 수강권 refunded 처리 + 매출 환불 기록 + 회원 상태 재계산
-- ============================================================

create or replace function refund_membership(p_membership_id uuid)
returns json
language plpgsql
security definer
as $$
declare
    v_mem     record;
    v_unlimited boolean := false;
    v_hours   numeric;
    v_amount  int := 0;
    v_still_active int := 0;
begin
    -- 본인 소유 수강권인지 확인 + 잠금
    select * into v_mem from memberships
    where id = p_membership_id
      and profile_id in (select id from profiles where account_id = my_account_id())
    for update;

    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;
    if v_mem.status = 'refunded' then
        raise exception '이미 환불된 수강권이에요';
    end if;

    -- 무제한 여부
    select coalesce(p.unlimited, false) into v_unlimited
    from products p where p.id = v_mem.product_id;
    v_unlimited := coalesce(v_unlimited, false);

    -- 24시간 이내인지
    v_hours := extract(epoch from (now() - v_mem.created_at)) / 3600;
    if v_hours > 24 then
        raise exception '결제 후 24시간이 지나 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    -- 미사용인지 (횟수권만 확인)
    if not v_unlimited and v_mem.total_count is not null
       and v_mem.remaining_count is distinct from v_mem.total_count then
        raise exception '이미 사용한 수강권은 셀프 환불이 어려워요. 센터에 문의해주세요.';
    end if;

    -- 결제 금액 찾기 (매출 환불 기록용)
    select coalesce(total_amount, 0) into v_amount
    from payments where membership_id = v_mem.id
    order by paid_at desc limit 1;
    v_amount := coalesce(v_amount, 0);

    -- 1) 수강권 환불 처리
    update memberships
       set status = 'refunded', remaining_count = 0
     where id = v_mem.id;

    -- 2) 매출에 환불(음수) 기록 → 매출관리 자동 반영
    if v_amount > 0 then
        insert into payments (
            center_id, profile_id, membership_id,
            sale_type, revenue_category,
            card_amount, cash_amount, transfer_amount, point_amount,
            total_amount, unpaid_amount, paid_at, status, memo
        ) values (
            v_mem.center_id, v_mem.profile_id, v_mem.id,
            'refund', 'membership',
            0, 0, 0, 0,
            -v_amount, 0, now(), 'paid',
            '앱 셀프 환불'
        );
    end if;

    -- 3) 남은 사용가능 수강권이 없으면 만료회원으로
    select count(*) into v_still_active
    from memberships m
    where m.profile_id = v_mem.profile_id
      and m.center_id = v_mem.center_id
      and m.status = 'active'
      and (m.remaining_count is null or m.remaining_count > 0)
      and (m.expires_at is null or m.expires_at >= current_date);

    if v_still_active = 0 then
        update center_members
           set status = 'expired'
         where profile_id = v_mem.profile_id
           and center_id = v_mem.center_id
           and status <> 'dormant';
    end if;

    return json_build_object('refunded', true, 'amount', v_amount);
end;
$$;


-- ============================================================
-- 수강권 발급 시 회원 자동 등록/복귀
--   fulfill_order 등에서 호출. 센터 회원목록에 없으면 추가,
--   만료회원이면 다시 이용중으로.
-- ============================================================

create or replace function ensure_center_member(p_center_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    insert into center_members (center_id, profile_id, status, registered_at, app_linked)
    values (p_center_id, p_profile_id, 'active', now(), true)
    on conflict (center_id, profile_id) do update
        set status = case
                        when center_members.status = 'dormant' then 'dormant'  -- 휴면은 유지
                        else 'active'
                     end;
end;
$$;


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
-- 매니저 출결 처리 (v2)
--   변경점:
--     · 예약취소는 최종 상태 → 취소된 예약은 다른 상태로 못 바꿈
--     · 취소 시 "예약에 사용된 바로 그 수강권"에만 +1 복구
--     · 이미 취소된 건 재복구 안 함 (중복 복구 방지)
-- ============================================================

create or replace function manager_set_attendance(p_reservation_id uuid, p_status text)
returns json
language plpgsql
security definer
as $$
declare
    v_res      record;
    v_class    record;
    v_restored boolean := false;
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

    -- ★ 취소된 예약은 최종 상태: 어떤 상태로도 변경 불가
    if v_res.status = 'cancelled' then
        raise exception '이미 취소된 예약이라 출결 상태를 바꿀 수 없어요';
    end if;

    -- 예약취소 → 사용했던 그 수강권에만 횟수 복구
    if p_status = 'cancelled' then
        if v_res.membership_id is not null then
            update memberships
               set remaining_count = remaining_count + 1
             where id = v_res.membership_id          -- 예약에 쓰인 바로 그 수강권
               and remaining_count is not null;
            v_restored := true;
        end if;
    end if;

    update reservations set status = p_status where id = p_reservation_id;

    return json_build_object('status', p_status, 'restored', v_restored);
end;
$$;
