-- ============================================================
-- 관리자 "수강권 만료일 연장" (2026-10-02)
--
-- [감사 결과(Production 실제 정책 조회)]
--   · memberships UPDATE RLS "매니저 수강권 수정" = customer.member.issue_pass OR customer.member.pass_detail OR 플랫폼 관리자(같은 센터).
--     authenticated에는 테이블 전체 UPDATE 권한(컬럼 제한 없음)이 부여돼 있다 → 새 permission만 만들면 issue_pass/pass_detail만 가진 직원이
--     REST로 supabase.from("memberships").update({ expires_at }) 를 직접 호출해 만료일을 바꿀 수 있었다(UI 숨김만으로는 무의미).
--   · expires_at을 UPDATE하는 서버 함수는 없고, 클라이언트 경로는 lib/members.ts setMemberStatus(휴면→복귀 시 휴면 기간만큼 기간권 연장) 하나뿐이다.
--   · admin_action_logs가 이미 'MEMBERSHIP_UPDATE' action_type + membership_id/member_profile_id/before_state/after_state/reason_detail/admin_id를
--     갖고 있어 새 로그 테이블 없이 재사용한다.
--
-- [이 migration]
--   1) permission 카탈로그에 customer.member.pass_expiry.update("수강권 만료일 연장", parent=customer.member.pass_detail) 추가.
--      role_permissions / account_center_permissions는 건드리지 않는다 → 적용 직후 Studio Owner(has_permission의 is_owner)만 가능,
--      오너가 역할/개인 권한 화면에서 켜야 다른 직원이 사용할 수 있다. (표시 순서를 pass_detail 바로 다음으로 두려고
--      assign_any_status의 sort_order만 18→19로 한 칸 민다.)
--   2) manager_extend_membership_expiry(): 서버 최종 방어선. has_permission(center, 새 권한) OR 플랫폼 관리자, 행 잠금(FOR UPDATE),
--      goods/무제한/비정상 상태/단축/과거 날짜 거부, expires_at만 UPDATE, admin_action_logs 기록.
--   3) memberships BEFORE UPDATE OF expires_at 가드 트리거: 로그인 사용자(JWT 있음)가 직접 expires_at을 바꾸면 거부한다
--      (issue_pass/pass_detail/오너/플랫폼 관리자 모두 — 전용 RPC만 허용). 값이 그대로면 통과, service_role/서버 작업(JWT 없음)은 통과.
--      remaining_count/status 등 다른 컬럼 UPDATE(예약 차감/복원, 환불 등)는 이 트리거가 발동하지 않는다.
--   4) 기존 휴면 복귀 만료일 연장은 가드에 막히지 않도록 같은 효과의 서버 함수 extend_passes_after_dormant()로 옮기고 클라이언트가 호출한다
--      (권한 customer.member.update, 같은 계산식, 이 함수만 가드를 통과).
--
-- 변경하지 않는 것: remaining_count/total_count/starts_at, 결제/주문/예약, products 만료 정책, 다른 회원 수강권, role_permissions.
-- 여러 번 실행해도 안전. 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
BEGIN;

-- 1) permission 카탈로그 (역할/개인 권한 화면은 이 테이블을 읽어 자동으로 항목을 그린다)
update permissions set sort_order = 19
 where key = 'customer.member.assign_any_status' and sort_order = 18;

insert into permissions (key, category, parent_key, label, description, sort_order)
values (
    'customer.member.pass_expiry.update', 'customer', 'customer.member.pass_detail',
    '수강권 만료일 연장', '회원에게 발급된 수강권의 만료일을 연장할 수 있습니다.', 18
)
on conflict (key) do update set
    category = excluded.category, parent_key = excluded.parent_key,
    label = excluded.label, description = excluded.description, sort_order = excluded.sort_order;

