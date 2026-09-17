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

  // ---- P1 중복/경쟁(§7) ----
  { id: "SCN-P1-01", title: "더블클릭 → 중복 예약 방지", priority: "P1", supportedLayers: ["shared", "ios", "android"], status: "not-automated", reason: "schema.sql의 unique_active_reservation UNIQUE INDEX(class_id, profile_id where status in (confirmed,waitlisted))가 DB 레벨에서 이미 구조적으로 보장 — 다음 단계에서 확인 테스트만 추가하면 됨" },
  { id: "SCN-P1-02", title: "동시 중복 요청 방지", priority: "P1", supportedLayers: ["shared"], status: "not-automated", reason: "P1-01과 동일 근거(unique_active_reservation)" },
  { id: "SCN-P1-03", title: "마지막 1자리 동시 경쟁", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-04", title: "취소/예약 동시 경쟁", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-05", title: "이중 취소 요청 방지", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-06", title: "승격 직전 대기자 취소", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-07", title: "승격 후보 동시 상태변화", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P1 네트워크(§8) ----
  { id: "SCN-P1-10", title: "예약 중 네트워크 끊김", priority: "P1", supportedLayers: ["shared"], status: "blocked", reason: "이 샌드박스에서 실제 원격 네트워크 단절을 재현할 방법이 없음 — RPC 자체의 서버측 원자성(단일 트랜잭션)으로 간접 보장되지만 클라이언트 재시도 UX까지는 검증 불가" },
  { id: "SCN-P1-11", title: "성공 응답 유실(idempotency)", priority: "P1", supportedLayers: ["shared"], status: "blocked", reason: "unique_active_reservation이 재시도 시 중복 삽입을 DB 레벨에서 막아줌(간접 보장) — 클라이언트 재시도 흐름 자체는 이 배치 범위에서 미검증" },
  { id: "SCN-P1-12", title: "취소 응답 유실(중복 환급 방지)", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-13", title: "예약 중 앱 백그라운드", priority: "P1", supportedLayers: ["ios", "android"], status: "blocked", reason: "실 기기/시뮬레이터 자동화 범위(§19-20 대표 세트) 밖" },
  { id: "SCN-P1-14", title: "강제종료 후 재시작", priority: "P1", supportedLayers: ["ios", "android"], status: "blocked", reason: "P1-13과 동일" },
  { id: "SCN-P1-15", title: "느린 네트워크(더블탭/버튼 비활성화)", priority: "P1", supportedLayers: ["ios", "android"], status: "not-automated" },

  // ---- P1 날짜/시간 경계(§9) ----
  { id: "SCN-P1-20", title: "만료 당일", priority: "P1", supportedLayers: ["shared"], status: "not-automated", reason: "reservation_functions.sql의 calc_deadline 실제 구현 확인 후 작성 예정(추측 금지 원칙)" },
  { id: "SCN-P1-21", title: "만료 직전/직후", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-22", title: "예약 마감 직전", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-23", title: "취소 마감 경계", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/reservation-cancel-grace-period.test.ts, tests/integration/class-cancel-deadline-override.test.ts" },
  { id: "SCN-P1-24", title: "자정 경계", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/month-boundary-kst.test.ts (KST 경계 처리 패턴 동일)" },
  { id: "SCN-P1-25", title: "월말 경계", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/month-boundary-kst.test.ts" },
  { id: "SCN-P1-26", title: "연말 경계", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-27", title: "윤년/2월 경계", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P1 관리자↔회원 동시 상태(§10) ----
  { id: "SCN-P1-30", title: "관리자가 수업 정보 수정 중 회원 예약", priority: "P1", supportedLayers: ["shared", "ios", "android"], status: "not-automated" },
  { id: "SCN-P1-31", title: "관리자가 정원 축소 직후 회원 예약", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-32", title: "관리자가 정원 확대 시 대기 자동 승격 정책", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-33", title: "관리자 수동 배정 + 회원 셀프예약 동시", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/private-class-capacity.test.ts (admin_assign_reservation 정원 강제배치 거부 검증)" },
  { id: "SCN-P1-34", title: "관리자 수동 취소, 회원 화면 상태 일치", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P1-35", title: "회원 취소 + 관리자 취소 동시(중복 환급 방지)", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P1 멀티센터/권한(§11) ----
  { id: "SCN-P1-40", title: "centerA 관리자가 centerA 회원 관리 — 성공", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (E, I 등)" },
  { id: "SCN-P1-41", title: "centerA 관리자가 centerB 회원 수정 시도 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (M~O)" },
  { id: "SCN-P1-42", title: "centerA 관리자가 centerB 수업 수정 시도 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (N: centers 정보 수정 거부)" },
  { id: "SCN-P1-43", title: "일반 회원이 admin API 직접 호출 — 거부", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (M~O), tests/integration/acl-003-permission-read.test.ts" },
  { id: "SCN-P1-44", title: "타인 예약 ID 조작 — 접근 불가", priority: "P1", supportedLayers: ["shared"], status: "covered-by-existing", coveredBy: "tests/integration/manager-centers-privilege-escalation.test.ts (O: reservations 조회 거부)" },
  { id: "SCN-P1-45", title: "센터 전환 후 캐시 오염 없음", priority: "P1", supportedLayers: ["shared"], status: "not-automated" },

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

  // ---- P2 알림(§17) ----
  { id: "SCN-P2-50", title: "예약완료/취소/승격/만료임박/저잔여 알림", priority: "P2", supportedLayers: ["shared"], status: "not-automated" },

  // ---- P2 캐시/stale data(§18) — Batch 7 home TTL 캐시 관련, 고가치 후보 ----
  { id: "SCN-P2-60", title: "관리자 데이터 변경 후 회원 홈 재진입", priority: "P2", supportedLayers: ["shared", "ios"], status: "not-automated", reason: "다음 단계 우선순위 — Batch 7에서 추가된 홈 TTL 캐시 직접 검증 대상" },
  { id: "SCN-P2-61", title: "TTL 경계 시점 데이터 변경", priority: "P2", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P2-62", title: "예약 직후 홈/내예약 이동", priority: "P2", supportedLayers: ["shared", "ios"], status: "not-automated" },
  { id: "SCN-P2-63", title: "정원 변경, 회원 화면 stale 확인", priority: "P2", supportedLayers: ["shared"], status: "not-automated" },
  { id: "SCN-P2-64", title: "백그라운드 1분 후 포그라운드", priority: "P2", supportedLayers: ["ios", "android"], status: "not-automated" },
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
