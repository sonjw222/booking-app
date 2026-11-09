#!/usr/bin/env node
/*
  NICEPAY 격리 QA(인증만) 환경 사전 점검 — 값은 판정에만 쓰고 어디에도 출력하지 않는다(MID·MerchantKey·토큰·Supabase 주소 포함). 출력은 항목 이름 + PASS/FAIL/WARN 뿐.
  사용: node scripts/qa/nicepayAuthOnlyPreflight.mjs [--env-file <파일>]   (파일 없으면 현재 프로세스 환경변수. 예: `vercel env pull --environment=preview --git-branch=qa/nicepay-auth-only-20261030 .env.qa` 로 받은 파일)
  종료 코드: 0 = 실제 외부 결제창 테스트를 시작해도 되는 상태, 1 = 하나라도 FAIL(시작 금지). 이 스크립트는 네트워크·파일 쓰기·결제 호출을 하지 않는다.
  판정 규칙은 서버 런타임(lib/payments/server/nicepay/qaAuthOnly.ts)과 같은 함수를 쓴다 — 서버가 거부할 설정이면 여기서도 FAIL.
*/
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const present = (v) => typeof v === "string" && v.trim().length > 0;
function parseEnvFile(text) { const out = {}; for (const line of text.split("\n")) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line); if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, ""); } return out; }

export async function runPreflight(env) {
  const { evaluateQaAuthOnly, NICEPAY_PUBLIC_TEST_MID } = await import(pathToFileURL(path.join(root, "lib/payments/server/nicepay/qaAuthOnly.ts")).href).catch(() => ({}));
  const rows = []; const add = (name, status, note = "") => rows.push({ name, status, note });
  // 필수 이름(값 비출력)
  for (const n of ["NICEPAY_CHECKOUT_ENABLED", "NICEPAY_API_FAMILY", "NICEPAY_ENV", "NICEPAY_RETURN_BASE_URL", "PAYMENT_RETURN_TOKEN_SECRET", "NICEPAY_MID", "NICEPAY_MERCHANT_KEY", "NICEPAY_QA_AUTH_ONLY", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) add(n, present(env[n]) ? "PASS" : "FAIL", present(env[n]) ? "존재(값 비공개)" : "누락");
  add("NICEPAY_QA_AUTH_ONLY=true", env.NICEPAY_QA_AUTH_ONLY === "true" ? "PASS" : "FAIL", "인증만 모드 명시(공용 테스트 MID 는 어차피 강제되지만 명시 필수)");
  add("NICEPAY_CHECKOUT_ENABLED=true", env.NICEPAY_CHECKOUT_ENABLED === "true" ? "PASS" : "FAIL", "QA 환경에서만 true — Production 값은 건드리지 않는다");
  add("NEXT_PUBLIC_PAYMENT_PROVIDER=nicepay", env.NEXT_PUBLIC_PAYMENT_PROVIDER === "nicepay" ? "PASS" : "FAIL");
  add("NEXT_PUBLIC_PG_CHECKOUT_ENABLED(일반회원 결제 OFF)", env.NEXT_PUBLIC_PG_CHECKOUT_ENABLED === "true" ? "FAIL" : "PASS", "true 가 아니어야 한다");
  if (!evaluateQaAuthOnly) { add("서버 판정 모듈 로드", "WARN", "TypeScript 모듈을 직접 불러오지 못함 — `npx tsx scripts/qa/nicepayAuthOnlyPreflight.mjs` 로 실행"); }
  else {
    const q = evaluateQaAuthOnly(env);
    add("서버 안전 판정(qaAuthOnly)", q.ok ? "PASS" : "FAIL", q.ok ? `테스트 MID(${NICEPAY_PUBLIC_TEST_MID}) · sandbox · 비운영 DB · 비운영 도메인` : `문제 항목: ${q.problems.join(" | ")}`);
  }
  const sb = (env.NEXT_PUBLIC_SUPABASE_URL ?? "").toLowerCase();
  add("Supabase 가 운영 프로젝트가 아님", sb && !sb.includes("bxntqggkfwnhcczsbqtj") ? "PASS" : "FAIL", sb ? "운영 ref 아님(값 비공개)" : "URL 없음");
  add("Preview 의 DB 에 심사용 센터·게이트가 있는지", "WARN", "이 스크립트는 DB 를 읽지 않는다 — 로컬 격리 스택(기본) 또는 비운영 테스트 DB 에서만 확인");
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--env-file");
  const env = i >= 0 ? parseEnvFile(fs.readFileSync(process.argv[i + 1], "utf8")) : process.env;
  const rows = await runPreflight(env);
  for (const r of rows) console.log(`${r.status.padEnd(4)} ${r.name}${r.note ? " — " + r.note : ""}`);
  const fails = rows.filter((r) => r.status === "FAIL").length;
  console.log(fails ? `\n→ FAIL ${fails}건: 실제 외부 결제창 테스트를 시작하지 마세요.` : "\n→ 필수 항목 통과(WARN 은 수동 확인).");
  process.exit(fails ? 1 : 0);
}
