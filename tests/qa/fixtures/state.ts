/*
  로컬 전용 fixture 상태 파일(.qa-state/production-fixture.json, gitignore).
  센터 id/계정 id/프로필 id만 저장한다 — 비밀번호, 토큰, 키는 저장하지 않는다. 시나리오는 매 실행 DB에서 다시 조회하므로
  이 파일은 사람이 확인하기 위한 참고용이다(없어도 동작).
*/
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { QaFixtureState } from "./center";

export const QA_STATE_PATH = path.resolve(process.cwd(), ".qa-state", "production-fixture.json");

export function stateForFile(s: QaFixtureState, now: Date = new Date()): Record<string, string> {
  return { centerId: s.centerId, managerAccountId: s.managerAccountId, memberAccountId: s.memberAccountId, memberProfileId: s.memberProfileId, updatedAt: now.toISOString() };
}

export function writeQaState(s: QaFixtureState): void {
  mkdirSync(path.dirname(QA_STATE_PATH), { recursive: true });
  writeFileSync(QA_STATE_PATH, JSON.stringify(stateForFile(s), null, 2) + "\n");
}
