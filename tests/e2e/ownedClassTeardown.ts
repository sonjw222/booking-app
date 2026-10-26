/*
  전역 teardown(Q01): 이 실행의 수업 정리 원장을 읽어 해결되지 않은 blocked/failed 가 있으면 실행을 실패시킨다.
  원래 테스트 실패는 건드리지 않는다(이 실패는 별도 항목으로 보고된다). 정리 호출이 아예 없었던(= 강제 종료 등) 등록 수업은
  경고로 남기고 manifest 기반 수동 정리를 안내한다 — 자동 삭제는 하지 않는다.
*/
import path from "node:path";
import { readLedger, readManifest, summarizeLedger } from "./fixtures/ownedClassCleanup";

export default async function globalTeardown(): Promise<void> {
  const runId = process.env.E2E_RUN_ID;
  if (!runId) return;
  const dir = path.resolve(process.cwd(), "playwright/.auth");
  const ledger = readLedger(dir, runId);
  const manifest = readManifest(dir, runId);
  const resolved = new Set(ledger.filter((r) => r.status === "deleted" || r.status === "already_gone").map((r) => r.classId));
  const leftover = manifest.filter((m) => !resolved.has(m.classId) && !ledger.some((r) => r.classId === m.classId));
  if (leftover.length) {
    console.warn(`[E2E teardown] 정리 호출이 없던 등록 수업 ${leftover.length}건 — 삭제하지 않음. 수동 정리: playwright/.auth/owned-classes-${runId}.jsonl (ids: ${leftover.map((l) => l.classId).join(",")})`);
  }
  const s = summarizeLedger(ledger);
  console.log(`[E2E teardown] ${s.message}`);
  if (!s.ok) throw new Error(`수업 정리 미해결(삭제하지 않고 남김 — 확인 필요):\n${s.message}`);
}
