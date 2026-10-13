# Work 이후 통합 Batch 사전 감사 (2026-10-12, Issue #200)

예약·취소 / 관리자 / 회원 모바일 UI 세 영역을 한 번에 개선하기 전의 **조사 전용** 문서다.
앱 코드·SQL·DB는 변경하지 않았고, SQL은 실행하지 않았다.

## 0. 조사 범위와 한계 (먼저 읽을 것)

- 근거는 이 worktree의 **저장소 코드·SQL 파일·테스트·기존 문서**를 직접 읽은 것뿐이다.
- 이 조사에서는 **명령 실행이 불가능**해 `npm test`/`npm run build`를 실행하지 못했다. → "테스트·빌드 통과"는 **미확인**이다(9절 체크리스트의 첫 항목).
- 라이브 DB·브라우저·실기기는 확인하지 않았다. DB 상태는 Issue 본문에 적힌 2026-10-12 읽기 전용 확인(운영·DEV 모두 `cancel_source` 컬럼 + `cancel_reservation()` 10분 유예 존재, 운영 `add_holiday_safe()`에 수강권 환급 존재)을 **전제로만** 사용했다.
- **브라우저 QA는 하나도 수행하지 않았다.** 6절의 UI 항목은 모두 코드 읽기 기반 "추정"이다.
- Work PR #192~#197의 내용은 이 저장소(docs, 커밋 로그)에서 확인되지 않았다. 7절의 의존성은 Issue 본문(#193, #196은 관리자 변경)을 근거로 한 **가정**이며, 각 PR의 실제 diff로 재확인해야 한다.
- 앞선 감사 문서(`docs/23_Admin_Feature_Audit.md`, 2026-08-02)의 일부 서술은 이미 stale이다(아래 2절).

## 1. 현재 구현 완료 사항

### 1-1. 예약·취소 (Issue #36 RES-001)

| 항목 | 상태 | 근거 |
|---|---|---|
| 예약 후 10분 무료 취소 | **구현됨** | `fix_grant_schedule_and_kst_dates_20261003.sql:278` `v_grace_deadline = least(created_at + 10분, start_time)`, 유효 마감 = `greatest(마감, 유예)`. 클라이언트 재현 함수 `lib/cancelDeadline.ts`, 테스트 `tests/unit/cancelDeadline.test.ts`, `tests/integration/reservation-cancel-grace-period.test.ts` |
| `allow_cancel=false` 수업도 유예 10분은 취소 가능 | 구현됨 | 같은 파일 :284 |
| 수업 시작 후 취소 불가 | 구현됨 | 같은 파일 :256 (`now() >= start_time`). 예약 쪽은 `fix_reserve_class_block_after_start_draft_proposed.sql`, `tests/e2e/reservation/block-after-start.spec.ts` |
| 마감 후 취소 시 수강권 처리 | 구현됨 | `deduct_on_late_cancel`이 꺼져 있으면 거부, 켜져 있으면 취소는 되되 환급 생략(`deducted:true`). UI 토스트가 이 값을 반영(`app/reservation/page.tsx:439`, `app/my-reservations/page.tsx:114`) |
| 수강권 환급 | 구현됨 | :337-343 확정 예약만 +1. 환불/양도된 수강권은 제외(유령 횟수 방지, `tests/integration/cancel-reservation-refunded-membership.test.ts`) |
| 대기자 승격 | 구현됨 | :345-374 `waitlist_order` 순, 승격 시점에 활성/잔여/기간/시작일/수업 자격 재검증, `membership_consumed=true` 설정. 센터 `waitlist_auto_hours/minutes` 마감 반영. `tests/integration/scenarios/waitlist-promotion.test.ts`, `tests/sql/waitlist-membership-consumed.test.mjs` |
| 중복 취소 방지 | 구현됨 | :250 `status='cancelled'`이면 예외, `for update` 행 잠금 |
| 취소 출처 `cancel_source` | **부분 구현** | 허용값 `MEMBER`/`ADMIN`/`HOLIDAY`(`fix_reservation_cancel_source_column_draft_proposed.sql`). 실제로 쓰는 곳은 `MEMBER`(`cancel_reservation`)와 `HOLIDAY`(`add_holiday_safe`)뿐. 3-1 참고 |
| 관리자 취소(배치 예약) | 구현됨 | `admin_cancel_reservation`(`add_admin_assignment.sql:333`): 권한 검사, 중복 방지, `ADMIN_ASSIGNMENT`+실제 차감분만 복구, 감사 로그. 대상은 `ADMIN_ASSIGNMENT`/`ADMIN_FREE` 유형만 |
| 출석 처리 중 대기 승격 | 구현됨 | `fix_manager_cancel_waitlist_promotion.sql`의 `manager_set_attendance` |
| 휴무일 지정 시 환급·이력·알림 | 구현됨(문서 기준) | `fix_holiday_history_and_notification_draft_proposed.sql` (UPDATE 방식 + `cancel_source='HOLIDAY'` + 환급). `docs/TODO.md` P0-6 "완료" 및 Issue 본문의 운영 확인과 일치. 회원 화면에 "센터 휴무로 자동 취소" 배지(`app/my-reservations/page.tsx:199`) |

