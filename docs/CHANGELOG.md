# CHANGELOG

이 저장소는 2026-07-26 `Initial commit`에 그 이전까지 개발된 기능이 통째로 들어왔습니다
(초기 개발은 zip 파일 전달 방식으로 진행됨 — `SETUP_INSTRUCTIONS.md` 참고).
따라서 **초기 스냅샷 이전의 기능별 이력은 Git 커밋만으로 알 수 없으며**, 이후 변경은 실제 commit과 아래 재구성 기록을 함께 확인해야 합니다.

아래는 두 가지 근거를 함께 사용해 재구성한 변경 이력입니다.
1. **Git 커밋 로그** (2026-07-26 이후, 실제 날짜 있음)
2. **SQL 마이그레이션 파일 + `TEST_CHECKLIST*.md` 문서**에 남아 있는 롤아웃 순서 (날짜 없음, 상대적 순서만 확인 가능)

## 2026-08-02 — P0-6/P1-12: SQL 실행 및 검증, sibling FK 버그 추가 발견

사용자가 `fix_holiday_membership_restore_draft_proposed.sql`, `fix_settings_wire_reservation_logic_draft_proposed.sql`,
`fix_test_center_approval_draft_proposed.sql`을 Supabase SQL Editor에서 실행 완료. CI 재검증 결과:

- **P2-15(테스트 센터 승인 gap) 해결 확인**: `settings-reserve-class-wiring.test.ts`의 beforeAll이
  더 이상 막히지 않고 8개 테스트가 전부 실행됨.
- **`admin_action_logs.reservation_id` FK 수정 확인**: 이전에 발생하던 FK 위반이 사라짐.
- **sibling 버그 추가 발견**: `admin_action_logs.class_id`도 동일하게 `not null`이고 ON DELETE
  미지정이라, `add_holiday_safe`의 `delete from classes` 단계에서 여전히 FK 위반 발생. 같은 패턴의
  수정(`fix_admin_action_logs_class_id_fk_draft_proposed.sql` + rollback, 신규)을 준비함 — **아직 미실행**.
- **P1-12 테스트 fixture 설계 결함 2건 발견(SQL 문제 아님)**: 당일예약 테스트가 기존 book-deadline
  체크에 먼저 막히던 문제(book 설정 오버라이드로 해결), daily_book_limit이 다른 describe 블록의
  잔여 예약과 날짜가 겹쳐 오염되던 문제(날짜를 16~28일 뒤로 분리해 해결), open-days-before
  "아직 오픈 전" 케이스의 날짜 산식이 반대로 계산되던 문제(수업일이 오픈 기준일보다 멀어야 함을
  재확인해 수정). `lib/adminAssignment.ts`의 `AdminActionLog.classId`도 `string | null`로 조정
  (런타임 영향 없음, build 확인).

