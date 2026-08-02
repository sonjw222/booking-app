# 관리자(Admin/Manager) 기능 전수 감사 (2026-08-02)

Track B 감사 산출물. 17개 관리자 기능 영역을 실제 코드(`app/manager/*`, `app/admin/*`,
관련 `lib/*.ts`, RLS SQL)를 직접 읽어 조사했습니다. 각 영역마다 구현 상태 / 접근 권한 체크 /
버그 후보 / 기존 TODO 연결 / 누락 기능 / 우선순위를 기록합니다.

> **감사 중 발견한 중요 정정**: `account_center_permissions` SELECT RLS는 이미 수정·적용되어
> 있습니다(ACL-003, `fix_account_center_permissions_select_draft_proposed.sql` 2026-08-02
> 실행 완료 — 상세는 `docs/CHANGELOG.md`/`docs/TODO.md` P0-4 참고). 감사 중 이 파일을 읽고
> "취약하다"고 잘못 판단한 조사 결과가 있어 이 문서에서는 정정된 내용으로 기록합니다.

## 요약 매트릭스

| 영역 | 구현 상태 | 우선순위 | 비고 |
|---|---|---|---|
| 관리자 대시보드 | 완료 | P2 | 에러 시 시트 미정리, 메뉴 깜빡임(의도됨) |
| 회원관리 | 완료(2개 탭 준비중) | P2 | 담당회원/상담고객 탭 — 기존 P1-8 |
| 스태프관리 | 완료 | P3 | 검색결과 10개 cap, 역할삭제 안내 부족 |
| 권한관리 | 완료 | P2 | 클라이언트 가드(오너전용)와 서버 정책(role.manage자도 가능) 불일치 |
| 예약관리(직접배치 포함) | 완료 | P3 | 세부 permission key 미도입 — 기존 P1-9 |
| 출석관리 | 완료 | P3 | RPC 중복 정의 이력 — 기존 P0-3 |
| 클래스관리 | 완료 | **P1** | 반복생성/그룹수정 비원자적, 죽은 코드 |
| 일정관리(휴무일/룸) | 완료 | **P0(SQL 필요, 이번 배치 미수정)** | 휴무일 강제취소 시 수강권 횟수 미복구 |
| 수강권 | 완료 | **P1** | 권한키 불일치로 인한 무언(silent) 실패 |
| 상품관리 | 완료 | P3 | 의도적으로 권한 미세분화(P1-5 기록됨) |
| 결제관리 | 부분 구현 | **P1** | fulfill_order 반환값 불일치로 자동예약 안내 죽은 코드 |
| 매출 | 완료 | P1(기존 추적) | 포인트 원장 이원화 — 기존 P1-1, 이번에 실사용 버그로 재확인 |
| 문의 | 완료 | **P1** | 전송/조회 실패 무언 처리 — 매니저가 실패를 모름 |
| 공지 | 완료 | P3 | 특이사항 없음 |
| 알림(매니저) | 부분 구현 | P2 | 전체 페이지 리로드, 스키마만 있고 미구현인 발송 규칙(P3-6 기존) |
| 센터관리 | 완료 | P2 | 센터정보 수정이 오너 전용이라는 주석과 실제 권한 불일치 |
| 클래스/일정 외 기타(후기/진도) | 완료(진도 일부 죽은 코드) | P3 | `updateProgressNote` 미사용 |
| 운영설정 | **부분 구현** | **P1** | 17개 설정 중 다수(약 17/26 필드)가 UI만 있고 미시행 |
| Platform Admin(배너/카테고리/허브) | 완료 | — | 가드 정상, 문서만 stale이었음(정정 완료) |
| ManagerNav 도달성 | 문제 없음 | P3 | 고아 라우트 없음, 휴무일만 2단계 진입(의도적 IA로 판단) |

