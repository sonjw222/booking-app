#!/usr/bin/env node
// 오케스트레이터: preflight → 스키마 검증 → seed → 전체 검증. 스키마가 없으면 seed 전에 중단한다(root SQL 439개를 자동 실행하지 않는다).
import { requireNonProductionOrExit } from "./requiredEnv.mjs";
import { assertSeedAllowed, makeClient } from "./lib.mjs";
import { makeReporter, verifyCatalog, verifyFixtures, verifySchema } from "./verify.mjs";
import { runSeed } from "./seed.mjs";

requireNonProductionOrExit(process.env, { forSeed: true });
try { assertSeedAllowed(process.env); } catch (e) { console.error("ci-dev bootstrap 중단: " + e.message); process.exit(1); }
console.log("1/4 preflight OK");
const client = makeClient(process.env), s = makeReporter();
await verifySchema({ client, report: s.report });
if (s.failed()) { console.error("\n" + s.summary() + "\n2/4 스키마 검증 실패 — schema baseline must be applied first (docs/CI_DEV_SUPABASE_SETUP.md §2). seed는 실행하지 않았습니다."); process.exit(2); }
console.log("2/4 schema OK");
let seeded = process.env;
try { const { ids, text } = await runSeed(process.env); seeded = { ...process.env, TEST_CENTER_ID: ids.TEST_CENTER_ID, TEST_PRODUCT_ID: ids.TEST_PRODUCT_ID }; console.log("3/4 seed OK\n" + text); } catch (e) { console.error("seed 중단: " + e.message); process.exit(1); }
const f = makeReporter();
await verifyCatalog({ client, report: f.report });
await verifyFixtures({ client, env: seeded, report: f.report });
console.log("4/4 " + f.summary()); process.exit(f.failed() ? 1 : 0);