상세 내역은 [TODO.md](./TODO.md) P0-6/P1-12/P2-15 참고. PR [#32](https://github.com/sonjw222/booking-app/pull/32)는
아직 merge하지 않음 — `class_id` FK 수정 SQL 승인·실행 및 전체 재검증 후 판단 예정.

## 2026-08-02 — P0-6/P1-12: 휴무일 수강권 미복구 버그 + 운영설정 미배선 수정 SQL 준비

Track B 감사(바로 아래 항목)에서 SQL 실행이 필요해 미루었던 두 항목을 이번 배치에서 조사·수정
SQL 작성·테스트 작성까지 완료했습니다. **SQL은 아직 Supabase에 실행하지 않았습니다** — 두 초안
모두 사용자 승인 후 실행 필요.

- **P0-6 (휴무일 강제 지정 시 수강권 미복구)**: `add_holiday_safe`가 삭제할 예약 중
  `status in ('confirmed','attended') and membership_consumed and membership_id is not null`인
  것만 `membership_id`별로 집계해 `remaining_count`를 복구하도록 수정
  (`fix_holiday_membership_restore_draft_proposed.sql` + rollback). 무제한권(`remaining_count`
  null)·이미 취소된 예약·`membership_consumed=false`(예: 무료배치) 예약은 복구 대상에서 제외.
  DELETE 기반 구조(예약/수업을 실제로 지움)는 그대로 유지 — FK에 `ON DELETE CASCADE`가 없어
  UPDATE-cancelled 방식으로 바꾸면 `delete from classes`가 실패함. 회귀 테스트
  `tests/integration/holiday-membership-restore.test.ts` 신규 작성(SQL 미적용 상태에서는
  의도적으로 FAIL). **테스트 작성 중 별도 버그를 추가로 발견해 같은 SQL에 함께 수정**:
  `admin_action_logs.reservation_id`가 ON DELETE 지정 없는 FK라(기본 RESTRICT), 관리자
  직접배치/무료배치로 만들어진 예약이 하루라도 있으면 `add_holiday_safe`의 예약 삭제가 FK
  위반으로 통째로 실패하던 실질적 P0급 버그 — `reservation_id`를 nullable + `ON DELETE SET NULL`로
  바꿔 감사 로그는 보존하면서 참조만 끊도록 수정(`AdminActionLog.reservationId` 타입도
  `string | null`로 맞춤, 현재 읽는 화면 없어 런타임 영향 없음).
- **P1-12 (운영설정 다수 필드 미배선)**: 34개 필드를 전수 재조사해
  [24_P1_12_Settings_Audit.md](./24_P1_12_Settings_Audit.md)로 표 작성. 그중
  `reserve_class()`의 기존 동기 흐름에 자연스럽게 추가 가능한 8개(당일예약 허용/일일예약
  한도/주간 대기예약 한도/예약 오픈 시각 private·group)를 `calc_deadline()`(`'open'` kind 신설)과
  `reserve_class()`에 배선(`fix_settings_wire_reservation_logic_draft_proposed.sql` + rollback).
  나머지 17개는 스케줄러 인프라 부재·대응 UI 부재·정책 중복 등의 사유로 이번에도 Dead Code로
  남김(사유는 감사 문서에 필드별로 기록). 회귀 테스트
  `tests/integration/settings-reserve-class-wiring.test.ts` 신규 작성(SQL 미적용 상태에서는
  의도적으로 FAIL). `reserve_class()`는 앱 최다 호출 RPC라 P0-6보다 위험도가 높다고 판단해
  SQL 파일 헤더에 별도 경고를 남기고, 같은 PR에는 포함하되 반드시 함께 실행할 필요는 없다고
  명시함.

두 SQL 모두 기존 함수 시그니처·반환값·다른 호출부(`admin_assign_reservation` 등)는 변경하지
않았고, 기존 로직은 그대로 재사용(순수 추가)했습니다.

## 2026-08-02 — Track B: 관리자(Admin) 기능 전수 감사 + 예외처리/사용성 버그 수정

17개 관리자 기능 영역(대시보드/회원/스태프/권한/예약/출석/클래스/일정/수강권/상품/결제/매출/
문의/공지/알림/센터관리/운영설정 등)을 실제 코드 기준으로 전수 조사했습니다. 상세 결과는
[23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 참고. SQL/RLS 변경이 필요한 발견
사항(휴무일 강제취소 시 수강권 미복구 P0, 운영설정 다수 필드 미시행 P1, 센터정보 권한 불일치
P1 등)은 이번 배치 규칙(SQL 실행 금지·새 RLS 수정 금지)에 따라 코드를 고치지 않고
`docs/TODO.md`(P0-6, P1-12, P1-13, P2-14)에만 기록했습니다.

**애플리케이션 코드만으로 고칠 수 있는 P0/P1 버그**를 수정했습니다(전부 예외처리·사용성 개선,
새 RLS/ACL 없음):
- `app/manager/page.tsx`: 예약자 명단/회원 상세 조회 실패 시 시트가 안 닫혀 "예약자 없음"으로
  오인되거나 무한 로딩으로 보이던 문제 — 실패 시 시트를 닫고 상단 에러로만 알리도록 수정.
- `app/manager/membership-rules/page.tsx`: 상품 생성 후 요일·시간 예약조건 등록이 실패해도
  `catch {/* 무시 */}`로 조용히 넘어가던 문제 — 실패 건수를 안내하도록 수정.
- `app/components/InquiryChat.tsx`(문의 채팅): 메시지 조회/전송/사진 업로드 실패가 전부 무언
  처리되어 매니저가 답장이 실패한 걸 몰랐던 문제 — 화면에 에러 메시지를 표시하도록 수정.
- `app/manager/notifications/page.tsx`: 알림 클릭 시 `window.location.href`로 전체 페이지를
  새로고침하던 것을 Next.js 라우터(`router.push`)로 교체(SPA 상태 유지).
- `lib/orders.ts`/`app/manager/orders/page.tsx`: `fulfill_order()` RPC가 실제로는
  `{already_done, membership_id, amount}`만 반환하는데 존재하지 않는 `auto_booked`/`remaining`
  필드를 기대해 항상 무시되던 죽은 분기를 제거 — 반환값을 안다고 가정하지 않는 정확한 안내로
  정리(RPC 자체는 변경하지 않음).
- `app/manager/progress/record/page.tsx`: 어디서도 호출되지 않는 `updateProgressNote` 죽은
  import 제거.
- `docs/ROUTES.md`: `/admin/categories`·`/admin/banners`의 `checkPlatformAdmin()` 가드 상태와
  `/manager/inquiries`·`/manager/notifications`의 `fetchMyCenters()` 상태가 실제로는 이미
  적용됐는데 문서만 stale하게 "미완성"으로 남아있던 것을 정정.

Track B 진행 중 별도로 발견: `tests/integration/acl-003-permission-read.test.ts`와
`docs/TODO.md` P0-4가 `fix_account_center_permissions_select_draft_proposed.sql`을 여전히
"미실행"으로 기술하고 있었으나, 실제로는 이미 실행·검증·병합 완료된 상태였습니다(문서 갱신
누락) — 위 CHANGELOG 첫 항목에서 별도로 정정했습니다.

## 2026-08-02 (Track B 감사 중 발견) — 문서 정정: ACL-003 fix SQL 실행 완료 기록 누락

Track B(관리자 기능 Audit) 진행 중 `tests/integration/acl-003-permission-read.test.ts`와
`docs/TODO.md` P0-4가 여전히 "`fix_account_center_permissions_select_draft_proposed.sql`
미실행"으로 기술돼 있는 것을 발견했습니다. 실제로는 이 SQL이 사용자에 의해 Supabase SQL
Editor에서 이미 실행됐고(Success), 그 결과 ACL-003 통합 테스트 3/3 통과, 전체 통합
테스트·PR #19 CI green까지 확인한 뒤 `feature/access-control-guards`(PR #19, ACL-001~005
Batch)에 포함되어 main에 병합됐습니다 — 다만 그 실행 완료 사실 자체를 CHANGELOG에 별도
기록하지 않아 두 문서가 "미실행"으로 정체돼 있었습니다. 코드/테스트/실제 라이브 정책은
이미 올바른 상태였고(실제 보안 결함이 남아있던 것이 아님), 이번엔 그 사실을 반영하도록
`docs/TODO.md`와 테스트 파일 헤더 주석만 갱신했습니다.

## 2026-08-02 (추가 3) — SEC-009: Batch A1 적용 후 messages SELECT 결함 발견 및 수정 SQL 준비

`proposed_rls_gap_batch_a1.sql`을 사용자가 직접 Supabase SQL Editor에서 실행(Success). 검증
결과 `staff_salaries`/`leads`는 정상 동작(각각 5/5, 3/3 통과)했지만, `messages`의 SELECT
정책이 channel로 분리되지 않아 `message.sms.view`만 가진 스태프도 push 채널 메시지를 볼 수
있는 결함이 실제로 발견됨(37/38 통과, 1건 실패 — INSERT/UPDATE/DELETE는 원래부터 channel로
정확히 분리돼 있어 영향 없음). 전체 rollback 대신 `messages` SELECT 정책만 최소 범위로
수정하는 `fix_messages_select_channel_scope_draft_proposed.sql`(짝 파일
`rollback_fix_messages_select_channel_scope_draft_proposed.sql`)을 준비 — **아직 실행하지
않음, 승인 대기 중.** 회귀 테스트도 lms 채널 케이스와 push 전용 권한 케이스를 추가해 보강.
SEC-009는 계속 Review 유지, PR #20은 merge하지 않음.

## 2026-08-02 (추가 2) — SEC-009: Batch A를 A1/A2로 분리 (SQL 실행은 아직 안 함)

바로 아래 항목(Batch A 5개 테이블 통합 준비)에 대한 사용자 검토 결과, "검증 안 된 2개 테이블을
검증된 3개와 함께 적용하면 회귀 시 원인 분리가 어렵다"는 지적에 따라 분리했습니다.

- **A1**(`proposed_rls_gap_batch_a1.sql`/`rollback_rls_gap_batch_a1.sql`, 신규) — `staff_salaries`/
  `leads`/`messages`. 기존 5개 테이블 통합본에서 정책 내용 변경 없이 이 3개만 그대로 분리.
  `tests/integration/sec007-batch-a-rls.test.ts` → `sec009-batch-a1-rls.test.ts`로 이름 변경(A1
  전용임을 명확히 함).
- **A2**(SQL 미확정, 조사만) — `contracts`/`notification_logs`. `docs/22_RLS_Gap_A2_Investigation.md`
  신규 작성 — 요청받은 10개 질문(앱/RPC 실사용 여부, 정상 INSERT/DELETE 주체, GRANT 필요성과
  노출면, fixture 전략 등)에 전부 답함. 결론: 두 테이블 다 앱/트리거 참조 0건(미구현 기능),
  service_role GRANT를 추가하는 것을 권장(앱 보안과 무관 — service_role 키는 클라이언트에
  노출되지 않음)하되, `contracts`의 INSERT 정책은 실제 계약 발급이 RPC로 설계되기 전까지
  보류할 것을 제안(SELECT 정책만 초안 포함). **SQL 초안만 작성, 실행하지 않음.**
- 읽기 전용 진단(anon/authenticated/service_role로 SELECT 시도, mutation 없음)으로 A1 3개
  테이블의 실제 GRANT 상태를 추가 확인: **anon/authenticated 둘 다 GRANT 정상**(SELECT 시도 시
  에러 없이 0건 반환 — RLS가 막고 있을 뿐 GRANT 자체는 있음). 즉 `proposed_rls_gap_batch_a1.sql`
  만으로 충분하고 추가 GRANT는 필요 없음(service_role 부재는 테스트 도구 전용 문제, 이미
  알려진 대로 A2에서만 필요). 이 결과를 `docs/21_RLS_Gap_Analysis.md`에 역할별 기대 결과
  매트릭스(A1 3개 테이블 × 7개 역할 × 4개 연산)로 정리.
- Issue #28(SEC-009)에 이 분리 내용을 코멘트로 기록, Status는 계속 Review 유지(A1도 아직
  미승인·미실행).

