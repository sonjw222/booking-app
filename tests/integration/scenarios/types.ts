/*
  Automated Business Scenario E2E Batch(2026-09-18) — 공통 시나리오 정의 타입.

  이 파일은 Layer A(Shared, 이 tests/integration/scenarios/*.test.ts)와 Layer B/C(iOS
  XCUITest/Android Espresso, 다른 언어라 타입 자체를 공유할 수는 없음)가 "같은 시나리오
  ID/문서"를 참조하도록 하는 얇은 레지스트리 스키마다. 새 테스트 러너나 새 fixture
  체계를 만들지 않는다 — 실제 실행은 전부 기존 tests/integration/setup.ts +
  vitest.integration.config.ts(fileParallelism:false, 기존 그대로) 위에서 이뤄진다.

  ScenarioMeta는 "문서화 + 결과 리포팅용 메타데이터"이지, 시나리오 로직 자체를 담는
  DSL이 아니다 — 실제 로직은 여전히 일반 TypeScript 테스트 코드(it() 안)로 작성한다.
  이렇게 하는 이유: 이 저장소의 tests/integration 43개 파일이 이미 실제 RPC를 그대로
  호출하는 성숙한 패턴을 갖고 있는데, 여기에 별도 DSL(steps 배열을 해석해서 실행하는
  인터프리터 같은 것)을 얹으면 오히려 기존 패턴과 이중화되고 디버깅이 어려워진다.
*/

export type ScenarioPriority = "P0" | "P1" | "P2";
export type ScenarioLayer = "shared" | "ios" | "android";
export type ScenarioStatus =
  | "implemented" // 이 배치에서 새로 구현 + 실행 확인됨
  | "covered-by-existing" // tests/integration의 기존 파일이 이미 검증하고 있음(중복 구현 안 함)
  | "not-automated" // 자동화 대상이지만 아직 안 함(범위/시간 제약)
  | "blocked"; // 안전/환경 제약으로 의도적으로 자동화 보류(BLOCKED, 근거를 reason에 남김)

export interface ScenarioMeta {
  id: string; // 예: "SCN-P0-23"
  title: string;
  priority: ScenarioPriority;
  supportedLayers: ScenarioLayer[];
  status: ScenarioStatus;
  /** status가 covered-by-existing/blocked/not-automated일 때 근거. */
  reason?: string;
  /** covered-by-existing일 때 실제로 검증하는 기존 파일 경로(중복 구현 안 했다는 증거). */
  coveredBy?: string;
  /** implemented일 때 실제 구현 파일. */
  implementedIn?: string;
}

/*
  요청 24번 "테스트 결과 포맷"에 맞춘 기계 판독용 결과 — 각 시나리오 it()이 끝날 때
  writeScenarioResult()로 test-results/business-scenarios/<id>.json에 남긴다(요청
  25번 "실패 산출물" 위치 지정과 동일).
*/
export interface ScenarioResult {
  scenario: string;
  platform: "shared";
  status: "PASS" | "FAIL" | "SKIP";
  durationMs: number;
  actors: string[];
  assertions: { name: string; passed: boolean; detail?: string }[];
  cleanup: "PASS" | "FAIL" | "SKIPPED";
  error?: string;
  timestamp: string;
}
