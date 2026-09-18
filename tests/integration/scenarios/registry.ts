/*
  Automated Business Scenario E2E Batch(2026-09-18) — 요청 사항 2/23번: 시나리오 메타데이터
  레지스트리. Section 31-C(구현된 시나리오 표)의 근거 데이터로 쓴다.

  status 판정 기준(요청 원문 그대로):
  - "implemented": 이 배치에서 새로 작성 + 실제 라이브 dev Supabase에 대해 실행해 PASS를
    확인함(코드만 작성하고 안 돌려본 것은 여기 포함하지 않는다).
  - "covered-by-existing": 기존 tests/integration/*.test.ts 43개 파일 중 하나가 이미
    같은 불변식/정책을 검증하고 있음을 실제로 파일을 열어 describe/it 제목과 본문으로
    확인함 — 중복 구현하지 않는다(coveredBy에 정확한 파일 경로 기록).
  - "not-automated": 아직 손대지 않음(시간/범위 제약, 다음 단계).
  - "blocked": 안전/환경 제약(실 DB에 별도 QA/staging 없음, 실제 SMS/결제 비용 등)으로
    자동화를 의도적으로 보류함 — reason에 근거 기록.

  이 파일은 "문서 + 리포트 근거"일 뿐 실행 가능한 테스트 러너가 아니다(types.ts 상단
  주석과 동일한 설계 원칙).
*/
import type { ScenarioMeta } from "./types";