## 2026-08-02 (추가) — SEC-009: RLS Gap Batch A 적용 준비 완료 (SQL 실행은 아직 안 함)

`docs/rls-gap-design` 브랜치(PR #20)에서 진행. SEC-007/008에서 초안까지만 작성했던
`proposed_rls_gap_batch_a.sql`(staff_salaries/contracts/leads/messages/notification_logs)을
실제 적용 가능한 상태로 완성했습니다.

- 재검증: 5개 테이블의 `schema.sql` 컬럼 정의, 초안이 참조하는 permission key 17개 전부가
  실제 카탈로그에 존재하는지, `has_permission()`/`my_account_id()`/`is_platform_admin()`
  헬퍼 시그니처를 전수 재확인 — SEC-007/008 작성 이후 drift 없음.
- **중요 정정**: SEC-007은 이 5개 테이블을 "RLS가 없거나 정책 0건"으로 분류했으나, 실제
  개발(dev) Supabase에서 오너 권한 insert를 시도해본 결과 **RLS는 이미 활성화돼 있고
  정책만 0건**이었다(`42501: new row violates row-level security policy` 확인 — 이 저장소
  SQL 이력에 이걸 켠 기록 없음, 대시보드에서 직접 조작된 것으로 추정). "정책 0건"과 "RLS
  비활성화"는 서로 다른 별개 상태 — 실제로는 오너를 포함해 아무도 접근 못 하는 완전 차단
  상태였다(당초 우려했던 "누구나 접근 가능"보다 안전한 상태). `rollback_rls_gap_batch_a.sql`이
  `disable row level security`로 되돌리게 되어 있었는데, 그러면 원래보다 더 위험한(전체
  공개) 상태가 되므로 정책 제거만 하도록 수정했다. 테스트 fixture 생성도 일반 client로는
  지금 당장 불가능해(0 정책 = 오너도 차단) `getOrCreateOwnedTestCenter`와 동일한
  admin(service-role) client 패턴으로 전환했다. **Batch B/C/D의 12개 테이블과 production
  Supabase의 실제 상태는 아직 확인하지 못함** — 각각 다음 배치 적용 전, 그리고 실행 승인
  전에 반드시 별도 확인 필요. 상세: `docs/21_RLS_Gap_Analysis.md` 상단 정정 섹션.
- **두 번째 정정**: 위 발견과 별개로, service_role 자체에도 5개 테이블 전부 SQL GRANT가
  없다는 것도 확인했다(RLS와 무관한 별개 문제, `account_center_permissions`에서 이미 겪은
  것과 같은 패턴). `staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이 모두
  있어 일반 client(오너)로 fixture 관리가 가능하지만, `contracts`(DELETE 정책이 의도적으로
  없음 — 서명 후 불변)와 `notification_logs`(INSERT 정책이 의도적으로 없음 — 서버 트리거
  전용)는 일반 client·admin client 어느 쪽으로도 지금은 fixture를 만들거나 지울 방법이 없어,
  이 두 테이블은 `docs/TODO.md` P2-13(service_role GRANT 승인·실행 후 진행)으로 미루고
  이번 테스트 파일에서는 의도적으로 제외했다.
- `tests/integration/sec009-batch-a1-rls.test.ts` 신규 작성 — `staff_salaries`/`leads`/
  `messages` 3개 테이블에 "무권한 SELECT 차단/권한 보유자 SELECT 허용/무권한 쓰기 차단"
  최소 3~4종(`staff_salaries`는 own/other 권한 완전 분리라 조합 추가, `messages`는 channel별
  분리라 sms/push 조합 추가). Fixture 계정은 TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B
  (centerA에 권한 0개 스태프로 초대)/TEST_USER_A(무관 일반 회원)만 재사용, 새 Secret 없음.
  **이 테스트는 SQL이 실제 적용되기 전에는 의도적으로 RED**입니다(정책 0건이라 fixture 준비
  단계에서부터 막힘 — `tests/integration/acl-003-permission-read.test.ts`가 SQL 적용 전
  red였던 것과 같은 취지지만, 그쪽은 일부 정책이 이미 있어 fixture 준비까지는 됐다는 차이가 있음).
- SQL은 이번에도 **전혀 실행하지 않았습니다.** 실행은 사용자 승인 후 별도 단계에서 진행.
- Issue: [SEC-009](https://github.com/sonjw222/booking-app/issues/28)(신규, SEC-007/008과
  Related). Batch B/C/D는 아직 손대지 않음(다음 배치에서 순서대로 진행).

## 2026-08-02 — ACL-005 관리자 진입 SSOT 수정 + UI-003 센터 등록 흐름 개선 (PR #19)

일반 회원을 스태프로 등록해도 마이페이지 "관리자 모드로 전환"이 안 뜨고 `/manager` 접속이
차단되는 문제(1차 조사·수정은 커밋되지 않은 채 보류돼 있었고, 그 상태로 실브라우저 재현이
보고돼 2차로 전수 조사·수정함).

- **원인**: `accounts.is_manager`(스태프 초대와 별개로 저장되는 플래그)를 관리자 진입 판정
  기준으로 쓰고 있었는데, `inviteStaff()`가 이 플래그를 갱신하려는 UPDATE가 `accounts` RLS
  정책("본인 계정 수정", `auth_id = auth.uid()`)에 막혀 항상 조용히 실패했음(반환 `error`
  미확인). 전수 조사 결과 `account_type`/`signup_type` 같은 별도의 영구 차단 필드는 존재하지
  않았고, ID 연결(`auth_id`→`accounts.id`→`manager_centers.account_id`)에도 혼동이 없었음 —
  원인은 이 플래그 하나였음.
- **수정**: `lib/manager.ts`(`getMyAccountId()`)와 `lib/mypage.ts`(`getMyContext()`)가 이제
  `accounts.is_manager`가 아니라 active `manager_centers` 소속 존재를 라이브 조회로 판단(SSOT
  통일). `lib/roles.ts`의 `inviteStaff()`에서 항상 실패하던 `is_manager` 갱신 코드 제거. RLS/SQL
  변경 없음 — 기존 "본인 매니저센터 조회" SELECT 정책만으로 충분.
- **UI-003**: 회원가입 유형 문구 "회원"→"일반", "매니저"→"센터 운영자"로 변경(보조 설명 추가,
  내부 상태값은 불변). 마이페이지 "센터 운영하기(매니저 등록)"→"내 센터 등록하기"로 변경하고
  `/login`으로 되돌아가던 동작을 제거, 로그인된 사용자가 바로 센터 등록 폼(`/mypage/register-center`,
  신규)으로 이동하도록 함. "관리자 모드로 전환"과 동시에 노출 가능(상호 배제 조건 제거).
- **공용화**: `lib/centers.ts`(신규) — 센터 등록 검증(`validateCenterRegistrationInput`)·저장
  (`registerCenterForAccount`) 로직, `app/components/CenterRegistrationForm.tsx`(신규) — 입력
  UI. 회원가입("센터 운영자") 흐름과 마이페이지 "내 센터 등록하기" 흐름이 이 두 모듈만 공유하고
  로직을 복제하지 않음. 기존에 각 supabase 호출의 반환 error를 확인하지 않던 지점(센터 오너
  역할 연결)도 이번에 함께 고쳐 실패가 조용히 무시되지 않도록 함.
- Issue: [ACL-005](https://github.com/sonjw222/booking-app/issues/26)(재사용, 제목/범위 확장),
  [UI-003](https://github.com/sonjw222/booking-app/issues/27)(신규). `feature/access-control-guards`
  (PR #19)에 포함 — main 미병합.

## 2026-08-01 (추가) — SEC-007/008 단계 적용 준비 (ACL-003 재검증 반영)

ACL-003 서버 측 재검증에서 "센터 소속 = 무권한이라도 전체 접근 가능"이 실제 보안 결함으로
확인된 뒤, `add_rls_gap_tables_draft_proposed.sql`의 17개 테이블 정책 중 `my_managed_center_ids()`만으로
**쓰기**를 허용하던 6곳(class_types/lockers/locker_assignments/popup_notices의 쓰기,
notification_logs/change_logs의 조회)을 더 구체적인 `has_permission()` 권한 키로 좁혔습니다.
단일 파일을 4개 독립 배치(`proposed_rls_gap_batch_a/b/c/d.sql` + 짝 `rollback_rls_gap_batch_*.sql`)로
나눠, 배치별로 독립 적용·검증·rollback할 수 있게 했습니다. `staff_schedules`/`schedule_memos`의
조회는 낮은 민감도의 캘린더 조율 정보라는 이유로 센터 전체 조회를 의도적으로 유지했고, 이를
"정당화된 예외"로 문서에 명시했습니다. 17개 테이블 재분류표와 역할×테이블 접근 매트릭스(7번째
열 "타 센터 owner/staff" 추가 — 전부 차단됨을 명시)를 `docs/21_RLS_Gap_Analysis.md`에 반영했습니다.
Fixture 계획도 갱신: TEST-002에서 검증된 "TEST_MANAGER_A/B 두 계정만으로 오너+무권한 스태프
페르소나 생성" 패턴을 재사용해, platform admin 테스트 계정 1개를 제외하면 **새 GitHub Secrets가
전혀 필요 없습니다.** 이번 배치도 실제 SQL은 실행하지 않았습니다.

## 2026-08-01 — RLS 조사 및 설계 Batch (DB-001, SEC-007·008)

`docs/rls-gap-design` 브랜치(PR B)에서 진행. 조사·설계만 진행했고 운영 DB에는 아무것도
실행하지 않았습니다. 이 이슈들은 PR이 머지돼도 자동으로 닫히지 않습니다(Relates to만 연결) —
실제 정책 적용과 QA가 끝나기 전에는 Done으로 바뀌지 않습니다.

**DB-001 — `chat_messages` 조사**: app/lib 전체·모든 SQL 함수/트리거/뷰에서 참조 0건, RLS는
활성화돼 있으나 정책 0건(현재 완전 차단 상태). 1:1 채팅은 `inquiry_threads`/`inquiry_messages` +
RPC로 완전히 대체되어 있음을 확인. **결론: 정책 추가가 아니라 삭제 후보** — 이번 배치는 DROP을
실행하지 않았고, 사용자 승인 후 별도 배치에서 처리하도록 `docs/TODO.md` P3-9에 기록.

**SEC-007/SEC-008 — RLS 갭 분석 및 정책 설계**: `schema.sql` + 저장소의 모든 `*.sql`을 전수 매칭해
RLS가 없거나 정책이 0건인 테이블 18개를 찾았고, `chat_messages`(DB-001에서 별도 처리)를 제외한
17개(`change_logs`, `class_types`, `community_comments`, `competitions`, `contract_templates`,
`contracts`, `leads`, `locker_assignments`, `lockers`, `membership_transfers`, `messages`,
`notification_logs`, `popup_notices`, `schedule_memos`, `staff_salaries`, `staff_schedules`, `terms`)에
대해 목적/개인정보/tenant scope/현재 사용여부/예상 접근 역할/SELECT·INSERT·UPDATE·DELETE 정책초안/
기존 데이터 영향/회귀 가능성/테스트 시나리오/우선순위를 정리한 `docs/21_RLS_Gap_Analysis.md`를
작성했습니다. 17개 전부 app/lib 코드 참조 0건(미구현 기능)이라 지금 당장의 활성 위험은 아니지만,
Supabase는 anon key만으로 PostgREST를 통해 이 테이블에 직접 접근 가능하므로 "미사용 = 안전"이 아닌
잠재 위험으로 분류했습니다. `staff_salaries`(급여)와 `contracts`(서명 계약서)는 Critical로 표시.
정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 작성했으며 **이번 배치에서는 실행하지
않았습니다** — 실행은 별도 승인 후 후속 배치에서 진행합니다. RLS 통합 테스트 계획(6개 역할 ×
17개 테이블 CRUD 매트릭스 + fixture 요구사항)도 같은 문서에 설계만 해뒀고 실제 DB 테스트는
실행하지 않았습니다.

## 2026-08-01 (추가) — ACL-001~004 서버 측 권한 재검증 + PR 2개 분리

이전 Access Control + RLS Design Batch(바로 아래 항목)는 클라이언트 가드만 다뤘습니다. 이번
추가 작업은 "화면 가드만으로는 충분하지 않다"는 지적에 따라 실제 RLS/RPC를 전수 재검증했습니다.

- **ACL-001 (관리자 화면 쓰기 차단)**: **PASS**. `service_categories`/`home_banners`는 SELECT는
  공개(`true`, 홈 화면 노출용)지만 INSERT/UPDATE/DELETE는 `is_platform_admin()`으로 이미 막혀
  있어, 일반 회원이 쓰기 쿼리를 직접 호출해도 서버가 차단함을 확인.
- **ACL-002 (센터 미소속 사용자의 직접 접근)**: **PASS**. `inquiry_threads`/`inquiry_messages`는
  회원 본인(`member_account_id`) 또는 소속 센터(`my_managed_center_ids()`)로, `notifications`는
  `recipient_account_id = my_account_id()`로 이미 스코프되어 있어, 화면 가드 없이 RPC/REST를
  직접 호출해도 타인의 데이터는 보이지 않음을 확인. 매니저 화면 가드는 보조 방어선, RLS가 최종
  방어선이라는 원칙이 실제로 지켜지고 있었음.
- **ACL-003 (개인 권한 데이터 직접 접근)**: **FAIL**. `account_center_permissions`의 기존
  "개인권한 조회" SELECT 정책이 `manager_center_id in (select id from manager_centers where
  center_id in (select my_managed_center_ids()))`만 확인해, `facility.role_permission` 권한이
  없는 일반 스태프도 "같은 센터 소속"이기만 하면 다른 스태프의 개인 권한 예외(allow/deny)를
  Supabase SDK로 직접 조회할 수 있는 구조였음(화면 가드 `isOwnerOfCenter()`를 완전히 우회 가능).
  테이블/정책 주석에는 "오너만 조회 가능"이라고 적혀 있었지만 실제 SELECT 정책 구현에 그 권한
  체크가 빠져 있었던 것으로 확인됨. INSERT/UPDATE/DELETE 정책은 원래부터
  `has_permission(center_id,'facility.role_permission')`을 정확히 요구하고 있어 **쓰기는
  안전**했음(READ만 FAIL). 수정 SQL 초안을 `fix_account_center_permissions_select_draft_proposed.sql`에
  작성(본인 것 + facility.role_permission 보유자만 허용 — ACL-004의 `fetchMyEffectivePermissionKeys()`가
  본인 데이터를 읽어야 하므로 "본인 것" 허용은 반드시 유지). **이번에도 이 SQL은 실행하지
  않았음** — 실행 전 `tests/integration/acl-003-permission-read.test.ts`(신규, 현재는 실패해야
  정상 — 수정 SQL 적용 후에만 통과)를 통과시켜야 함. 정적 검토 테스트
  `tests/unit/acl003SqlFix.staticCheck.test.ts`로 SQL 파일 내용 자체를 회귀 검증함(둘 다 통과).
- **ACL-004 (메뉴 숨김이 실제 권한 제어의 전부가 아님)**: 메뉴에 대응하는 각 화면의 실제
  쓰기는 여전히 서버 RLS/RPC가 강제하며, 클라이언트 메뉴 숨김은 UX 보조 수단일 뿐임을 재확인.
  `effectiveState()`가 `has_permission()` SQL과 동일한 우선순위(개인 deny > 개인 allow > 역할)를
  따름을 role×override 2×3 전체 조합으로 단위 테스트 보강(신규 3건). center 전환 시
  `app/manager/page.tsx`의 `useEffect`가 새 fetch 시작 전에 `setMyPerms(null)`을 동기적으로
  호출해 이전 센터의 권한 캐시가 새 센터에 노출되지 않음, 권한 로딩 중에는 `canSeeManagerMenu()`가
  `myPerms === null`을 false로 처리해 메뉴가 순간적으로 전부 노출되지 않음을 코드 검토로 확인
  (이 저장소에 `@testing-library/react`가 없어 React effect 순서 자체를 렌더 테스트로 검증할 수는
  없음 — 로직은 순수 함수로 분리해 단위 테스트했고, effect 배선 자체는 코드 리뷰로 확인).

**PR 분리**: 위 결과에 따라 앱 코드(ACL-001~004 + 이번 수정)와 RLS 조사/설계 문서(DB-001,
SEC-007/008)를 별도 브랜치·PR로 분리함 — `feature/access-control-guards`(PR A),
`docs/rls-gap-design`(PR B). 상세는 아래 두 PR의 실제 커밋/링크 참고.

## 2026-08-01 — Access Control 구현 Batch (ACL-001~004)

`feature/access-control-guards` 브랜치(PR A)에서 진행. `feature/access-control-rls-design`
worktree(`booking-app-access-control`)에서 원래 함께 조사했던 6개 이슈(ACL-001~004,
DB-001, SEC-007/008) 중 실제 코드 구현이 필요한 4건만 이 PR에 포함하고, DB 조사·RLS 설계
2건은 별도 PR B(`docs/rls-gap-design`)로 분리했습니다 — 상세 사유는 바로 위 "ACL-001~004
서버 측 권한 재검증 + PR 2개 분리" 항목 참고.

**ACL-001 — 관리자 화면 가드 누락**: `app/admin/categories/page.tsx`, `app/admin/banners/page.tsx`에
`/admin/centers`와 동일한 `checkPlatformAdmin()` 가드를 추가(`isAdmin` 3상태: null=확인중/false=차단/true=허용).

**ACL-002 — 매니저 화면 센터 미보유 가드 누락**: `app/manager/inquiries/page.tsx`,
`app/manager/notifications/page.tsx`에 `fetchMyCenters()` + "운영 중인 센터가 없어요" 가드를 추가
(기존 9개 화면과 동일한 패턴). 두 화면 모두 기존에는 `fetchMyCenters()`를 아예 호출하지 않았음.

**ACL-003 — 개인 권한 설정 화면 오너십 미검증**: `app/manager/staff/page.tsx`의 스태프 상세 링크에
`&center=${centerId}`를 추가하고, `app/manager/staff/permissions/page.tsx`가 그 값을 읽어
`fetchMyCenters()` 결과로 "요청자가 그 센터의 오너인지"를 확인(`lib/manager.ts`의 신규
`isOwnerOfCenter()`)한 뒤에만 실제 권한 데이터를 불러오도록 수정. 기존에는 `mc`/`role` 파라미터만
있으면(형식만 맞으면) 소속 센터·오너 여부와 무관하게 접근 가능했음.

**ACL-004 — 매니저 홈 메뉴 권한 미반영**: `lib/manager.ts`의 `ManagedCenter`에 `managerCenterId`/
`roleId`를 추가하고, `lib/roles.ts`에 서버 SQL 함수 `has_permission()`과 동일한 우선순위
(오너 전권 → 개인 deny → 개인 allow → 역할)로 "내 유효 권한 키 집합"을 계산하는
`fetchMyEffectivePermissionKeys()`와, 메뉴 한 항목의 노출 여부를 판정하는 순수 함수
`canSeeManagerMenu()`를 추가. `app/manager/page.tsx`의 13개 메뉴 중 권한 카탈로그(`permissions`
테이블)에 대응 키가 있는 9개(수강권관리→`pass.create`, 회원진도기록→`customer.progress`,
스태프&권한→`facility.staff.view`, 매출관리→`pass.sales.view`, 공지사항→`board.notice.view`,
1:1문의→`board.inquiry.view`, 센터정보→`facility.info`, 룸관리→`facility.room`,
운영설정→`facility.operation`)를 이 함수들로 노출 제어. 나머지 4개(상품관리/후기관리/주문관리/
관리자배치내역)는 카탈로그에 대응 permission key가 없어 1차 범위에서 제외(새 key 추가는 스키마
변경이라 별도 승인 필요 — `docs/TODO.md` P2-11 참고). `ManagerNav`의 고정 탭 4개는 이번 범위 밖.

**테스트**: 새 로직(`checkPlatformAdmin`/`isOwnerOfCenter`/`fetchMyCenters`/
`fetchMyEffectivePermissionKeys`/`canSeeManagerMenu`/`effectiveState` 우선순위 일관성)을 검증하는
단위 테스트 22건 + 서버 측 재검증에서 보강한 회귀 테스트 7건(role×override 2×3 전체 조합 3건,
ACL-003 SQL 수정 초안 정적 검토 4건) = 총 29건. React 컴포넌트 렌더링 테스트는 이 저장소에
`@testing-library/react`가 없어(기존 테스트 전부 로직 단위 테스트) 이번에도 페이지를 직접
렌더링하지 않고, 가드가 의존하는 로직을 lib 함수로 분리해 단위 테스트했습니다.

## 2026-07-30 (추가) — 관리자 직접배치 통합 테스트 성공 경로 보강

이전 커밋의 `admin-assignment-security.test.ts`는 매니저 fixture가 없어 권한 차단·입력 검증만
다뤘습니다. 이번 추가 작업으로 서비스 역할 키 없이 테스트가 스스로 매니저/센터 fixture를 만들도록
`tests/integration/setup.ts`에 `getOrCreateOwnedTestCenter()`/`createFutureTestClass()`/
`createTestMembership()`/`cleanupTestClass()`를 추가했습니다(앱의 실제 매니저 가입 RLS 정책만
사용 — `centers`/`manager_centers` insert가 로그인 사용자면 허용되는 기존 정책을 그대로 활용).

- 신규 환경변수 `TEST_MANAGER_A_EMAIL`/`PASSWORD`, `TEST_MANAGER_B_EMAIL`/`PASSWORD` 추가
  (get-or-create, `tests/README.md`·`.env.test.local.example`·`.github/workflows/test.yml`에 반영).
- ADMIN_ASSIGNMENT/ADMIN_FREE 정상 생성, 이용권 없음/만료 회원 성공, 취소 시 수강권 복구/미변화,
  `admin_action_logs`·회원 알림 생성, 동시 요청 단일 생성, 다른 센터 관리자 차단 — 10개 성공 경로
  테스트 추가.
- 테스트 작성 중 실제 버그 발견 및 수정: `add_admin_assignment.sql`의 알림 트리거가 회원 알림
  `data` metadata에 `reservation_type`(ADMIN_ASSIGNMENT/ADMIN_FREE)을 그대로 담고 있어, 회원이
  자신의 알림 원본 데이터를 조회하면 무료 추가 배치 여부를 알 수 있는 정보 노출이 있었음
  (§16 정책 위반). `reservation_id`/`class_id`/`action`만 남기도록 수정하고, 회귀 테스트로 고정.
- 정원 초과 확인(`needs_capacity_confirm` → `p_force_capacity`) 2단계 흐름 자체는 이번에도
  자동화하지 못함 — `docs/TODO.md` P1-11에 남은 범위로 재기록.

## 2026-07-30 — 예약 UX 개선 + 관리자 직접배치/무료 추가 배치 (`feature/p1-reservation-ux`)

### 왜 바꿨는가

관리자가 미배치 요일반 수강권을 "다시배치"(자동 재시도)만 할 수 있고, 날짜·수업을 직접 골라
회원을 배치하거나 수강권 없이 무료로 추가 예약을 넣어줄 방법이 없었습니다. 또한 예약 화면에
구매용 상품(goods)이 "사용 가능한 수강권" 목록에 잘못 섞여 보이는 버그, 구매 완료 문구의 어색한
표현, 예약 화면의 중복 계정 조회 등 성능 이슈가 있었습니다.

### 무엇을 바꿨는가

- **예약 타입/출처 구조화**: `reservations.reservation_type`(MEMBER/ADMIN_ASSIGNMENT/ADMIN_FREE),
  `reservation_source`(USER/ADMIN/SYSTEM), `admin_reason_code`/`admin_reason_detail`,
  `is_capacity_override`, `membership_consumed`, `cancelled_by`/`cancel_reason`/`cancelled_at`,
  `created_by_account_id`, `updated_at` 컬럼 추가 (`add_admin_assignment.sql`, text+CHECK 방식 —
  기존 `status`/`pass_type`/`product_kind` 등 다른 모든 상태 컬럼과 동일한 관례).
- **관리자 직접배치/무료 추가 배치 RPC 신설**: `admin_assign_reservation`(일반 직접배치는 수강권
  종류·예약 가능 시간 제한 무시하고 기존 수강권/미배치건 차감, 무료 추가배치는 차감 없음),
  `admin_cancel_reservation`(타입별 정확한 복구 + 중복 취소 방지). 권한 검사는 기존
  `manager_book_member`와 동일한 "센터 활성 매니저 OR 플랫폼 운영자" 정책을 `can_manage_center_reservations()`
  헬퍼로 분리해 재사용 — 향후 세부 permission key 확장 지점으로 남겨둠. 회원 자격 검사도
  `is_profile_assignable()`로 분리(현재는 기존 셀프예약과 동일하게 프로필 존재 여부만 확인).
- **관리자 예약 작업 로그**: `admin_action_logs` 테이블 신설(append-only, 일반 매니저 UI에서
  수정·삭제 불가 — update/delete RLS 정책을 아예 만들지 않음).
- **기존 함수 확장(회귀 없음)**: `reserve_class`/`reserve_with_membership`/`manager_book_member`/
  `cancel_reservation`/`manager_set_attendance`는 반환값과 기존 로직을 그대로 두고 새 컬럼만 채우도록
  `create or replace`. `manager_book_member`(기존 "보강예약")는 수강권+차감 여부에 따라
  ADMIN_ASSIGNMENT/ADMIN_FREE로 자동 태깅.
- **알림 트리거 확장**: `trg_notify_reservation_insert`/`_update`가 `reservation_type`에 따라
  분기 — 관리자 배치/취소는 회원에게 "관리자가 예약을 등록/취소했습니다"만 안내(무료 여부·사유·
  관리자명·정원초과 등 내부 정보 비공개), 다른 매니저에게는 알리지 않음(소음 방지).
- **버그 수정** (`fix_usable_memberships_product_kind.sql`): `usable_memberships()`/
  `usable_memberships_for_classes()`가 `products.product_kind`를 확인하지 않아 구매용 상품(goods)이
  "사용 가능한 수강권" 목록과 예약 확인 팝업에 섞여 보이던 문제 수정. `remaining_count` NULL(기간권)
  처리도 함께 바로잡음.
- **구매 완료 문구 수정**: 기본 "상품 구매가 완료되었습니다.", 실제 이용 가능한 수강권이 즉시
  발급된 경우에만 "상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다." (`app/checkout/page.tsx`,
  `app/reservation/page.tsx`).
- **예약 화면 성능 개선** (`app/reservation/page.tsx`, `lib/reservations.ts`): `fetchMonthData`/
  `fetchMyProfiles`가 각각 중복으로 `auth.getUser()`+`accounts` 조회를 하던 것을 `getMyAccountId()`
  한 번 조회 후 `Promise.all`로 병렬화. `dayClasses`/`categoryCenterIds`를 `useMemo`로 감싸 매
  렌더링마다 새 배열·Set을 만들지 않게 함(특히 `categoryCenterIds`는 `dayClasses`의 `useMemo` 의존성으로
  쓰이므로, 메모이제이션하지 않으면 dayClasses 메모도 매번 무효화되는 연쇄 문제가 있었음). 수강권 이름
  Set을 매 행마다 새로 만들던 `usableProductNames`를 `usablePassesByClass` 변경 시 한 번만 계산하는
  `Map`으로 변경. `doReserve`/`handleCancel`에 재진입 방지 가드 추가. 로딩 텍스트에 은은한 shimmer
  애니메이션 추가.
- **관리자 UI** (`app/manager/classes/page.tsx`): "미배치 수강권" 시트의 각 행에 "직접배치" 버튼 추가,
  신규 "회원 직접배치" 진입 버튼으로 회원 검색 후 기존 캘린더 위에서 날짜·수업을 고르는 방식 지원,
  배치 방식(일반 직접배치/무료 추가 배치) 확인 팝업 + 사유 선택 + 정원 초과 추가 확인, 예약자 명단에
  관리자 배치 배지와 "관리자 배치 취소" 액션 추가.
- **관리자 배치 내역 조회 화면 신설**: `app/manager/admin-assignments/page.tsx` (기간/회원·관리자·수업
  검색/타입/작업/사유/정원초과 필터 — 통계·엑셀 다운로드는 이번 범위 제외).
- **회원 화면**: `app/my-reservations/page.tsx`에 관리자 배치 예약 배지 표시(ADMIN_ASSIGNMENT/ADMIN_FREE
  구분 없이 "관리자 배치 예약"으로만 노출).

### 알려진 제한 (docs/TODO.md에 항목으로 기록)

- 세부 permission key(`schedule.admin_assign` 등)와 회원 상태(이용정지/탈퇴/휴면) 차단 정책은 이번
  범위에서 결정하지 않고 확장 지점만 마련함 (사용자 확인 결과).
- 통합 테스트는 매니저/오너 테스트 계정 fixture가 없어 권한 차단·입력 검증 경로만 검증했고, 실제
  배치 성공·정원초과·취소 복구 경로는 수동 테스트로 확인함.

## 2026-07-28 — 프로젝트 문서 리팩터링 (커밋 전)

### 변경 성격

이번 작업은 **기능 변경이 아닌 문서 전용 리팩터링**입니다.

- `app/`, `lib/`, 루트 SQL, package·환경·배포 설정을 수정하지 않았습니다.
- 앱 기능, 라우트, 테이블, RPC, RLS 또는 trigger를 새로 구현하지 않았습니다.
- SQL migration을 생성하거나 Supabase에 적용하지 않았습니다.
- Git commit·push와 Vercel 배포를 수행하지 않았습니다.
- 문서의 기능 상태는 현재 코드와 SQL을 직접 확인해 재분류했으며, 운영 환경에서 확인할 수 없는 내용은 `확인 필요` 또는 `운영 설정 필요`로 유지했습니다.

### 변경 문서

| 문서 | 구조 개선 내용 |
|---|---|
| `docs/REQUIREMENTS.md` | 문서 역할과 판정 기준, 프로젝트 목표, 개발 상태, 사용자별 기능, 비즈니스·UX 요구사항, 로드맵과 AI 갱신 규칙으로 재구성. `구현됨`·`미완성`·`확인 필요`·`운영 설정 필요` 상태를 분리 |
| `docs/DATABASE.md` | `app/`·`lib/`가 직접 참조하는 테이블 36개를 검증하고 연결 상태를 구분. 향후 기능 후보 23개와 용도·존속 여부 확인이 필요한 미사용 테이블 5개를 분리하고 보호 테이블, 핵심 RPC·RLS·trigger와 SQL 적용 상태를 정리 |
| `docs/ROUTES.md` | 실제 `app/**/page.tsx` 41개를 기준으로 사용자 유형, 기능, 데이터 의존성, 권한 처리와 미완성 상태를 라우트별로 정리 |
| `docs/AI_PLAYBOOK.md` | ChatGPT, Claude Code/Codex, NotebookLM, Graphify, GitHub, Vercel의 책임·금지 작업·필수 인계 정보를 명확히 하고 기능·버그·DB 작업 절차를 재구성 |
| `docs/WORKFLOW.md` | `NotebookLM → ChatGPT → Claude Code/Codex → 로컬 테스트 → GitHub → Vercel → Graphify·문서 갱신` 표준 흐름과 단계별 입력물·작업·결과물·검수 기준을 정의 |
| `docs/DEVELOPMENT_RULES.md` | 현재 Next.js·TypeScript·Supabase 구조에 맞춰 SQL migration, 환경변수, 권한, 데이터 무결성, UI 상태, 로컬 검증, Git과 문서 갱신 규칙을 구체화 |
| `docs/TODO.md` | REQUIREMENTS와 DATABASE 및 기존 문서의 미완성·확인 필요·운영 설정 필요 항목을 P0~P3의 30개 작업으로 통합하고 각 항목에 근거와 완료 조건을 추가 |
| `docs/CHANGELOG.md` | 이번 문서 리팩터링의 범위와 비기능 변경 사실을 기록 |

### 검증과 정정

- 실제 라우트 41개와 ROUTES의 41개 항목이 일치하는지 확인했습니다.
- `app/`·`lib/`의 직접 참조를 기준으로 현재 사용 테이블과 코드 미사용 테이블을 다시 분류했습니다.
- 기존 문서의 “코드 미사용 테이블 27개”를 실제 목록 수인 28개로 정정했습니다.
- 요일반 자동예약 재시도는 `app/manager/classes/page.tsx`에 “다시 배치” UI가 존재하므로 구현된 기능으로 정정했습니다.
- SQL 파일 67개와 앱이 호출하는 핵심 RPC를 대조했으며, 여러 migration에서 재정의되는 함수와 운영 DB 적용 상태는 완료로 단정하지 않았습니다.
- 문서 간 상세 중복을 줄이고 REQUIREMENTS, DATABASE, ROUTES, TODO, 절차 문서가 각자의 책임을 갖도록 상호 링크를 정리했습니다.

## Git 커밋 이력 (실제 날짜 확인됨)

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-07-30 | (커밋 전, `feature/p0-test-payment`) | **fix(ci): GitHub Actions Node.js 20 → 22** — `PaymentProviderFactory.test.ts`가 CI에서만 실패(로컬 Node 24는 통과). 원인: `@supabase/supabase-js`(realtime-js)가 클라이언트 생성 시 native `WebSocket` 전역을 요구하는데 Node 20엔 없음 — 이 테스트는 mock 없이 `lib/supabaseClient.ts`까지 실제로 import하는 체인이라 import 단계에서 바로 실패함. `.github/workflows/test.yml`의 `node-version`을 22로, `package.json`에 `engines.node: ">=22"`, `.nvmrc` 신규 추가. 근본 원인(단위 테스트가 Supabase 클라이언트 초기화에 우연히 의존하는 구조)은 아직 안 고침 — `docs/TODO.md` P2-9에 기록 |
| 2026-07-30 | `64d3d67` | **P0-1 결제 시스템 자동 테스트 환경 구축** — Vitest 신규 도입(`vitest`/`dotenv` devDependency 추가). `npm run test`(단위, Supabase 불필요, `tests/unit/`)와 `npm run test:integration`(실제 개발용 Supabase에 실제 RPC 호출, `tests/integration/`), `npm run test:all` 3개 스크립트 신설. 단위 테스트는 `mockPaymentApi`를 mock해 `MockPaymentProvider`의 success/failed/cancelled 분기와 `PaymentProviderFactory`의 provider 선택 로직만 검증(12개, 항상 통과 가능). 통합 테스트는 실제 계정 2개(A/B, get-or-create 방식 — 없으면 자동 가입 후 `accounts`/`profiles` 생성, 있으면 재사용)로 로그인해 성공/취소 결제, 순차·동시(`Promise.all`) idempotency, RLS(본인 소유·mock 전용 가드), 존재하지 않는 주문 등 실제 DB 상태까지 검증. `.env.test.local.example` 템플릿 신설(`.gitignore`에 `.env*` 예외 추가로 커밋 대상 포함). `.github/workflows/test.yml` 신설 — 매 push/PR에 단위 테스트, 같은 저장소 브랜치 간 PR·push·수동실행에 통합 테스트(fork PR은 Secrets 미주입으로 제외). UI/UX 테스트는 자동화 범위에서 제외(사용자가 직접 수행) |
| 2026-07-30 | `c3bb9f2` | **P0-1 테스트 결제 환경 구축** — Payment Adapter Pattern(`Checkout → PaymentService → PaymentProviderFactory → PaymentProvider interface → {Mock\|Toss\|PortOne}`) 신설. `lib/payments/`(신규 7개 파일): `types.ts`(인터페이스+DTO), `MockPaymentProvider.ts`(success/failed/cancelled 3개 시나리오 실동작, `NEXT_PUBLIC_PAYMENT_SCENARIO` 또는 checkout `?mockScenario=` 쿼리로 선택), `TossPaymentProvider.ts`/`PortOnePaymentProvider.ts`(구조만), `PaymentProviderFactory.ts`(`NEXT_PUBLIC_PAYMENT_PROVIDER`로 전환), `PaymentService.ts`, `index.ts`. `add_payment_test_provider.sql` 신규 — 회원 본인 전용 `confirm_test_payment`/`cancel_test_payment` RPC 2개(`orders.payment_provider` 컬럼 1개 추가, `schema.sql`은 무수정). **`fulfill_order`(add_order_fulfillment.sql)는 절대 수정하지 않고 로직 중복을 의도적으로 허용** — 매니저 전용 권한 모델과 회원 본인 확정 모델이 근본적으로 다르기 때문(사유·공통화 방안·향후 계획은 `docs/TODO.md` P0-1 참고). `app/checkout/page.tsx`의 `handlePay()`만 수정(라우트/기존 UI 요소 불변) — Mock 결제 성공 시 실제로 수강권이 즉시 발급되도록 연결. `app/reservation/page.tsx`는 무수정(기존 "즉시 가능/발급 대기" 토스트 분기 로직이 실제 DB 상태를 재조회해 판단하도록 이미 설계돼 있어, Mock 성공 시 자동으로 "바로 예약 가능" 문구가 나옴). `lib/orders.ts`는 `createOrder()`에 선택적 `provider` 필드 1개만 추가(하위 호환, `app/cart/page.tsx` 등 기존 호출부 영향 없음) |
| 2026-07-28 | `e412cd9` | `fix_usable_memberships_shared.sql` 추가: 수강권 조회·예약 RPC를 계정 공유 기준으로 통일하고 `usable_memberships_for_classes()` 배치 RPC 정의. 운영 Supabase 적용 여부는 저장소만으로 확인할 수 없음. 관련 프로젝트 개요 문서 보강 |
| 2026-07-28 | `40f22b6` | 예약 → 수강권 구매 → 주문 접수 → 예약 화면 복귀 UX 개선. 구매 가능한 상품 배치 조회, 수강권·굿즈 조회 경합 방지, 기본 수강권 선택, 센터·checkout 복귀 URL 유지, 주문 후 발급 상태 안내를 포함. 실제 PG와 즉시 수강권 발급을 추가한 변경은 아님 |
| 2026-07-28 | `345d5e0` | AI 작업 규칙과 도구 협업 문서 추가 (`CLAUDE.md`, `AI_PLAYBOOK.md`, `WORKFLOW.md`) |
| 2026-07-28 | `f6058e7` | REQUIREMENTS, DATABASE, ROUTES, TODO, DEVELOPMENT_RULES, CHANGELOG 초기 문서 추가 |
| 2026-07-27 | `155fda1` | Fix sales product type error — `app/manager/sales/page.tsx`의 state 타입에 `kind`/`unlimited` 필드 누락으로 인한 빌드 실패 수정, `my-reservations` 페이지의 존재하지 않는 status 비교 제거, `useSearchParams()` 5개 페이지에 `Suspense` 경계 추가(Next.js 16 프리렌더 요구사항) |
| 2026-07-27 | `d5493d3` | Add package lock file |
| 2026-07-26 | `abd3b96` | Initial commit — 아래 "커밋 이전 기능 롤아웃"에 정리된 기능이 모두 포함된 최초 스냅샷 |

## 커밋 이전 기능 롤아웃 (SQL/체크리스트 근거, 상대적 순서)

`TEST_CHECKLIST*.md`에 남은 세션별 안내와 `schema.sql`/`add_*.sql`/`fix_*.sql` 파일명을 근거로 재구성한
개발 진행 순서입니다(정확한 날짜는 알 수 없음, 오래된 것부터).

### 1단계 — 기반 스키마
- 3계층 계정 구조 설계: `accounts`(로그인) → `profiles`(회원 프로필) / `manager_centers`(운영 소속)
- 센터, 수업(`classes`), 수강권(`memberships`), 예약(`reservations`), 결제(`payments`) 등 핵심 테이블 (`schema.sql`)
- 예약 처리 함수 및 관련 RLS 96개 정책 (`reservation_functions.sql`)
- 회원가입 RLS 오픈 (`auth_policies.sql`)

### 2단계 — 운영 기능 확장
- 룸/수업구분/운영설정(17항목) 도입, 결제수단 지정, 당일예약 설정
- 상품 체계 개편(수강권/굿즈 분리), 수업별 예약가능 수강권 제한
- 스태프 & 권한 관리(역할, 권한 카탈로그, 개인별 권한 예외) 도입
- 회원관리(등급/상태/메모/주소), 진도표(1단계 기술목록 → 2단계 기록)
  - `lockers`/`locker_assignments`(락커)는 `schema.sql`의 최초 설계에 테이블만 포함되었고, 재검증 결과 실제 화면/코드는 없는 것으로 확인됐습니다([DATABASE 5절](./DATABASE.md#5-향후-기능-후보-테이블)) — "커밋 이전 롤아웃"이 아니라 "설계됐지만 만들어지지 않은 기능"입니다
- 반복수업 그룹, 스케줄 복사(요일 기준/날짜 기준, 달력 미리보기) — `TEST_CHECKLIST_4.md` "A. 스케줄 복사" 항목

### 3단계 — 커머스/커뮤니케이션 확장
- 매출 관리(분할결제, 지출, 매출구분), 포인트 적립/사용
- 주문(`orders`)/장바구니/구매내역/환불 플로우 (실제 PG 미연동 — 매니저 수기 확인)
- 요일반 수강권 자동예약(`add_auto_booking.sql`) 및 하루 1회 제한 보정(`fix_auto_book_oneperday.sql`)
- 프로필 간 수강권 공유(`add_shared_passes.sql`) — `TEST_CHECKLIST_4.md` "B. 프로필 간 수강권 공유 ★신규"
- 미배치 수강권 관리 + 주문 발급 자동화(`add_unplaced_passes.sql`, `add_order_fulfillment.sql`)
- 후기(별점/사진) + 후기 기반 포인트, 센터 답변 (`add_reviews_points.sql`, `add_review_reply.sql`)
- 후기 테이블 명칭 충돌 긴급 수정(`fix_center_reviews.sql`)
- 공지사항(서식+사진), 1:1 문의 채팅, 알림 시스템(실시간 팝업 + 알림함), 예약/취소 관련 알림 트리거
- 플랫폼 운영자(센터 승인) 기능 도입 (`add_platform_admin.sql`)

### 반복적으로 발생한 RLS 버그 수정 (운영 중 발견)
다음은 실제 사용 중 발견되어 별도 `fix_*.sql`로 패치된 회귀 버그들입니다. 향후 관련 테이블 작업 시 참고:
- 프로필 조회 불가("프로필을 찾을 수 없어요") — `fix_profile_rls_restore.sql`, `fix_missing_primary_profile.sql`
- RLS `with check` 누락으로 쓰기 정책이 의도대로 동작하지 않음 — `fix_rls_policies.sql`
- 수강권 발급/회원 추가 시 RLS 차단 — `fix_membership_rls.sql`
- 스태프 검색 시 `accounts` 조회 정책 무한 재귀 — `fix_staff_search.sql`
- 예약자 명단 미노출 — `add_roster_rls.sql`
- 대기자 자동 승격 오류(v2 패치) — `fix_waitlist.sql`
- 수업 삭제 시 취소 예약 처리/오너 권한 문제 — `fix_class_delete.sql`
- 회원 만료/휴면 처리 권한 — `fix_member_status.sql`

## 참고
- 위 "커밋 이전" 항목은 상대적 순서 추정치이며, 정확한 완료일이 필요하면 SQL을 실제로 Supabase에 적용한 시점을 팀 내에서 별도로 기록해야 합니다.
- 앞으로는 [DEVELOPMENT_RULES.md](./DEVELOPMENT_RULES.md)의 "기능별 작은 커밋" 규칙에 따라 Git 커밋 로그 자체가 신뢰할 수 있는 변경 이력이 되도록 합니다.
