# 생애주기 감사 — 추가 SQL 인계 (Codex 검토·적용용)

- 기준 브랜치 `fix/lifecycle-audit-fixes-20261022`. 아래 SQL은 **전부 미적용**이다. 직접 적용하지 않았고 push·PR·배포도 없다.
- 이미 운영 적용된 4개 파일(`add_my_member_coupons_rpc_20261022.sql`, `fix_center_limit_settings_normalize_20261022.sql`, `fix_write_review_unified_ledger_20261022.sql`, `fix_period_revenue_remainder_20261022.sql`)은 수정하지 않았다. sha256이 `apply-manifest.json`과 일치한다. 아래는 모두 **별도 후속 SQL**이다.
- 모든 SQL은 `pg_get_functiondef`를 읽어 정확히 한 군데씩 치환하거나(0건/2건 이상이면 중단) 새 함수를 추가한다. 운영 정의가 저장소와 달라도 통째로 덮어쓰지 않는다. 마커가 있으면 재실행은 변화 없음.
- 검증은 격리 DB(`npm run test:rls-real:fresh`: Docker PostgreSQL 16 + PostgREST, 실제 JWT)에서 적용 → 재적용 → 롤백 → 재적용까지 실행했다. 운영 정의와의 차이 감지는 적용 직전 Codex가 `verify_*` 와 정의 백업으로 확인해야 한다.

## 적용 순서(서로 독립적이라 어느 순서든 가능하지만 권장 순서)
| 순서 | 파일(+ rollback_/verify_ 접두 파일) | 대상 | 앱과의 호환 | 격리 증거(`tests/rls-real/…`) |
|---|---|---|---|---|
| 1 | `fix_center_reviews_write_hardening_20261023.sql` | `center_reviews` 직접 INSERT/UPDATE 권한, `reply_review` search_path·EXECUTE | 앱은 definer RPC만 쓰므로 구/신 앱 모두 영향 없음. **적용 전 확인**: 다른 클라이언트(스크립트·대시보드)가 `authenticated`로 직접 UPDATE하지 않는지 | `reviewsHardening.rls.test.ts` 8건 |
| 2 | `fix_collect_unpaid_overcollect_20261023.sql` | `collect_unpaid_payment` (+ anon/public 실행 권한 회수) | 시그니처·반환값 불변 → 구 앱 호환. 새 앱의 화면 검사는 서버가 최종 판정 | `unpaid.rls.test.ts` 12건 |
| 3 | `fix_member_dormant_restore_idempotent_20261023.sql` | `extend_passes_after_dormant`(휴면 회차 소비) + 새 `set_center_member_status` | **SQL 선행 적용 가능**: 구 앱(extend RPC → center_members UPDATE)에서 연장 1회·UPDATE 정상. 새 앱은 새 RPC를 쓰고 함수가 없으면 예전 두 단계로 폴백 → 어느 순서로 배포해도 깨지지 않음(중복 방지는 SQL 적용 후부터) | `dormant.rls.test.ts` 9건 |
| 4 | `fix_waitlist_promotion_null_expiry_20261023.sql` | `cancel_reservation` 승격 루프 조건 | 앱 변경 없음 | `lifecycle.rls.test.ts`(F21 재현→수정) |
| 5 | `fix_reservation_limit_race_20261023.sql` | `reserve_class`, `reserve_with_membership` (advisory lock) | 앱 변경 없음. 한도가 꺼져 있으면 잠금 없음 | `reservationRace.rls.test.ts` 9건 |
| 6 | `fix_autocancel_duplicate_notification_20261023.sql` | `trg_notify_reservation_update`, `run_autocancel_sweep` | 앱 변경 없음. 알림 종류·본문 불변, 회원 중복만 제거 | `autocancel.rls.test.ts` 8건 |

