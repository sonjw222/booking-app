// Playwright JSON 결과(tests/e2e/admin-qa) → 역할 × 액션 매트릭스 마크다운. 사용: node buildMatrix.mjs <results.json> <출력.md>
import fs from "node:fs";
const [inFile, outFile] = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(inFile, "utf8")); const rows = [];
const walk = (s, file = "") => { for (const sp of s.specs ?? []) for (const t of sp.tests) { const res = t.results[t.results.length - 1]; const m = /^\[([^\]]+)\]\s*(.*)$/.exec(sp.title); rows.push({ file: sp.file ?? file, role: m?.[1] ?? "-", action: (m?.[2] ?? sp.title), status: res.status === "passed" ? "PASS" : res.status === "skipped" ? "BLOCKED" : "FAIL", ms: res.duration, ann: t.annotations ?? [] }); } for (const c of s.suites ?? []) walk(c, s.file ?? file); };
for (const s of r.suites) walk(s);
const esc = (x) => String(x).replace(/\|/g, "\\|").replace(/\n/g, " ");
const cnt = (st) => rows.filter((x) => x.status === st).length;
let md = `# 관리자 QA 매트릭스 (이슈 #239) — 자동 생성\n\n실행 결과 ${rows.length}건: PASS ${cnt("PASS")} / FAIL ${cnt("FAIL")} / BLOCKED ${cnt("BLOCKED")}. 환경: 로컬 격리 Supabase 스택 + 실제 Chromium(Playwright). 공유 DEV·운영 미사용.\n\n| 역할 | 액션 | 결과 | 파일 | 메모 |\n|---|---|---|---|---|\n`;
for (const x of rows) md += `| ${esc(x.role)} | ${esc(x.action)} | **${x.status}** | \`${x.file.split("/").pop()}\` | ${esc(x.ann.filter((a) => ["observed", "matrix", "a11y"].includes(a.type)).map((a) => a.description).join(" / ").slice(0, 400))} |\n`;
fs.writeFileSync(outFile, md); console.log(`matrix: ${rows.length} rows, PASS ${cnt("PASS")} FAIL ${cnt("FAIL")} BLOCKED ${cnt("BLOCKED")}`);
