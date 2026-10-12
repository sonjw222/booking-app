/*
  PR 자동 병합 판정 엔진(lib/automation/mergePolicy.ts) 단위 테스트. 순수 함수만 검증하며
  네트워크·GitHub·Git에 접근하지 않는다. 기본값은 "자동 병합 가능한 순수 문서 PR"이고,
  각 테스트가 한 가지 조건만 어겨서 fail-closed 경계를 확인한다.
*/
import { describe, expect, it } from "vitest";
import {
  evaluateMergePolicy,
  type ChangedFile,
  type MergePolicyInput,
  type MergeVerdict,
} from "../../lib/automation/mergePolicy";

const HEAD = "a".repeat(40);
const MAIN = "b".repeat(40);
const OPTIONS = { trustedAuthors: ["sonjw222"] };
const REQUIRED = ["unit", "build"];

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", additions: 10, deletions: 2, patchAvailable: true, ...extra };
}

function make(overrides: Partial<MergePolicyInput> = {}, pr: Partial<MergePolicyInput["pr"]> = {}): MergePolicyInput {
  return {
    pr: {
      number: 300,
      state: "open",
      draft: false,
      baseRef: "main",
      headSha: HEAD,
      observedHeadSha: HEAD,
      currentMainSha: MAIN,
      author: "sonjw222",
      isFork: false,
      labels: ["ai-merge-approved"],
      approvedHeadSha: HEAD,
      mergeable: true,
      mergeStateStatus: "clean",
      dependencies: [],
      patchMatchesIssue: true,
      ...pr,
    },
    files: [file("docs/GUIDE.md")],
    filesComplete: true,
    checks: REQUIRED.map((name) => ({ name, status: "completed", conclusion: "success", headSha: HEAD })),
    requiredChecks: REQUIRED,
    evidence: { collectedByExecutor: true, headSha: HEAD, mainSha: MAIN, passed: true },
    e2eRequired: false,
    e2eExecuted: false,
    ...overrides,
  };
}

const verdictOf = (i: MergePolicyInput): MergeVerdict => evaluateMergePolicy(i, OPTIONS).verdict;
const codesOf = (i: MergePolicyInput) => evaluateMergePolicy(i, OPTIONS).reasons.map((r) => r.code);

describe("순수 문서 / 일반 단위 테스트", () => {
  it("모든 조건을 만족한 문서 PR은 MERGE_ELIGIBLE이고 이유가 없다", () => {
    const d = evaluateMergePolicy(make(), OPTIONS);
    expect(d.verdict).toBe("MERGE_ELIGIBLE");
    expect(d.reasons).toEqual([]);
  });

  it("검증된 일반 단위 테스트 PR도 MERGE_ELIGIBLE", () => {
    const f = file("tests/unit/dateFormat.test.ts", {
      contentScan: { verified: true, writesData: false, touchesSensitiveDomain: false },
    });
    expect(verdictOf(make({ files: [f] }))).toBe("MERGE_ELIGIBLE");
  });

  it("내용 스캔이 없는 단위 테스트는 MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file("tests/unit/dateFormat.test.ts")] }))).toBe("MANUAL_APPROVAL");
  });

  it("파일명이 무해해도 데이터 쓰기 가능성이 있으면 BLOCK", () => {
    const f = file("tests/unit/dateFormat.test.ts", {
      contentScan: { verified: true, writesData: true, touchesSensitiveDomain: false },
    });
    expect(verdictOf(make({ files: [f] }))).toBe("BLOCK");
  });

  it.each(["authFlow", "paymentRetry", "reservationSlots", "aclFixture", "rlsPolicy", "rpcCall"])(
    "민감 키워드 테스트(%s)는 스캔을 통과해도 MANUAL_APPROVAL",
    (name) => {
      const f = file(`tests/unit/${name}.test.ts`, {
        contentScan: { verified: true, writesData: false, touchesSensitiveDomain: false },
      });
      expect(verdictOf(make({ files: [f] }))).toBe("MANUAL_APPROVAL");
    },
  );

  it("문서 확장자가 아니거나 docs 밖이면 MANUAL_APPROVAL(기본 거부)", () => {
    expect(verdictOf(make({ files: [file("docs/a.sql")] }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ files: [file("README.md")] }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ files: [file("app/page.tsx")] }))).toBe("MANUAL_APPROVAL");
  });
});

