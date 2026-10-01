-- ============================================================
-- manager_centers RLS 무한 재귀 최종 정리 + 권한상승 방지 (2026-10-01 QA 9)
--
-- 증상: 스태프 추가 시 "infinite recursion detected in policy for relation "manager_centers"".
--
-- [라이브 감사 결과(2026-10-01, pg_policies/pg_proc 직접 조회)]
--   이미 적용돼 있는 것(= 아래 draft들의 일부가 이전에 실행됨, 이 파일은 중복 적용하지 않고 "남은 것만"):
--     · center_roles "내 센터 역할 조회" → my_managed_center_ids() 사용            (center_roles draft)
--     · has_permission() / my_managed_center_ids() / is_center_owner() = SECURITY DEFINER + search_path 고정
--     · centers "승인된 센터 조회" → my_center_ids_any_status() 사용               (centers draft)
--     · 헬퍼 manager_centers_has_any_row / role_id_belongs_to_center / role_id_is_owner_for_center / center_is_pending
--     · manager_centers "오너 스태프 초대"/"수정"/"삭제"가 위 헬퍼를 사용
--   라이브에 "남아 있는" 재귀 원인:
--     · manager_centers INSERT 정책 "매니저센터 생성"이 아직 raw self-subquery를 쓴다:
--         NOT (EXISTS (SELECT 1 FROM manager_centers mc2 WHERE mc2.center_id = manager_centers.center_id))
--       manager_centers 정책 안에서 manager_centers를 다시 조회 → 정책 전개 시 즉시 재귀(INSERT는 모든
--       INSERT 정책을 함께 전개하므로 정상적인 "오너 스태프 초대"도 같이 막혔다).
--       fix_manager_centers_self_reference_recursion / privilege_escalation / pending_check_helper
--       draft 3개가 모두 이 정책을 헬퍼 호출로 바꾸려는 것이었고 그 마지막 단계가 라이브에 빠져 있었다.
--
-- [이 파일이 하는 일] 위 draft 3개의 "최종 형태"를 한 파일로 합치되 라이브에 이미 있는 건 재정의만 한다.
--   1) "매니저센터 생성"(첫 오너 부트스트랩): raw self-subquery 제거 → manager_centers_has_any_row() +
--      center_is_pending()(승인 대기 센터에서만 최초 1회).
--   2) 보안 불변식 강화(기존 policy의 구멍도 함께 막음):
--      · 다른 센터 role_id 주입 금지: INSERT/UPDATE 모두 role_id_belongs_to_center().
--      · owner 역할 탈취 금지: owner 역할을 부여/변경/오너 행을 수정·삭제할 수 있는 사람은 "해당 센터 오너"뿐
--        (facility.staff.* 권한만 있는 일반 매니저는 owner 역할을 줄 수도, 오너를 강등/삭제할 수도 없다).
--        본인이 스스로 owner로 올리는 경로는 "센터에 다른 행이 하나도 없을 때"(부트스트랩)만 허용.
--      · 마지막 오너 삭제 금지: 활성 오너가 1명뿐이면 그 행은 삭제 불가(DELETE 정책).
--      · 마지막 활성 오너 강등 금지: BEFORE UPDATE 트리거가, 센터에 다른 활성 오너가 없는데 그 오너 행을
--        non-owner 역할로 바꾸거나(role_id 변경/NULL) 비활성화(status가 'active'가 아니게)하거나 다른 센터로
--        옮기는 UPDATE를 막는다. 다른 활성 오너가 있으면 정상적으로 강등 가능. 센터별로 격리되고, 이름/전문분야
--        등 owner 자격과 무관한 필드 수정은 영향 없음. 동시에 두 오너가 서로를 강등하는 경합은 센터 단위
--        advisory lock으로 직렬화한다.
--      · staff.create / update / delete 권한 준수(기존 그대로).
--   3) 헬퍼 함수는 SECURITY DEFINER + search_path 고정 + PUBLIC/anon 실행 회수, authenticated/service_role만 허용.
--      (RLS 정책 평가는 호출 role 권한으로 함수를 실행하므로 authenticated EXECUTE는 필요.)
--
-- RLS를 끄거나 authenticated에 광범위한 write를 열지 않는다. 여러 번 실행해도 안전.
-- 이 세션에서는 production에 실행하지 않았습니다.
-- ============================================================
BEGIN;

