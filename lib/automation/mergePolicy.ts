/*
  PR 자동 병합 안전 판정 엔진(순수 함수, dry-run 전용).

  입력(PR 메타·변경 파일·검증 결과)을 받아 MERGE_ELIGIBLE / WAIT / MANUAL_APPROVAL / BLOCK 으로
  분류하고 이유 목록을 돌려준다. 네트워크·Git·파일 접근을 전혀 하지 않으며, 입력 수집과 검증은
  (후속) 실행기의 책임이다. 이 모듈은 PR을 병합하지 않는다.

  원칙: Fail closed. 알 수 없거나 누락된 값은 절대 "안전"으로 해석하지 않는다.
  심각도 우선순위: BLOCK > WAIT > MANUAL_APPROVAL > MERGE_ELIGIBLE.
*/

export type MergeVerdict = "MERGE_ELIGIBLE" | "WAIT" | "MANUAL_APPROVAL" | "BLOCK";

export const MERGE_APPROVAL_LABEL = "ai-merge-approved";
/** GitHub Issue용 승인 라벨. PR 병합 승인으로 인정하지 않는다. */
export const ISSUE_APPROVAL_LABEL = "ai-dev-approved";

export const MAX_AUTO_MERGE_FILES = 10;
export const MAX_AUTO_MERGE_CHANGED_LINES = 400;

export type FileStatus = "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";

export interface ChangedFile {
  path: string;
  status: FileStatus | string;
  additions: number;
  deletions: number;
  /** GitHub가 patch를 제공했는가(바이너리/대용량이면 false). */
  patchAvailable: boolean;
  /** 실행기가 확인한 파일 모드(120000=symlink, 160000=submodule). */
  mode?: string;
  /** 실행기가 patch 본문을 스캔한 결과. 없으면 "미검증"으로 취급한다. */
  contentScan?: { verified: boolean; writesData?: boolean; touchesSensitiveDomain?: boolean };
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion?: "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "action_required" | string | null;
  /** 이 check가 실행된 커밋 SHA. */
  headSha: string;
}

export interface VerificationEvidence {
  /** 실행기가 직접 수집한 증거인가(PR 본문/코멘트의 주장은 false). */
  collectedByExecutor: boolean;
  /** 현재 HEAD + 최신 main을 합성(merge)해서 검증했을 때의 SHA. */
  headSha: string;
  mainSha: string;
  passed: boolean;
}

export interface PrSnapshot {
  number: number;
  state: "open" | "closed" | "merged" | string;
  draft: boolean;
  baseRef: string;
  headSha: string;
  /** 실행기가 병합 직전 GitHub에서 다시 조회한 HEAD SHA. */
  observedHeadSha?: string;
  currentMainSha: string;
  author?: string;
  isFork: boolean;
  labels: string[];
  /** 승인 라벨이 붙은 시점에 고정된 HEAD SHA. */
  approvedHeadSha?: string;
  mergeable: boolean | null | undefined;
  mergeStateStatus?: "clean" | "dirty" | "behind" | "blocked" | "unstable" | "unknown" | "has_hooks" | string;
  /** 선행되어야 하는 PR. undefined면 의존성 미확인. */
  dependencies?: { number: number; merged: boolean }[];
  /** 실행기가 PR 패치가 Issue/제목 범위와 일치함을 확인했는가. */
  patchMatchesIssue?: boolean;
}

export interface MergePolicyInput {
  pr: PrSnapshot;
  /** undefined 또는 filesComplete=false면 diff 불확실. */
  files?: ChangedFile[];
  filesComplete?: boolean;
  checks?: CheckRun[];
  /** 브랜치 보호 규칙 등에서 실행기가 가져온 required check 이름. */
  requiredChecks?: string[];
  evidence?: VerificationEvidence;
  e2eRequired?: boolean;
  e2eExecuted?: boolean;
}

export interface MergePolicyOptions {
  trustedAuthors: string[];
  baseBranch?: string;
}

export interface MergeReason {
  code: string;
  verdict: Exclude<MergeVerdict, "MERGE_ELIGIBLE">;
  message: string;
}

export interface MergeDecision {
  verdict: MergeVerdict;
  reasons: MergeReason[];
}