describe("민감 경로", () => {
  it.each([
    "supabase/migrations/1.sql",
    "db/x.sql",
    ".github/workflows/ci.yml",
    "scripts/run.sh",
    "ios/App/Info.plist",
    "android/app/build.gradle",
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "next.config.js",
    "tests/e2e/login.spec.ts",
    "tools/merge.ts",
  ])("%s → MANUAL_APPROVAL", (p) => {
    expect(verdictOf(make({ files: [file(p)] }))).toBe("MANUAL_APPROVAL");
  });

  it.each([".env", ".env.local", "docs/.env.production", "keys/app.pem", "secrets/token.md"])("%s → BLOCK", (p) => {
    expect(verdictOf(make({ files: [file(p)] }))).toBe("BLOCK");
  });

  it("경로 우회(../, 절대경로, 대문자 우회)는 자동 병합되지 않는다", () => {
    expect(verdictOf(make({ files: [file("docs/../.github/x.md")] }))).toBe("BLOCK");
    expect(verdictOf(make({ files: [file("/docs/a.md")] }))).toBe("BLOCK");
    expect(verdictOf(make({ files: [file("SUPABASE/a.md")] }))).not.toBe("MERGE_ELIGIBLE");
    expect(verdictOf(make({ files: [file("docs/ENV/.ENV")] }))).toBe("BLOCK");
  });
});

describe("파일 형태", () => {
  it("symlink / submodule은 BLOCK", () => {
    expect(verdictOf(make({ files: [file("docs/a.md", { mode: "120000" })] }))).toBe("BLOCK");
    expect(verdictOf(make({ files: [file("docs/a.md", { mode: "160000" })] }))).toBe("BLOCK");
  });

  it.each(["renamed", "removed", "copied", "changed"])("status=%s는 자동 병합 불허", (status) => {
    expect(verdictOf(make({ files: [file("docs/a.md", { status })] }))).toBe("MANUAL_APPROVAL");
  });

  it("patch 메타데이터가 없으면 MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file("docs/a.md", { patchAvailable: false })] }))).toBe("MANUAL_APPROVAL");
  });

  it("대량 변경(파일 수/줄 수)은 MANUAL_APPROVAL", () => {
    const many = Array.from({ length: 11 }, (_, i) => file(`docs/a${i}.md`));
    expect(verdictOf(make({ files: many }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ files: [file("docs/a.md", { additions: 500 })] }))).toBe("MANUAL_APPROVAL");
  });

  it("파일 목록이 불완전/없음", () => {
    expect(verdictOf(make({ filesComplete: false }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ filesComplete: undefined }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ files: [] }))).toBe("BLOCK");
    expect(verdictOf(make({ files: undefined }))).toBe("BLOCK");
  });

  it("Issue와 무관한 패치는 BLOCK, 미확인은 MANUAL_APPROVAL", () => {
    expect(verdictOf(make({}, { patchMatchesIssue: false }))).toBe("BLOCK");
    expect(verdictOf(make({}, { patchMatchesIssue: undefined }))).toBe("MANUAL_APPROVAL");
  });
});