create or replace function manager_centers_has_any_row(p_center_id uuid, p_exclude_id uuid default null)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from manager_centers
        where center_id = p_center_id
          and (p_exclude_id is null or id <> p_exclude_id)
    );
$$;

create or replace function role_id_belongs_to_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(select 1 from center_roles where id = p_role_id and center_id = p_center_id);
$$;

create or replace function role_id_is_owner_for_center(p_role_id uuid, p_center_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select exists(
        select 1 from center_roles where id = p_role_id and center_id = p_center_id and is_owner = true
    );
$$;

create or replace function center_is_pending(p_center_id uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
    return exists(select 1 from centers where id = p_center_id and status = 'pending');
end;
$$;

-- 이 행이 "마지막 활성 오너"인지(삭제 금지 판정용). 새 헬퍼.
create or replace function manager_centers_is_last_active_owner(p_center_id uuid, p_id uuid)
returns boolean
language sql stable
security definer
set search_path = public
as $$
    select
        exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
            where mc.id = p_id and mc.center_id = p_center_id and mc.status = 'active' and r.is_owner
        )
        and not exists (
            select 1 from manager_centers mc
            join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
            where mc.center_id = p_center_id and mc.id <> p_id and mc.status = 'active' and r.is_owner
        );
$$;

-- 이 행(role_id)이 가리키는 역할이 owner인지(오너 행 수정/삭제 보호용). role_id가 null이면 false.
-- 기존 role_id_is_owner_for_center와 같은 뜻이라 별도 함수 없이 그것을 재사용한다.

revoke all on function manager_centers_has_any_row(uuid, uuid) from public, anon;
revoke all on function role_id_belongs_to_center(uuid, uuid) from public, anon;
revoke all on function role_id_is_owner_for_center(uuid, uuid) from public, anon;
revoke all on function center_is_pending(uuid) from public, anon;
revoke all on function manager_centers_is_last_active_owner(uuid, uuid) from public, anon;
grant execute on function manager_centers_has_any_row(uuid, uuid) to authenticated, service_role;
grant execute on function role_id_belongs_to_center(uuid, uuid) to authenticated, service_role;
grant execute on function role_id_is_owner_for_center(uuid, uuid) to authenticated, service_role;
grant execute on function center_is_pending(uuid) to authenticated, service_role;
grant execute on function manager_centers_is_last_active_owner(uuid, uuid) to authenticated, service_role;

-- 1) 첫 오너 부트스트랩(본인, role 없음, 센터에 아직 아무 행도 없음, 센터가 승인 대기)
drop policy if exists "매니저센터 생성" on manager_centers;
create policy "매니저센터 생성"
    on manager_centers for insert
    with check (
        account_id = my_account_id()
        and role_id is null
        and not manager_centers_has_any_row(center_id)
        and center_is_pending(center_id)
    );

-- 2) 스태프 초대: staff.create 권한 + (역할 없음 | 같은 센터 역할). owner 역할 부여는 센터 오너만.
drop policy if exists "오너 스태프 초대" on manager_centers;
create policy "오너 스태프 초대"
    on manager_centers for insert
    with check (
        has_permission(center_id, 'facility.staff.create')
        and (
            role_id is null
            or (
                role_id_belongs_to_center(role_id, center_id)
                and (not role_id_is_owner_for_center(role_id, center_id) or is_center_owner(center_id))
            )
        )
    );

