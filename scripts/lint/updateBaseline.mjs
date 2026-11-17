// 사용: 저장소 루트에서 `node scripts/lint/updateBaseline.mjs`
// 현재 ESLint 에러(severity 2)로 scripts/lint/baseline.json 을 갱신한다(check.mjs 와 같은 키: [파일, 규칙, 해당 줄 trim]).
// 기존 키 순서를 유지하고(사라진 키 삭제·개수 갱신), 새 키는 같은 파일의 마지막 키 뒤에 넣어 PR 간 diff 충돌을 줄인다. 에러가 늘어나는지 확인하려면 `npm run lint` 를 쓴다.
import { ESLint } from "eslint";
import { writeFileSync, readFileSync } from "node:fs";
import { relative } from "node:path";
const eslint = new ESLint();
const results = await eslint.lintFiles(["."]);
const seen = {};
for (const r of results) {
  const lines = (r.source ?? "").split("\n");
  for (const m of r.messages.filter((x) => x.severity === 2)) {
    const key = JSON.stringify([relative(process.cwd(), r.filePath), m.ruleId, lines[m.line - 1]?.trim() ?? ""]);
    seen[key] = (seen[key] ?? 0) + 1;
  }
}
const old = JSON.parse(readFileSync("scripts/lint/baseline.json", "utf8"));
const keys = Object.keys(old).filter((k) => k in seen);                      // 사라진 키 제거(순서 유지)
const fileOf = (k) => JSON.parse(k)[0];
for (const k of Object.keys(seen).filter((k) => !(k in old))) {              // 새 키(편집으로 줄이 바뀐 잔여 진단): 같은 파일 마지막 키 뒤, 없으면 파일명 순서 위치
  const f = fileOf(k);
  let at = -1;
  for (let i = 0; i < keys.length; i++) if (fileOf(keys[i]) === f) at = i;
  if (at < 0) { at = keys.findIndex((x) => fileOf(x) > f); at = at < 0 ? keys.length - 1 : at - 1; }
  keys.splice(at + 1, 0, k);
}
const next = Object.fromEntries(keys.map((k) => [k, seen[k]]));
writeFileSync("scripts/lint/baseline.json", JSON.stringify(next, null, 2) + "\n");
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
console.log(`baseline: ${Object.keys(old).length} keys (${sum(old)}) -> ${keys.length} keys (${sum(next)})`);
