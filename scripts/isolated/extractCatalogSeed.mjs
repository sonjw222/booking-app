#!/usr/bin/env node
/*
  격리 환경 카탈로그(참조/구성) 시드 생성기 — 저장소의 루트 SQL 파일에서 `insert into permissions|subscription_plans|service_categories ...` 문장만 뽑는다.
  운영·공유 DEV 의 데이터를 복사하지 않는다(이 스크립트는 DB 에 접속하지 않고 저장소 파일만 읽는다). 결과는 supabase seed 로 쓸 SQL(멱등: 충돌 시 무시).
  사용: node scripts/isolated/extractCatalogSeed.mjs <출력.sql>
  한계: 파일명 순서는 적용 순서가 아니므로, 같은 키를 바꾸는 후속 변경(update/delete)은 반영하지 않는다 — 결과 키 집합은 scripts/isolated/compareCatalogKeys.md 의 절차로 공유 DEV 와 이름만 대조한다.
*/
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TABLES = ["permissions", "subscription_plans", "service_categories"];
const files = fs.readdirSync(root).filter((f) => f.endsWith(".sql") && !/^(rollback_|reset_|cleanup_|diagnose_|verify_)/.test(f)).sort();

/** 따옴표('...', $$...$$)·주석(-- ...)을 존중하며 시작 위치부터 문장 끝(;)까지 읽는다. */
function readStatement(src, start) {
  let i = start, inS = false, inDollar = false;
  while (i < src.length) {
    const c = src[i], two = src.slice(i, i + 2);
    if (inDollar) { if (two === "$$") { inDollar = false; i += 2; continue; } i++; continue; }
    if (inS) { if (c === "'" && src[i + 1] === "'") { i += 2; continue; } if (c === "'") inS = false; i++; continue; }
    if (two === "--") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "'") { inS = true; i++; continue; }
    if (two === "$$") { inDollar = true; i += 2; continue; }
    if (c === ";") return src.slice(start, i + 1);
    i++;
  }
  return null;
}
// 파일명 순서는 적용 순서가 아니므로, "나중에 지워진 키"는 그 삭제를 명시한 저장소 migration 의 DELETE 문장만 골라 마지막에 적용한다(공유 DEV 와 키 이름 집합이 일치함을 확인한 3개 파일).
// fix_*_catalog_hide 계열은 fix_restore_* 가 되살리므로 제외한다.
const DELETE_FILES = ["add_schedule_permission_completion.sql", "fix_customer_permission_cleanup.sql", "fix_pass_product_permission_cleanup.sql"];
const out = []; const seen = new Set(); const perTable = Object.fromEntries(TABLES.map((t) => [t, 0]));
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), "utf8");
  const re = new RegExp(`^\\s*insert\\s+into\\s+(?:public\\.)?(${TABLES.join("|")})\\b`, "gim");
  let m;
  while ((m = re.exec(src))) {
    const before = src.slice(0, m.index); const line = before.slice(before.lastIndexOf("\n") + 1);
    if (/^\s*--/.test(line)) continue;                                   // 주석 처리된 문장
    const stmt = readStatement(src, m.index + m[0].length - m[0].trimStart().length); if (!stmt) continue;
    let s = stmt.trim();
    if (/\bselect\b[\s\S]*\bfrom\b\s+(?!\()/i.test(s) && !/\bvalues\b/i.test(s) && m[1] !== "subscription_plans") continue;   // 다른 테이블을 읽는 INSERT…SELECT 는 제외(기본 요금제 한 건만 허용)
    if (!/\bon\s+conflict\b/i.test(s)) s = s.replace(/;\s*$/, " on conflict do nothing;");
    const key = s.replace(/\s+/g, " "); if (seen.has(key)) continue; seen.add(key);
    out.push(`-- ${f}\n${s}`); perTable[m[1]]++;
  }
}
const deletes = [];
for (const f of DELETE_FILES) {
  const src = fs.readFileSync(path.join(root, f), "utf8"); const re = /^\s*delete\s+from\s+(?:public\.)?permissions\b/gim; let m;
  while ((m = re.exec(src))) { const line = src.slice(src.lastIndexOf("\n", m.index - 1) + 1, m.index); if (/--/.test(line)) continue; const stmt = readStatement(src, m.index + m[0].length - m[0].trimStart().length); if (stmt) deletes.push(`-- ${f}\n${stmt.trim()}`); }
}
const header = `-- 격리 환경 카탈로그 시드(자동 생성: scripts/isolated/extractCatalogSeed.mjs). 저장소 SQL 의 INSERT 문장만 모았다 — 운영/공유 DEV 데이터 복사 아님.\n-- 문장 수: ${JSON.stringify(perTable)}\n`;
// permissions.parent_key FK 때문에 부모 키가 뒤 파일에 있을 수 있어, 적재 동안만 FK 트리거를 끈다(session_replication_role=replica, 로컬 supabase 의 postgres 는 superuser). 모든 INSERT 는 충돌 시 무시라 멱등이다.
const body = out.join("\n\n");
fs.writeFileSync(process.argv[2] ?? "/dev/stdout", header + "\nset session_replication_role = replica;\n\n" + body + "\n\n-- ── 이후 저장소 migration 이 명시적으로 지운 권한 키 ──\n" + deletes.join("\n\n") + "\n\nset session_replication_role = origin;\n");
console.error(`deletes: ${deletes.length}; statements: ${out.length} ${JSON.stringify(perTable)} from ${files.length} files`);
