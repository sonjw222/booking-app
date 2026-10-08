#!/usr/bin/env node
// 스키마-only 덤프 정적 검사(네트워크 없음). dev에 적용하기 전에 반드시 통과해야 한다.
//   node scripts/ci-dev/schemaDumpCheck.mjs <dump.sql>      (exit 1 = 적용 금지)
// 검사: ① 최상위 COPY ... FROM stdin / INSERT INTO (함수 본문 안의 plpgsql INSERT는 제외) = 애플리케이션 데이터 ② 비밀 값 형태(JWT, sb_secret_, PG 키 등)
//       ③ PII(이메일/휴대폰 번호 형태; example.com·noreply 등 허용). 값은 출력하지 않고 "줄 번호 + 종류"만 보고한다.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// $tag$ ... $tag$ 본문을 같은 길이의 공백으로 치환(줄 번호 보존) — 최상위 문장만 남긴다.
export function stripDollarQuoted(sql) {
  return sql.replace(/(\$[A-Za-z_]*\$)[\s\S]*?\1/g, (m) => m.replace(/[^\n]/g, " "));
}
const SECRET_PATTERNS = [
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/],
  ["supabase key", /\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/],
  ["payment/PG key", /\b(test|live)_(sk|ck|gsk|gck)_[A-Za-z0-9]{8,}/],
  ["private key block", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["secret assignment", /\b(secret|token|api[_-]?key|password|webhook[_-]?secret)\b\s*[:=]\s*'[A-Za-z0-9_\-/+=]{16,}'/i],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_ALLOW = /@(example\.(com|org|net)|localhost|mwhabit\.com)$|^(noreply|no-reply|support)@/i;
const PHONE = /\b01[016789]-?\d{3,4}-?\d{4}\b/;

export function checkSchemaDump(sql) {
  const findings = [], lines = sql.split("\n"), top = stripDollarQuoted(sql).split("\n");
  top.forEach((l, i) => {
    const t = l.trim();
    if (/^COPY\s+\S+.*\bFROM\s+stdin\b/i.test(t)) findings.push({ line: i + 1, kind: "DATA: COPY ... FROM stdin" });
    else if (/^INSERT\s+INTO\b/i.test(t)) findings.push({ line: i + 1, kind: "DATA: top-level INSERT INTO" });
  });
  lines.forEach((l, i) => {
    for (const [kind, re] of SECRET_PATTERNS) if (re.test(l)) findings.push({ line: i + 1, kind: `SECRET: ${kind}` });
    for (const m of l.matchAll(EMAIL)) if (!EMAIL_ALLOW.test(m[0])) { findings.push({ line: i + 1, kind: "PII: email" }); break; }
    if (PHONE.test(l)) findings.push({ line: i + 1, kind: "PII: phone" });
  });
  return { ok: findings.length === 0, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error("사용: node scripts/ci-dev/schemaDumpCheck.mjs <dump.sql>"); process.exit(2); }
  const { ok, findings } = checkSchemaDump(readFileSync(file, "utf8"));
  if (ok) { console.log("schema dump check: OK — 데이터/비밀/PII 패턴 없음"); process.exit(0); }
  console.error(`schema dump check: FAILED — dev에 적용하지 마세요 (${findings.length}건, 값은 출력하지 않음)`);
  for (const f of findings.slice(0, 50)) console.error(`  line ${f.line}: ${f.kind}`);
  process.exit(1);
}