### 1-2. 회원 UI에서 이미 갖춰진 것

- 내 예약: 예정/지난/전체 탭, 날짜 그룹, 로딩(`Loading`), 빈 화면(`EmptyState`), 앱 복귀 시 조용한 재조회, 분류 로직 단위 테스트(`tests/unit/myReservations.classifyReservationDisplay.test.ts`).
- 테마: 라이트 기본(네이비 `--brand #0A2545`)과 다크(`[data-theme="charcoal"]`)가 CSS 변수로 분리됨. 테마 화면은 시스템/라이트/다크 선택 제공(`app/settings/theme/page.tsx`). 회원 핵심 페이지(홈·예약·내 예약·마이페이지·센터 상세·검색) TSX에는 하드코딩 hex 색이 **0건**(grep 확인) — 색은 전부 토큰/CSS 경유.
- 터치 영역: 토스트·버튼·검색 결과 행 다수가 `min-height: 44px` 이상.
- `role="status"`/`aria-live`가 홈·예약·검색·센터 상세 등 22개 파일에 사용됨.

## 2. 기존 관리자 감사 문서(#29)와 현재 코드 재비교

| 구분 | 항목 | 현재 판단 |
|---|---|---|
| **이미 수정됨 / 문서만 stale** | **P0-6 휴무일 수강권 미복구** | `docs/23_Admin_Feature_Audit.md` 8번은 "미수정"으로 기술하나, `docs/TODO.md` P0-6은 "완료(라이브 함수 본문과 일치 확인, 2026-08-14)", Issue 본문도 운영 `add_holiday_safe()`에 환급 존재를 확인. **→ 23번 문서가 stale.** 단, `reservation_functions.sql`의 `add_holiday_safe`는 여전히 **옛 DELETE 방식**(`:1482`)이라 이 파일만 보고 판단하면 안 됨 |
| 이미 수정됨 | 운영설정 17/26 필드 미적용(P1) | TODO P1-12 "완료"(재감사 후 대부분 이미 wiring, `show_group_waitlist_count` 구현, `show_all_classes`는 "준비 중" 표기). 23번 문서 17번 항목은 stale |
| 이미 수정됨 | `fulfill_order` 반환값 불일치, InquiryChat 오류 삼킴, 알림 `window.location.href`, 규칙 생성 실패 삼킴, 대시보드 시트 미정리 | 23번 문서가 "이번에 수정함"으로 기록. 현재 코드에서 재확인하지 않았음(미검증) |
| 이미 수정됨 | `account_center_permissions` SELECT RLS | 문서상 2026-08-02 적용 완료 |
| **남은 항목(코드 확인)** | `lib/cancelDeadline.ts`는 UI에서 미사용 | 테스트에서만 import(grep 확인). 주석에도 "UI 표시용으로 쓰이진 않지만"이라 명시 |
| 남은 항목(문서 기준, 현재 코드 미재확인) | 반복수업 생성·그룹 수정 비원자적, `lib/classes.ts` 구 copySchedule 죽은 코드, 권한관리 클라이언트 가드/서버 정책 불일치, `center-info` 주석과 RLS 불일치(스태프도 수정 가능), `schedule.own.group.delete` 키를 휴무일에 재사용, 포인트 원장 이원화(P1-1), 센터 승인/반려 알림 없음, 수강권 상품 수정 불가 | 이번 조사에서 파일별로 다시 열어보지 못함 → **추가 검증 필요**(3절 B) |
| 확인 불가 | 접근 권한(RLS) 최신 상태 | `docs/24_P0_4_RLS_Snapshot.md`는 2026-08 스냅샷. 현재 라이브와 같은지는 읽기 전용 재조회 필요 |

