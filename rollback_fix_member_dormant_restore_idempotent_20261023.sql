-- 롤백(F19): 새 RPC 제거 + extend_passes_after_dormant 를 add_membership_expiry_extension.sql 의 정의로 되돌린다.
-- ⚠ 적용 직전 운영 정의를 백업한 것이 우선이며, 이 파일은 저장소 정의 기준이다(Codex 가 적용 전 운영 정의와 대조할 것).
drop function if exists set_center_member_status(uuid, text);
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
notify pgrst, 'reload schema';
