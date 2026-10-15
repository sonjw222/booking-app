// 관리자 센터 페이지네이션 ON/OFF 읽기 전용 E2E 수동 러너.
// - DB 쓰기·권한 변경·SQL 없음. service role 키를 읽지 않는다. 기존 DEV 플랫폼 관리자 로그인과 기존 데이터 조회만 한다.
// - ON/OFF를 서로 다른 env의 별도 dev 서버 프로세스로 순차 실행한다(playwright.config.ts가 이 모드에서 서버 재사용을 끈다).
// - 사용: node scripts/e2e/adminPaginationReadonly.mjs   (.env.test.local 또는 환경변수에 DEV 대상 + TEST_PLATFORM_ADMIN_* 필요)
import { spawnSync } from "node:child_process";

const missing = ["TEST_PLATFORM_ADMIN_EMAIL", "TEST_PLATFORM_ADMIN_PASSWORD"].filter((n) => !process.env[n]);
// .env.test.local 값은 playwright.config.ts가 로드하므로 여기서는 셸 env만 확인하고, 없으면 spec이 명시적으로 실패한다.
if (missing.length) console.warn(`[admin-pagination] 셸 env에 ${missing.join(", ")} 없음 — .env.test.local에 없으면 spec이 실패합니다(skip 아님).`);

const spec = "tests/e2e/production-readiness/admin-center-pagination.spec.ts";
for (const [flag, value] of [["on", "true"], ["off", "false"]]) {
  console.log(`\n[admin-pagination] ${flag.toUpperCase()} 서버 실행 (NEXT_PUBLIC_ADMIN_CENTER_PAGINATION=${value})`);
  const r = spawnSync("npx", ["playwright", "test", "--project=chromium", "--no-deps", spec, "--grep", "커서 페이지네이션"], {
    stdio: "inherit",
    env: { ...process.env, RUN_ADMIN_PAGINATION: "1", E2E_ADMIN_CENTER_PAGINATION_FLAG: flag, NEXT_PUBLIC_ADMIN_CENTER_PAGINATION: value },
  });
  if (r.status !== 0) { console.error(`[admin-pagination] ${flag.toUpperCase()} 실행 실패(status=${r.status})`); process.exit(r.status ?? 1); }
}
