# 새 dev DB 재현성 공백 감사 (2026-10-07)

목표: 빈 Supabase 프로젝트에 앱이 쓰는 스키마를 재현할 수 있는가. 결론: **현재 저장소만으로는 신뢰할 수 있게 재현할 수 없다.** 이 문서는 공백만 기록하며, Production 라이브 정의를 읽기 전용으로 확인하기 전에는 통합(create or replace) migration을 만들지 않는다.

## 사실 (저장소 루트 `*.sql`)
- 총 439개: `add_*` 131, `fix_*` 129, `rollback_*` 128(대부분 대응 add/fix의 되돌리기), `draft/proposed` 이름 포함 107, 그 외 `schema.sql`·`seed_data.sql`·`reset_*.sql`·`cleanup_*_proposed.sql`.
- `supabase/` 에는 `config.toml`과 `functions/`만 있고 `supabase/migrations/`가 없다 → Supabase CLI 방식 `db reset`/`db push`로 재현 불가.
- `schema.sql`은 초기 스냅샷(table 57개)일 뿐 이후 변경이 `add_*`/`fix_*`에 흩어져 있다. **파일명 순서는 적용 순서가 아니다**(날짜/번호 규약 없음).

## 공백
1. 적용 순서 미정의: 의존(테이블→컬럼→함수→정책) 순서를 파일명으로 알 수 없다.
2. 함수 lineage 드리프트: 같은 함수를 여러 파일이 `create or replace`한다(예: `evaluate_notification_rules` 5개 파일). 오래된 파일을 재실행하면 더 새로운 리팩터를 되돌린다(과거 2회 실제 발생, 메모리 기록). 어느 파일이 최종본인지는 Production 라이브 정의만이 진실.
3. draft/proposed 파일(107개)은 적용 여부가 파일만으로 불명.
4. `rollback_*`를 실수로 포함하면 파괴적.
5. GRANT: 일부 테이블/함수의 service_role 등 GRANT 누락이 별도 `fix_*_draft_proposed.sql`로만 존재(예: accounts 관련). 2026-10-30 이후 새 테이블은 명시 GRANT 필수.
6. Auth/Storage 설정, 확장(extensions), cron, Realtime publication, Edge Function 배포는 SQL 밖 설정이라 저장소에 선언이 없다.
7. fixture(센터/상품/역할) 시드 스크립트가 Production 데이터와 무관하게 재현 가능한지 불명(`seed_data.sql`의 최신성 미검증).

## 권장 경로 (사람 + 읽기 전용 확인 필요)
1. Production에서 **읽기 전용**으로 `pg_dump --schema-only` 상당(Dashboard/CLI `db dump` 읽기)을 받아 단일 baseline을 만든다. 쓰기/적용은 dev 프로젝트에만.
2. baseline을 dev 프로젝트에 적용 → `npm run ci:dev:verify`와 PGlite SQL 테스트(`tests/sql`)로 검증.
3. 이후 변경만 `supabase/migrations/` 타임스탬프 파일로 전환(별도 승인된 구조 변경).

## 이번 브랜치가 하지 않는 것
통합 migration 생성, Production SQL 실행, 오래된 SQL 재실행.
