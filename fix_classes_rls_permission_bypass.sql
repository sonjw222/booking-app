-- ============================================================
-- classes RLS INSERT/UPDATE/DELETE 권한 우회 차단
--
-- 배경(2026-09-13, "예약 취소 완전 불가" 기능 QA 중 실제 공격으로 발견): classes의
-- INSERT/UPDATE/DELETE RLS 정책이 지금까지 my_managed_center_ids()(그 센터 소속인지)
-- 만 확인하고 has_permission()을 전혀 확인하지 않았다. 반면 앱이 정식으로 쓰는
-- create_class_safe()/update_class_safe()/delete_class_safe() RPC는 내부적으로
-- schedule.own/other.{group|private}.{create|update|delete|past_*} 권한키를 정확히
-- 확인한다. 즉 지금까지는:
--
--   schedule.* 권한이 전혀 없는 스태프도 브라우저 개발자도구에서
--   supabase.from("classes").update({...}) 를 RPC 없이 직접 호출하면
--   정원·담당강사·취소마감·**allow_cancel(이번에 추가한 컬럼)** 등 아무 컬럼이나
--   그 센터 소속이기만 하면 바꿀 수 있었다.
--
-- 실제로 schedule 권한이 전혀 없는 테스트 스태프 계정으로 재현 확인함(allow_cancel과
-- capacity 둘 다 직접 REST 호출로 변경 성공).
--
-- 이 파일이 하는 일: products/rooms에 이미 적용된 것과 동일한 패턴(fix_permission_
-- products_rooms_rls.sql)으로, classes의 INSERT/UPDATE/DELETE RLS에도
-- has_permission() 기반 세분권한 확인을 추가한다. own/other·group/private·
-- create/update/delete/past_* 조합을 판정하는 로직은 각 RPC와 완전히 동일하게
-- can_write_class() 헬퍼 함수 하나로 통일해서 재사용한다(로직 두 곳에 따로 적지 않음).
--
-- ⚠ 이 저장소 대부분의 세분권한 RPC(create_class_safe 등)는 SECURITY DEFINER이고
-- classes 테이블 소유자(postgres)로 실행되며, classes는 FORCE ROW LEVEL SECURITY가
-- 아니므로(직접 확인함, relforcerowsecurity=false) 테이블 소유자로 실행되는 이
-- RPC들과 add_holiday_safe/create_recurring_classes_safe/update_class_group_safe/
-- delete_class_group_safe/update_class_pass_selection_mode_safe/run_autocancel_sweep/
-- delete_test_center_cascade(모두 SECURITY DEFINER, postgres 소유로 직접 확인함)는
-- 이 RLS 변경의 영향을 전혀 받지 않는다 — RLS는 이 함수들이 실행하는 내부 update/
-- insert/delete에는 애초에 적용되지 않기 때문이다. 오직 클라이언트가 anon/authenticated
-- 롤로 classes 테이블에 직접 REST 요청을 보내는 경로만 이 정책의 영향을 받는다.
--
-- ⚠ 실사용자 동작 변화 없음: 정상적인 앱 화면(수업 등록/수정/삭제)은 이미 위 RPC들이
-- 동일한 has_permission() 체크를 안에서 하고 있었으므로, 이 SQL 적용 전후로 정상
-- 사용자가 할 수 있던 일이 달라지지 않는다. 이번 변경은 오직 "RPC를 거치지 않고
-- 테이블에 직접 쓰는" 우회 경로만 막는다(products/rooms 때와 달리 이번엔 breaking
-- change가 아님).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function public.can_write_class(
    p_class_id     uuid,        -- INSERT면 NULL(아직 존재하지 않는 수업)
    p_center_id    uuid,
    p_class_format text,
    p_start_time   timestamptz,
    p_action       text         -- 'create' | 'update' | 'delete'
) returns boolean
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
declare
    v_is_own boolean;
    v_verb   text;
    v_key    text;
begin
    if p_action = 'create' then
        -- create_class_safe()와 동일: 생성 시점엔 아직 담당 강사 배정이 없으므로 항상 own.
        v_is_own := true;
    else
        v_is_own := not exists (select 1 from class_trainers where class_id = p_class_id)
                 or exists (select 1 from class_trainers where class_id = p_class_id and account_id = my_account_id());
    end if;

    v_verb := case when p_start_time < now() then 'past_' || p_action else p_action end;
    v_key := 'schedule.' || (case when v_is_own then 'own' else 'other' end) || '.' ||
             (case when p_class_format = 'private' then 'private' else 'group' end) || '.' || v_verb;

    return has_permission(p_center_id, v_key) or is_platform_admin();
end;
$function$;

grant execute on function public.can_write_class(uuid, uuid, text, timestamptz, text) to authenticated;

-- ------------------------------------------------------------
-- INSERT: create_class_safe()와 동일한 판정
-- ------------------------------------------------------------
drop policy if exists "매니저 수업 생성" on classes;
create policy "매니저 수업 생성"
    on classes for insert
    with check (
        center_id in (select my_managed_center_ids())
        and can_write_class(null, center_id, class_format, start_time, 'create')
    );

-- ------------------------------------------------------------
-- UPDATE: update_class_safe()와 동일한 판정
-- ------------------------------------------------------------
drop policy if exists "매니저 수업 수정" on classes;
create policy "매니저 수업 수정"
    on classes for update
    using (
        center_id in (select my_managed_center_ids())
        and can_write_class(id, center_id, class_format, start_time, 'update')
    )
    with check (
        center_id in (select my_managed_center_ids())
        and can_write_class(id, center_id, class_format, start_time, 'update')
    );

-- ------------------------------------------------------------
-- DELETE: delete_class_safe()와 동일한 판정
-- ------------------------------------------------------------
drop policy if exists "매니저 수업 삭제" on classes;
create policy "매니저 수업 삭제"
    on classes for delete
    using (
        center_id in (select my_managed_center_ids())
        and can_write_class(id, center_id, class_format, start_time, 'delete')
    );

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies where tablename = 'classes' order by cmd;
