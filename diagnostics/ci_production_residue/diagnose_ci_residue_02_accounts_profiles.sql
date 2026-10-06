-- READ ONLY / PRODUCTION SAFE DIAGNOSTIC / NO MUTATION
-- 2026-10-07 — CI(GitHub Actions) E2E/integration이 Production Supabase에서 실행됐을 가능성에 대한 재진단. SELECT만 포함한다(INSERT/UPDATE/DELETE/DDL 없음).
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 "하나만" 실행하고 결과를 확인한 뒤 다음 번호 파일로 넘어간다. 결과가 0행이면 해당 범위에 잔여물이 없다.
-- 패턴은 tests/e2e, tests/integration 코드가 실제로 만드는 이름만 사용한다(추측 prefix 없음). 의도적 운영 데이터([QA]/[토스 심사용] 센터, 심사 계정)는 패턴에 넣지 않았다.
-- created_at 날짜별 집계(day)로 보여 주므로, 이전에 정리한 시점 이후 날짜에 나타난 행만 "새 잔여물"로 본다.
-- 02) 계정/프로필: 통합/E2E 테스트가 만드는 throwaway auth 사용자(이메일 패턴)와 테스트 프로필. 공유 테스트 계정(TEST_USER_A 등) 자체는 존재해도 정상이다.
select 'auth_user' as kind, u.id::text as id, u.email as label, u.created_at::date as day
  from auth.users u
 where u.email like 'qa-secfix-%@example.com' or u.email like 'qa-report-%@example.com' or u.email like 'qa-delete-%@example.com'
    or u.email like 'qa-consent-%@example.com' or u.email like 'qa-avatar-%@example.com' or u.email like 'qa-fanout-operator-%@example.com'
union all
select 'profile', p.id::text, p.name || ' | primary=' || p.is_primary::text || ' | deleted=' || (p.deleted_at is not null)::text, p.created_at::date
  from public.profiles p
 where p.name in ('P3 출결-대기용', 'E2E 생애주기 회원', '통합테스트', '통합테스트계정')
 order by kind, day desc, label;
-- 기대: auth_user/프로필 행이 남아 있으면 해당 테스트가 중간에 종료돼 정리되지 않은 것이다(정상 실행은 afterAll에서 삭제).
