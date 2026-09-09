-- ============================================================
-- fetch_member_phones_safe() 센터 범위 검증 누락 수정
--
-- 문제: add_customer_member_phone_masking.sql의 fetch_member_phones_safe()가
-- p_center_id에 대한 has_permission()만 확인하고, p_profile_ids가 실제로 그
-- 센터 소속인지는 전혀 검증하지 않았다. 그 결과 센터 A에서 customer.member.phone
-- 권한을 정상적으로 가진 스태프가 p_center_id=A(자기 권한 있는 센터)를 그대로 두고
-- p_profile_ids만 센터 B(전혀 무관한 다른 센터) 회원들의 profile_id로 바꿔 넘기면,
-- v_can이 true로 평가되어 센터 B 회원들의 전화번호까지 그대로 새어나갔다
-- (profile_id를 어떻게든 알아내거나 추측만 하면 됨 — center_members로 소속 검증이
-- 전혀 없었기 때문).
--
-- 수정: p_profile_ids를 center_members로 p_center_id 소속인 것만 필터링하도록
-- WHERE에 exists 조건을 추가한다. 소속이 아닌 profile_id는 이제 결과 행 자체가
-- 안 나온다(phone만 null이 아니라 행 전체가 빠짐 — 더 안전).
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function fetch_member_phones_safe(p_profile_ids uuid[], p_center_id uuid)
returns table(profile_id uuid, account_phone text, profile_phone text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_can boolean;
begin
    v_can := has_permission(p_center_id, 'customer.member.phone') or is_platform_admin();

    return query
        select p.id,
               case when v_can then a.phone else null end,
               case when v_can then p.phone else null end
        from profiles p
        left join accounts a on a.id = p.account_id
        where p.id = any(p_profile_ids)
          and exists (
              select 1 from center_members cm
              where cm.center_id = p_center_id and cm.profile_id = p.id
          );
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select proname, pg_get_functiondef(oid) like '%center_members%' as has_center_scope_check
from pg_proc where proname = 'fetch_member_phones_safe';