폐기/미적용 유지: `harden_center_reviews_update_columns_20261022.sql`(1번으로 대체 — **적용 금지**), `proposed_migrate_legacy_review_points_20261022.sql`(정책·데이터 승인 전 실행 금지).

## 파일별 상세

### 1. `fix_center_reviews_write_hardening_20261023.sql`
- 결함: 정책 "센터후기 본인 수정"에 `WITH CHECK`·컬럼 제한이 없어 작성자가 자기 후기의 `reply/replied_at/hidden/center_id/profile_id`를 PATCH로 바꿀 수 있었고(격리 재현), 센터 직원은 정책 "센터후기 매니저 답변"으로 회원의 `rating/content`까지 직접 고칠 수 있었다. INSERT도 컬럼 제한이 없어 `reply/hidden`을 채워 작성 가능.
- 변경: `authenticated/anon/public`의 UPDATE 전부 회수(테이블+컬럼), INSERT는 `center_id,profile_id,rating,content,photos` 5컬럼만 허용, `reply_review`는 본문 유지 + `search_path=public` + `anon/public` EXECUTE 회수. SELECT/DELETE/RLS 정책은 그대로.
- 정책 영향: 답변 권한 모델 불변(센터 활성 직원 전원). 전용 권한 키 도입은 별도 결정.
- 롤백: 기본 권한(authenticated/anon INSERT·UPDATE) 복원 — 적용 직전 실제 ACL 백업이 우선.
- 검증: 수정 전 위조 가능 재현 → 후 작성자·직원·오너·타 센터 오너·타 회원·익명의 직접 PATCH 전부 거절·행 불변, 직접 INSERT에서 reply/hidden 거절, 정상 경로(write_review / update_my_review(답글·id 보존) / reply_review) 유지, 무권한 reply 거절, 권한 상태 쿼리.

### 2. `fix_collect_unpaid_overcollect_20261023.sql`
- 결함: 수금 합이 현재 미수 잔액을 넘어도 통과(QA: 원미수 1000 → 300 회수 후 701 수금, 합 1001).
- 변경: 이미 있는 `for update` 뒤에서 (a) 회수/환불 행 거절 (b) 네 금액 NULL→0, 음수·소수 거절(`int` 컬럼의 조용한 반올림 방지) (c) 합계 0 이하 거절(기존 문구) (d) 합계 > 잔액 거절. 실패 시 insert/update 전에 종료 → 행 불변.
- 정책 영향: 별도 멱등 키 없음 — 같은 금액의 합법 부분 회수 두 번은 막지 않는다(잔액 상한이 중복을 막음). 과거 초과 회수 데이터는 SQL로 확정 불가(원 미수금이 남지 않음) → `verify_`는 수동 대조용 목록만 출력.
- 롤백: 2026-10-22 운영 감사 로그의 정의로 복원(ACL은 건드리지 않음).

### 3. `fix_member_dormant_restore_idempotent_20261023.sql`
- 결함: 복구가 클라이언트 두 단계라 같은 휴면 회차 요청이 모두 연장(3일 → 6일).
- 변경: (A) 기존 RPC가 연장과 같은 트랜잭션에서 `dormant_since`를 비움(연장 0일이어도 회차 소비) — 시그니처 불변. (B) 새 RPC `set_center_member_status(uuid,text)`: 상태 변경·연장·회차 소비 원자 처리, 이미 휴면이면 시작 시각 유지, 잘못된 상태 거절.
- 정책 영향: 연장 계산식·대상(같은 센터·프로필의 `status='active'` 이고 `expires_at` 있는 수강권)은 그대로. 이미 휴면인 회원에게 다시 "휴면"을 요청해도 시작 시각을 덮어쓰지 않음(예전엔 경과 일수를 잃었음).
- 롤백: 새 RPC 삭제 + 저장소 정의로 복원(운영 백업 우선).

