/*
  E2E 진단 reporter(2026-10-07) — 실패/timeout/flaky 테스트를 "끝나는 즉시" stdout(CI 로그)에 한 줄 요약 + 에러 앞부분으로 남긴다.
  배경: list reporter는 실패 상세를 run 끝에 몰아서 출력하므로 job이 30분 timeout으로 cancelled되면(#166/#167/#169) 어떤 에러였는지가 로그에 하나도 남지 않았다.
  민감 정보 보호: JWT 형태 문자열과 password/key/secret/token/email 계열 환경변수의 "값"은 출력 전에 가린다.
*/
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";

const SENSITIVE_ENV = /(PASSWORD|KEY|SECRET|TOKEN|EMAIL|AUTHORIZATION)/i;

export function redact(text: string, env: Record<string, string | undefined> = process.env): string {
  let out = text.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[JWT]");
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= 4 && SENSITIVE_ENV.test(name)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  return out.replace(/\x1b\[[0-9;]*m/g, "");   // ANSI 색상 제거
}

export function summarizeResult(test: Pick<TestCase, "title" | "location" | "outcome">, result: Pick<TestResult, "status" | "retry" | "duration" | "errors" | "attachments">, env?: Record<string, string | undefined>): string | null {
  if (result.status === "passed" || result.status === "skipped") return null;
  const err = result.errors[0];
  const msg = redact([err?.message, err?.location ? `at ${err.location.file.split("/tests/")[1] ?? err.location.file}:${err.location.line}` : ""].filter(Boolean).join("\n"), env).slice(0, 900);
  const attach = result.attachments.map((a) => a.name).join(",");
  return `[e2e-diag] ${result.status.toUpperCase()} retry=${result.retry} ${Math.round(result.duration / 1000)}s ${test.location.file.split("/tests/")[1] ?? test.location.file}:${test.location.line} › ${test.title}\n${msg}${attach ? `\n(attachments: ${attach})` : ""}`;
}

export default class DiagnosticsReporter implements Reporter {
  onBegin(config: FullConfig, suite: Suite) {
    console.log(`[e2e-diag] begin: ${suite.allTests().length} tests, workers=${config.workers}, baseURL=${config.projects[0]?.use?.baseURL ?? "?"}, CI=${process.env.CI ? "yes" : "no"}`);
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const line = summarizeResult(test, result);
    if (line) console.log(line);
  }
  onEnd(result: FullResult) {
    console.log(`[e2e-diag] end: ${result.status} (${Math.round(result.duration / 1000)}s)`);
  }
}
