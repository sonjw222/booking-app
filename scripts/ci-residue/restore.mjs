#!/usr/bin/env node
/*
  purge.mjs 가 저장한 백업으로 복원 — 검토용(공유 DEV 에서 실행된 적 없음). 승인된 계획 해시·백업 digest·대상 호스트·허용 테이블을 검증하고,
  기존 행은 "백업과 같으면 건너뜀 / 다르면 쓰기 전에 전체 중단"으로 대조하며, 복원 뒤 실제 데이터를 백업과 다시 대조한다.
  사용: PURGE_ENV_FILE=<env 파일> node restore.mjs <backup.json> [--execute --accept-notification-side-effects]
  주의: 예약 재삽입은 notify_reservation_insert 트리거로 알림 행을 만든다(웹푸시 경로는 공유 DEV 에서 미확인) — 수락 플래그가 있어야 실행한다.
*/
import fs from "node:fs";
import { assertTarget, makeClient, runRestore, sha256, stable } from "./core.mjs";
import { DEFAULT_PLAN, PINNED_PLAN_SHA256, PRODUCTION_REF, SHARED_DEV_REF } from "./pinned.mjs";
const args = process.argv.slice(2); const file = args.find((a) => !a.startsWith("--"));
const die = (m, c = 2) => { console.error("ABORT: " + m); process.exit(c); };
if (!file || !process.env.PURGE_ENV_FILE) die("백업 파일과 PURGE_ENV_FILE 필요");
const plan = JSON.parse(fs.readFileSync(DEFAULT_PLAN, "utf8")); const planSha = sha256(stable(plan));
if (planSha !== PINNED_PLAN_SHA256) die("계획 해시가 검토·고정된 값과 다름");
const env = Object.fromEntries(fs.readFileSync(process.env.PURGE_ENV_FILE, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
let origin; try { origin = assertTarget(env.NEXT_PUBLIC_SUPABASE_URL, { allowedRef: SHARED_DEV_REF, forbiddenRefs: [PRODUCTION_REF] }).origin; } catch (e) { die("대상 검증 실패: " + e.message); }
const client = makeClient({ baseUrl: origin, key: env.SUPABASE_SERVICE_ROLE_KEY });
const r = await runRestore({ client, plan, planSha, backup: JSON.parse(fs.readFileSync(file, "utf8")), execute: args.includes("--execute"), acceptNotificationSideEffects: args.includes("--accept-notification-side-effects") });
console.log(`상태 ${r.state}${r.wouldInsert ? ` · 삽입 예정 ${r.wouldInsert.join(", ")}` : ""}${r.inserted ? ` · 삽입 ${r.inserted.join(", ")}` : ""}`);
if (!r.ok) { (r.errors ?? []).forEach((e) => console.error("  - " + e)); process.exit(3); }