> 17개 영역 전체를 "한 줄씩 다시 읽어" 비교한 것이 **아니다**. 위 표는 문서 간 교차 확인(23번 ↔ TODO ↔ SQL)과 예약·취소·휴무일 관련 직접 코드 확인에 한정된다.

## 3. 실제 확인된 문제 vs 추정 문제

### A. 실제 확인된 문제 (코드·SQL을 직접 읽어 확인)

| # | 내용 | 근거 |
|---|---|---|
| A1 | `cancel_source='ADMIN'`이 CHECK 제약에 허용되지만 **어떤 SQL도 이 값을 쓰지 않는다.** 관리자 취소(`admin_cancel_reservation`)는 `cancelled_by/cancelled_at`만 기록하고 `cancel_source`는 NULL. 따라서 "관리자 취소" 구분·알림 문구 분기가 불가능 | `cancel_source = 'ADMIN'` grep 결과 0건, `add_admin_assignment.sql:377-383`. (최신 라이브 `admin_cancel_reservation` 본문은 미확인 — 이후 개정이 있을 수 있음) |
| A2 | 회원 취소 확인창이 **"이 수업 예약을 취소할까요?" 한 문장뿐**이라, 마감 후 취소(차감 옵션 ON)여도 취소를 누른 **뒤** 토스트로만 "수강권 1회 차감"을 알게 됨. 클라이언트에 이미 있는 `computeEffectiveCancelDeadline()`을 쓰지 않아 사전 안내 불가 | `app/reservation/page.tsx:435`, `app/my-reservations/page.tsx:110`, `lib/cancelDeadline.ts`(미사용) |
| A3 | 내 예약 화면에서 **조회 실패 시 에러 토스트가 뜨지만 본문은 "예정된 예약이 없어요" 빈 화면**이 그대로 노출됨(재시도 버튼 없음). 실패와 "정말 없음"이 구분되지 않음 | `app/my-reservations/page.tsx:99,160,176` (`error` 상태가 본문 분기에 쓰이지 않음) |
| A4 | 내 예약의 토스트(`.toast`)에 `role="status"`/`aria-live`가 없고, `setTimeout`을 정리하지 않음(언마운트 후 상태 갱신·중복 토스트 타이머 겹침) | `app/my-reservations/page.tsx:86-91,161` (이 파일은 role/aria-live grep 목록에 없음) |
| A5 | 취소 버튼 접근 가능한 이름이 "취소"뿐 — 같은 화면에 여러 개 있을 때 어느 수업인지 스크린리더로 구분 불가(`aria-label` 없음) | `app/my-reservations/page.tsx:207-214` |
| A6 | `docs/23_Admin_Feature_Audit.md`와 `docs/TODO.md`가 P0-6/P1-12 상태에서 서로 모순. `reservation_functions.sql`도 옛 `add_holiday_safe`를 가진 채 "최신 통합본"처럼 보임 | 2절 |
| A7 | `lib/cancelDeadline.ts`는 UI에서 쓰이지 않는 죽은 코드(테스트 전용) | grep 확인 |
| A8 | `cancel_reservation`에서 `v_res.status = 'waitlisted'` 취소 시 환급은 없지만(올바름) `cancel_source`/알림은 `MEMBER`로 동일 처리. 대기 취소가 "승격 불필요"인 점은 정상 | :335-345 (결함 아님, 확인 사실만 기록) |

### B. 추정 문제 (확인 필요 — 코드 정황은 있으나 실행/브라우저/라이브 확인 없음)

