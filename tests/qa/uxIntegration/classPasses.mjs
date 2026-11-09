import { ctxFor, BASE, UX, browser, OUT, settle, psql, check, save } from "./lib.mjs";
const cls = psql(`select id||'|'||title||'|'||pass_selection_mode from classes where center_id='${UX}' order by start_time`).split("\n").map((l) => l.split("|"));
const [A, B, ALL, SEL] = cls.map((c) => c[0]);
const { ctx, page: p } = await ctxFor();
const body = async () => (await p.locator("body").innerText()).replace(/\n+/g, " | ");
// 센터 수업 탭
await p.goto(`${BASE}/center/${UX}`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
await p.getByText("수업", { exact: true }).first().click(); await settle(p, 2500);
let t = await body();
check("C1", "센터 수업 탭: 11월 1/4/8/12회 변형이 '[UX] 11월 수강권' 한 줄로 병합", (t.match(/\[UX\] 11월 수강권/g) || []).length === 1 && !/11월 수강권 (1|4|8|12)회/.test(t) ? "PASS" : "FAIL", (t.match(/\[UX\] 11월[^|]*/g) || []).join(" ; "));
check("C2", "센터 수업 탭: '모든 수강권 가능'은 전체 허용 수업에만", /\[UX\] 전체 수강권 수업[^\[]*모든 수강권 가능/.test(t) && (t.match(/모든 수강권 가능/g) || []).length === 1 ? "PASS" : "FAIL");
check("C3", "선택형 수업은 허용 수강권(자유 선택 수강권) 표시", /\[UX\] 선택형 수강권 수업[\s\S]*\[UX\] 자유 선택 수강권/.test(t) ? "PASS" : "FAIL");
await p.screenshot({ path: `${OUT}/class-tab.png`, fullPage: true });
// 수업 상세: 같은 이름 두 수업이 각자 허용 수강권을 보여줌(class_id 기준)
for (const [id, want, notWant, tag] of [[A, "11월 수강권", "12월 수강권", "A(11월)"], [B, "12월 수강권", "11월 수강권", "B(12월)"]]) {
  await p.goto(`${BASE}/center/${UX}/class/${id}`, { waitUntil: "domcontentloaded" }); await settle(p, 3500); t = await body();
  check(`C4-${tag}`, `같은 이름 수업 ${tag} 상세: 자기 허용 수강권만 병합 표시(다른 수업 것 섞임 없음)`, t.includes(`[UX] ${want}`) && !t.includes(`[UX] ${notWant}`) && !/수강권 (1|4|8|12)회/.test(t.replace(/\d+회 수강권/g, "")) ? "PASS" : "FAIL", (t.match(/\[UX\] 1[12]월[^|]*/g) || []).join(" ; "));
  await p.screenshot({ path: `${OUT}/class-detail-${tag.startsWith("A") ? "A" : "B"}.png` });
}
// 허용 수강권 조회 실패 → '모든 수강권 가능'으로 표시하면 안 됨
await p.route("**/rest/v1/class_allowed_products*", (r) => r.abort());
await p.goto(`${BASE}/center/${UX}`, { waitUntil: "domcontentloaded" }); await settle(p, 3500);
await p.getByText("수업", { exact: true }).first().click(); await settle(p, 2500); t = await body();
const allCount = (t.match(/모든 수강권 가능/g) || []).length;
check("C5", "허용 수강권 조회 실패 시 어떤 수업도 '모든 수강권 가능'으로 표시되지 않고 '수업 상세에서 확인'으로 안내(안전 쪽 실패)", allCount === 0 && /수강권은 수업 상세에서 확인/.test(t) ? "PASS" : "FAIL", `all=${allCount} ${t.slice(t.indexOf("운영 중인"), t.indexOf("운영 중인") + 260)}`);
await p.screenshot({ path: `${OUT}/class-tab-fetch-fail.png`, fullPage: true });
save("C"); await browser.close();
