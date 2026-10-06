#!/usr/bin/env node
// fixture 일괄 준비(멱등). 조건: 비-production + CI_DEV_TARGET_PROJECT_REF==URL ref + CI_DEV_SEED_ACK=1 (모두 네트워크 호출 전에 검사).
// 만드는 것: Auth 사용자 6 + accounts/profiles, fixture 센터 1(approved), 상품 1(pass 10회). 끝나면 비밀이 아닌 ID 매핑을 .tmp/ci-dev-secret-map.env 로 저장.
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertSeedAllowed, ensureFixtures, makeClient } from "./lib.mjs";

export function secretMapText(ids) {
  return `# 비밀이 아닌 ID 매핑 — GitHub Secrets에 이 두 값을 등록하세요(커밋 금지: .tmp/ 는 gitignore)\nTEST_CENTER_ID=${ids.TEST_CENTER_ID}\nTEST_PRODUCT_ID=${ids.TEST_PRODUCT_ID}\n`;
}
export async function runSeed(env, { fetchImpl, log = console.log, writeMap = true } = {}) {
  assertSeedAllowed(env);   // ← 네트워크 이전
  const ids = await ensureFixtures(makeClient(env, fetchImpl), env, log);
  const text = secretMapText(ids);
  if (writeMap) { mkdirSync(".tmp", { recursive: true }); writeFileSync(".tmp/ci-dev-secret-map.env", text); }
  return { ids, text };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const { text } = await runSeed(process.env); console.log("\nseed 완료.\n" + text + "저장: .tmp/ci-dev-secret-map.env (ID만, 비밀번호/키 없음)"); }
  catch (e) { console.error("ci-dev seed 중단: " + e.message + "\n(재실행하면 이미 만든 것은 재사용하고 이어서 진행합니다. 자동 삭제는 하지 않습니다.)"); process.exit(1); }
}