const RANK: Record<MergeVerdict, number> = { MERGE_ELIGIBLE: 0, MANUAL_APPROVAL: 1, WAIT: 2, BLOCK: 3 };
const SHA_RE = /^[0-9a-f]{40}$/;

const BLOCK_PATH_RES = [
  /(^|\/)\.env(\.|$)/,
  /(^|\/)(secrets?|credentials?)(\/|\.|$)/,
  /\.(pem|p12|key|keystore|jks|mobileprovision)$/,
  /(^|\/)(id_rsa|service[-_]?account[^/]*\.json)$/,
];

const MANUAL_PATH_RES = [
  /\.sql$/,
  /^supabase\//,
  /^\.github\//,
  /^scripts\//,
  /^(ios|android)\//,
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|podfile\.lock|gradle\.lockfile)$/,
  /(^|\/)[^/]*\.config\.(js|ts|mjs|cjs|json)$/,
  /(^|\/)(vercel\.json|tsconfig[^/]*\.json|\.npmrc|dockerfile)$/,
  /^tests\/e2e\//,
  /^tests\/(integration|live)\//,
  /^(tools|agent)\//,
  /^app\//,
  /^lib\//,
];

/** 파일명이 무해해 보여도 민감 도메인 키워드를 포함하면 단위 테스트도 수동 처리. */
const SENSITIVE_KEYWORD_RE =
  /(auth|login|signup|session|payment|billing|toss|checkout|refund|reserv|booking|pass|membership|acl|permission|role|rls|rpc|policy|supabase|secret|token|env|admin|ci[-_.]|workflow|e2e|live|seed|migration|production)/i;

function isDocsPath(p: string): boolean {
  return /^docs\/.+\.(md|mdx|txt)$/i.test(p);
}

function isUnitTestPath(p: string): boolean {
  return /^tests\/unit\/[^/]+\.test\.ts$/.test(p);
}