### 4. `fix_waitlist_promotion_null_expiry_20261023.sql`
- 결함: 승격 루프가 `expires_at >= current_date`만 봐서 기간 무제한(NULL) 수강권 대기자를 건너뜀(예약·목록 함수는 NULL 허용). **운영 `cancel_reservation`에 같은 조건이 있는지 적용 전 확인 필요**(저장소 최종 정의 기준 결함).
- 변경: 그 한 조건만 `(expires_at is null or expires_at >= current_date)`. 이미 가드가 있으면 아무것도 안 함.
- 비고: `current_date`(DB 시간대)와 예약 함수의 KST 날짜 차이는 범위 밖.

### 5. `fix_reservation_limit_race_20261023.sql`
- 결함: 일일·프라이빗 동시 한도가 "세고 insert"라 동시 요청이 한도를 넘음(격리 재현: 프라이빗 1건 한도에 서로 다른 계정 동시 예약 → 2건 확정, 일일 1회 한도에 같은 프로필·다른 수강권 → 2건).
- 변경: 한도 확인 직전 트랜잭션 advisory lock — 일일 키 (프로필, KST 날짜), 프라이빗 키 센터. 판정식·메시지 불변. 잠금 순서 일일 → 프라이빗 → 수강권 행 잠금(교착 없음).
- 영향: 한도가 켜진 센터에서 같은 키의 동시 요청만 순서대로 처리.

### 6. `fix_autocancel_duplicate_notification_20261023.sql`
- 원인: 스윕이 `admin_cancelled`를 직접 보내고, 같은 UPDATE의 알림 트리거가 `reservation_canceled`를 다시 만든다.
- 변경: 스윕이 트랜잭션 로컬 플래그 `app.system_class_cancel='on'`을 켜고 트리거가 그동안 **회원에게 가는** `reservation_canceled`만 건너뜀. 직원 알림·일반 취소 알림 불변.
- 주의: 운영 cron·스윕·외부 푸시는 실행/변경하지 않았다. 운영 중복 수신을 확인한 것이 아니라 격리 재현이다.

## 해시 (이 문서 작성 시점의 작업 트리)
- `84926ee061e3ec39…` fix_center_reviews_write_hardening_20261023.sql
- `1124b41985f19f0b…` rollback_fix_center_reviews_write_hardening_20261023.sql
- `2866cc7acd81fdb3…` verify_fix_center_reviews_write_hardening_20261023.sql
- `71cb510a356d8483…` fix_collect_unpaid_overcollect_20261023.sql
- `293fc242aab73b35…` rollback_fix_collect_unpaid_overcollect_20261023.sql
- `ceea50a5f0137d0e…` verify_fix_collect_unpaid_overcollect_20261023.sql
- `2a53bbd3476e38fc…` fix_member_dormant_restore_idempotent_20261023.sql
- `6fbd0fdfda0885e2…` rollback_fix_member_dormant_restore_idempotent_20261023.sql
- `21a3acf52a13b7b6…` verify_fix_member_dormant_restore_idempotent_20261023.sql
- `688889e876d49f72…` fix_waitlist_promotion_null_expiry_20261023.sql
- `9edc28a46c36ed83…` rollback_fix_waitlist_promotion_null_expiry_20261023.sql
- `0752359c5ca2dec7…` verify_fix_waitlist_promotion_null_expiry_20261023.sql
- `cb8d91ff4a35274e…` fix_reservation_limit_race_20261023.sql
- `7a122c15f3b86053…` rollback_fix_reservation_limit_race_20261023.sql
- `f83a4073f9a7b190…` verify_fix_reservation_limit_race_20261023.sql
- `92951ce158e970e2…` fix_autocancel_duplicate_notification_20261023.sql
- `4cf23234bd30d478…` rollback_fix_autocancel_duplicate_notification_20261023.sql
- `fcb528acc4f487c8…` verify_fix_autocancel_duplicate_notification_20261023.sql
(전체 sha256은 `shasum -a 256 <파일>`로 확인. 위 접두 16자리만 기록)