이번 배치(Track B)에서 실제로 **수정한 항목**은 P0/P1 중 **애플리케이션 코드만으로 고칠 수 있는 것**입니다.
P0(휴무일 수강권 미복구)는 RPC(SQL) 수정이 필요해 이번 규칙("SQL 실행 금지·새 RLS 수정
금지·DB 변경 금지")상 **이번 배치에서 고치지 않고 신규 TODO로만 기록**했습니다.

## 영역별 상세

### 1. 관리자 대시보드 (`app/manager/page.tsx`)
- **A**: 완료 — 센터 전환, 오늘 수업/예약, 출결, 회원 상세, 13개 메뉴(9개 권한 게이트, 4개 미게이트).
- **B**: `fetchMyCenters()`만 사용(의도된 설계, ACL-005). RLS: `add_roster_rls.sql` 정책 확인됨.
- **C**: `openMemberInfo`/`openRoster` 에러 시 시트가 안 닫힘(빈 시트 노출). **이번에 수정함.**
- **D**: P1-5(권한 미세분화 4개 메뉴).
- **E**: 일괄 출결 처리, 명단 검색/정렬 없음.

### 2. 회원관리 (`app/manager/members/`)
- **A**: 완료. "담당회원"/"상담고객" 탭은 안내만 표시.
- **B**: `fetchMyCenters()` + RLS(`add_member_management.sql`, `fix_member_status.sql`) 양호.
- **C**: 검색 debounce 중 센터 전환 시 race 가능성(경미).
- **D**: P1-8(담당회원/상담고객 미완성).
- **E**: 일괄 등급변경, 정렬 옵션, 탈퇴 처리 없음.

### 3. 스태프관리 (`app/manager/staff/page.tsx`)
- **A**: 완료.
- **B**: `manager_centers`/`center_roles` SELECT는 소속이면 role 무관 조회 가능(쓰기만 권한 필요) — 기존에 문서화된 의도적 패턴.
- **C**: 검색 결과 10개 cap에 "더보기" 없음, 역할 삭제 시 소속 스태프의 role_id 처리 결과가 화면에 안내되지 않음.
- **D**: P0-4(RLS 회귀 테스트), P1-6.
- **E**: 초대 취소/재발송, 활동 로그 없음.

### 4. 권한관리 (`app/manager/staff/permissions/page.tsx`)
- **A**: 완료 — `isOwnerOfCenter()` 기반 강한 클라이언트 가드(ACL-003).
- **B**: **이미 수정된 사항 재확인**: `account_center_permissions` SELECT는 2026-08-02 실행된 fix로 이미 "본인 것 또는 facility.role_permission 보유자"로 좁혀져 있음(문서 정정 완료, 위 CHANGELOG 참고). 다만 클라이언트 가드(오너만 화면 진입)와 서버 쓰기 정책(`facility.role_permission` 보유자도 가능)이 불일치 — 오너가 다른 매니저에게 이 권한을 줘도 그 매니저는 화면 자체에 못 들어감(기능 격차, 취약점 아님).
- **C**: `cycle()` 저장 실패 시 로컬 상태 롤백 안 함(다음 새로고침 전까지 UI·서버 불일치 가능).
- **D**: 위 B 항목은 P0-4에 이미 최신 상태로 기록.
- **E**: 권한 변경 이력(감사 로그) 없음.

### 5. 예약관리 (`app/manager/classes/page.tsx` 예약 파트, `app/manager/admin-assignments/page.tsx`)
- **A**: 완료 — 직접배치/무료배치/취소/보강예약/배치로그.
- **B**: RPC 내부 `can_manage_center_reservations()`가 서버에서 이중예약·정원을 `for update` 락으로 원자적 검증 — 안전.
- **C**: 특이사항 없음.
- **D**: P1-9(세부 permission key), P1-10(회원상태 차단), P1-11(정원초과 테스트).
- **E**: 통계/엑셀 다운로드 범위 제외(문서화됨).

### 6. 출석관리
- **A**: 완료.
- **C**: `manager_set_attendance` RPC가 여러 SQL 파일에 중복 정의된 이력 — 최종본 확인은 P0-3이 이미 추적.
- **E**: 노쇼 자동 처리, 일괄 출석 처리 없음.

### 7. 클래스관리 (`app/manager/classes/page.tsx` CRUD 파트, `lib/classes.ts`)
- **A**: 완료.
- **B**: `center_id in my_managed_center_ids()`만 확인(권한 미세분화, P1-5 범주).
- **C (이번에 발견)**:
  1. `lib/classes.ts`의 구버전 `previewCopySchedule`/`copySchedule`(nth-weekday 방식)이 더 이상 화면에서 호출되지 않는 죽은 코드로 남아있음.
  2. 반복수업 생성(`perDayMode`)이 요일별로 순차 `await` 호출 — 트랜잭션 아님, 중간 실패 시 일부만 생성됨.
  3. `updateClassGroup`이 그룹 내 각 수업을 개별 update로 순회 — 원자성 없음.
- **D**: 없음(신규 발견).
- **E**: 없음.

### 8. 일정관리 (휴무일/룸) (`app/manager/holidays/page.tsx`, `app/manager/rooms/page.tsx`)
- **A**: 완료.
- **B**: `rooms` SELECT가 `using (true)`로 완전 공개(로그인 불필요) — PII는 아니나 의도 확인 필요.
- **C (이번에 발견, P0급)**: `add_holiday_safe` RPC가 확정/대기/출석 예약을 강제 삭제하면서 **`memberships.remaining_count`를 복구하지 않음**. 같은 취소 성격의 `admin_cancel_reservation`/`manager_set_attendance`는 정확히 +1 복구하는 것과 대조적 — 매니저가 예약자 있는 날을 휴무일로 지정하면 회원이 수강권 횟수를 영구히 잃는 실질적 금전/재화 손실 버그. **SQL(RPC) 수정이 필요해 이번 배치에서 고치지 않고 새 TODO(P0)로 기록.**
  또한 `add_holiday_safe`가 "수업그룹 삭제" 권한 키(`schedule.own.group.delete`)를 "휴무일 지정"에 재사용 — 의미상 부정확한 매핑(오너는 무관하나 세분권한 도입 시 혼란 소지, SQL 필요라 미수정).
- **D**: 신규 발견, 기존 TODO 없음.
- **E**: 반복(정기) 휴무일 등록 불가, 룸별 시간대 중복 방지 없음.

### 9. 수강권 (`app/manager/membership-rules/page.tsx`)
- **A**: 완료.
- **B**: `products` 쓰기는 권한 미세분화(P1-5), `membership_schedule_rules`는 `pass.update` 요구 — 메뉴 게이트(`pass.create`)와 실제 필요 권한(`pass.update`) 불일치.
- **C (이번에 발견)**: `handleCreateProduct`에서 규칙 생성 실패를 `catch {/* 무시 */}`로 삼킴 — 상품은 만들어졌는데 요일/시간 규칙만 조용히 실패해도 매니저는 모름. **이번에 수정함.**
- **D**: P1-5.
- **E**: 수강권 상품 수정 불가(생성/삭제만).

### 10. 상품관리 (`app/manager/goods/page.tsx`)
- **A**: 완료.
- **B**: 권한 카탈로그에 대응 키 없음(의도적 무제한 — 이미 코드 주석에 명시).
- **C/D/E**: 특이사항 없음(P1-5에 이미 포함).

### 11. 결제관리 (`app/manager/orders/page.tsx`, `lib/orders.ts`)
- **A**: 부분 구현. 확정/취소는 서버(`fulfill_order` RPC)가 이미 관리자 소속을 검증하고 원자적으로 처리.
- **B**: 클라이언트 가드 없음(의도적, P1-5), 서버 RPC는 안전.
- **C (이번에 발견)**: `fulfill_order`는 실제로 `{already_done, membership_id, amount}`만 반환하는데, `lib/orders.ts`는 `data.auto_booked`/`data.remaining`을 기대 — 항상 `undefined`가 되어 "N개 수업 자동예약" 안내 분기가 영구 죽은 코드. 자동예약 자체(`auto_book_membership`)는 RPC 내부에서 정상 동작하지만 매니저에게 그 결과가 전달되지 않음. **이번에 수정함**(클라이언트 토스트 로직만 존재하는 반환값에 맞게 정리, RPC/SQL은 변경하지 않음).
- **D**: P1-2(환불 정책), P1-5.
- **E**: 실제 PG 미연동(P0-1이 이미 추적), 부분 환불 UI 없음.

### 12. 매출 (`app/manager/sales/page.tsx`, `lib/sales.ts`)
- **A**: 완료.
- **B**: `payments`는 `pass.sales.view`/`pass.payment.*`로 정확히 게이트. `expenses`/`point_transactions`는 센터 소속만 확인(미세분화).
- **C**: **기존 P1-1(포인트 원장 이원화)이 실사용 버그임을 재확인** — 매출관리의 포인트 등록(`point_transactions`)과 회원 앱이 보는 잔액(`point_accounts`)이 서로 다른 테이블이라 매니저가 포인트를 등록해도 회원 화면 잔액에 반영 안 됨. SQL/제품 정책 결정이 필요해 이번 배치에서 손대지 않음(기존 P1-1 유지).
- **D**: P1-1(정확히 일치), P2-5.
- **E**: 결제 내역 수정 불가, 영수증 발급 없음.

### 13. 문의 (`app/manager/inquiries/page.tsx`, `app/components/InquiryChat.tsx`)
- **A**: 완료.
- **B**: `fetchMyCenters()` + RLS(`add_inquiries.sql`) 양호, 쓰기는 security-definer RPC 경유로 안전.
- **C (이번에 발견)**: `InquiryChat.tsx`의 조회/전송/사진첨부 실패가 전부 `catch {/* 무시 */}` — 매니저가 답장을 보냈다고 생각했는데 실제로는 실패했을 수 있음(가장 사용자 체감 영향이 큰 버그 중 하나). **이번에 수정함.**
- **D**: P2-2(Realtime RLS 운영 확인).
- **E**: 문의별 권한 세분화 없음(전 스태프가 전체 열람 가능 — 의도 여부 미확정, 새 TODO로만 기록).

### 14. 공지 (`app/manager/announcements/page.tsx`)
- **A**: 완료.
- **B**: RLS(`add_announcements.sql`) 센터 소속 기준 양호, 에러 처리도 `setError`로 정상 노출.
- **C/D/E**: 특이사항 없음.

### 15. 알림(매니저용) (`app/manager/notifications/page.tsx`)
- **A**: 부분 구현 — 인앱 알림 피드는 완료, `notification_rules`/`messages`(자동 SMS 규칙, 대량발송)는 스키마만 있고 코드 참조 0건(기존 P3-6이 이미 결론 냄: 미구현 기능).
- **B**: RLS(`add_notifications.sql`) 본인 것만, 쓰기는 RPC 경유 — 안전.
- **C (이번에 발견)**: `handleClick`이 `window.location.href` 전체 페이지 리로드 사용 — SPA 상태 손실, 불필요하게 느림. **이번에 수정함(Next.js 라우터로 교체).**
- **D**: P0-5(알림 스케줄러), P1-3(외부 발송), P2-2, P3-6.
- **E**: 실제 SMS/알림톡 발송 없음(이미 추적됨).

### 16. 센터관리 (`app/manager/center-info/page.tsx`, `app/admin/centers/page.tsx`)
- **A**: 완료 — 매니저 정보수정, 플랫폼 승인/반려 플로우 전부 종단 검증됨(상태변경은 `guard_center_status_change` 트리거로 `is_platform_admin()`만 허용 — 매니저가 직접 `.update()` 호출해도 트리거가 막음, 안전 확인).
- **B (이번에 발견)**: `center-info/page.tsx` 주석은 "시설 정보 설정 권한(facility.info) 필요 — 오너는 항상 가능"이라 적혀 있지만, 실제 RLS(`매니저 센터 수정` 정책)는 `center_id in my_managed_center_ids()`만 확인 — **오너가 아닌 일반 스태프도 센터 정보/결제수단/평판점수를 수정할 수 있음**, 주석과 실제 동작 불일치. 새 TODO로 기록(권한 세분화는 P1-5 범주와 겹침, RLS 변경 필요해 이번 배치 미수정).
- **C**: 센터 승인/반려 시 센터 오너에게 알림이 안 감(다른 이벤트는 대부분 알림 발생).
- **D**: P1-6(admin/centers 가드는 이미 반영 확인).
- **E**: 승인/반려 감사 로그(누가/언제) 없음.

### 17. 운영설정 (`app/manager/settings/page.tsx`)
- **A (이번에 발견, 중요)**: 부분 구현 — 화면에 17개 항목이 모두 표시되고 저장도 되지만, **약 17개 필드(당일예약 허용, 대기 자동승격 시간, 일일예약 제한, 락커 사용, 라운지 사용 등)가 실제로 어떤 예약/조회 RPC에서도 읽히지 않음**(전수 grep 결과 스키마·`lib/settings.ts` 외 참조 0건). 매니저가 설정을 바꿔도 실제 앱 동작에 아무 영향이 없음 — "저장은 되는데 적용은 안 되는" 신뢰 저하 버그. 9개 필드(사전예약 마감시각류, 노쇼 시 자동차감)만 실제로 `calc_deadline()`/`cancel_reservation()`에서 사용됨.
- **B**: `facility.operation` 권한으로 쓰기 게이트 — 정상.
- **C**: 위 A와 동일 건.
- **D**: 신규 발견, 기존 TODO 없음.
- **E**: 없음(기능은 다 있어 보이지만 무효).

### 진도관리 (`app/manager/progress/`, 기타 항목)
- **A**: 완료.
- **C (이번에 발견)**: `updateProgressNote()`가 `lib/progress.ts`에 정의·import는 되어 있으나 어디서도 호출되지 않는 죽은 코드. 게다가 `progress_records`에는 UPDATE RLS 정책 자체가 없어(SELECT/INSERT/DELETE만 존재) 만약 나중에 이 함수가 호출되면 RLS로 막힘. **이번에 죽은 import만 정리함**(RLS 추가는 SQL이라 미수정, 새 TODO로 기록).

### Platform Admin (배너/카테고리/허브)
- **A/B**: 완료, `checkPlatformAdmin()` 가드 전부 정상 확인. **`docs/ROUTES.md`가 "가드 없음"으로 stale하게 기술돼 있던 것을 정정함**(이번에 수정).

### ManagerNav 도달성
- 19개 매니저 라우트 전수 확인 — 고아 라우트(URL 직접 입력 외 접근 불가) 없음. `/manager/holidays`만 클래스 화면 내부에서만 링크됨(대시보드 메뉴·하단 네비 어디에도 없음) — 정보구조상 합리적 배치로 판단해 이번엔 변경하지 않음(P3, 필요시 별도 논의).