-- 3) 수정: 본인 부트스트랩(첫 행) 또는 staff.update 권한. 오너 행/owner 역할 변경은 오너만.
drop policy if exists "오너 스태프 수정" on manager_centers;
create policy "오너 스태프 수정"
    on manager_centers for update
    using (
        (
            account_id = my_account_id()
            and role_id is null
            and not manager_centers_has_any_row(center_id, id)
        )
        or (
            has_permission(center_id, 'facility.staff.update')
            and (not role_id_is_owner_for_center(role_id, center_id) or is_center_owner(center_id))
        )
    )
    with check (
        (role_id is null or role_id_belongs_to_center(role_id, center_id))
        and (
            (
                account_id = my_account_id()
                and status = 'active'
                and role_id_is_owner_for_center(role_id, center_id)
                and not manager_centers_has_any_row(center_id, id)
            )
            or (
                has_permission(center_id, 'facility.staff.update')
                and (not role_id_is_owner_for_center(role_id, center_id) or is_center_owner(center_id))
            )
        )
    );

-- 4) 삭제: 본인 탈퇴 또는 staff.delete 권한. 센터에 다른 행이 남아 있어야 하고, 마지막 활성 오너는 삭제 불가,
--    오너 행 삭제는 오너만.
drop policy if exists "오너 스태프 삭제" on manager_centers;
create policy "오너 스태프 삭제"
    on manager_centers for delete
    using (
        (account_id = my_account_id() or has_permission(center_id, 'facility.staff.delete'))
        and manager_centers_has_any_row(center_id, id)
        and not manager_centers_is_last_active_owner(center_id, id)
        and (not role_id_is_owner_for_center(role_id, center_id) or is_center_owner(center_id))
    );

-- 5) 마지막 활성 오너 UPDATE 강등 차단(트리거 — RLS 정책은 OLD 행을 못 봐서 정책만으로는 불가능).
--    owner 자격 = status='active' AND role이 같은 센터의 is_owner 역할.
create or replace function manager_centers_protect_last_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    -- OLD가 활성 오너가 아니면 관심 없음(대부분의 UPDATE는 여기서 바로 통과).
    if not (
        old.status = 'active'
        and old.role_id is not null
        and role_id_is_owner_for_center(old.role_id, old.center_id)
    ) then
        return new;
    end if;

    -- NEW도 같은 센터의 활성 오너면 owner 자격이 유지되는 수정(이름/전문분야 등) — 통과.
    if new.center_id = old.center_id
       and new.status = 'active'
       and new.role_id is not null
       and role_id_is_owner_for_center(new.role_id, new.center_id) then
        return new;
    end if;

    -- 여기까지 왔다면 이 UPDATE는 활성 오너 자격을 제거한다 — 센터별 직렬화 후 다른 활성 오너 확인.
    perform pg_advisory_xact_lock(hashtextextended('manager_centers_owner:' || old.center_id::text, 0));
    if not exists (
        select 1 from manager_centers mc
        join center_roles r on r.id = mc.role_id and r.center_id = mc.center_id
        where mc.center_id = old.center_id and mc.id <> old.id and mc.status = 'active' and r.is_owner
    ) then
        raise exception '센터의 마지막 활성 오너는 강등하거나 비활성화할 수 없어요. 먼저 다른 오너를 지정해주세요.'
            using errcode = '23514';
    end if;
    return new;
end;
$$;
revoke all on function manager_centers_protect_last_owner() from public, anon, authenticated;

drop trigger if exists manager_centers_protect_last_owner on manager_centers;
create trigger manager_centers_protect_last_owner
    before update on manager_centers
    for each row execute function manager_centers_protect_last_owner();

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
-- raw manager_centers 자기참조가 정책에 남아 있지 않아야 한다(아래 5개 행의 with_check/qual에 'FROM manager_centers' 없음)
select policyname, cmd, qual, with_check
from pg_policies where tablename = 'manager_centers' order by cmd, policyname;
select count(*) as self_referencing_policies_must_be_0
from pg_policies
where tablename = 'manager_centers'
  and (coalesce(qual, '') ilike '%from manager_centers%' or coalesce(with_check, '') ilike '%from manager_centers%');
