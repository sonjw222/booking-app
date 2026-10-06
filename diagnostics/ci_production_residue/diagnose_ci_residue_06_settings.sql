-- READ ONLY / PRODUCTION SAFE DIAGNOSTIC / NO MUTATION
-- 2026-10-07 — CI(GitHub Actions) E2E/integration이 Production Supabase에서 실행됐을 가능성에 대한 재진단. SELECT만 포함한다(INSERT/UPDATE/DELETE/DDL 없음).
-- 사용법: Supabase SQL Editor에서 이 파일 전체를 "하나만" 실행하고 결과를 확인한 뒤 다음 번호 파일로 넘어간다. 결과가 0행이면 해당 범위에 잔여물이 없다.
-- 패턴은 tests/e2e, tests/integration 코드가 실제로 만드는 이름만 사용한다(추측 prefix 없음). 의도적 운영 데이터([QA]/[토스 심사용] 센터, 심사 계정)는 패턴에 넣지 않았다.
-- created_at 날짜별 집계(day)로 보여 주므로, 이전에 정리한 시점 이후 날짜에 나타난 행만 "새 잔여물"로 본다.
-- 06) 센터 설정 오염: 운영 센터(테스트 센터가 아닌 센터)의 설정이 테스트가 쓰는 값으로 남아 있는지 보기 위한 전체 요약. E2E는 공유 테스트 센터의 center_settings를 저장/복구한다.
-- (공유 테스트 센터 id는 GitHub Secrets의 TEST_CENTER_ID와 같은 센터이며, 이 값이 Production 운영 센터를 가리키면 그 센터의 설정이 바뀌었을 수 있다.)
select cs.center_id::text as center_id, c.name as center_name, c.status::text as status, cs.daily_book_limit_enabled, cs.daily_book_limit, cs.allow_same_day_booking, cs.updated_at::date as updated_day
  from public.center_settings cs
  join public.centers c on c.id = cs.center_id
 where cs.updated_at >= date '2026-09-01'
 order by cs.updated_at desc
 limit 100;
-- 기대: 최근 갱신된 설정이 테스트 센터(이름이 통합테스트센터-… 등)가 아니라 운영 센터라면 CI가 그 센터 설정을 만졌을 가능성이 있다 — 먼저 01번 결과의 센터 id와 대조한다.
