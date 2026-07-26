-- ============================================================
-- 진단: 로그인은 되는데 "프로필을 찾을 수 없어요" 가 뜰 때
--
-- Supabase SQL Editor 에서 실행하세요.
-- (SQL Editor 는 관리자 권한이라 RLS 무시하고 실제 데이터를 봅니다)
-- ============================================================

-- 1) 내 계정이 있는지 (전화번호를 본인 것으로 바꿔서 확인)
select id, auth_id, name, phone
from accounts
order by created_at desc
limit 20;

-- 2) 각 계정에 대표 프로필(is_primary=true)이 있는지
--    primary_count 가 0 이면 → 그 계정이 로그인 시 오류 납니다
--    primary_count 가 2 이상이면 → .single() 이 실패해 오류 납니다
select
    a.id            as account_id,
    a.name          as account_name,
    a.phone,
    count(p.id)                                          as profile_count,
    count(p.id) filter (where p.is_primary)              as primary_count
from accounts a
left join profiles p on p.account_id = a.id
group by a.id, a.name, a.phone
order by primary_count asc, a.created_at desc;

-- 3) 대표 프로필이 없는 계정 목록 (문제 대상)
select a.id, a.name, a.phone
from accounts a
where not exists (
    select 1 from profiles p
    where p.account_id = a.id and p.is_primary = true
);
