#!/usr/bin/env node
// READ-ONLY: marker 이름으로 fixture 센터/상품을 찾아 TEST_CENTER_ID/TEST_PRODUCT_ID를 출력(seed를 다시 실행하지 않고 값만 다시 보고 싶을 때).
import { requireNonProductionOrExit } from "./requiredEnv.mjs";
import { FIXTURE_CENTER_NAME, FIXTURE_PRODUCT_NAME, makeClient } from "./lib.mjs";
const env = process.env;
requireNonProductionOrExit(env, { forSeed: true });
const c = makeClient(env), enc = encodeURIComponent;
const ce = await c.select("centers", `select=id&name=eq.${enc(FIXTURE_CENTER_NAME)}`);
const centerId = ce.json?.[0]?.id; if (!centerId) { console.error("fixture 센터가 없습니다 — 먼저 ci:dev:seed"); process.exit(1); }
const pr = await c.select("products", `select=id&center_id=eq.${centerId}&name=eq.${enc(FIXTURE_PRODUCT_NAME)}`);
if (!pr.json?.[0]?.id) { console.error("fixture 상품이 없습니다 — 먼저 ci:dev:seed"); process.exit(1); }
console.log(`TEST_CENTER_ID=${centerId}\nTEST_PRODUCT_ID=${pr.json[0].id}`);