export function evaluateMergePolicy(input: MergePolicyInput, options: MergePolicyOptions): MergeDecision {
  const reasons: MergeReason[] = [];
  const add = (verdict: MergeReason["verdict"], code: string, message: string) =>
    reasons.push({ code, verdict, message });
  const pr = input?.pr;
  if (!pr || typeof pr.number !== "number") {
    return { verdict: "BLOCK", reasons: [{ code: "NO_PR", verdict: "BLOCK", message: "PR 정보가 없다." }] };
  }
  const base = options.baseBranch ?? "main";
  const labels = Array.isArray(pr.labels) ? pr.labels : [];

  // ── PR 상태 ──
  if (pr.state === "merged") add("BLOCK", "ALREADY_MERGED", "이미 병합된 PR이다.");
  else if (pr.state === "closed") add("BLOCK", "CLOSED", "닫힌 PR이다.");
  else if (pr.state !== "open") add("BLOCK", "STATE_UNKNOWN", `PR 상태를 알 수 없다: ${String(pr.state)}`);
  if (pr.draft !== false) add("WAIT", "DRAFT", "Draft PR이거나 draft 여부를 알 수 없다.");
  if (pr.baseRef !== base) add("BLOCK", "BASE_MISMATCH", `base가 ${base}가 아니다: ${String(pr.baseRef)}`);
  if (pr.isFork !== false) add("BLOCK", "FORK", "fork PR이거나 출처를 알 수 없다(비신뢰).");

  // ── 작성자·승인 ──
  if (!pr.author) add("MANUAL_APPROVAL", "AUTHOR_UNKNOWN", "작성자를 확인할 수 없다.");
  else if (!options.trustedAuthors.includes(pr.author))
    add("MANUAL_APPROVAL", "AUTHOR_UNTRUSTED", `허용 목록에 없는 작성자: ${pr.author}`);

  const headOk = typeof pr.headSha === "string" && SHA_RE.test(pr.headSha);
  const mainOk = typeof pr.currentMainSha === "string" && SHA_RE.test(pr.currentMainSha);
  if (!headOk) add("BLOCK", "HEAD_SHA_INVALID", "HEAD SHA가 올바르지 않다.");
  if (!mainOk) add("WAIT", "MAIN_SHA_INVALID", "최신 main SHA를 확인할 수 없다.");
  if (headOk && pr.observedHeadSha !== pr.headSha)
    add("BLOCK", "HEAD_SHA_MISMATCH", "재조회한 HEAD SHA가 판정 입력과 다르거나 없다.");

  if (!labels.includes(MERGE_APPROVAL_LABEL)) {
    add(
      "MANUAL_APPROVAL",
      "NO_MERGE_APPROVAL",
      labels.includes(ISSUE_APPROVAL_LABEL)
        ? `${ISSUE_APPROVAL_LABEL}는 Issue 승인이며 PR 병합 승인이 아니다.`
        : `${MERGE_APPROVAL_LABEL} 라벨이 없다.`,
    );
  } else if (!pr.approvedHeadSha) {
    add("MANUAL_APPROVAL", "APPROVAL_SHA_MISSING", "승인 당시 HEAD SHA가 기록되지 않았다.");
  } else if (pr.approvedHeadSha !== pr.headSha) {
    add("BLOCK", "APPROVAL_STALE", "승인 이후 HEAD가 바뀌었다. 이전 승인을 재사용할 수 없다.");
  }

  // ── 병합 가능 여부 ──
  if (pr.mergeable === false || pr.mergeStateStatus === "dirty")
    add("BLOCK", "CONFLICT", "병합 충돌 또는 병합 불가 상태다.");
  else if (pr.mergeable !== true || pr.mergeStateStatus === "unknown" || pr.mergeStateStatus === undefined)
    add("WAIT", "MERGEABLE_UNKNOWN", "병합 가능 여부가 아직 계산되지 않았다.");
  else if (pr.mergeStateStatus !== "clean") add("WAIT", "NOT_CLEAN", `병합 상태가 clean이 아니다: ${pr.mergeStateStatus}`);

  // ── 의존 PR ──
  const unmergedDeps = (pr.dependencies ?? []).filter((d) => !d.merged);
  if (!pr.dependencies) add("WAIT", "DEPENDENCIES_UNKNOWN", "의존 PR 정보를 확인할 수 없다.");
  if (unmergedDeps.length)
    add("WAIT", "DEPENDENCY_UNMERGED", `미병합 선행 PR: ${unmergedDeps.map((d) => `#${d.number}`).join(", ")}`);

  // ── 검증(checks / evidence) ──
  evaluateChecks(input, headOk ? pr.headSha : "", unmergedDeps.length > 0, add);
  const ev = input.evidence;
  if (!ev) add("WAIT", "NO_EVIDENCE", "현재 HEAD+최신 main 합성 검증 증거가 없다.");
  else if (!ev.collectedByExecutor) add("BLOCK", "EVIDENCE_UNTRUSTED", "실행기가 수집하지 않은 검증 증거다.");
  else if (ev.headSha !== pr.headSha || ev.mainSha !== pr.currentMainSha)
    add("WAIT", "EVIDENCE_STALE", "검증 증거가 현재 HEAD 또는 최신 main에 대한 것이 아니다. 재검증 필요.");
  else if (!ev.passed) add("BLOCK", "EVIDENCE_FAILED", "합성 검증이 통과하지 못했다.");

  // ── 파일 ──
  evaluateFiles(input, pr, add);

  if (input.e2eRequired !== false && !input.e2eExecuted)
    add("WAIT", "E2E_NOT_RUN", "E2E 필요 여부가 불명확하거나, 필요하지만 실행되지 않았다.");

  const verdict = reasons.reduce<MergeVerdict>((v, r) => (RANK[r.verdict] > RANK[v] ? r.verdict : v), "MERGE_ELIGIBLE");
  return { verdict, reasons };
}

type Add = (verdict: MergeReason["verdict"], code: string, message: string) => void;

function evaluateChecks(input: MergePolicyInput, headSha: string, hasUnmergedDeps: boolean, add: Add): void {
  const required = input.requiredChecks;
  const checks = input.checks;
  if (!required || required.length === 0) {
    add("MANUAL_APPROVAL", "REQUIRED_CHECKS_UNKNOWN", "required check 목록을 확인할 수 없다.");
  }
  if (!checks) {
    add("WAIT", "CHECKS_MISSING", "check 결과가 없다.");
    return;
  }
  for (const name of required ?? []) {
    if (!checks.some((c) => c.name === name)) add("WAIT", "REQUIRED_CHECK_MISSING", `required check 누락: ${name}`);
  }
  // required 여부와 관계없이 모든 check(Actions workflow 포함)를 집계한다.
  for (const c of checks) {
    if (c.headSha !== headSha) add("WAIT", "CHECK_STALE", `다른 커밋에서 실행된 check: ${c.name}`);
    else if (c.status !== "completed") add("WAIT", "CHECK_PENDING", `검증 진행 중: ${c.name}`);
    else if (c.conclusion === "cancelled") add("WAIT", "CHECK_CANCELLED", `취소된 check: ${c.name}`);
    else if (c.conclusion === "success") continue;
    else if (hasUnmergedDeps) add("WAIT", "CHECK_FAILED_DEPENDENT", `check 실패(선행 PR 대기 중): ${c.name}`);
    else add("BLOCK", "CHECK_FAILED", `check 실패(${String(c.conclusion)}): ${c.name}`);
  }
}

function evaluateFiles(input: MergePolicyInput, pr: PrSnapshot, add: Add): void {
  const files = input.files;
  if (!files || files.length === 0) {
    add("BLOCK", "NO_FILES", "변경 파일 정보가 없다.");
    return;
  }
  if (input.filesComplete !== true) add("MANUAL_APPROVAL", "DIFF_INCOMPLETE", "변경 파일 목록이 완전하지 않다(추가 diff 불확실).");
  if (pr.patchMatchesIssue === false) add("BLOCK", "UNRELATED_PATCH", "PR 패치가 Issue 범위와 무관하다.");
  else if (pr.patchMatchesIssue !== true) add("MANUAL_APPROVAL", "SCOPE_UNVERIFIED", "패치와 Issue 범위 일치가 확인되지 않았다.");

  let lines = 0;
  for (const f of files) {
    const p = typeof f.path === "string" ? f.path : "";
    const lower = p.toLowerCase();
    lines += (Number(f.additions) || 0) + (Number(f.deletions) || 0);
    if (!p || p.startsWith("/") || p.includes("\\") || p.split("/").includes("..") || p.includes("\0")) {
      add("BLOCK", "PATH_INVALID", `비정상 경로: ${p}`);
      continue;
    }
    if (f.mode === "120000") add("BLOCK", "SYMLINK", `symlink: ${p}`);
    if (f.mode === "160000") add("BLOCK", "SUBMODULE", `submodule: ${p}`);
    if (f.status !== "added" && f.status !== "modified")
      add("MANUAL_APPROVAL", "FILE_STATUS", `추가/수정 외 변경(${String(f.status)}): ${p}`);
    if (!f.patchAvailable) add("MANUAL_APPROVAL", "PATCH_MISSING", `patch 메타데이터 없음: ${p}`);
    if (BLOCK_PATH_RES.some((re) => re.test(lower))) {
      add("BLOCK", "SECRET_PATH", `비밀키/환경변수 관련 경로: ${p}`);
      continue;
    }
    if (f.contentScan?.writesData) add("BLOCK", "TEST_WRITES_DATA", `운영 데이터/권한에 쓰기 가능성: ${p}`);
    if (MANUAL_PATH_RES.some((re) => re.test(lower))) {
      add("MANUAL_APPROVAL", "SENSITIVE_PATH", `자동 병합 비대상 경로: ${p}`);
    } else if (isDocsPath(p)) {
      // 순수 문서: 추가 조건 없음.
    } else if (isUnitTestPath(p)) {
      if (SENSITIVE_KEYWORD_RE.test(p.slice("tests/unit/".length)))
        add("MANUAL_APPROVAL", "SENSITIVE_TEST", `민감 도메인 가능성이 있는 테스트: ${p}`);
      else if (!f.contentScan?.verified || f.contentScan.touchesSensitiveDomain !== false)
        add("MANUAL_APPROVAL", "TEST_UNSCANNED", `테스트 내용이 검증되지 않았다: ${p}`);
    } else {
      add("MANUAL_APPROVAL", "NOT_ALLOWLISTED", `허용 범위(문서·일반 단위 테스트) 밖: ${p}`);
    }
  }
  if (files.length > MAX_AUTO_MERGE_FILES || lines > MAX_AUTO_MERGE_CHANGED_LINES)
    add("MANUAL_APPROVAL", "LARGE_CHANGE", `대량 변경: ${files.length}개 파일, ${lines}줄`);
}
