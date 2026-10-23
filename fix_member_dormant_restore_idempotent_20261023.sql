-- F19: 휴면 복구 중복 연장 방지 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상)
--
-- 결함: 복구가 클라이언트의 두 단계(① extend_passes_after_dormant RPC → ② center_members UPDATE 로 dormant_since=null)로 나뉘어 있고,
--      ① 은 만료일만 늘리고 휴면 회차를 "처리 완료"로 표시하지 않았다. 그래서 ② 가 끝나기 전의 같은 회차 요청(더블 클릭·재시도·병렬)이
--      모두 성공해 3일 휴면이 6일 연장됐다(QA 로그 extra-dormant-repeat-1022.json: 병렬 2건 모두 200, 11/21 → 11/30).
-- 수정(두 갈래, 둘 다 기존 정책 — 휴면 일수만큼 활성 수강권 만료일 연장 — 은 그대로):
--  A) extend_passes_after_dormant(uuid): 이미 잠근 center_members 행에서 연장과 같은 트랜잭션으로 dormant_since 를 NULL 로 비워
--     그 휴면 회차를 소비한다. 다음 호출은 `dormant_since is null` 가드에서 0 을 돌려준다. 시그니처·반환값 불변 → 현재 운영 중인
--     구버전 앱(① 후 ②)과 호환된다(② 는 이미 비워진 dormant_since 를 다시 null 로 쓸 뿐이며 연장은 없다).
--  B) set_center_member_status(uuid, text): 새 앱이 쓰는 원자 RPC. 상태 변경·연장·회차 소비가 한 트랜잭션이다.
--     이미 휴면인 회원에게 다시 'dormant' 를 요청해도 시작 시각을 덮어쓰지 않는다(기존 클라이언트는 덮어써 경과 일수를 잃었다).
-- 호환/적용 순서: (1) 이 SQL 먼저 적용 → 구버전 앱도 안전(위 A). (2) 새 앱 배포 → set_center_member_status 사용,
--     함수가 없으면(SQL 미적용) 예전 두 단계 경로로 폴백. 따라서 어느 순서로 가도 앱이 깨지지 않지만 중복 방지는 SQL 적용 후부터 보장된다.
-- 정책 영향: 없음(연장 일수 계산식 floor(경과일), 대상 = 같은 센터·프로필의 status='active' 이고 expires_at 있는 수강권 — 그대로).
-- 범위 밖: 센터 회원 행을 RLS 로 직접 UPDATE 하는 다른 경로가 있으면 연장 없이 상태만 바뀐다(기존과 동일).

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

    -- 휴면 회차 소비: 연장 일수가 0이어도 이 회차는 처리된 것으로 비운다(같은 회차 재요청이 나중에 일수가 차서 연장되는 일 방지).
    update center_members set dormant_since = null where id = v_cm.id;
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

create or replace function set_center_member_status(p_center_member_id uuid, p_status text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cm        center_members;
    v_days      integer := 0;
    v_n         integer := 0;
    v_since     timestamptz;
begin
    if p_status is null or p_status not in ('active', 'expired', 'dormant') then
        raise exception '회원 상태는 활성/만료/휴면 중 하나여야 해요';
    end if;
    select * into v_cm from center_members where id = p_center_member_id for update;
    if not found then
        raise exception '회원을 찾을 수 없어요';
    end if;
    if not (has_permission(v_cm.center_id, 'customer.member.update') or is_platform_admin()) then
        raise exception '회원 상태를 변경할 권한이 없어요';
    end if;

    v_since := v_cm.dormant_since;
    if p_status = 'dormant' then
        -- 이미 휴면이면 시작 시각 유지(재요청이 경과 일수를 지우지 않게)
        if v_cm.status <> 'dormant' or v_cm.dormant_since is null then
            v_since := now();
        end if;
    else
        if v_cm.status = 'dormant' and v_cm.dormant_since is not null then
            v_days := floor(extract(epoch from (now() - v_cm.dormant_since)) / 86400)::integer;
            if v_days > 0 then
                perform set_config('app.membership_expiry_write', 'on', true);
                update memberships set expires_at = expires_at + v_days
                 where profile_id = v_cm.profile_id and center_id = v_cm.center_id
                   and status = 'active' and expires_at is not null;
                get diagnostics v_n = row_count;
                perform set_config('app.membership_expiry_write', '', true);
            end if;
        end if;
        v_since := null;
    end if;

    update center_members set status = p_status, dormant_since = v_since where id = v_cm.id;
    return json_build_object('status', p_status, 'daysAdded', v_days, 'extendedPasses', v_n);
end;
$$;
revoke all on function set_center_member_status(uuid, text) from public, anon;
grant execute on function set_center_member_status(uuid, text) to authenticated, service_role;
notify pgrst, 'reload schema';