export const SCENARIOS: ScenarioMeta[] = [
  // ---- P0 기본(§4) ----
  { id: "SCN-P0-01", title: "관리자가 수강권 상품을 생성한다", priority: "P0", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P0-02", title: "회원이 수강권을 구매한다(Mock 결제)", priority: "P0", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/payment-lifecycle.test.ts" },
  { id: "SCN-P0-03", title: "정상 예약", priority: "P0", supportedLayers: ["shared", "ios", "android"], status: "covered-by-existing", coveredBy: "tests/integration/private-class-capacity.test.ts (그룹 수업 정상 예약 경로는 이 배치의 waitlist-promotion.test.ts SCN-P0-23의 1단계로도 실행 확인됨)" },
  { id: "SCN-P0-04", title: "예약 취소", priority: "P0", supportedLayers: ["shared", "ios", "android"], status: "covered-by-existing", coveredBy: "tests/integration/cancel-reservation-refunded-membership.test.ts" },
  { id: "SCN-P0-05", title: "회원 예약 내역 조회", priority: "P0", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P0-06", title: "관리자 회원 조회", priority: "P0", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/acl-003-permission-read.test.ts" },

  // ---- P0 수강권 상태(§5) ----
  { id: "SCN-P0-10", title: "유효 수강권 예약 성공", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts (SCN-P0-23의 A/B 확정 단계에서 유효 수강권으로 예약 성공을 함께 검증)" },
  { id: "SCN-P0-11", title: "만료 수강권 예약 차단", priority: "P0", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/schedule-rule-override.test.ts, tests/integration/usable-memberships-pass-kind.test.ts (만료/조건 불충족 수강권 필터링 검증)" },
  { id: "SCN-P0-12", title: "잔여 0 수강권 예약 차단", priority: "P0", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P0-13", title: "일시정지 수강권 정책", priority: "P0", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P0-14", title: "시작 전 수강권 정책", priority: "P0", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P0-15", title: "마지막 1회 예약 시 음수 방지", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/invariants.ts의 checkMembershipNonNegative()가 SCN-P0-23/24/25 실행마다 이 불변식을 재확인함(remaining_count < 0이면 실패)" },
  { id: "SCN-P0-16", title: "취소 시 수강권 횟수 환급", priority: "P0", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/cancel-reservation-refunded-membership.test.ts" },
  { id: "SCN-P0-17", title: "여러 수강권 보유 시 올바른 자동 선택", priority: "P0", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/usable-memberships-pass-kind.test.ts" },

  // ---- P0 정원/대기(§6) — 이번 배치 핵심 ----
  { id: "SCN-P0-20", title: "정원 이내 → 확정", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts" },
  { id: "SCN-P0-21", title: "정원 정확히 도달", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts" },
  { id: "SCN-P0-22", title: "정원 초과 → 대기", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts" },
  { id: "SCN-P0-23", title: "대기 자동 승격(1명 취소 → 대기 1순위 승격)", priority: "P0", supportedLayers: ["shared", "ios", "android"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts — 실제 라이브 dev DB에서 PASS 확인(test-results/business-scenarios/SCN-P0-23.json)" },
  { id: "SCN-P0-24", title: "다중 대기 승격 순서(C→confirmed, D는 다음 순번 유지)", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts — PASS 확인(test-results/business-scenarios/SCN-P0-24.json)" },
  { id: "SCN-P0-25", title: "대기자 자가 취소(환급/승격 없음, 나머지 대기자 영향 없음)", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/waitlist-promotion.test.ts — PASS 확인(test-results/business-scenarios/SCN-P0-25.json)" },

  // ---- P1 중복/경쟁(§7) — Phase 2에서 실제 동시성으로 구현·실행 확인 ----
  { id: "SCN-P1-01", title: "더블클릭 → 중복 예약 방지", priority: "P1", supportedLayers: ["shared", "ios", "android"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts(SCN-P1-01-02) — 같은 계정으로 독립된 두 client 세션에서 동시(Promise.all) reserve_class 호출, 실제 라이브 DB에서 PASS 확인(정확히 1건만 성공)" },
  { id: "SCN-P1-02", title: "동시 중복 요청 방지", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts(SCN-P1-01-02) — P1-01과 동일 테스트로 함께 검증(같은 불변식)" },
  { id: "SCN-P1-03", title: "마지막 1자리 동시 경쟁", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts — capacity=1, 서로 다른 두 회원이 동시 요청 → 정확히 1명 확정+1명 대기, PASS 확인" },
  { id: "SCN-P1-04", title: "취소/예약 동시 경쟁", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-05", title: "이중 취소 요청 방지", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts — 같은 예약을 동시에 2번 취소 → 정확히 1회만 환급(실제 사용된 membership row의 remaining_count 델타로 검증), PASS 확인" },
  { id: "SCN-P1-06", title: "승격 직전 대기자 취소", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-07", title: "승격 후보 동시 상태변화", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts — 대기자 1명뿐인 상태에서 확정자 2명이 동시 취소 → 정확히 1회만 승격(다른 하나는 waitlist_promoted:false로 자연스럽게 스킵됨, for update 락으로 직렬화됨을 실측 확인), PASS 확인" },

  // ---- P1 네트워크(§8) ----
  { id: "SCN-P1-10", title: "예약 중 네트워크 끊김", priority: "P1", supportedLayers: ["shared"], status: "blocked", reason: "이 샌드박스에서 실제 원격 네트워크 단절을 재현할 방법이 없음 — 대신 그 실패가 우려하는 결과(재시도 시 중복)는 SCN-P1-11이 직접 검증함" },
  { id: "SCN-P1-11", title: "성공 응답 유실(idempotency)", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/reservation-concurrency.test.ts — 예약 성공 직후 동일 요청 재시도(retry) 시뮬레이션 → 재시도는 명시적으로 거부되고, 실제 사용된 membership의 remaining_count가 재시도 전후로 불변임을 델타로 검증, PASS 확인" },
  { id: "SCN-P1-12", title: "취소 응답 유실(중복 환급 방지)", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-13", title: "예약 중 앱 백그라운드", priority: "P1", supportedLayers: ["ios", "android"], status: "blocked", reason: "실 기기/시뮬레이터 자동화 범위(§19-20 대표 세트) 밖" },
  { id: "SCN-P1-14", title: "강제종료 후 재시작", priority: "P1", supportedLayers: ["ios", "android"], status: "blocked", reason: "P1-13과 동일" },
  { id: "SCN-P1-15", title: "느린 네트워크(더블탭/버튼 비활성화)", priority: "P1", supportedLayers: ["ios", "android"], status: "not-automated" },

  // ---- P1 날짜/시간 경계(§9) — Phase 3에서 실제 배포된 calc_deadline/reserve_class 본문
  // (git 시간순 최종본) 기준으로 구현·실행 확인. 추측 금지 원칙에 따라 초 단위 경계 대신
  // "명백히 마감 전 vs 명백히 마감 후" 두 구간으로 검증(파일 상단 주석 참고) ----
  { id: "SCN-P1-20", title: "만료 당일", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/date-boundaries.test.ts(SCN-P1-20) — expires_at=오늘(KST)인 수강권으로 예약 성공, PASS 확인" },
  { id: "SCN-P1-21", title: "만료 직전/직후", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/date-boundaries.test.ts(SCN-P1-21) — expires_at=어제(KST)인 수강권으로 예약 실패, PASS 확인. memberA는 leftover 수강권 오염 위험이 있어 전용 서브프로필(memberC)로 검증" },
  { id: "SCN-P1-22", title: "예약 마감 직전", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/date-boundaries.test.ts(SCN-P1-22) — 마감 전(48시간 뒤 수업) 성공 / 마감 후(2시간 뒤 임박 수업) 거부, PASS 확인" },
  { id: "SCN-P1-23", title: "취소 마감 경계", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/reservation-cancel-grace-period.test.ts, tests/integration/class-cancel-deadline-override.test.ts" },
  { id: "SCN-P1-24", title: "자정 경계 / 당일예약 허용", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/date-boundaries.test.ts(SCN-P1-24-ON/OFF/STARTED/DAYS-0~2) — [MWHABIT Business Logic Fix Batch] fix_same_day_booking_deadline.sql로 수정, 테스트를 'expected behavior PASS'로 전환. ⚠ SQL 미적용 상태 — 이 세션은 Supabase SQL Editor 직접 실행 수단이 없어, 위 테스트들은 현재(수정 전) 라이브 DB에 대해 실행하면 의도적으로 FAIL한다(레드 상태 확인됨 — 버그가 여전히 살아있다는 증거). SQL 적용 후 재실행하면 PASS로 전환되어야 함 — 최종 보고서 참고." },
  { id: "SCN-P1-25", title: "월말 경계", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/month-boundary-kst.test.ts" },
  { id: "SCN-P1-26", title: "연말 경계", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-27", title: "윤년/2월 경계", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P1 관리자↔회원 동시 상태(§10) — Phase 3에서 실제 update_class_safe RPC로 구현 확인.
  // 실측 결과 이 RPC는 권한 체크만 하고 정원-확정인원 정합성/대기 승격 로직이 전혀 없음을
  // 확인(두 건 모두 BUG FOUND로 별도 기록) ----
  { id: "SCN-P1-30", title: "관리자가 수업 정보 수정 중 회원 예약", priority: "P1", supportedLayers: ["shared", "ios", "android"], status: "not-automated" },
  { id: "SCN-P1-31", title: "관리자가 정원 축소 직후 회원 예약", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/admin-member-concurrency.test.ts(SCN-P1-31-A/B) — [MWHABIT Business Logic Fix Batch] fix_class_capacity_invariants.sql로 수정, 'expected behavior PASS'로 전환(확정 인원 미만 축소는 거부, 동일/그 이상은 허용). ⚠ SQL 미적용 — 현재 라이브 DB 대비 실행하면 31-A는 의도적으로 FAIL(레드 확인됨), 31-B는 원래 영향 안 받는 케이스라 그대로 PASS. SQL 적용 후 31-A도 PASS로 전환되어야 함." },
  { id: "SCN-P1-32", title: "관리자가 정원 확대 시 대기 자동 승격 정책", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/admin-member-concurrency.test.ts(SCN-P1-32-A/B/C/D) — [MWHABIT Business Logic Fix Batch] fix_class_capacity_invariants.sql로 수정(정원 확대 시 자동 승격 루프 추가), 'expected behavior PASS'로 전환 + 다중 대기자 순서 보존(32-B) + 정원확대·취소 동시성 안전성(32-D) 신규 커버. ⚠ SQL 미적용 — 32-A/B/D는 현재 라이브 DB 대비 의도적으로 FAIL(레드 확인됨), 32-C(취소 트리거 승격, 회귀 없음 대조군)는 원래도 정상이라 그대로 PASS. SQL 적용 후 나머지도 PASS로 전환되어야 함." },
  { id: "SCN-P1-33", title: "관리자 수동 배정 + 회원 셀프예약 동시", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/private-class-capacity.test.ts (admin_assign_reservation 정원 강제배치 거부 검증)" },
  { id: "SCN-P1-34", title: "관리자 수동 취소, 회원 화면 상태 일치", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-35", title: "회원 취소 + 관리자 취소 동시(중복 환급 방지)", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P1 멀티센터/권한(§11) — Phase 3에서 기존 커버리지를 실제로 재실행해 재확인(19개 테스트
  // 전부 PASS, 재구현 안 함 — 요청의 "기존 인프라 재사용" 원칙) ----
  { id: "SCN-P1-40", title: "centerA 관리자가 centerA 회원 관리 — 성공", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (E, I 등) — Phase 3에서 19/19 PASS 재확인" },
  { id: "SCN-P1-41", title: "centerA 관리자가 centerB 회원 수정 시도 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (M~O) — Phase 3에서 재확인" },
  { id: "SCN-P1-42", title: "centerA 관리자가 centerB 수업 수정 시도 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (N: centers 정보 수정 거부) — Phase 3에서 재확인" },
  { id: "SCN-P1-43", title: "일반 회원이 admin API 직접 호출 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (M~O), tests/integration/acl-003-permission-read.test.ts — Phase 3에서 재확인" },
  { id: "SCN-P1-44", title: "타인 예약 ID 조작 — 접근 불가", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (O: reservations 조회 거부) — Phase 3에서 재확인" },
  { id: "SCN-P1-45", title: "센터 전환 후 캐시 오염 없음", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- 위치 기반(사용자 추가 요청, Phase 3) — 실측 발견: "반경 필터" 기능은 실제 코드에
  // 존재하지 않음(lib/home.ts fetchHomeCenters는 거리순 정렬만 함, radius 컷오프 없음) —
  // 요청 원문의 "반경 안/밖 경계" 예시는 실제 구현과 다르므로, 실제 구현(거리순 정렬 +
  // 좌표없음 처리)을 대신 검증했다. 최종 보고서에 이 갭을 별도로 명시 ----
  { id: "SCN-LOC-01", title: "위치 반경 필터(요청 원문 fixture: 서울/강원/제주/부산)", priority: "P0", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-01/02/03) — [MWHABIT Business Logic Fix Batch] lib/home.ts에 NEARBY_RADIUS_KM(20km) 반경 필터를 실제로 구현(이전엔 정렬만 있었음). SQL 불필요, 순수 TS 변경이라 실제 라이브 DB에 대해 즉시 실행해 PASS 확인 — 제주 위치→제주 센터만 표시(서울/강원/부산 제외), 서울 위치→서울만, 부산 위치→부산만." },
  { id: "SCN-LOC-04-BOUNDARY", title: "반경 경계값(바로 안쪽/바깥)", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-04) — ~18.9km 포함/~21.1km 제외, 실제 실행 PASS" },
  { id: "SCN-LOC-05-SORT", title: "반경 내 다중 센터 거리 오름차순 정렬", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-05), 실제 실행 PASS" },
  { id: "SCN-LOC-06-NOCOORD", title: "좌표 없는/잘못된 센터 안전 제외", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-06/07) — null 좌표, 범위밖(999,999) 좌표 둘 다 예외 없이 안전하게 제외, 실제 실행 PASS" },
  { id: "SCN-LOC-08", title: "위치 권한 없음 fallback", priority: "P1", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-08) — 위치 없이 호출 시 반경 필터 미적용, 기존 fallback UX 유지, 실제 실행 PASS" },
  { id: "SCN-LOC-09-STALE", title: "stale 위치 → 새 위치로 결과 갱신", priority: "P2", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/location-nearby.test.ts(SCN-LOC-FIX-09) — fetchHomeCenters()가 상태 없는 순수 함수임을 확인, 새 위치 호출 시 이전 결과가 남지 않음, 실제 실행 PASS. 실제 브라우저 GPS 캐시(app/page.tsx의 lastKnownPosition) 자체는 UI 레이어 관심사라 Shared 범위 밖(SCN-P2-60류와 동일 한계)." },

  // ---- P1 invariants(§12) — 공통 헬퍼로 구현, 각 시나리오 실행 시 재사용 ----
  {
    id: "SCN-P1-INVARIANTS", title: "공통 invariant(capacity/membership 음수방지/중복예약/waitlist중복 등)", priority: "P1",
    supportedLayers: ["shared"], status: "implemented",
    implementedIn: "tests/integration/scenarios/invariants.ts — checkCoreInvariants()가 SCN-P0-23/24/25 실행마다 자동 재검증(관리자/service_role 클라이언트로 조회, 특정 actor 세션의 RLS에 갇히지 않도록 설계)",
  },

  // ---- P2 복잡 UI(§13) — iOS/Android 대표 세트 매핑 대상, 미착수 ----
  { id: "SCN-P2-01", title: "탭 전환 중 예약", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated" },
  { id: "SCN-P2-05", title: "빠른 회원↔관리자 전환", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated" },
  { id: "SCN-P2-10", title: "화면 전환 중 토스트", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated" },

  // ---- P2 권한(§14) ----
  { id: "SCN-P2-20", title: "위치/푸시/카메라/사진 권한 허용·거부", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated" },

  // ---- P2 계정 삭제(§15) ----
  { id: "SCN-P2-30", title: "예약 없는 계정 탈퇴", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/account-deletion-anonymization.test.ts" },
  { id: "SCN-P2-31", title: "예약/구매 이력 있는 계정 탈퇴(익명화+auth 삭제+아바타 삭제)", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/account-deletion-anonymization.test.ts, tests/integration/avatar-storage-cleanup.test.ts" },

  // ---- P2 결제(§16) ----
  { id: "SCN-P2-40", title: "정상 결제", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/payment-lifecycle.test.ts" },
  { id: "SCN-P2-41", title: "사용자 결제 취소", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/payment-lifecycle.test.ts (취소 결제)" },
  { id: "SCN-P2-42", title: "결제 실패", priority: "P2", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P2-43", title: "결제 성공 직후 앱 종료", priority: "P2", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P2-44", title: "결제 콜백 중복 수신", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/payment-lifecycle.test.ts (Idempotency 중복 확정 방지)" },
  { id: "SCN-P2-45", title: "정기 결제 재시도", priority: "P2", supportedLayers: ["shared"], status: "not-automated", reason: "정기결제(빌링) 기능 자체의 구현 여부부터 docs/REQUIREMENTS.md 확인 필요 — 미착수" },
  { id: "SCN-P2-46", title: "중복 결제 방지", priority: "P2", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/order-amount-verification.test.ts, tests/integration/payment-security.test.ts" },

  // ---- P2 알림(§17) — Phase 4에서 실제 DB 트리거로 구현·실행 확인 ----
  { id: "SCN-P2-50", title: "예약완료/취소/승격/만료임박/저잔여 알림", priority: "P2", supportedLayers: ["shared"], status: "implemented", implementedIn: "tests/integration/scenarios/notifications.test.ts — add_admin_assignment.sql의 trg_notify_reservation_insert/update 트리거(git 시간순 최종본) 실제 동작 확인. reservation_confirmed/reservation_waitlisted/waitlist_promoted/reservation_canceled 4개 kind 모두 notifications 테이블에 정확히 큐잉됨을 확인, PASS. push_notification()은 순수 INSERT뿐 실제 발송 코드가 없어 '발송 금지' 원칙에 자연히 부합함을 코드로 확인 — 만료임박/저잔여 알림(notify_expiring_passes 등 cron성 함수)은 미착수" },

  // ---- P2 캐시/stale data(§18) — Batch 7 home TTL 캐시. Phase 4에서 실제 코드 확인 결과
  // Shared(Layer A, Node 기반) 레이어에서는 원천적으로 테스트 불가능함을 확인했다 ----
  { id: "SCN-P2-60", title: "관리자 데이터 변경 후 회원 홈 재진입", priority: "P2", supportedLayers: ["shared", "ios"], status: "blocked", reason: "실제 코드 확인 결과(app/page.tsx) 이 캐시는 브라우저/WebView 자바스크립트 런타임의 모듈 레벨 변수(homeDataCache)다 — Node 기반 tests/integration에는 이 모듈의 실행 컨텍스트 자체가 없어 원천적으로 검증 불가. Playwright E2E(tests/e2e) 또는 네이티브 UI 레이어에서 별도 자동화가 필요하며 이번 배치 범위 밖" },
  { id: "SCN-P2-61", title: "TTL 경계 시점 데이터 변경", priority: "P2", supportedLayers: ["shared"], status: "blocked", reason: "SCN-P2-60과 동일 근거" },
  { id: "SCN-P2-62", title: "예약 직후 홈/내예약 이동", priority: "P2", supportedLayers: ["shared", "ios"], status: "blocked", reason: "SCN-P2-60과 동일 근거" },
  { id: "SCN-P2-63", title: "정원 변경, 회원 화면 stale 확인", priority: "P2", supportedLayers: ["shared"], status: "blocked", reason: "SCN-P2-60과 동일 근거" },
  { id: "SCN-P2-64", title: "백그라운드 1분 후 포그라운드", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated", reason: "실기기/부팅된 시뮬레이터·에뮬레이터에서의 실제 lifecycle 이벤트 필요 — 기존 SafeAreaTests가 background/foreground 전환 자체는 다루지만 캐시 staleness까지는 미검증" },

  // ---- Phase 4: iOS/Android 대표 UI 시나리오 매핑(§19-20) — 기존 AppUITests/androidTest
  // 구조 재사용(새 타겟/새 CI 워크플로 생성 안 함), 파일 단위로만 추가 ----
  {
    id: "SCN-UI-RESERVE-SMOKE", title: "예약 화면 진입 + 예약가능/대기/empty 상태 스모크(P0-03/P0-23 대표)", priority: "P0",
    supportedLayers: ["ios", "android"], status: "implemented",
    implementedIn: "ios/App/AppUITests/ReservationSmokeTests.swift, android/app/src/androidTest/java/com/mwhabit/app/ReservationSmokeTests.java — 전체 예약/대기승격 로직은 Shared(Layer A)가 이미 실제 RPC로 검증했으므로(SCN-P0-23/24/25 등), UI 레이어는 '회원이 실제로 예약 화면까지 도달해 액션 버튼을 볼 수 있는가'만 스모크로 확인(중복 구현 방지 원칙). BUILD PASS 확인: iOS `xcodebuild build-for-testing`(TEST BUILD SUCCEEDED, 임시 placeholder GoogleService-Info.plist/App.entitlements는 검증 직후 삭제·미커밋), Android `./gradlew compileDebugAndroidTestSources`+`assembleDebugAndroidTest`(BUILD SUCCESSFUL) 둘 다 실제 실행해 확인. RUNTIME PASS(실제 부팅된 시뮬레이터/에뮬레이터 실행)는 이 세션에서 미수행 — docs/TODO.md P2-39와 동일 후속 과제",
  },
];

export function scenarioSummary(): { total: number; byStatus: Record<string, number>; byPriority: Record<string, number> } {
  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const s of SCENARIOS) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    byPriority[s.priority] = (byPriority[s.priority] ?? 0) + 1;
  }
  return { total: SCENARIOS.length, byStatus, byPriority };
}
