-- ============================================================
-- 해결: 대표 프로필이 없거나 중복된 계정 복구
--
-- diagnose_profile.sql 로 확인한 뒤 실행하세요.
-- 여러 번 실행해도 안전합니다.
-- ============================================================

-- 1) 프로필이 아예 없는 계정 → 계정 이름으로 대표 프로필 생성
insert into profiles (account_id, name, is_primary)
select a.id, coalesce(nullif(a.name, ''), '회원'), true
from accounts a
where not exists (select 1 from profiles p where p.account_id = a.id);

-- 2) 프로필은 있는데 대표가 하나도 없는 계정 → 가장 먼저 만든 것을 대표로
update profiles p
set is_primary = true
where p.id in (
    select distinct on (p2.account_id) p2.id
    from profiles p2
    where not exists (
        select 1 from profiles p3
        where p3.account_id = p2.account_id and p3.is_primary = true
    )
    order by p2.account_id, p2.created_at asc
);

-- 3) 대표가 2개 이상인 계정 → 가장 먼저 만든 것만 남기고 해제
update profiles p
set is_primary = false
where p.is_primary = true
  and p.id not in (
    select distinct on (p2.account_id) p2.id
    from profiles p2
    where p2.is_primary = true
    order by p2.account_id, p2.created_at asc
  );


-- ============================================================
-- 확인: primary_count 가 모두 1 이어야 정상
-- ============================================================
select
    a.name, a.phone,
    count(p.id)                             as profile_count,
    count(p.id) filter (where p.is_primary) as primary_count
from accounts a
left join profiles p on p.account_id = a.id
group by a.id, a.name, a.phone
order by primary_count asc;
