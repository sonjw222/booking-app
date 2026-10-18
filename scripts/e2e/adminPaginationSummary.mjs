// Playwright JSON 리포트를 PASS / FAIL / SKIP / BLOCKED로 나눈다(읽기 전용 — 파일만 읽고 아무 것도 실행하지 않는다).
// Playwright는 통과·실패·skipped만 구분하므로, skip 사유가 "BLOCKED:"로 시작하는 것을 BLOCKED(전제 부족, PASS 아님)로 센다.
export function classifyReport(report) {
  const out = { PASS: [], FAIL: [], SKIP: [], BLOCKED: [] };
  const walk = (suite, trail) => {
    const here = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const title = [...here, spec.title].filter(Boolean).join(" › ");
        const results = t.results ?? [];
        const finalStatus = results.length ? results[results.length - 1].status : t.status;
        const skipNote = (t.annotations ?? []).find((a) => a.type === "skip")?.description ?? "";
        if (t.status === "skipped" || finalStatus === "skipped") {
          (skipNote.startsWith("BLOCKED") ? out.BLOCKED : out.SKIP).push({ title, reason: skipNote });
        } else if (t.status === "expected") out.PASS.push({ title });
        else out.FAIL.push({ title, reason: t.status });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const s of report.suites ?? []) walk(s, []);
  // 종합: FAIL이 있으면 FAIL, BLOCKED/SKIP이 있거나 PASS가 0개면 PASS가 아니다(INCOMPLETE).
  const overall = out.FAIL.length ? "FAIL" : out.BLOCKED.length || out.SKIP.length || out.PASS.length === 0 ? "INCOMPLETE" : "PASS";
  return { ...out, overall };
}

export function formatSummary(label, c) {
  const lines = [`[admin-pagination] ${label} 요약: PASS ${c.PASS.length} / FAIL ${c.FAIL.length} / BLOCKED ${c.BLOCKED.length} / SKIP ${c.SKIP.length} → ${c.overall}`];
  for (const k of ["FAIL", "BLOCKED", "SKIP"]) for (const x of c[k]) lines.push(`  - ${k}: ${x.title}${x.reason ? ` (${x.reason})` : ""}`);
  if (c.overall === "INCOMPLETE") lines.push("  ※ BLOCKED/SKIP은 PASS가 아닙니다. 전제(관리자 계정·상태별 31건 이상 데이터·ON용 RPC)를 갖춘 뒤 다시 실행해야 완료입니다.");
  return lines.join("\n");
}