| # | 내용 | 확인 방법 |
|---|---|---|
| B1 | 내 예약 취소 버튼: `min-height:30px; padding:10px 8px; margin:0 -8px -10px 0`(`app/globals.css:4385-4393`)로 높이는 대략 50px이나 **가로 터치 폭이 글자 2자 + 16px 안팎**이라 44×44 미만일 수 있고, 음수 margin 때문에 인접 요소와 터치 영역이 겹칠 수 있음 | 실기기/DevTools에서 히트 영역 측정 |
| B2 | 다크 모드(`charcoal`)에서 내 예약 상태 배지(`.hist-status.s-*`), `holiday-cancel-tag`, `reservation-type-tag` 대비가 AA를 만족하는지 | 다크 모드 스크린샷 + 대비 측정 |
| B3 | 홈(`app/page.tsx:83,85,217,222,253,264`)의 다수 `.catch(() => {})`/`.catch(() => null)`로 **실패가 조용히 사라짐**(다음 예약 카드·내 수업·매니저 여부). 부가 기능이라 의도일 수 있으나 오류 안내가 없음 | 네트워크 차단 상태로 홈 진입 |
| B4 | 센터 찾기(검색)·센터 상세·마이페이지의 로딩/빈/오류 상태 완결성 — 오류·로딩 키워드 사용 횟수만 확인했고(검색 19, 센터 상세 29, 마이페이지 14) **각 분기를 실제로 읽지는 않음** | 화면별 코드 정독 + 오프라인/빈 데이터 시나리오 |
| B5 | 320~380px 폭, 노치/홈 인디케이터 safe-area, 키보드 올라온 상태에서 예약 시트·하단 네비 겹침 | 실기기 또는 에뮬레이터 |
| B6 | 대기 취소·승격 시 회원 알림 문구(승격된 회원에게 알림이 가는지)와 `cancel_source` 기반 알림 분기 | `trg_notify_reservation_update` 본문 + 통합 테스트(`notifications.test.ts`) 정독 |
| B7 | `cancel_reservation` 최신 라이브 본문이 `fix_grant_schedule_and_kst_dates_20261003.sql`과 동일한지(여러 파일이 같은 함수를 `create or replace`함 — 최소 12개 파일) | `pg_get_functiondef` 읽기 전용 조회 후 대조(Issue 본문은 10분 유예 존재만 확인) |
| B8 | 2절 "남은 항목(문서 기준)" 전체 | 해당 파일 재정독 |

## 4. 우선순위 (P0~P3)

| 등급 | 항목 | 비고 |
|---|---|---|
| **P0** | (신규 확정 P0 없음) | 이전 P0-6은 해소됨. 단 **B7(라이브 `cancel_reservation` 본문 대조)**는 통합 Batch 착수 전 반드시 선행 — 환급·승격은 금전/재화와 직결 |
| **P1** | A2 마감 후 취소 시 차감 사전 안내 | 사용자 손실 체감. 앱 코드만으로 가능(SQL 불필요). `reserve`/`cancel` 핵심 로직은 건드리지 않고 UI 문구만 |
| **P1** | A3 내 예약 조회 실패 시 오류 화면 + 재시도 | 앱 코드만 |
| **P1** | A1 `cancel_source='ADMIN'` 미사용 | 정책 결정(10절) 후 SQL 필요 |
| **P2** | A4/A5 접근성(토스트 role, 취소 버튼 라벨, 타이머 정리), B1 터치 영역, B2 다크 대비 | 앱 코드/CSS |
| **P2** | A6 문서 모순 정리, B3 홈 조용한 실패 | 문서 / 앱 코드 |
| **P3** | A7 `lib/cancelDeadline.ts` 처리(A2에서 사용하면 해소), B5 반응형 점검, 23번 문서 "남은 항목" 소거 | |

## 5. 변경 예상 파일 (통합 Batch 시)

| 파일 | 변경 내용 | 영역 |
|---|---|---|
| `app/my-reservations/page.tsx` | 오류 상태 분기·재시도, 토스트 `role="status"`와 타이머 정리, 취소 버튼 `aria-label`, 취소 확인창에 차감 안내 | 회원 UI |
| `app/reservation/page.tsx` | 취소 확인창 차감 안내(공통 헬퍼 사용) | 예약·취소 |
| `lib/cancelDeadline.ts`, `tests/unit/cancelDeadline.test.ts` | UI 연동용 헬퍼 추가(예: 차감 여부 판정), 테스트 보강 | 예약·취소 |
| `lib/mypage.ts` (+ 해당 단위 테스트) | 취소 마감 정보 조회 필드 추가(센터 설정·`cancel_deadline_min` 필요 시) | 예약·취소 |
| `app/globals.css` | `.member-my-reservations .hist-cancel-btn` 히트 영역, 다크 대비 보정 | 회원 UI |
| `app/page.tsx` | 홈 조용한 실패에 최소 안내(필요 시) | 회원 UI |
| `docs/23_Admin_Feature_Audit.md`, `docs/TODO.md`, `docs/CHANGELOG.md` | P0-6/P1-12 stale 정정, 이번 결과 반영 | 문서 |
| (조건부) 신규 SQL 파일 1개 | `admin_cancel_reservation`에 `cancel_source='ADMIN'` 기록 + 알림 분기 | 6절 |

