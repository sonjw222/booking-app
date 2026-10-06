-- READ ONLY / PRODUCTION SAFE DIAGNOSTIC / NO MUTATION
-- 2026-10-07 — CI(GitHub Actions) E2E/integration이 Production Supabase에서 실행됐을 가능성에 대한 재진단. SELECT만 포함한다(INSERT/UPDATE/DELETE/DDL 없음).
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 "하나만" 실행하고 결과를 확인한 뒤 다음 번호 파일로 넘어간다. 결과가 0행이면 해당 범위에 잔여물이 없다.
-- 패턴은 tests/e2e, tests/integration 코드가 실제로 만드는 이름만 사용한다(추측 prefix 없음). 의도적 운영 데이터([QA]/[토스 심사용] 센터, 심사 계정)는 패턴에 넣지 않았다.
-- created_at 날짜별 집계(day)로 보여 주므로, 이전에 정리한 시점 이후 날짜에 나타난 행만 "새 잔여물"로 본다.
-- 01) 센터/구독 플랜: 통합테스트가 만드는 센터와 전역 구독 플랜(기본 플랜 is_default를 테스트가 일시적으로 바꾼다 — 원복 여부 확인).
select 'center' as kind, c.id::text as id, c.name, c.status::text as status, c.created_at::date as day
  from public.centers c
 where c.name like '통합테스트센터-%' or c.name like 'CLASS-REV 격리센터-%' or c.name like 'SEC-114 격리센터-%' or c.name like 'QA 신고테스트센터-%'
    or c.name like 'P0-8 플랜제한 테스트센터-%' or c.name in ('SEC-D/K 부트스트랩 테스트센터', 'SEC-J 타센터 role 탈취용', 'SEC-N 공격시도', 'SEC-Q orphan(approved) 재현용', 'SEC-Q-2 pending 대조군', 'P3 타센터-격리테스트', 'P3 통합-타센터')
union all
select 'subscription_plan', p.id::text, p.name || ' | is_default=' || p.is_default::text || ' | active=' || p.is_active::text, p.monthly_price::text, p.created_at::date
  from public.subscription_plans p
 order by kind, day desc, name;
-- 기대: is_default=true인 플랜이 정확히 1개이고 그것이 의도한 기본 플랜이어야 한다. 'QA 테스트 제한 플랜-%' 행은 테스트 잔여물이다.
