# 성능 최적화 Sprint (2026-10-10) — 추적표 / 병합 순서 / 한계

기준 main `f3828a9`. 구현은 Batch별 브랜치(아래)에 있고 **모두 미병합**이다. 이 문서는 docs 전용 브랜치에 있다.
태그: MEASURED(실측) / CODE-INFERRED(코드 구조) / NOT VERIFIED. 요청 수·직렬 단계 수치는 별도 표기가 없으면 CODE-INFERRED(실제 ms 개선은 NOT VERIFIED).

## Batch → 브랜치
| Batch | 브랜치 | 커밋 | 영역 |
|---|---|---|---|
| A | perf/member-home-center-20261010 | f943ea1 | 회원 홈·검색·센터 상세 |
| B | perf/member-reservation-20261010 | 4b19fed | 회원 예약·내 예약·마이페이지 |
| C | perf/manager-classes-calendar-20261010 | a99881c | 센터 관리자 수업·캘린더·홈 |
| D | perf/manager-members-20261010 | 19b3455 | 센터 관리자 회원(1,000행 상한) |
| E | perf/manager-products-sales-20261010 | bde5ac8 | 상품·이용권·매출·기타 관리자 화면 |
| F | perf/shared-auth-realtime-bundle-20261010 | 4ee0c18 | 공통 인증·알림·스플래시 |
| G | (미착수) | – | 플랫폼 관리자 — PR #173 병합 후 |