> Work PR #193/#196이 `app/manager/**`를 수정한다면 위 목록은 **관리자 파일을 일부러 포함하지 않았다**. 관리자 영역은 두 PR 병합 후 재감사한 뒤에 파일을 확정한다.

## 6. SQL 필요 여부 및 적용 위험

- **이번 조사에서 실행·변경한 SQL: 없음.** 기존 SQL을 다시 실행하라는 제안도 하지 않는다. `fix_*_draft_proposed.sql`들은 이후 다른 이름/개정본으로 적용됐을 수 있어 **파일 존재 ≠ 라이브 적용**이다.
- **필수 SQL: 현재 없음.** P1 항목 중 A2·A3·A4·A5·B1은 앱 코드/CSS만으로 가능.
- **조건부 SQL 후보 (A1, 정책 결정 시)**: `admin_cancel_reservation`을 최신 라이브 본문 기준으로 `create or replace` 하며 `cancel_source='ADMIN'`을 함께 기록.
  - 선행 조건: B7처럼 `select pg_get_functiondef('public.admin_cancel_reservation(uuid,text)'::regprocedure);`를 **읽기 전용**으로 조회해 최신 본문 확보. 이 저장소의 `add_admin_assignment.sql:333`은 오래된 본문일 수 있어 **그대로 쓰면 이후 개정(회원상태 가드 등)을 되돌릴 위험**이 있다(`rollback_admin_assignment_member_status_guard.sql` 존재가 개정 이력을 시사).
  - 이 조사에서는 라이브 본문을 보지 못했으므로 **SQL 전문은 작성하지 않았다.** 임의로 작성한 전문은 오히려 위험하다. 라이브 본문 확보 후 별도 승인 단계에서 작성한다.
  - 파일 경로(안): `fix_admin_cancel_source_20261012.sql` + `rollback_fix_admin_cancel_source_20261012.sql`
  - 실행 순서: ① 라이브 본문 조회 → ② DEV에서 적용 → ③ `tests/integration`의 admin-assignment/notifications 테스트 → ④ 사용자 승인 후 운영.
  - 적용 후 확인: `select pg_get_functiondef(...) like '%cancel_source%'`, 테스트 예약을 관리자 취소 후 `cancel_source='ADMIN'`·수강권 복구·알림 확인.
  - 위험: 핵심 예약 RPC 개정(회원 알림 트리거 `trg_notify_reservation_update`와 연동 — 문구 분기 추가 시 같은 트리거 재정의 필요), 기존 취소 건은 NULL로 남음(소급 불가).
- **참고(SQL 아님)**: `reservation_functions.sql`·`schema.sql`이 라이브와 어긋난 부분(옛 `add_holiday_safe`)은 코드 변경이 아니라 문서에 "라이브 기준 아님"을 명시하는 쪽이 안전하다(이 파일은 재실행 금지).

## 7. Work PR 의존성 (가정 — 실제 diff로 재확인 필요)

| PR | 알려진 정보 | 이번 Batch와의 관계 |
|---|---|---|
| #193, #196 | Issue 본문: 관리자 변경 | 관리자 영역(`app/manager/**`, `lib/*` 관리자 함수)은 **두 PR 병합 후 시작**. 같은 파일을 만지면 충돌 |
| #192, #194, #195, #197 | 이 저장소에서 내용 확인 불가 | 회원 UI/예약 파일(`app/reservation`, `app/my-reservations`, `app/globals.css`, `lib/mypage.ts`)과 겹치는지 **PR 파일 목록 확인 필수** |
| 공통 | `app/globals.css`는 4,000줄 이상의 단일 파일 | 어떤 PR이든 CSS를 건드렸으면 충돌 가능성이 가장 높음 |

## 8. 통합 Batch 구성 및 실행 순서 (제안)

