#!/usr/bin/env node
/*
  공유 DEV CI 잔여 수업 정리. 격리 DB 회귀를 통과했고(tests/rls-real/ciResidueCleanup.rls.test.ts), 사람이 승인한 일회성 정리(계획 해시 0bbd2f61…, 수업 23·예약 12·상품 연결 2)로 2026-10-27 공유 DEV 에서 한 번 실행됐다. 다른 계획·데이터에는 쓰지 않는다(해시 고정).
  범위: 승인된 계획(cleanup-plan.json, 해시 고정)에 적힌 수업·예약·연결 데이터로만 동작한다. id 를 인자로 받지 않는다.
  모드: (기본) dry-run — 읽기만. --execute: PURGE_ACK=<계획 해시 앞 12자리> + --backup-dir 필요. --resume: 이전 실행 journal·검증된 백업과 현재 상태를 대조한 뒤에만 수업 삭제를 이어서 한다.
  환경: PURGE_ENV_FILE=<NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 든 파일>. 키는 출력하지 않는다. 대상은 정확한 https://<공유 DEV ref>.supabase.co 호스트여야 한다.
  원자성: 예약 삭제와 수업 삭제는 각각 하나의 요청(트랜잭션)이지만 둘 사이는 비원자적이다 — 중간 실패 시 "수업만 남은" 상태가 journal 에 남고 --resume 로만 이어간다.
  부수 효과(조사 결과는 계획의 sideEffects 참고): 예약 DELETE 트리거는 차감된 대여 사용 기록이 있을 때만 대여 수강권 횟수를 +1 한다.
*/
import fs from "node:fs";
import { assertTarget, makeClient, runPurge, sha256, stable } from "./core.mjs";
import { DEFAULT_PLAN, PINNED_PLAN_SHA256, PRODUCTION_REF, SHARED_DEV_REF } from "./pinned.mjs";

const args = process.argv.slice(2); const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const mode = args.includes("--resume") ? "resume" : args.includes("--execute") ? "execute" : "dry-run";
const die = (m, c = 2) => { console.error("ABORT: " + m); process.exit(c); };
const plan = JSON.parse(fs.readFileSync(opt("--plan") ?? DEFAULT_PLAN, "utf8")); const planSha = sha256(stable(plan));
if (planSha !== PINNED_PLAN_SHA256) die("계획 해시가 검토·고정된 값과 다름 — 새로 검토 필요");
if (!process.env.PURGE_ENV_FILE) die("PURGE_ENV_FILE 필요");
const env = Object.fromEntries(fs.readFileSync(process.env.PURGE_ENV_FILE, "utf8").split("\n").filter((l) => l && !l.startsWith("#") && l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")]; }));
let origin; try { origin = assertTarget(env.NEXT_PUBLIC_SUPABASE_URL, { allowedRef: SHARED_DEV_REF, forbiddenRefs: [PRODUCTION_REF] }).origin; } catch (e) { die("대상 검증 실패: " + e.message); }
if (!env.SUPABASE_SERVICE_ROLE_KEY) die("서비스 키 없음");
const client = makeClient({ baseUrl: origin, key: env.SUPABASE_SERVICE_ROLE_KEY });
console.log(`모드 ${mode} · 대상 ${new URL(origin).hostname} · 수업 ${plan.classes.length} · 예약 ${plan.reservations.length} · 계획 ${planSha.slice(0, 12)}`);
try {
  const r = await runPurge({ client, plan, planSha, mode, backupDir: opt("--backup-dir"), ack: process.env.PURGE_ACK });
  if (!r.ok) { console.error(`상태 ${r.state}`); r.mismatches.forEach((m) => console.error("  - " + m)); die("대조 불일치/검증 실패 — 가능한 쓰기는 하지 않았거나 중단됨. 현재 상태를 조회해 확인하세요", 3); }
  console.log(`완료: ${r.state}`);
} catch (e) { die(`${e.message}${e.state ? ` (state=${e.state})` : ""}`, 4); }
