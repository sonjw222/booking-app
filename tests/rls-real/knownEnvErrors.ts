/*
  격리 환경(tests/rls-real/run.sh up — 운영 SQL 일부만 적용, Realtime 없음)에서 원인을 확인한 "알려진" 오류만 선언한다(Q02).
  2026-10-26 발견 스윕(VISUAL_SWEEP_DISCOVER)의 raw 이벤트와 격리 PostgREST 직접 호출로 상태·오류 코드·원인을 확인했다.
  각 규칙은 종류·상태·PostgREST 오류 코드·경로를 모두 고정한다 — 일반 문자열("Failed to load resource")이나 "RPC 호출"이라는 이유만으로는 무시하지 않는다.
  대상 객체가 생기거나 상태/코드가 달라지면 규칙이 맞지 않아 자동으로 예상 밖(unexpected)이 된다.
*/
import type { KnownRule } from "./errorCollector";

const missing = (id: string, path: RegExp, status: number, code: string, cause: string): KnownRule => ({ id, cause, kind: ["http", "console"], status, code, path });

export const KNOWN_ENV_RULES: KnownRule[] = [
  { id: "realtime-ws", cause: "격리 프록시(tests/ui-real/proxy.mjs)에 Realtime(WebSocket) 엔드포인트가 없어 핸드셰이크가 404", kind: ["console"], path: /^\/_next\/static\/chunks\/[^/]+\.js$/, text: /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:3211\/realtime\/v1\/websocket\?[^']*' failed: Error during WebSocket handshake: Unexpected response code: 404$/ },
  { id: "nav-abort-notifications", cause: "화면 전환(goto) 때 진행 중이던 알림 개수 조회(HEAD)를 브라우저가 취소", kind: ["requestfailed"], method: "HEAD", path: /^\/rest\/v1\/notifications$/, text: /^net::ERR_ABORTED$/ },
  { id: "nav-abort-manager-centers", cause: "화면 전환(goto) 때 진행 중이던 관리 센터 존재 조회(HEAD)를 브라우저가 취소", kind: ["requestfailed"], method: "HEAD", path: /^\/rest\/v1\/manager_centers$/, text: /^net::ERR_ABORTED$/ },
  missing("missing-center_announcements", /^\/rest\/v1\/center_announcements$/, 404, "42P01", "격리 DB 에 center_announcements 테이블 없음"),
  missing("missing-subscription_plans", /^\/rest\/v1\/subscription_plans$/, 404, "42P01", "격리 DB 에 subscription_plans 테이블 없음"),
  missing("missing-center_settlement_accounts", /^\/rest\/v1\/center_settlement_accounts$/, 404, "42P01", "격리 DB 에 center_settlement_accounts 테이블 없음"),
  missing("missing-center_payout_accounts", /^\/rest\/v1\/center_payout_accounts$/, 404, "42P01", "격리 DB 에 center_payout_accounts 테이블 없음"),
  missing("missing-rpc-manager_dashboard_summary", /^\/rest\/v1\/rpc\/manager_dashboard_summary$/, 404, "PGRST202", "격리 DB 에 manager_dashboard_summary 함수 없음"),
  missing("missing-center_subscriptions-rel", /^\/rest\/v1\/center_subscriptions$/, 400, "PGRST200", "격리 DB 에 center_subscriptions↔subscription_plans 관계(테이블) 없음"),
  missing("missing-inquiry_threads-rel", /^\/rest\/v1\/inquiry_threads$/, 400, "PGRST200", "격리 DB 에 inquiry_threads 관계(문의 테이블 계열) 없음"),
  missing("missing-column-rooms.memo", /^\/rest\/v1\/rooms$/, 400, "42703", "격리 DB 의 rooms 에 memo 등 최신 컬럼 없음(42703)"),
  missing("missing-column-progress_categories.node_type", /^\/rest\/v1\/progress_categories$/, 400, "42703", "격리 DB 의 progress_categories 에 node_type 컬럼 없음(42703)"),
];

/** 위 환경 한계 때문에 화면 데이터가 안 떠 "불러오지 못했" 오류 화면이 나오는 관리자 경로 — 레이아웃(넘침·제목)만 검증되고 정상 데이터 흐름은 미검증이다. */
export const LAYOUT_ONLY_PATHS: Record<string, string> = {
  "/manager": "missing-rpc-manager_dashboard_summary",
  "/manager/announcements": "missing-center_announcements",
  "/manager/rooms": "missing-column-rooms.memo",
  "/manager/inquiries": "missing-inquiry_threads-rel",
  "/manager/subscription": "missing-subscription_plans / missing-center_subscriptions-rel",
  "/manager/settlement": "missing-center_settlement_accounts / missing-center_payout_accounts",
};