0. **선행(코드 변경 없음)**: #192~#197 병합 상태·변경 파일 확인 → 최신 `origin/main` 기준 새 worktree.
1. **선행(읽기 전용 DB)**: B7 — `cancel_reservation`, `admin_cancel_reservation`, `add_holiday_safe`, `trg_notify_reservation_update`의 라이브 본문을 사용자가 조회해 이 문서 3절에 대조.
2. **Batch 1 — 예약·취소 UI(앱 코드만)**: A2(차감 사전 안내) → 단위 테스트 → A3/A4/A5 내 예약 보강.
3. **Batch 2 — 회원 모바일 UI**: B1/B2 CSS(브라우저로 측정한 값 기준), B3 홈, B4 검색·센터·마이페이지 정독 후 보정.
4. **Batch 3 — 관리자(#193/#196 병합 후)**: 2절 "남은 항목(문서 기준)"을 파일별 재확인해 실제 남은 것만 수정. 23번 문서 정정.
5. **Batch 4(정책 승인 시)**: A1 SQL. 코드 배포보다 **먼저** DB 적용해도 UI가 `cancel_source`를 모르는 값에 안전하도록(null/unknown 무시) 확인.
6. 각 Batch는 별도 Draft PR로 나눠 리뷰 단위를 작게 유지(한 PR에 세 영역 섞지 않음).

## 9. 검증 체크리스트

- [ ] **`npm test`(단위) 통과 — 이 조사에서는 미실행**
- [ ] **`npm run build` 통과 — 이 조사에서는 미실행**
- [ ] 이 문서의 파일 경로·줄 번호가 병합 후 `origin/main`과 일치하는지 재확인
- [ ] 통합 테스트(DEV Supabase): `reservation-cancel-grace-period`, `cancel-reservation-refunded-membership`, `holiday-history-and-notification`, `waitlist-promotion`, `admin-assignment-security`
- [ ] 취소 시나리오 수동 QA: 예약 직후 10분 이내 / 10분 후·마감 전 / 마감 후(차감 ON·OFF) / 수업 시작 후 / `allow_cancel=false` / 이미 취소된 예약 재취소 / 대기 취소 / 확정 취소 시 대기자 승격
- [ ] 휴무일 지정: 확정·대기 예약 취소, 수강권 +1, 회원 알림·배지
- [ ] 모바일(실기기 또는 에뮬레이터) 라이트/다크 각각: 홈, 센터 찾기, 센터 상세, 예약, 내 예약, 마이페이지 — 320/360/390px
- [ ] 접근성: 스크린리더로 취소 버튼·토스트 읽기, 포커스 이동, 대비 4.5:1, 터치 44×44
- [ ] 오류/오프라인/빈 데이터 상태 화면
- [ ] SQL 변경이 있을 경우: 롤백 파일, DEV 적용 → 테스트 → 사용자 승인 → 운영

## 10. 사용자 정책 결정 필요 사항

1. **관리자 취소 출처(`cancel_source='ADMIN'`)**: 관리자 취소를 회원에게 "관리자에 의해 취소됨"으로 구분 표시/알림할지, 현재처럼 구분 없이 둘지. (SQL 필요)
2. **마감 후 취소 차감 안내**: 취소 확인창에서 미리 경고할지(권장), 취소 버튼 자체를 차감 상태로 구분 표시할지. 센터가 `deduct_on_late_cancel`을 켠 경우 문구 정책.
3. **10분 유예의 노출**: 회원에게 "예약 후 10분 이내 무료 취소" 남은 시간 카운트다운을 보여줄지(`lib/cancelDeadline.ts` 활용 가능).
4. **홈의 조용한 실패**: 부가 정보 실패를 계속 숨길지, 최소한의 안내를 넣을지.
5. **관리자 영역 범위**: 23번 문서의 "남은 항목(문서 기준)" 중 어디까지를 이번 통합 Batch에 넣을지(권한 세분화·포인트 원장 이원화는 별도 정책/SQL이라 분리 권장).
6. **`reservation_functions.sql` 정리**: 옛 함수가 들어 있는 통합본을 갱신할지, "라이브 기준 아님" 주석만 달지.
7. **Batch를 나누는 단위**: 8절처럼 4개 PR로 분리할지, 이슈 본문 의도대로 하나로 묶을지.
