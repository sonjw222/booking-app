import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 만료 상품 주문 처리 E2E 전용 workflow(expired-order-qa.yml)의 "격리·안전" 계약을 정적으로 고정한다.
// 이 workflow 는 러너 안의 일회용 Supabase 스택에서만 도는 테스트 전용 job 이다 — 운영·공유 DEV·Secrets·실제 결제/알림으로 가는 경로가 생기면 이 테스트가 실패해야 한다.
const root = path.resolve(__dirname, "../..");
const rd = (p: string) => readFileSync(path.join(root, p), "utf8");
const code = (s: string) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");   // 주석 제외

const wf = rd(".github/workflows/expired-order-qa.yml");
const apply = rd("scripts/isolated/expiredOrder/applyProdParity.sh");
const cfg = rd("playwright.expiredorderqa.config.ts");
const spec = rd("tests/expired-order-qa/member-to-manager.spec.ts");
const main = rd("playwright.config.ts");

describe("expired-order-qa.yml — 격리 계약", () => {
  it("읽기 전용 권한·Secrets/vars 없음·운영/DEV 식별자 없음", () => {
    expect(code(wf)).toMatch(/^permissions:\n  contents: read\n/m);
    expect(code(wf)).not.toMatch(/secrets\.|vars\./);
    for (const bad of ["jdglfvwdnkjnraqdxuuj", "bxntqggkfwnhcczsbqtj", "supabase.co", "service_role", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"]) expect(wf).not.toContain(bad);
    expect(code(wf)).not.toMatch(/supabase (link|db push|db query|--linked)|--project-ref|continue-on-error|\|\| true/);
    expect(code(wf)).not.toMatch(/NICEPAY|TOSS|ALIGO|PG_CHECKOUT_ENABLED/);   // 실제 결제·알림·PG 게이트 설정 없음(직접결제만)
  });
  it("일회용 스택 action 이 npm ci·playwright·SQL 적용보다 먼저, 스택은 항상 내린다", () => {
    const c = code(wf);   // 주석 속 언급은 제외하고 실제 단계 순서만 본다
    const iso = c.indexOf("uses: ./.github/actions/isolated-supabase");
    expect(iso).toBeGreaterThan(-1);
    for (const marker of ["npm ci", "npx playwright", "applyProdParity.sh"]) expect(c.indexOf(marker), marker).toBeGreaterThan(iso);
    expect(c.indexOf("npx playwright test")).toBeGreaterThan(c.indexOf("applyProdParity.sh"));
    expect(wf).toMatch(/name: Stop the isolated stack[^\n]*\n\s+if: always\(\)\n\s+run: supabase stop --no-backup --workdir isolated-supabase/);
  });
  it("기존 test.yml 과 분리: 별도 concurrency 그룹·같은 저장소 PR/수동만·push 제외·timeout", () => {
    expect(wf).toMatch(/concurrency:\n  group: expired-order-qa-/);
    expect(wf).not.toMatch(/group: test-/);
    expect(code(wf)).toContain("github.event_name != 'push'");
    expect(code(wf)).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(Number(wf.match(/timeout-minutes: (\d+)/)![1])).toBeLessThanOrEqual(30);
    expect(wf).toContain("EXPIREDORDER_START_SERVER");
    expect(wf).toContain("--config playwright.expiredorderqa.config.ts");
  });
  it("포트: 앱 서버 :3021 — 기본 playwright.config.ts(:3000)와 겹치지 않고 CI 에서는 점유 서버를 재사용하지 않는다", () => {
    expect(cfg).toContain("const PORT = 3021");
    expect(cfg).toContain("reuseExistingServer: !process.env.CI");
    expect(main).toContain("http://localhost:3000");
    expect(main).not.toContain("3021");
  });
  it("artifact: 스크린샷·결과 JSON 만(trace/video/test-results 제외), 보존 3일 이하", () => {
    expect(wf.match(/actions\/upload-artifact@v4/g)).toHaveLength(1);
    expect([...wf.matchAll(/^\s+path: (.+)$/gm)].map((m) => m[1].trim())).toEqual(["expired-order-qa-evidence/"]);
    expect(wf).not.toMatch(/path: (test-results|playwright-report)/);
    for (const m of wf.matchAll(/retention-days: (\d+)/g)) expect(Number(m[1])).toBeLessThanOrEqual(3);
  });
  it("applyProdParity.sh: 로컬 컨테이너(docker exec)만 쓰고 가드 통과 전에는 SQL 을 실행하지 않는다", () => {
    expect(apply).toContain('DB_CONTAINER="supabase_db_mwhabit-isolated"');
    expect(apply.indexOf("isolatedTargetGuard.mjs")).toBeLessThan(apply.indexOf("psql_file \"$f\""));
    expect(apply).toContain("set -euo pipefail");
    expect(apply).not.toMatch(/--db-url|postgresql:\/\/|supabase (link|db push|db query)|--linked|PGPASSWORD|psql -h/);
    // 적용 순서: 운영 선행 SQL → NICEPAY P2/P2b → #251 → 운영 fulfill_order 정의 → #252
    const order = ["fix_refund_pg_origin_guard_20261017", "add_nicepay_review_center_isolation_20261028", "fix_nicepay_gate_reviewer_flag_20261029", "fix_expired_fixed_date_products_20261031", "prodParity_fulfill_order.sql", "add_expired_order_resolution_20261031"].map((n) => apply.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("config·spec 가드: 로컬 Supabase 가 아니면, 또는 실제 PG·알림 자격증명 env 가 있으면 중단", () => {
    expect(cfg).toContain("ISOLATED_GUARD");
    expect(cfg).toMatch(/\["127\.0\.0\.1", "localhost"\]\.includes\(host\)/);
    expect(cfg).toMatch(/NICEPAY\|TOSS\|PORTONE/);
    expect(spec).toContain("ISOLATED_GUARD");
    expect(spec).toMatch(/\["127\.0\.0\.1", "localhost"\]\.includes\(host\)/);
    expect(spec).toContain("supabase_db_mwhabit-isolated");   // DB 변경은 이 로컬 컨테이너로만
  });
});
