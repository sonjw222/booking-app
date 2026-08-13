-- ============================================================
-- READ-ONLY 진단 SQL — Supabase SQL Editor에 그대로 붙여넣고 실행
-- SELECT만 사용. DB를 전혀 변경하지 않음.
-- 목적: (1) Live에 이미 orphan center가 있는지 (2) role_id/center_id mismatch 기존
--       데이터가 있는지 (3) 적용 전/후 정책·트리거·함수 상태 확인
-- ============================================================

-- [1] centers 전체 개수 및 status별 분포
select status, count(*) from centers group by status order by status;

-- [2] manager_centers가 0건인 centers (= 이미 orphan 상태) — 반드시 확인
select c.id, c.name, c.status, c.created_at
from centers c
where not exists (select 1 from manager_centers mc where mc.center_id = c.id)
order by c.created_at;

-- [3] owner role을 가진 active manager가 0명인 center(= 관리는 있지만 오너가 없는 상태 —
--     orphan은 아니지만 owner-less 상태, 향후 SEC-113 심화 검토 대상)
select c.id, c.name
from centers c
where exists (select 1 from manager_centers mc where mc.center_id = c.id and mc.status = 'active')
  and not exists (
    select 1
    from manager_centers mc
    join center_roles cr on cr.id = mc.role_id
    where mc.center_id = c.id and mc.status = 'active' and cr.is_owner = true
  );

-- [4] manager_centers.role_id와 center_roles.center_id가 불일치하는 기존 데이터 —
--     0건이어야 정상(있으면 별도 cleanup plan 필요, 이 진단에서는 조회만)
select mc.id as manager_center_id, mc.account_id, mc.center_id as mc_center_id,
       cr.id as role_id, cr.center_id as role_center_id, cr.name as role_name
from manager_centers mc
join center_roles cr on cr.id = mc.role_id
where mc.role_id is not null and cr.center_id <> mc.center_id;

-- [5] manager_centers.role_id가 아예 존재하지 않는 center_roles를 가리키는 경우(고아 FK) —
--     스키마상 FK가 있다면 불가능해야 함, 확인용
select mc.id, mc.account_id, mc.center_id, mc.role_id
from manager_centers mc
where mc.role_id is not null
  and not exists (select 1 from center_roles cr where cr.id = mc.role_id);

-- ============================================================
-- 적용 전/후 비교용
-- ============================================================

-- [6] 적용 전: 정책 현재 정의
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'manager_centers'
order by policyname;

-- [7] 적용 후: 신규 trigger 존재 확인
select tgname, tgenabled, tgtype
from pg_trigger
where tgrelid = 'manager_centers'::regclass and not tgisinternal;

-- [8] 적용 후: has_permission() 최신 본문에 center_id join 조건이 반영됐는지
select pg_get_functiondef('has_permission(uuid, text)'::regprocedure);

-- [9] 적용 후: manager_centers 정책 재확인(4개 전부 최신 버전인지)
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'manager_centers'
order by policyname;

-- [10] 🚨 center_roles "내 센터 역할 조회" 정책 현재 정의 — qual에
--      "from manager_centers where account_id"(raw 서브쿼리, 버그 있는 버전)가 보이면
--      2026-08-13 발견된 RLS 무한 재귀 버그가 아직 남아있는 상태(스태프 초대 실패 가능).
--      "my_managed_center_ids"가 보이면 hotfix v1/[7]번 수정이 이미 적용된 것.
select policyname, cmd, qual
from pg_policies
where tablename = 'center_roles' and policyname = '내 센터 역할 조회';

-- [11] 🚨 has_permission()이 security definer인지 — security_type이 'DEFINER'가
--      아니면(=INVOKER) hotfix v2/[6]번 수정이 아직 적용되지 않은 것(재귀 버그 2번째
--      경로가 여전히 열려 있음).
select routine_name, security_type
from information_schema.routines
where routine_name = 'has_permission';

-- [12] 🚨 manager_centers 자기참조 제거용 helper 함수 3종이 존재하는지(hotfix v3/[0]번) —
--      0건이면 "매니저센터 생성"/"오너 스태프 삭제" 정책이 여전히 raw self-subquery를
--      쓰고 있을 가능성이 높음(재귀 버그 3번째 경로).
select proname, prosecdef
from pg_proc
where proname in ('manager_centers_has_any_row', 'role_id_belongs_to_center', 'role_id_is_owner_for_center');

-- [13] 🚨 centers 테이블 "승인된 센터 조회" 정책 현재 정의 — 다른 세션이 raw subquery
--      (manager_centers를 함수 없이 직접 참조하는 절)를 발견했다고 보고함. qual에
--      "from manager_centers where account_id"가 보이면 그 raw 절이 아직 남아있는 것
--      (4번째 순환 경로 후보). 이 정책은 이번 배치 파일들이 전혀 건드리지 않는 영역이라
--      여기서 상태만 확인.
select policyname, cmd, qual
from pg_policies
where tablename = 'centers' and policyname = '승인된 센터 조회';

-- [14] 🚨 manager_centers INSERT 정책(특히 "매니저센터 생성")에 centers 테이블을
--      참조하는 조건이 실제로 존재하는지 직접 확인 — 다른 세션이 발견했다는
--      "EXISTS(select 1 from centers c where c.id = manager_centers.center_id and
--      c.status = 'pending')" 조건의 실존 여부와 정확한 문구를 확인하기 위함(이 조건은
--      이 세션이 작성한 어떤 draft 파일에도 없음 — 출처 미상, [6]/[9]로도 보이지만
--      centers 키워드로 한 번 더 명시적으로 필터링).
select policyname, cmd, with_check
from pg_policies
where tablename = 'manager_centers' and with_check ilike '%centers%';
