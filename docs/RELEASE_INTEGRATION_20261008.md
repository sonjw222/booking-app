# 출시 전 통합 branch — 릴리스 매니페스트 (2026-10-08)

branch `integration/pre-android-release-20261008` (base: origin/main `0be4808`). **PR/main 병합 전 상태.**
Production 적용 상태는 사용자가 직접 알려준 값이 source of truth이며, 이 문서는 코드를 근거로 추측해 "적용됨"으로 바꾸지 않는다.

## 1. 통합된 branch (merge --no-ff, 이 순서)
| # | branch | 내용 |
|---|---|---|
| 1 | `chore/ci-dev-supabase-bootstrap-20261007` | CI/dev Supabase bootstrap, E2E 안정화, **PR #170 production guard 포함**(51fcfbc는 이 branch의 조상) |
| 2 | `fix/security-db-boundaries-20261008` | center INSERT guard(정본 aa87042과 byte-identical), `ensure_center_member`/알림 배치 함수 EXECUTE 회수, storage MIME/size |
| 3 | `fix/security-api-auth-boundaries-20261008` | billing confirm 인증/오너, login next 검증, OTP 발송 제한(fail-closed), allowBackup=false |
| 4 | `fix/postlaunch-operational-reliability-20261008` | 오류 기록 기반, FCM 성공만 완료 처리, 알림톡 선점/재시도 |
| 5 | `fix/manager-class-pass-guidance-20261008` | 수업 직접 지정 수강권 안내 문구 정정 |
| 6 | `fix/android-play-quality-20261008` | Android R8(minify+shrink) |
| 7 | `fix/android-systembars-migration-20261008` | SystemBars 1차(R8 위 stacked) |
| 8 | `fix/safe-repo-followups-20261007` | 클라이언트 KST "오늘" 계산 |
| 9 | `fix/manager-workflow-safe-refresh-20261007` | 매니저 설정 미저장 변경 가드 |
| 10 | `fix/web-mode-switch-label-refresh-20261006` (PR #167) | compact web 모드 전환 라벨 |

### 건너뛴 branch
- `fix/security-center-insert-guard-20261008` (aa87042): 5개 파일 전부 #2에 byte-identical 포함 → 중복 병합 금지.
- `fix/ci-e2e-checkpoints-production-guard-20261007` (#170): #1의 조상 → 이미 포함.
- `fix/manager-center-persistence-20261007`(31파일), `fix/postlaunch-maintenance-refresh-20261007`(67파일): 출시 전 안정화 범위를 벗어난 UI/매니저 동작 변경이고 서로 겹침(`app/manager/*`). 별도 릴리스에서 검토.
- `docs/stale-todo-refresh-20261007`: 병합 계획 문서가 구 순서 기준이라 오래됨. 일부 문서는 추후 선별 반영.

## 2. SQL migration 분류
### A. ALREADY APPLIED TO PRODUCTION — 재실행 금지
- `fix_center_insert_guard_20261008.sql` (정본 aa87042)
- `fix_ensure_center_member_privileges_20261008.sql`
- `fix_notification_batch_function_privileges_20261008.sql` (evaluate_notification_rules / notify_expiring_passes / notify_upcoming_reservations)
- `fix_storage_bucket_mime_limits_20261008.sql`
- `add_phone_otp_send_limits_20261008.sql`
- Edge Function `send-phone-otp` (ec8c357 기준) — 이미 배포·smoke 완료, **재배포 금지**

### B. NOT APPLIED — 사용자 검토 후 별도 실행
- `fix_alimtalk_dispatch_claim_20261008.sql` (+rollback/verify): `service_role`에 `messages` SELECT/UPDATE(status, sent_at, claimed_at) 부여. 적용 전 verify 3번(`has_table_privilege`)으로 현재 권한 확인. 추가로 `messages.claimed_at`, `notification_logs.message_id`/`error` 컬럼과 부분 인덱스 2개를 만든다(모두 additive·nullable). **`send-alimtalk`만 이 SQL에 의존**한다 — SQL 적용 후에 배포(먼저 배포하면 `claimed_at` 갱신이 실패해 큐 발송이 매분 실패). `send-web-push`는 SQL 의존이 없는 코드-only 배포(순서 무관). 두 함수는 어떤 workflow로도 자동 배포되지 않으며 수동 배포다.

### C. DEFERRED / DO NOT APPLY YET
- `fix_storage_bucket_size_limits_20261008.sql`: 제안값(avatars 10MB / alimtalk-images 10MB / business-licenses 20MB)일 뿐 적용 대상 아님. Production 실측: business-licenses 1개(max 3.53MB), 나머지 버킷 객체 없음.

### D. NO SQL
- 위 5~10번 branch 전부(코드/문서/네이티브만).

## 2-1. main 병합 직후 동작 (감사 결과)
- 앱/CI/Vercel 어디에도 migration을 자동 실행하는 코드가 없다(적용 완료 SQL 재실행 불가, size-limit SQL도 자동 실행 없음).
- Edge Function은 자동 배포되지 않는다. pg_cron은 현재 배포된 함수를 호출하므로 수동 배포 전까지 기존 코드로 동작한다.
- 서버 환경에 `NEXT_PUBLIC_SUPABASE_ANON_KEY`가 필요하다(billing confirm이 호출자 JWT로 기존 `is_center_owner` RPC를 호출; 없으면 500). Production에 이미 있는 함수에 의존한다.

## 3. 테스트 대상 DB
통합/E2E는 CI/dev 프로젝트(`jdglfvwdnkjnraqdxuuj`)만 사용. DEV에는 20261008 migration이 적용돼 있지 않으므로 해당 SQL은 PGlite 테스트(`tests/sql/*.mjs`)로 검증한다.

## 4. 검토에서 나온 후속(blocker 아님, docs/TODO.md 반영)
- 알림톡: 로그 기록 전 크래시/Aligo timeout 시 재발송 가능(at-least-once), 긴 수신자 목록이 10분 임대를 넘길 수 있음, 영구 실패 수신자 재시도 로그 누적.
- FCM: 웹푸시 성공 시 네이티브 일시 실패는 재시도되지 않음, `INVALID_ARGUMENT`로 토큰 삭제, `pushed_at` 기록 실패 시 재발송 가능, 푸시 선점 비원자.
- center guard `search_path = public` → `public, pg_temp` 고려. OTP 클라이언트 IP 헤더 신뢰 범위.
- Android: R8 release 서명 빌드 실기기 확인(Google/Kakao/Naver 로그인, FCM, CalendarEventPlugin, AppSettingsPlugin), cold start 상태바 아이콘 색, 병합 manifest의 allowBackup 확인.
- Play deprecated API 경고 제거 여부는 **UNKNOWN**(SystemBars 2차 plugin 제외 + 새 AAB 필요).
- CI: preflight는 deny-list(Production ref만 차단). `mobile-ui-qa.yml`의 secret 직접 interpolation을 `env:`로.
