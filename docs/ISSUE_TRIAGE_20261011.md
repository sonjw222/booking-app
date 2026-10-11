# 열린 Issue 10건 분류 (2026-10-11, 읽기 전용 조사 — 아무것도 닫지 않았다)

분류: A 완료 / B 진행 중 / C 대체됨 / D 구현 필요 / E 중복 / F 보류 / G 추가 확인 필요.
"라이브 DB 적용 여부"는 이 저장소만으로 확인할 수 없다(`*_draft_proposed.sql` 다수가 이후 다른 이름으로 적용/개정됨 — `docs/TODO.md` 참고). 닫기 전 사용자가 Production에서 읽기 전용으로 확인해야 한다.

| # | 제목 | 요구사항 | 현재 구현 증거 | 관련 PR/커밋 | 남은 작업 | 분류 | 닫아도 되는가 | 다음 Sprint |
|---|---|---|---|---|---|---|---|---|
| 40 | AUTH-001 가입 휴대폰 인증 | 가입 시 OTP 인증 | `lib/phoneVerification.ts`, `supabase/functions/send-phone-otp`, 커밋 `1944109`(OTP, 알림톡/SMS) | `1944109` | 실제 SMS/알림톡 발송 채널·비용 정책은 운영 설정에 의존(G) | **A/C** (다른 방식으로 구현됨) | 예 (이슈 본문의 "미구현" 전제가 사라짐) — 확인 후 | 아니오 |
| 38 | NOTIF-001 알림 기본값/딥링크/휴무 이력 | 휴무 강제취소 이력 보존·알림 | CHANGELOG 2026-08-03: 문의 알림 딥링크, `add_holiday_safe` DELETE→UPDATE | PR #39 (병합 2026-08-05) | 라이브 DB의 `add_holiday_safe` 최신본 확인(G) | **A** | 예 (라이브 확인 후) | 아니오 |
| 37 | CLASS-001 개별 수업 마감 우선 + 프라이빗 | 수업별 마감 override, 정원 1 강제 | `fix_class_booking_deadline_override*`, `fix_private_class_capacity_*`, 통합 테스트 `class-deadline-override-and-private`; TODO에 프라이빗 정원 라이브 확인 기록 | PR #39 | 지정회원 전용 등 정책 결정 항목(DEC-001~003)은 별도 | **A** (최소 범위 완료) | 예 — 남은 정책은 별도 이슈로 | 정책 결정 시 |
| 36 | RES-001 예약 제한 재검증 + 10분 무료 취소 | cancel grace 10분 | `fix_reservation_cancel_grace_period*`, `reservations.cancel_source`, 테스트 `reservation-cancel-grace-period` | PR #39 | 라이브 `cancel_reservation` 정의 확인(G) | **A** | 예 (라이브 확인 후) | 아니오 |
| 31 | ADMIN-002 휴무 수강권 미복구 + 운영설정 미배선 | P0-6, P1-12 | PR #32는 CLOSED(미병합). P0-6은 이후 NOTIF-001 배치/`fix_*20261003/04` 계열이 `add_holiday_safe`를 개정(TODO P0-6 항목) | PR #32(closed), PR #39 | 운영설정 34필드 중 미배선 필드(P1-12) 잔여 여부 TODO 기준 확인 | **C** + **G** | 아니오 — P1-12 잔여 확인 후 | 확인 후 |
| 29 | ADMIN-001 관리자 기능 전수 감사 | 감사 문서 + 버그 수정 | `docs/23_Admin_Feature_Audit.md` 존재, 발견 항목은 TODO로 이관 | 별도 PR 병합 | 감사 산출물 완료. 후속 항목은 TODO가 추적 | **A** | 예 | 아니오 |
| 24 | TEST-002 ACL-003 fixture 격리/정리 | 오염 fixture 정리 | `cleanup_acl003_test_fixture_proposed.sql`은 **미실행 제안 상태**로 존재. CI는 이후 전용 dev 프로젝트로 이전(`docs/CI_DEV_SUPABASE_SETUP.md`)되어 문제의 공유 DB 오염이 구조적으로 해소 | PR #19(병합), PR #23(CLOSED) | 정리 SQL 불필요해졌을 가능성 큼(G) | **C** (대체됨) | 예 — dev 프로젝트 이전으로 목적 소멸, 확인 후 | 아니오 |
| 18 | SEC-008 RLS 갭 정책 초안 (17개 테이블) | 초안 SQL | `add_rls_gap_tables_draft_proposed.sql` 존재. SEC-009 Batch A(5개 테이블)는 별도 적용 준비됨(CHANGELOG 2026-08-02), 나머지 12개 테이블은 app/lib 참조 0건 | PR #20(병합) | 나머지 12개 테이블의 정책 적용 여부 결정(보안, 승인 필요) | **B/F** | 아니오 | 보안 Sprint 후보 |
| 17 | SEC-007 RLS 갭 분석 | 66개 테이블 전수 | `docs/21_RLS_Gap_Analysis.md` 산출 완료. 이후 SEC-008/009로 이어짐 | PR #20(병합) | 없음(분석 산출물 완료) — 후속은 #18 | **A** | 예 | 아니오 |
| 16 | DB-001 chat_messages 사용 조사 | 사용 여부 조사 | 조사 완료(참조 0, `inquiry_*`로 대체). 여전히 `schema.sql` 등 SQL에만 존재, DROP 미실행 | - | `DROP TABLE`은 사용자 승인 필요(HIGH) | **A**(조사) / **F**(삭제 보류) | 조사 이슈로는 예, 삭제 작업은 별도 이슈로 | 아니오 |

근거 한계: 위 표는 저장소 코드·문서·PR 상태로만 판단했다. 라이브 DB 함수 정의는 확인하지 않았다(`supabase db query --linked`는 사용자 승인 없이 실행하지 않음). 따라서 "닫아도 됨"은 모두 **사용자 확인 후**다.
