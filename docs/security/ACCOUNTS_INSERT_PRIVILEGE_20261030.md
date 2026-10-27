# accounts INSERT 시점 특권 컬럼 우회 — 취약점·수정·검증 (2026-10-30)

## 1. 취약점
- **원인**: `accounts` 의 "본인 계정 생성" RLS 정책은 `auth_id = auth.uid()`(+ 전화번호가 있으면 최근 휴대폰 인증)만 확인하고 컬럼 값을 보지 않는다. authenticated 에는 전체 컬럼 INSERT 권한이 있다. 특권 컬럼을 지키는 트리거 3개(`trg_accounts_is_platform_admin_admin_only`, `trg_accounts_pg_checkout_override_admin_only`, `trg_accounts_merged_into_via_linking_only`)는 모두 **BEFORE UPDATE 전용**이다.
- **영향**: 계정 행이 아직 없는 인증 사용자(= 신규 가입자, 또는 자기 계정 삭제 후 재생성)가 가입 INSERT 에 특권 값을 끼워 넣을 수 있었다.
  - `is_platform_admin=true` → `is_platform_admin()` 이 true (**플랫폼 관리자 권한**)
  - `pg_checkout_override=true` → 토스 심사용 결제 우회 권한
  - `merged_into=<다른 계정 id>` → `my_account_id()` 가 다른 계정 id 를 반환(**그 계정의 데이터 접근 = 계정 사칭**)
- **재현(로컬 일회용 Supabase, 실제 Auth + PostgREST)**: 수정 전 검증 47개 중 23개 실패(`docs/security/evidence/phase0-before-fix.log`). 브라우저 가입 화면을 그대로 진행하면서 앱이 보내는 INSERT 본문에 특권 컬럼을 끼워 넣으면 계정이 특권 값으로 생성됨(`browser-run-without-insert-guard.txt`).
- **운영**: 같은 구성임을 읽기 전용으로 확인했다(INSERT 트리거 없음, 같은 정책, authenticated 전체 컬럼 INSERT 가능). 운영에서 악용은 시험하지 않았다.
- **용어 정정**: `trg_accounts_phone_verified` 는 관리자 권한과 무관하다. `accounts.phone` 에 새 값이 들어올 때 "최근 15분 내 휴대폰 인증"을 요구하는 **UPDATE 전용 전화번호 인증 트리거**(`enforce_phone_verified_before_change`)이며, `phone_verified` 라는 컬럼은 없다. INSERT 시점의 전화번호 인증은 RLS 정책의 `phone IS NULL OR _is_phone_recently_verified(phone)` 조건이 담당한다. 전화번호 인증 보호와 관리자 권한 보호는 서로 다른 보호다(앞선 보고서의 "기존 보호 트리거 4개가 모두 UPDATE 전용" 표현은 관리자 권한 3개에 대해서만 맞고, 전화번호 인증은 INSERT 가 RLS 로 보호된다).

## 2. 수정
`fix_accounts_insert_privileged_columns_20261030.sql` — BEFORE INSERT 행 트리거 1개(`trg_accounts_insert_privileged_columns`) + 함수 1개(`enforce_accounts_insert_privileged_columns`, SECURITY DEFINER, search_path=public).
- 인증 사용자(`auth.uid()` 있음)만 검사: `is_platform_admin`/`pg_checkout_override` 가 true 이면 플랫폼 관리자가 아닌 한 거부, `merged_into` 가 null 이 아니면 `app.allow_merged_into_change=true`(link_accounts_by_code 가 트랜잭션 로컬로 설정)가 아닌 한 거부 — 기존 UPDATE 가드와 같은 문구·기준.
- 서버(service_role)·SQL Editor(`auth.uid() is null`)는 통과. 정상 가입(앱 가입 화면은 이 컬럼을 보내지 않아 기본값)은 통과.
- upsert(INSERT … ON CONFLICT DO UPDATE)는 INSERT·UPDATE 트리거를 모두 거치고, 삭제 후 재생성도 INSERT 이므로 같은 기준이 적용된다.
- 기존 행·기존 트리거·정책·권한은 바꾸지 않는다. **이미 만들어진 비정상 권한·계정 연결은 복구하지 않는다**(§5 점검).
- 롤백 `rollback_fix_accounts_insert_privileged_columns_20261030.sql`(롤백하면 취약점이 다시 열린다 — 오류가 나도 무조건 실행하지 말고 영향을 판단). 검증(읽기 전용) `verify_fix_accounts_insert_privileged_columns_20261030.sql`.

