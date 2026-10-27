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

## 6. 운영 적용 기록 (PR #245)
자격증명·개인정보는 기록하지 않는다. 시각은 UTC 이며(KST = +9h), 아래 "실행 기록"은 이 작업을 수행한 세션의 도구 호출 기록에서 확인한 값이다.
| 항목 | 값 |
|---|---|
| PR / HEAD | #245 / `b046c327690043f050f2493adc016de400a23e79`(필수 CI 전부 통과 — E2E 3/4 는 러너에서 DB 컨테이너가 뜨지 않은 인프라 실패 후 같은 HEAD 의 해당 job 재실행으로 통과) |
| 병합 SHA | `4009495e56540df0d19f4dc289b54407b6a06119`(squash, 병합 2026-10-27 16:22:36Z) |
| Production 배포 | `7364089428` — SHA 가 병합 SHA 와 일치, 상태 success(2026-10-27 16:23:35Z) |
| main CI | run `40540296619`(push) — 병합 SHA 기준 success(16:22:38Z ~ 16:27:07Z; live job 은 push 에서 건너뛰는 설계) |
| **적용 SQL** | `fix_accounts_insert_privileged_columns_20261030.sql` SHA-256 `b8c77b4bbe669690e29d88f27cbd487d9b8dd975f63b5cc6995bae3929f619af`(PR HEAD 의 파일과 동일함을 적용 직전에 대조) |
| 적용 방법 | 운영 프로젝트에 Supabase CLI(`db query --linked -f`)로 파일 전체를 **한 번의 요청(BEGIN…COMMIT)** 으로 실행. 오류 없음. 롤백 SQL 은 실행하지 않았다 |
| **실제 적용 시각** | 실행 기록상 호출 **2026-10-27 16:21:35Z**, 응답 **16:21:45Z**(KST 2026-10-28 01:21). DB 에는 트리거 생성 시각이 남지 않아 DB 로는 확인할 수 없고, 마이그레이션 이력 테이블에도 기록하지 않았다(직접 SQL 실행). 병합(16:22:36Z) **약 1분 전**에 적용됐다 |
적용 직전 확인(읽기 전용): 대상 DB(`postgres`, PostgreSQL 17.6)·`accounts` 22행 지문 기록, `accounts` 트리거 4개(새 트리거·함수 없음), 기존 함수 6개 해시 — 4개는 격리 기준선과 동일, `enforce_pg_checkout_override_admin_only`·`my_account_id` 2개는 운영에 CR(줄바꿈) 문자가 있어 `md5(prosrc)` 가 달랐으나 CR 제거 후 해시와 본문이 기준선과 동일(기능 차이 아님).
적용 후 검증(읽기 전용):
- `verify_fix_accounts_insert_privileged_columns_20261030.sql`: `insert_trigger_enabled_before_row_insert=true`, `function_secdef_pinned_trigger=true`, `existing_update_guards_still_enabled=true`, `accounts_trigger_count_info=5`(4 → 5).
- 새 함수 `md5(prosrc)` = `13c5fd946908975ba880ce3c8b3058aa` — 검증에 쓴 격리 DB 의 값과 일치(SECURITY DEFINER, `search_path=public`, 소유자 postgres).
- 기존 함수 6개 해시 적용 전과 동일, `accounts` 22행 지문 동일(행 변경 없음), 정책 4개·테이블 권한 불변.
- 적용 후 재확인(2026-10-27 17:47Z): 위 검증 값 동일, 플랫폼 관리자 1·토스 override 1·`merged_into` 0.
- 운영에서 권한 탈취를 재현하지 않았다(재현은 격리 스택에서만).

### 기존 상태 점검 결과의 해석 (§5 와 함께 읽는다)
- **"현재 상태에서 의심 항목을 발견하지 못함"**: 2026-10-27 점검 시점의 스냅샷에서 비정상 특권·계정 연결이 없었다(플랫폼 관리자 1 = 오너 계정, 토스 override 1 = 기록된 토스 심사 계정, `merged_into` 0, 연동 요청/이력 0).
- **"과거 악용 여부는 확인 불가"**: 이 취약점이 열려 있던 기간 동안 값이 올려졌다가 되돌려졌거나, 특권 계정이 만들어져 삭제됐거나, 특권을 이용한 데이터 접근이 있었는지는 이 점검으로 알 수 없다. 운영에는 accounts 컬럼 변경 감사 로그가 없어(감사 대상 아님) 과거를 재구성할 수 없다. 이 SQL 은 앞으로의 우회를 막을 뿐 과거를 복구하거나 증명하지 않는다.

## 7. 새 환경(일회용 격리 스택)에서의 누락 방지 (후속 PR)
- **누락 확인**: PR #245 병합 직후의 main 으로 새로 만든 격리 스택에는 이 보호가 **설치되지 않았다**(새 트리거·함수 0, 검증 24/47 통과·23 실패). 격리 스택은 공유 DEV 스키마 덤프(baseline)에서 만들어지고, 이 보호는 운영에 SQL 로 직접 적용돼 baseline 에 없기 때문이다. 그러면 CI·로컬의 새 스택이 운영보다 약한 보호로 뜨고 같은 우회 회귀를 어떤 시험도 잡지 못한다.
- **조치**: `isolated-supabase/supabase/migrations/20261030000000_accounts_insert_privileged_columns.sql` 추가(루트 SQL 과 같은 본문, begin/commit 만 제외, 멱등 — baseline 을 다시 덤프해도 안전). `tests/unit/accountsInsertGuard.migrationParity.test.ts` 가 두 파일의 동일성과 migration 존재를 고정한다. `scripts/isolated/verifyBaselineParity.mjs` 는 이 의도적 추가를 "알려진 차이"로 분리해 출력한다. 환경 구축 문서(`isolated-supabase/README.md`, `docs/CI_ISOLATION_240.md`)에 절차를 반영했다. **운영 DB 에는 SQL 을 다시 실행하지 않았고 운영 마이그레이션 이력도 바꾸지 않았다.**
- **검증(새 스택 — `supabase db reset` 으로 migration 만으로 구축)**: 보호가 수동 SQL 없이 자동 설치됨(활성, BEFORE·행 단위·INSERT). 검증 47/47 통과(정상 가입·정상 계정 연동 포함, 세 특권 컬럼의 직접 INSERT·upsert·삭제 후 재생성 차단). 보호 제거 시 검증 실패(24/47) → migration 파일로 복원 후 47/47. 회귀 하니스·브라우저 가입(OTP)·변조 가입 시도 차단 모두 기대대로(보호 제거 시 브라우저 시험 3건 실패·종료 코드 1, 복원 후 13/13).
- **운영과의 동일성**: 새 스택의 트리거 정의 문자열이 운영과 글자 그대로 같고, 함수 `pg_get_functiondef` 해시(`d56ce810f4e22a531087e56d0160fbc9`)·`md5(prosrc)`(`13c5fd94…`)·SECURITY DEFINER·`search_path`·반환형이 운영과 같다. 즉 같은 보호 동작을 제공한다.
