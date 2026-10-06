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

## 후보 비교
| 후보 | 방법 | 평가 |
|---|---|---|
| A. Production **스키마-only** 덤프 → dev 적용 | `supabase db dump --linked` (데이터 플래그 없음 = 스키마만) | **채택.** 실제 라이브 정의(함수 lineage 드리프트 포함)를 그대로 복제. 데이터는 가져오지 않음 |
| B. 저장소 파일에서 baseline 조립 | 439개 SQL 순서 추정 | **기각.** 순서 정보 없음, 오래된 fix 재실행이 최신 리팩터를 되돌린 전례 2회 |
| C. CLI 스키마 전송 | A와 같은 `db dump` + `db push`/`--db-url` | A의 실행 수단. 단 `db push`는 migrations 폴더가 없어 쓰지 않음 |

## 확정 bootstrap 절차 (dev 프로젝트 생성 후, 한 단계씩 — 각 단계는 사용자 승인 후 실행)
**주의**: 이 저장소 워크트리의 Supabase CLI는 **Production에 link되어 있다**(`--linked`는 항상 Production). dev에는 `--linked`를 쓰지 말고 `--db-url`(dev 연결 문자열)만 쓴다. 실행 전에 연결 문자열에 dev ref가 있고 Production ref(`bxntqggkfwnhcczsbqtj`)가 없는지 확인한다. 재link 금지.
0. (사람) Docker Desktop 설치 — `supabase db dump`는 pg_dump를 컨테이너로 실행한다. 이 Mac에는 현재 Docker/psql/pg_dump가 **없다**. (대안: Docker 없이 `supabase db query --linked`의 읽기 전용 카탈로그 SELECT로 DDL을 재구성 — 더 길고 오차 위험, 비권장)
1. **[Production READ-ONLY, 사용자 승인 필요]** 먼저 `supabase db dump --linked --schema public --dry-run`(실행 스크립트만 출력)으로 내용 확인 → 승인 시 `supabase db dump --linked --schema public -f .tmp/prod_schema_public.sql`. `--data-only`를 절대 쓰지 않는다. 파일은 `.tmp/`(gitignored)에만 저장, 커밋 금지.
2. 덤프 검사(로컬): `INSERT INTO`/`COPY ... FROM stdin` 행 데이터가 없는지, 비밀/이메일이 없는지 grep. 있으면 중단.
3. **[Production READ-ONLY 추가 조회, 승인 필요]** public 밖 의존성 확인: `auth.users`에 걸린 트리거(예: 가입 시 accounts 생성), `storage.buckets`/`storage.objects` 정책, 필요한 extensions, publication(realtime). 결과를 덤프 보완 SQL로 정리(데이터 아님).
4. dev 프로젝트에 **dev 연결 문자열로만** 적용(`supabase db query --db-url <dev> -f ...` 또는 Dashboard SQL Editor). Production에는 쓰기 없음.
5. `npm run ci:dev:verify -- --schema`로 테이블/컬럼/RPC 확인(MISSING 0이 될 때까지). RLS/GRANT는 SQL로 별도 확인(`pg_class.relrowsecurity`, `information_schema.role_table_grants` 읽기).
6. `npm run ci:dev:bootstrap` → fixture 생성 + 전체 검증.
7. Secrets 교체 후 PR #170 CI 확인.

## 이번 브랜치가 하지 않는 것
통합 migration 생성, Production SQL/덤프 실행, 오래된 SQL 재실행, dev 프로젝트 생성.