## 3. 검증(일회용 로컬 Supabase, NICEPAY SQL 없는 main 기준선)
| 검증 | 결과 |
|---|---|
| PGlite 트리거 회귀 `tests/unit/accountsInsertPrivilegedColumns.sql.test.ts`(CI Unit 에서 실행) | 12개 통과. 보호를 변조한 SQL 6종(플래그 검사 제거·merged_into 검사 제거·트리거 제거·UPDATE 로만 걸기·override 검사 누락·서버 차단)으로 실행하면 각각 1~8개 실패 |
| 실제 인증·REST `scripts/security/accountsInsertGuard.verify.mjs`(단언, 실패 시 종료 코드 1) | 수정 전 **23개 실패(종료 코드 1)** → 적용 후 **47/47 통과(종료 코드 0)** |
| 회귀 하니스 `scripts/security/accountsInsertGuard.regression.sh` | 적용 전 실패 → 적용 통과 → 재적용(멱등) 통과 → **보호 제거·UPDATE 로만·빈 함수 3종 변조에서 검증이 다시 실패** → 복구 통과 → 적용 도중 실패 주입 시 전체 롤백. 모든 기대 충족(`regression-run.txt`) |
| 브라우저 `scripts/security/accountsInsertGuard.browser.mjs` | 실제 가입 화면(이메일 → 이름·휴대폰 OTP 인증 → 약관 동의)이 수정 후에도 정상 완료(계정·휴대폰 저장, 특권 값 기본값, UI 가 보낸 INSERT 본문에 특권 컬럼 없음). 앱이 보내는 가입 INSERT 본문을 변조해 특권 컬럼 3종을 주입하면 **수정 후 3종 모두 계정 미생성**, 보호를 제거하면 3종 모두 특권 계정이 만들어져 **종료 코드 1** |
검증 항목: 직접 INSERT·신규 upsert·삭제 후 재생성·기존 행 UPDATE/upsert 거부, 정상 가입·false 명시 가입·기존 계정 일반 갱신·upsert 일반 갱신 통과, **정상 계정 연동(`create_account_link_code` → `link_accounts_by_code`)** 통과, 서버(service_role)·SQL Editor 경로의 특권 값 생성 통과, 시도 후 `is_platform_admin()`=false·`my_account_id()`≠피해자 계정.

## 4. 한계
- 플랫폼 관리자의 INSERT 분기(관리자 계정이 특권 값으로 계정을 만드는 경로)는 PGlite 단위 시험에서만 확인(실제 Auth 로는 RLS 가 본인 auth_id 만 허용해 시험 불가).
- 실기기·운영 화면의 가입 흐름은 시험하지 않았다(운영에서 악용 재현 금지).
- 운영 편집기/도구가 SQL 을 한 트랜잭션으로 실행하는지는 파일의 BEGIN…COMMIT 와 실패 주입 시험(로컬)으로 확인했다.

## 5. 기존 특권·계정 연결 상태 점검(운영, 읽기 전용 — 2026-10-30)
이 SQL 은 이미 만들어진 비정상 값을 복구하지 않으므로 SELECT 로만 점검했다(수정·삭제·권한 회수 없음).
- `is_platform_admin=true` 계정 **1개**: 오너 계정(2026-07-16 생성, 이메일 로그인, 활성 매니저 소속 1, 최근 로그인 2026-10-17) — 가입 시점·이력이 정상으로 보인다.
- `pg_checkout_override=true` 계정 **1개**: "토스 심사 계정"(2026-10-06 생성, 회원, 회사 도메인) — 기록된 토스 심사 계정과 일치.
- `merged_into` 가 있는 계정 **0개**, `account_auth_identities` 0행, `account_link_requests` 0행 — 계정 사칭·연결 흔적 없음.
- 최근 30일 신규 계정 20개 중 특권 값이 있는 계정은 위 토스 심사 계정 1개(정상).
- auth 사용자가 없는 계정 3개: 탈퇴 표시 1(`탈퇴한 회원`)·QA 시험 계정 2 — 모두 특권 값 없음(정리 여부는 별도 판단).
**의심 항목: 없음.** 다만 이 점검은 현재 상태 스냅샷이다(과거에 올렸다가 되돌린 값은 알 수 없음).
