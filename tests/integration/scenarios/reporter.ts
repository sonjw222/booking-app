/*
  Automated Business Scenario E2E Batch(2026-09-18) — 요청 24/25번: 시나리오 실행 결과를
  기계 판독 가능한 JSON으로 남긴다. secret/token/password는 절대 담지 않는다(요청 25번
  "secret/token/password 출력 금지") — actors 배열은 이메일이 아니라 역할 이름
  (memberA 등)만 담는다.
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioResult } from "./types";

const OUT_DIR = join(process.cwd(), "test-results", "business-scenarios");

export function writeScenarioResult(result: Omit<ScenarioResult, "timestamp">): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const full: ScenarioResult = { ...result, timestamp: new Date().toISOString() };
  writeFileSync(join(OUT_DIR, `${result.scenario}.json`), JSON.stringify(full, null, 2), "utf-8");
}

/*
  it() 본문을 감싸서 성공/실패/소요시간을 자동으로 기록한다 — 각 시나리오 파일이 직접
  try/catch/타이머를 반복하지 않게 한다. assertions는 테스트 본문이 직접 채워서
  넘긴다(이 함수는 실행 결과만 감쌈).
*/
export async function runScenario(
  id: string,
  actors: string[],
  fn: (assertions: { name: string; passed: boolean; detail?: string }[]) => Promise<void>
): Promise<void> {
  const assertions: { name: string; passed: boolean; detail?: string }[] = [];
  const start = Date.now();
  try {
    await fn(assertions);
    writeScenarioResult({
      scenario: id,
      platform: "shared",
      status: "PASS",
      durationMs: Date.now() - start,
      actors,
      assertions,
      cleanup: "PASS",
    });
  } catch (e: any) {
    writeScenarioResult({
      scenario: id,
      platform: "shared",
      status: "FAIL",
      durationMs: Date.now() - start,
      actors,
      assertions,
      cleanup: "PASS", // 개별 시나리오 파일의 afterAll/afterEach가 별도로 정리(기존 관례 재사용)
      error: e?.message ?? String(e),
    });
    throw e; // vitest 자체 실패 처리는 그대로 유지(리포트만 부가로 남김)
  }
}
