/*
  강제 종료된 E2E 실행이 남긴 수업을 manifest 기반으로 수동 정리한다(Q01). 기본은 읽기 전용 계획(dry-run)이다.

    node scripts/e2e/cleanupOwnedClasses.ts playwright/.auth/owned-classes-<RUN_ID>.jsonl            # 계획만 출력
    node scripts/e2e/cleanupOwnedClasses.ts playwright/.auth/owned-classes-<RUN_ID>.jsonl --execute  # 소유 증명된 것만 삭제

  대상은 환경변수로 명시한다(실수로 다른 프로젝트를 쓰지 않도록 기본값 없음):
    E2E_CLEANUP_SUPABASE_URL, E2E_CLEANUP_SERVICE_KEY, E2E_CLEANUP_PROFILE_IDS(쉼표 구분 테스트 계정 profile id)
  manifest 는 "후보 목록"이다 — DB 의 실제 행(id·센터·제목·created_at)과 예약·감사 로그 참조를 다시 대조해, 증명되지 않으면 삭제하지 않는다.
  키 값은 출력하지 않는다.
*/
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { cleanupOwnedClass, memoryOwnershipStore, planManualCleanup, type OwnedClassEntry } from "../../tests/e2e/fixtures/ownedClassCleanup.ts";

const [file, ...flags] = process.argv.slice(2);
const execute = flags.includes("--execute");
const url = process.env.E2E_CLEANUP_SUPABASE_URL, key = process.env.E2E_CLEANUP_SERVICE_KEY;
const profileIds = (process.env.E2E_CLEANUP_PROFILE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!file || !url || !key) { console.error("사용법/환경변수 누락 — 파일 경로, E2E_CLEANUP_SUPABASE_URL, E2E_CLEANUP_SERVICE_KEY 필요"); process.exit(2); }

const entries = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as OwnedClassEntry);
// E2E_CLEANUP_STRIP_REST_V1=1 은 /rest/v1 접두사가 없는 격리 PostgREST(tests/rls-real) 전용이다.
const strip = process.env.E2E_CLEANUP_STRIP_REST_V1 === "1";
const admin = createClient(url, key, { global: strip ? { fetch: (i, init) => fetch(String(i).replace("/rest/v1/", "/"), init) } : {}, auth: { persistSession: false, autoRefreshToken: false } });
console.log(`대상: ${new URL(url).host} · manifest 항목 ${entries.length}건 · ${execute ? "EXECUTE" : "dry-run"}`);

let exit = 0;
for (const e of entries) {
  const store = memoryOwnershipStore(); store.register(e);
  const ctx = { admin, store, runId: e.runId, testProfileIds: profileIds };
  const [plan] = await planManualCleanup(ctx, [e]);
  console.log(`${e.classId} "${e.title}" → ${plan.note}`);
  if (!execute || !plan.exists || !plan.owned) continue;
  const r = await cleanupOwnedClass(ctx, e.classId);
  console.log(`  ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
  if (r.status === "blocked" || r.status === "failed") exit = 1;
}
process.exit(exit);
