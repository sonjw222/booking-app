#!/usr/bin/env node
/*
  일회용 로컬 Supabase 스택(isolated-supabase, ISOLATED_KIND=ephemeral-local-stack)에 테스트 fixture 를 만들고, E2E/Integration 이 읽는 환경변수 파일을 쓴다.
  - 가드(scripts/ci/isolatedTargetGuard.mjs)가 OK + kind=ephemeral-local-stack 이 아니면 어떤 요청도 보내기 전에 중단한다(공유 DEV/운영/호스팅 프로젝트로는 절대 가지 않는다).
  - 테스트 계정(USER_A/B, MANAGER_A/B)은 실행마다 새 비밀번호로 만든다(저장소·로그에 비밀번호를 남기지 않는다). 실제 회원/운영 데이터는 쓰지 않는다.
  - 카탈로그(permissions/subscription_plans/service_categories)는 supabase seed.sql(저장소 SQL 에서 생성)이 이미 넣었다.
  사용: ISOLATED_*(supabase status 값) node scripts/isolated/bootstrapEphemeral.mjs --out <env 파일>
*/
import fs from "node:fs";
import crypto from "node:crypto";
import { checkIsolatedTarget } from "../ci/isolatedTargetGuard.mjs";
import { ensureFixtures, makeClient } from "../ci-dev/lib.mjs";
import { FIXTURE_ACCOUNTS } from "../ci-dev/requiredEnv.mjs";

const outIdx = process.argv.indexOf("--out"); const outFile = outIdx >= 0 ? process.argv[outIdx + 1] : null;
const die = (m) => { console.error("ABORT: " + m); process.exit(1); };
if (!outFile) die("--out <env 파일> 필요");
const g = checkIsolatedTarget(process.env);
if (g.status !== "OK" || g.kind !== "ephemeral-local-stack") { console.error(`가드 판정 ${g.status} (kind=${g.kind}) — fixture 생성 안 함`); g.problems.forEach((p) => console.error("  - " + p)); process.exit(1); }

const url = process.env.ISOLATED_SUPABASE_URL.trim().replace(/\/+$/, ""), anon = process.env.ISOLATED_SUPABASE_ANON_KEY.trim(), service = process.env.ISOLATED_SUPABASE_SERVICE_ROLE_KEY.trim();
const env = { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service };
const pwd = () => crypto.randomBytes(18).toString("base64url") + "Aa1!";
for (const a of FIXTURE_ACCOUNTS) { env[`TEST_${a}_EMAIL`] = `ci-${a.toLowerCase().replace("_", "-")}@isolated.test`; env[`TEST_${a}_PASSWORD`] = pwd(); }
const ids = await ensureFixtures(makeClient(env), env, (m) => console.log("  " + m));
env.TEST_CENTER_ID = ids.TEST_CENTER_ID; env.TEST_PRODUCT_ID = ids.TEST_PRODUCT_ID;
fs.writeFileSync(outFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
console.log(`fixture 준비 완료: 계정 ${FIXTURE_ACCOUNTS.length}개, 센터·상품 1개 — 환경 파일 ${outFile}(0600, 비밀번호 포함·커밋 금지)`);