describe("PR 상태·승인", () => {
  it("Draft는 WAIT, draft 값 불명도 WAIT", () => {
    expect(verdictOf(make({}, { draft: true }))).toBe("WAIT");
    expect(verdictOf(make({}, { draft: undefined as unknown as boolean }))).toBe("WAIT");
  });

  it("이미 병합/닫힘/상태 불명은 BLOCK", () => {
    expect(verdictOf(make({}, { state: "merged" }))).toBe("BLOCK");
    expect(verdictOf(make({}, { state: "closed" }))).toBe("BLOCK");
    expect(verdictOf(make({}, { state: "weird" }))).toBe("BLOCK");
  });

  it("base != main, fork는 BLOCK", () => {
    expect(verdictOf(make({}, { baseRef: "develop" }))).toBe("BLOCK");
    expect(verdictOf(make({}, { isFork: true }))).toBe("BLOCK");
  });

  it("작성자 미확인/비신뢰는 MANUAL_APPROVAL", () => {
    expect(verdictOf(make({}, { author: undefined }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({}, { author: "stranger" }))).toBe("MANUAL_APPROVAL");
  });

  it("승인 라벨이 없으면 MANUAL_APPROVAL", () => {
    expect(verdictOf(make({}, { labels: [] }))).toBe("MANUAL_APPROVAL");
  });

  it("ai-dev-approved(Issue 승인)는 PR 병합 승인으로 인정하지 않는다", () => {
    const d = evaluateMergePolicy(make({}, { labels: ["ai-dev-approved"] }), OPTIONS);
    expect(d.verdict).toBe("MANUAL_APPROVAL");
    expect(d.reasons.map((r) => r.code)).toContain("NO_MERGE_APPROVAL");
  });

  it("승인 SHA 미기록은 MANUAL_APPROVAL, 승인 이후 HEAD 변경은 BLOCK", () => {
    expect(verdictOf(make({}, { approvedHeadSha: undefined }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({}, { approvedHeadSha: "c".repeat(40) }))).toBe("BLOCK");
  });

  it("재조회한 HEAD SHA가 다르거나 없으면 BLOCK", () => {
    expect(verdictOf(make({}, { observedHeadSha: "d".repeat(40) }))).toBe("BLOCK");
    expect(verdictOf(make({}, { observedHeadSha: undefined }))).toBe("BLOCK");
  });

  it("잘못된 SHA 형식은 자동 병합 불가", () => {
    expect(verdictOf(make({}, { headSha: "abc", observedHeadSha: "abc", approvedHeadSha: "abc" }))).toBe("BLOCK");
  });
});

describe("병합 가능 여부·의존성", () => {
  it("mergeable unknown/null은 WAIT", () => {
    expect(verdictOf(make({}, { mergeable: null }))).toBe("WAIT");
    expect(verdictOf(make({}, { mergeable: undefined }))).toBe("WAIT");
    expect(verdictOf(make({}, { mergeStateStatus: "unknown" }))).toBe("WAIT");
  });

  it("충돌(mergeable=false, dirty)은 BLOCK", () => {
    expect(verdictOf(make({}, { mergeable: false }))).toBe("BLOCK");
    expect(verdictOf(make({}, { mergeStateStatus: "dirty" }))).toBe("BLOCK");
  });

  it("behind 등 clean이 아닌 상태는 WAIT", () => {
    expect(verdictOf(make({}, { mergeStateStatus: "behind" }))).toBe("WAIT");
  });

  it("미병합 종속 PR / 의존성 미확인은 WAIT", () => {
    expect(verdictOf(make({}, { dependencies: [{ number: 213, merged: false }] }))).toBe("WAIT");
    expect(verdictOf(make({}, { dependencies: undefined }))).toBe("WAIT");
    expect(verdictOf(make({}, { dependencies: [{ number: 213, merged: true }] }))).toBe("MERGE_ELIGIBLE");
  });
});

describe("검증(checks / evidence)", () => {
  const check = (name: string, status: string, conclusion: string | null, headSha = HEAD) => ({
    name,
    status,
    conclusion,
    headSha,
  });

  it("pending/queued는 WAIT", () => {
    expect(verdictOf(make({ checks: [check("unit", "in_progress", null), check("build", "completed", "success")] }))).toBe("WAIT");
    expect(verdictOf(make({ checks: [check("unit", "queued", null), check("build", "completed", "success")] }))).toBe("WAIT");
  });

  it("취소된 check는 WAIT", () => {
    expect(verdictOf(make({ checks: [check("unit", "completed", "cancelled"), check("build", "completed", "success")] }))).toBe("WAIT");
  });

  it.each(["failure", "timed_out", "action_required", "skipped", "neutral"])("conclusion=%s는 BLOCK", (c) => {
    expect(verdictOf(make({ checks: [check("unit", "completed", c), check("build", "completed", "success")] }))).toBe("BLOCK");
  });

  it("required check 누락은 WAIT", () => {
    expect(verdictOf(make({ checks: [check("unit", "completed", "success")] }))).toBe("WAIT");
    expect(verdictOf(make({ checks: [] }))).toBe("WAIT");
    expect(verdictOf(make({ checks: undefined }))).toBe("WAIT");
  });

  it("required 목록을 알 수 없으면 MANUAL_APPROVAL 이상", () => {
    expect(verdictOf(make({ requiredChecks: undefined }))).toBe("MANUAL_APPROVAL");
    expect(verdictOf(make({ requiredChecks: [] }))).toBe("MANUAL_APPROVAL");
  });

  it("required가 아닌 workflow의 실패도 집계한다", () => {
    const checks = [...REQUIRED.map((n) => check(n, "completed", "success")), check("extra-workflow", "completed", "failure")];
    expect(verdictOf(make({ checks }))).toBe("BLOCK");
  });

  it("다른 커밋(과거 HEAD)에서 통과한 check는 인정하지 않는다", () => {
    const checks = REQUIRED.map((n) => check(n, "completed", "success", "e".repeat(40)));
    expect(verdictOf(make({ checks }))).toBe("WAIT");
  });

  it("합성 검증 증거 없음/오래됨(main 변경, HEAD 불일치)은 WAIT", () => {
    expect(verdictOf(make({ evidence: undefined }))).toBe("WAIT");
    expect(verdictOf(make({}, { currentMainSha: "f".repeat(40) }))).toBe("WAIT");
    expect(
      verdictOf(make({ evidence: { collectedByExecutor: true, headSha: "c".repeat(40), mainSha: MAIN, passed: true } })),
    ).toBe("WAIT");
  });

  it("실행기가 수집하지 않은 증거는 BLOCK, 증거 실패도 BLOCK", () => {
    expect(verdictOf(make({ evidence: { collectedByExecutor: false, headSha: HEAD, mainSha: MAIN, passed: true } }))).toBe("BLOCK");
    expect(verdictOf(make({ evidence: { collectedByExecutor: true, headSha: HEAD, mainSha: MAIN, passed: false } }))).toBe("BLOCK");
  });

  it("E2E가 필요하지만 실행되지 않았거나 필요 여부 불명이면 WAIT", () => {
    expect(verdictOf(make({ e2eRequired: true, e2eExecuted: false }))).toBe("WAIT");
    expect(verdictOf(make({ e2eRequired: undefined }))).toBe("WAIT");
    expect(verdictOf(make({ e2eRequired: true, e2eExecuted: true }))).toBe("MERGE_ELIGIBLE");
  });
});

describe("실제 PR 시나리오 dry-run", () => {
  const failingChecks = REQUIRED.map((name, i) => ({
    name,
    status: "completed",
    conclusion: i === 0 ? "failure" : "success",
    headSha: HEAD,
  }));

  it("#194 CI 변경 → MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file(".github/workflows/ci.yml")] }))).toBe("MANUAL_APPROVAL");
  });

  it("#197 권한 fixture 조작 테스트 → 파일명이 무해해도 쓰기 가능성이 있으면 BLOCK, 아니면 MANUAL_APPROVAL", () => {
    const scan = { verified: true, touchesSensitiveDomain: true };
    expect(verdictOf(make({ files: [file("tests/unit/aclFixture.test.ts", { contentScan: scan })] }))).toBe("MANUAL_APPROVAL");
    expect(
      verdictOf(make({ files: [file("tests/unit/aclFixture.test.ts", { contentScan: { ...scan, writesData: true } })] })),
    ).toBe("BLOCK");
  });

  it("#193 UI 변경 → MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file("app/admin/MonthPicker.tsx"), file("tests/unit/monthPicker.test.ts")] }))).toBe("MANUAL_APPROVAL");
  });

  it("#196 SQL → MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file("supabase/migrations/20261012_x.sql")] }))).toBe("MANUAL_APPROVAL");
  });

  it("#211 실패 재현 E2E(수정 PR #213 종속) → WAIT", () => {
    const input = make(
      { files: [file("tests/e2e/repro.spec.ts")], checks: failingChecks, e2eRequired: true, e2eExecuted: true },
      { dependencies: [{ number: 213, merged: false }] },
    );
    expect(verdictOf(input)).toBe("WAIT");
  });

  it("#213 UI 버그 수정 → MANUAL_APPROVAL", () => {
    expect(verdictOf(make({ files: [file("app/manager/Calendar.tsx")] }))).toBe("MANUAL_APPROVAL");
  });

  it("#205 실패 보고서(실패 check, 선행 PR 없음) → BLOCK", () => {
    expect(verdictOf(make({ checks: failingChecks }))).toBe("BLOCK");
  });

  it("BLOCK은 WAIT/MANUAL보다 우선한다", () => {
    const input = make({ files: [file("package.json")] }, { draft: true, state: "closed" });
    const d = evaluateMergePolicy(input, OPTIONS);
    expect(d.verdict).toBe("BLOCK");
    expect(codesOf(input)).toEqual(expect.arrayContaining(["DRAFT", "CLOSED", "SENSITIVE_PATH"]));
  });

  it("입력이 비정상이면 예외 없이 BLOCK", () => {
    expect(evaluateMergePolicy({} as MergePolicyInput, OPTIONS).verdict).toBe("BLOCK");
  });
});