## PERF 추적표
| ID | 항목 | 영역 | Batch | 상태 | 근거/변경 요약 |
|---|---|---|---|---|---|
| 001 | 홈 중복 계정·프로필 조회 | 사용자 | A | IMPLEMENTED | lib/home.ts: 홈 마운트 단위 ref로 profile id Promise 공유(요청 2개 감소) |
| 002 | 홈 병렬 로딩+30초 캐시 | 사용자 | A | VERIFIED-NO-CHANGE | 공개 데이터만 캐시, 항상 재조회해 덮어씀 |
| 003 | 센터 상세 직렬 await 7개 | 사용자 | A | IMPLEMENTED | 독립 6개 병렬, products→rules만 직렬(직렬 7→2단) |
| 004 | 허용 수강권 센터 전체 수업 조회 | 사용자 | A | DEFERRED-RISK | 좁히면 직렬 단계가 늘거나 표시가 달라짐 — 측정 후 결정 |
| 005 | 검색 중복/debounce | 사용자 | A | IMPLEMENTED(부분) | 칩 선택 시 350ms 뒤 중복 검색 제거, searchHome 내부 병렬 |
| 006 | 이미지·아이콘 lazy/CLS | 사용자 | A | VERIFIED-NO-CHANGE | 이미 lazy+decoding, 첫 화면 이미지는 lazy 금지 |
| 010 | 예약 화면 waterfall | 사용자 | B | IMPLEMENTED | getMyAccountId 2왕복→1, fetchMonthData 후반 4단→1단. 구매가능상품 선행조회는 egress 증가로 보류 |
| 011 | 예약 화면 리렌더 | 사용자 | B | NEEDS-MEASUREMENT | Profiler 없음 |
| 012 | 내 예약/마이페이지 직렬 | 사용자 | B | IMPLEMENTED(부분) | fetchMyPage 병렬(직렬 약 3단 감소). 이력 페이지네이션은 "더 보기" UI 없어 DEFERRED-RISK |
| 013 | 앱 복귀 최신성 | 사용자 | B | IMPLEMENTED | useResumeRefresh: 5분 이상 hidden일 때만 선택 재조회(실기기 NOT VERIFIED) |
| 014 | 내부 라우트 전체 재로드 | 사용자 | B | VERIFIED-NO-CHANGE | 소유 범위의 <a>는 의도된 것(인증/탭/결제). checkout·account-deletion은 후속 후보 |
| 015 | 수업 생성 후 상품 연결 부분 실패 | 센터관리자 | B | DEFERRED-RISK / NEEDS-SQL | lib/classes.ts:711,723 별도 INSERT — 서버 RPC 트랜잭션 후보 |
| 020 | loadClasses 중복 | 센터관리자 | C | IMPLEMENTED | 실제 Production 중복 확인, effect로 단일화 |
| 021 | 월 이동 시 정적 데이터 재조회 | 센터관리자 | C | IMPLEMENTED | 월 이동 요청 약 7~8개→1개 |
| 022 | stale response 경합 | 센터관리자 | C | IMPLEMENTED | 요청 generation 가드, 센터 전환 시 즉시 초기화 |
| 023 | 충돌검사 N+1·debounce | 센터관리자 | C | IMPLEMENTED | 300ms 디바운스 + 강사 일괄 조회. 서버 검증 불변 |
| 024 | 캘린더 렌더 | 센터관리자 | C | IMPLEMENTED(소규모) | 순수 함수+useMemo, 로컬 벤치 1,000개 5ms 미만(MEASURED, 로컬 Node) |
| 025 | classes 대형 컴포넌트 | 센터관리자 | C | DEFERRED-RISK | 대규모 리팩터링 승인 필요, 번들 측정 후 |
| 026 | 출석·예약 갱신 | 센터관리자 | C | VERIFIED-NO-CHANGE(+이중클릭 ref 가드) | RPC·낙관적 업데이트 불변 |
| 027 | 관리자 홈 | 센터관리자 | C | 일부 IMPLEMENTED | 출결 후 재조회 2개 병렬. 통계 RPC 유지 |
| 030 | PostgREST 1,000행 상한 | 센터관리자 | D | IMPLEMENTED(코드) / Production max-rows NEEDS-MEASUREMENT | 로컬 fixture에서 기존 코드는 1,001명 이상 1,000명만 반환·오류 무시 재현 → 전량 range 페이지네이션 |
| 031 | 회원 검색 4단 직렬 | 센터관리자 | D | IMPLEMENTED | 직렬 4→2단, 키 입력당 재조회 0회(보관본 필터) |
| 032 | .in() URL 길이 | 센터관리자 | D | IMPLEMENTED | 150개 청크 |
| 033 | 서버 검색/페이지네이션 | 센터관리자 | D | IMPLEMENTED(코드) / NEEDS-SQL | 서버 검색 RPC는 SQL 필요 — 큰 센터는 요청 수 증가 |
| 034 | 권한·전화 마스킹 유지 | 센터관리자 | D | VERIFIED-NO-CHANGE | fetch_member_phones_safe RPC 유지 |
| 035 | 확장성 테스트 | 센터관리자 | D | IMPLEMENTED | 50~20,000명 fixture 13개 |
| 040 | 규칙 N+1 | 센터관리자 | E | IMPLEMENTED | N+2→3요청, 결과 동일 테스트 |
| 041 | 가격표 100행 리렌더 | 센터관리자 | E | IMPLEMENTED(렌더 횟수 CODE-INFERRED) | memo(TierRow) |
| 042 | 매출 포인트 이력 | 센터관리자 | E | IMPLEMENTED | 탭 진입 시 1회+변경 후 갱신, fetchPayments range 페이징 |
| 043 | 공개범위 회원 조회 | 센터관리자 | E | IMPLEMENTED | 필요한 id만(요청 2개). 키워드 검색은 D 의존 |
| 044 | 미조사 관리자 화면 | 센터관리자 | E | 조사 완료, staff 수정 | 화면별 표는 E 보고서(orders/settings/rooms/holidays/coupons/goods/notifications/reviews/leads/alimtalk/progress/center-info/settlement/subscription/admin-assignments/inquiries/announcements/class-revenue) |
| 050 | 인증 왕복 | 공통 | F | IMPLEMENTED | in-flight 공유+2초 TTL+인증이벤트 무효화(실제 요청 감소 NEEDS-MEASUREMENT) |
| 051 | 알림 이중 구독 | 공통 | F | IMPLEMENTED | 구독 hub(채널 3→1) |
| 052 | 구독 전 언마운트 경합 | 공통 | F | IMPLEMENTED | |
| 053 | SessionWatcher | 공통 | F | VERIFIED-NO-CHANGE | |
| 054 | JS 번들/dynamic | 공통 | F | NEEDS-MEASUREMENT | 통합 빌드 비교: 라우트별 +1.5~4.8KB(코드 추가분, 감소 없음, MEASURED) |
| 055 | Leaflet CDN | 공통 | F | VERIFIED-NO-CHANGE | manager rooms/center-info에서만 로드 |
| 056 | CSS | 공통 | F | NEEDS-MEASUREMENT | 안전한 삭제 근거 없음 |
| 057 | 장시간 사용 | 공통 | F | 일부 IMPLEMENTED | 토스트 타이머 cleanup, 채널 정리 |
| 058 | 스플래시 상한 | 공통 | F | IMPLEMENTED(웹 코드만) | 8초 폴백. 네이티브 자체 타임아웃은 별도 승인(빌드 필요) |
| 060 | admin 탭 전환 시 관리자 재확인 | 플랫폼 | G | DEFERRED-DEPENDENCY | PR #173(app/admin/centers, lib/admin.ts) 병합 후 |
| 061 | 플랫폼 센터 목록 페이지네이션 | 플랫폼 | G | DEFERRED-DEPENDENCY | 동일 |
| 062 | 나머지 /admin 라우트 조사 | 플랫폼 | G | NEEDS-MEASUREMENT | 9개 라우트 중 centers만 분석됨 |
| 070 | DB 인덱스 후보 | DB | – | NEEDS-SQL | 저장소에 create index 없음 ≠ 누락. Production pg_indexes 확인 필요 |
| 071 | 기준선/실측(Web Vitals, 실기기) | 공통 | – | NOT VERIFIED | 실기기/Profiler 없음 |
| 072 | Production TTFB 변동 | 공통 | – | NOT VERIFIED | 단일 표본 3.95s 후 0.54s |