-- 2) 가드 트리거 — 직접 UPDATE로 expires_at을 바꾸는 우회 차단
create or replace function memberships_guard_expiry_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.expires_at is not distinct from old.expires_at then
        return new;   -- 만료일을 바꾸지 않는 UPDATE(차감/복원/상태 변경 등)는 영향 없음
    end if;
    -- 전용 RPC들이 같은 트랜잭션 안에서만 켜는 표식(클라이언트는 설정할 방법이 없다)
    if coalesce(current_setting('app.membership_expiry_write', true), '') = 'on' then
        return new;
    end if;
    -- 로그인 사용자 JWT가 없는 서버 작업(service_role, cron, SQL Editor)은 통과
    if auth.uid() is null then
        return new;
    end if;
    raise exception '수강권 만료일은 "수강권 만료일 연장" 기능으로만 변경할 수 있어요'
        using errcode = '42501';
end;
$$;
revoke all on function memberships_guard_expiry_update() from public, anon, authenticated;

drop trigger if exists memberships_guard_expiry_update on memberships;
create trigger memberships_guard_expiry_update
    before update of expires_at on memberships
    for each row execute function memberships_guard_expiry_update();

-- 3) 전용 RPC — 이미 발급된 수강권 1개의 만료일만 연장
create or replace function manager_extend_membership_expiry(
    p_membership_id uuid,
    p_mode text,
    p_days integer default null,
    p_new_expires_at date default null,
    p_reason text default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mem    memberships;
    v_kind   text;
    v_today  date := (now() at time zone 'Asia/Seoul')::date;
    v_old    date;
    v_new    date;
    v_reason text;
    v_name   text;
    v_days   integer;
begin
    if my_account_id() is null then
        raise exception '로그인이 필요해요';
    end if;

    select * into v_mem from memberships where id = p_membership_id for update;
    if not found then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    -- 서버 최종 권한: 센터는 클라이언트 입력이 아니라 수강권 행에서 찾는다(다른 센터 수강권은 자연히 거부)
    if not (has_permission(v_mem.center_id, 'customer.member.pass_expiry.update') or is_platform_admin()) then
        raise exception '수강권 만료일을 연장할 권한이 없어요';
    end if;

    if v_mem.status not in ('active', 'paused') then
        raise exception '연장할 수 없는 상태의 수강권이에요(환불·양도·만료 처리됨)';
    end if;

    select product_kind into v_kind from products where id = v_mem.product_id;   -- product_id가 null인 기존 수강권은 v_kind null
    if v_kind = 'goods' then
        raise exception '대여상품은 만료일을 연장할 수 없어요';
    end if;

    if v_mem.expires_at is null then
        raise exception '무제한 수강권은 만료일을 연장할 수 없어요';
    end if;
    v_old := v_mem.expires_at;

    if p_mode = 'days' then
        if p_days is null or p_days < 1 then
            raise exception '연장 일수는 1일 이상이어야 해요';
        end if;
        if p_days > 3650 then
            raise exception '한 번에 연장할 수 있는 일수를 넘었어요(최대 3650일)';
        end if;
        v_new := v_old + p_days;
    elsif p_mode = 'date' then
        if p_new_expires_at is null then
            raise exception '새 만료일을 선택해주세요';
        end if;
        v_new := p_new_expires_at;
    else
        raise exception '연장 방식이 올바르지 않아요';
    end if;

    if v_new <= v_old then
        raise exception '새 만료일은 현재 만료일(%)보다 뒤여야 해요. 만료일은 연장만 할 수 있어요.', v_old;
    end if;
    if v_new < v_today then
        raise exception '이미 만료된 수강권이에요. 새 만료일이 오늘 이후가 되도록 연장해주세요.';
    end if;

    v_reason := nullif(btrim(coalesce(p_reason, '')), '');
    if v_reason is not null and char_length(v_reason) > 200 then
        raise exception '연장 사유는 200자 이내로 입력해주세요';
    end if;

    v_days := v_new - v_old;

    perform set_config('app.membership_expiry_write', 'on', true);
    update memberships set expires_at = v_new where id = v_mem.id;   -- expires_at "만"
    perform set_config('app.membership_expiry_write', '', true);

    select coalesce(pr.nickname, pr.name, '회원') into v_name from profiles pr where pr.id = v_mem.profile_id;

    insert into admin_action_logs (
        center_id, action_type, admin_id, member_profile_id, membership_id,
        reason_code, reason_detail, capacity_override, membership_consumed,
        member_name_snapshot, before_state, after_state
    ) values (
        v_mem.center_id, 'MEMBERSHIP_UPDATE', my_account_id(), v_mem.profile_id, v_mem.id,
        'EXPIRY_EXTEND', v_reason, false, false,
        v_name,
        json_build_object('expires_at', v_old),
        json_build_object('expires_at', v_new, 'mode', p_mode, 'days', case when p_mode = 'days' then p_days else null end, 'days_added', v_days)
    );

    return json_build_object(
        'membershipId', v_mem.id,
        'oldExpiresAt', v_old,
        'newExpiresAt', v_new,
        'daysAdded', v_days
    );
end;
$$;
revoke all on function manager_extend_membership_expiry(uuid, text, integer, date, text) from public, anon;
grant execute on function manager_extend_membership_expiry(uuid, text, integer, date, text) to authenticated, service_role;

-- 4) 기존 기능 보존: 휴면 → 복귀 시 휴면 기간만큼 기간권 연장(예전에는 클라이언트가 memberships를 직접 UPDATE)
--    lib/members.ts setMemberStatus가 center_members 상태를 바꾸기 "전에" 호출한다(그 시점의 status='dormant', dormant_since를 사용).
create or replace function extend_passes_after_dormant(p_center_member_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cm   center_members;
    v_days integer;
    v_n    integer;
begin
    select * into v_cm from center_members where id = p_center_member_id for update;
    if not found then
        raise exception '회원을 찾을 수 없어요';
    end if;
    if not (has_permission(v_cm.center_id, 'customer.member.update') or is_platform_admin()) then
        raise exception '회원 상태를 변경할 권한이 없어요';
    end if;
    if v_cm.status <> 'dormant' or v_cm.dormant_since is null then
        return 0;
    end if;
    v_days := floor(extract(epoch from (now() - v_cm.dormant_since)) / 86400)::integer;
    if v_days <= 0 then
        return 0;
    end if;

    perform set_config('app.membership_expiry_write', 'on', true);
    update memberships set expires_at = expires_at + v_days
     where profile_id = v_cm.profile_id and center_id = v_cm.center_id
       and status = 'active' and expires_at is not null;
    get diagnostics v_n = row_count;
    perform set_config('app.membership_expiry_write', '', true);
    return v_n;
end;
$$;
revoke all on function extend_passes_after_dormant(uuid) from public, anon;
grant execute on function extend_passes_after_dormant(uuid) to authenticated, service_role;

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select key, category, parent_key, label, sort_order from permissions
 where key in ('customer.member.pass_detail', 'customer.member.pass_expiry.update', 'customer.member.assign_any_status') order by sort_order;
select
    (select count(*) from role_permissions where permission_key = 'customer.member.pass_expiry.update') as role_grants_must_be_0,
    (select count(*) from account_center_permissions where permission_key = 'customer.member.pass_expiry.update') as personal_grants_must_be_0,
    (select count(*) from pg_trigger where tgname = 'memberships_guard_expiry_update' and not tgisinternal) as guard_trigger_must_be_1,
    has_function_privilege('anon', 'manager_extend_membership_expiry(uuid,text,integer,date,text)', 'execute') as extend_rpc_anon_must_be_false,
    has_function_privilege('authenticated', 'manager_extend_membership_expiry(uuid,text,integer,date,text)', 'execute') as extend_rpc_auth_must_be_true,
    has_function_privilege('anon', 'extend_passes_after_dormant(uuid)', 'execute') as dormant_rpc_anon_must_be_false;