## 통합 검증 (모든 Batch 병합 시, 로컬)
충돌 없음(6개 브랜치 변경 파일 겹침 0). unit 184 files / 2,195 통과, Production build 통과, CI/dev Integration 346/346, E2E 체크포인트 1~4 = 18 / 13 / 17(+1 skip) / 27 통과. 번들: 대부분 라우트 +1.5~4.8KB(MEASURED, 압축 해제 firstLoad).
단, 로컬 E2E는 CI와 달리 포인터가 좌측 레일 위에 있지 않아 **사이드바 일요일 칸 문제(PR #175)**를 재현하지 못한다 — 아래 병합 순서의 #175를 먼저 병합해야 CI에서 안전하다.

## 권장 병합 순서
1. PR #175(E2E 캘린더/사이드바) — 이후 PR의 CI 안정화
2. PR #173(centers 민감 컬럼; SQL 2는 별도 사용자 실행), PR #174(Android 설정)
3. Batch F → A → B (공통 인증 변경을 먼저), 이후 C, D, E (파일 겹침 없음, 순서 자유)
4. Batch G(플랫폼 관리자) — #173 병합 후
CI는 같은 동시성 그룹이라 PR을 한 번에 하나씩 열어 순차 검증(대기 중 실행은 최신 것으로 대체됨).

## SQL
이번 Sprint에서 실행한 SQL 없음. 필요 후보: 회원 서버 검색 RPC, 수업+상품 연결 트랜잭션 RPC, 인덱스 후보(classes(center_id,start_time), memberships(profile_id,status), reservations(profile_id), profiles(account_id), manager_centers(account_id)) — Production 확인 후 별도 migration.

## 알려진 한계 / watch
- Batch D 브랜치에서 unit 1건이 한 번 실패했다가 4회 재실행 모두 통과(테스트 특정 못함). Batch B 보고: memberReservationUi 대기예약 케이스가 동시 실행에서 간헐 실패(단독 8회 통과).
- 회원 주소를 center_members 임베드로 읽도록 바꿈(Batch D) — 실제 DB 스모크 필요.
- 센터 전환 직후 목록이 잠깐 비어 보일 수 있음(Batch C, 의도된 초기화).
- 모든 요청 수 개선은 CODE-INFERRED, 실제 지연(ms)은 NOT VERIFIED(실기기·Profiler·Production 측정 필요).
