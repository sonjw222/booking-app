/*
  출시 전 실기기 QA 후속 배치(2026-10-03): Google URL scheme / white flash / 회원 이름·등록 노출·검색 / 예약조건 일괄 / 진도 7단계 tree.
  실제 Client ID/URL scheme 값은 어디에도 출력하지 않는다(존재 여부와 형식만 검증).
*/
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

// ---- 가짜 supabase (members.ts 검색/목록)
const calls: { table: string; ilike: [string, string][]; select: string }[] = [];
let tables: Record<string, any[]> = {};
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      const rec = { table, ilike: [] as [string, string][], select: "" };
      const chain: any = {
        select(s: string) { rec.select = s; return chain; },
        eq() { return chain; }, in() { return chain; }, order() { return chain; }, limit() { return chain; }, is() { return chain; },
        ilike(c: string, v: string) { rec.ilike.push([c, v]); return chain; },
        then(res: any) { calls.push(rec); return Promise.resolve({ data: tables[table] ?? [], error: null }).then(res); },
      };
      return chain;
    },
    rpc: async () => ({ data: [], error: null }),
  },
}));
import { fetchMembers, searchAccountsForMember } from "../../lib/members";
import { displayMemberName, isSyntheticMemberName, UNNAMED_MEMBER_LABEL } from "../../lib/memberName";
import { applyRulesToProducts, bulkRuleSummary } from "../../lib/ruleBulk";
import { MAX_PROGRESS_DEPTH, buildTree, canAddChild, categoryPath, checkParentChange, flattenTree, indentLevel, skillGroups, subtreeHeight } from "../../lib/progressTree";

describe("[0] Google callback URL scheme", () => {
  const plist = read("ios/App/App/Info.plist");
  it("Info.plist CFBundleURLTypes에 Google callback scheme(com.googleusercontent.apps.*)이 있고 중복 항목이 없다 — 값은 출력하지 않는다", () => {
    const out = execFileSync("plutil", ["-convert", "json", "-o", "-", join(__dirname, "../../ios/App/App/Info.plist")], { encoding: "utf-8" });
    const types = JSON.parse(out).CFBundleURLTypes as { CFBundleURLSchemes: string[] }[];
    expect(Array.isArray(types)).toBe(true);
    const schemes = types.flatMap((t) => t.CFBundleURLSchemes);
    const google = schemes.filter((s) => s.startsWith("com.googleusercontent.apps."));
    expect(google.length).toBeGreaterThanOrEqual(1);
    expect(new Set(schemes).size).toBe(schemes.length);   // 중복 없음
    expect(plist.match(/<key>CFBundleURLTypes<\/key>/g)).toHaveLength(1);
    expect(plist).toContain("<key>UIApplicationSceneManifest</key>");   // 기존 항목 보존
  });
  it("GoogleSignInPlugin이 SDK 호출 전에 필요한 scheme 존재를 확인하고, 없으면 crash 대신 reject한다(값 미출력)", () => {
    const s = read("ios/App/App/GoogleSignInPlugin.swift");
    expect(s).toContain("static func hasRequiredCallbackScheme(forClientId clientId: String");
    expect(s).toContain('"com.googleusercontent.apps." + id');
    expect(s).toContain('call.reject("Google 로그인 설정(URL scheme)이 이 앱 빌드에 없어요", "missing_url_scheme")');
    expect(s.indexOf("hasRequiredCallbackScheme(forClientId: clientId)")).toBeLessThan(s.indexOf("GIDSignIn.sharedInstance.signIn("));
    expect(s).not.toMatch(/print\(|NSLog/);
    expect(s).toContain("GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientId)");   // 정상 플로우 유지
  });
});

describe("[1] white flash — 웹 첫 paint", () => {
  const layout = read("app/layout.tsx");
  it("테마 스크립트는 <head>에서 실행되어 data-theme/colorScheme을 첫 paint 전에 확정", () => {
    const head = layout.slice(layout.indexOf("<head>"), layout.indexOf("</head>"));
    expect(head).toContain("document.documentElement.style.colorScheme=dark?");
    expect(head).toContain('setAttribute("data-theme","charcoal")');
    expect(layout.indexOf("</head>")).toBeLessThan(layout.indexOf("<body>\n"));
    expect(layout.slice(layout.indexOf("<body>\n"))).not.toContain("localStorage.getItem(\"app_theme\")");
  });
  it("html/body background transition 제거(라이트→다크 페이드로 흰 프레임이 보이던 원인), 라이트 배경 토큰은 유지", () => {
    const css = read("app/globals.css");
    const rule = css.slice(css.indexOf("html, body {"), css.indexOf("}", css.indexOf("html, body {")));
    expect(rule).not.toMatch(/transition:\s*background/);
    expect(css).toContain("--bg: #FBFBFA;");
    expect(read("app/settings/theme/page.tsx")).toContain('style.colorScheme = effective === "charcoal"');
  });
  it("native 배경 설정(SceneDelegate)과 edge-swipe 정책은 변경하지 않았다", () => {
    const sd = read("ios/App/App/SceneDelegate.swift");
    expect(sd).toContain("webView.underPageBackgroundColor = dynamicBg");
    expect(sd).toContain("allowsBackForwardNavigationGestures = true");
  });
});

describe("[6] 회원 이름 표시", () => {
  it("합성 handle(소문자+숫자 8~24자)과 빈 값은 '이름 미등록', 실제 이름은 그대로", () => {
    for (const bad of ["92wr87mcz5", "user12345678", "", null, undefined, "회원", "(이름 없음)"]) {
      expect(isSyntheticMemberName(bad as any)).toBe(true);
      expect(displayMemberName(bad as any)).toBe(UNNAMED_MEMBER_LABEL);
    }
    for (const good of ["홍길동", "Kim Minsu", "John", "손지윤", "minsu", "abcdefgh"]) expect(displayMemberName(good)).toBe(good);
  });
  it("가입 마무리 모달이 이름을 받고(필수), accounts와 대표 프로필에 저장한다", () => {
    const w = read("app/components/SessionWatcher.tsx");
    expect(w).toContain('setGateError("이름을 입력해주세요")');
    expect(w).toContain("isSyntheticMemberName(account.name)");
    expect(w).toContain("completeSocialProfile(phoneGateAccountId, phone.trim(), address || null, agreeMarketing, realName.trim())");
    const a = read("lib/authAccount.ts");
    expect(a).toContain("...(realName ? { name: realName } : {})");
    expect(a).toContain('.update({ name: realName }).eq("account_id", accountId).eq("is_primary", true)');
  });
});

describe("[7][8] 회원 검색/등록/목록", () => {
  beforeEach(() => { calls.length = 0; tables = {}; });
  it("검색: 이름 + 전화번호(전체/하이픈/일부) — 숫자만으로 정규화해 ilike, 합성 이름은 표시 대체", async () => {
    tables.profiles = [{ id: "p1", name: "92wr87mcz5", is_primary: true, accounts: { phone: "01026668674" } }, { id: "p2", name: "홍길동", is_primary: true, accounts: { phone: "01011112222" } }];
    tables.accounts = [{ id: "a3", phone: "01026668674", profiles: [{ id: "p3", name: "김민수", is_primary: true }] }];
    const r = await searchAccountsForMember("010-2666-8674");
    const phoneCall = calls.find((c) => c.table === "accounts")!;
    expect(phoneCall.ilike).toEqual([["phone", "%01026668674%"]]);
    expect(r.map((x) => x.name)).toEqual([UNNAMED_MEMBER_LABEL, "홍길동", "김민수"]);
    calls.length = 0; await searchAccountsForMember("2666");   // 일부 번호
    expect(calls.find((c) => c.table === "accounts")!.ilike).toEqual([["phone", "%2666%"]]);
    calls.length = 0; await searchAccountsForMember("홍길");
    expect(calls.find((c) => c.table === "accounts")).toBeUndefined();   // 숫자가 없으면 전화 검색 안 함
    expect(await searchAccountsForMember("가")).toEqual([]);   // 2자 미만
  });
  it("회원 목록: 수강권이 없어도 등록된 center_members는 보이고(등록 직후 노출), 활성/만료 필터는 수강권 이력이 있는 회원만", async () => {
    tables.center_members = [
      { id: "m1", profile_id: "p1", status: "active", registered_at: "2026-10-03", profiles: { name: "새회원" }, member_grades: null },
      { id: "m2", profile_id: "p2", status: "active", registered_at: "2026-10-02", profiles: { name: "기존회원" }, member_grades: null },
    ];
    tables.profiles = [];
    tables.memberships = [{ profile_id: "p2", product_name: "10회권", remaining_count: 3, expires_at: "2099-01-01", pass_type: "count", status: "active" }];
    const all = await fetchMembers("c1");
    expect(all.map((m) => [m.name, m.hasPass])).toEqual([["새회원", false], ["기존회원", true]]);
    expect((await fetchMembers("c1", { status: "active" })).map((m) => m.name)).toEqual(["기존회원"]);
    expect((await fetchMembers("c1", { status: "expired" })).map((m) => m.name)).toEqual([]);
    expect((await fetchMembers("c1", { keyword: "새회" })).map((m) => m.name)).toEqual(["새회원"]);
  });
  it("등록 직후 성공 toast + 목록 재조회(load) 경로 유지, 이미 등록된 회원은 오류(멱등)", () => {
    const page = read("app/manager/members/page.tsx");
    expect(page).toContain('showToast("회원을 등록했어요");');
    expect(page).toContain("await load();");
    expect(page).toContain("수강권 없음</span>");
    expect(read("lib/members.ts")).toContain('throw new Error("이미 등록된 회원이에요")');
  });
  it("검색은 클라이언트 RLS 질의 — 버전 의존 분기(App Store/TestFlight)가 코드에 없다(서버 URL 로드, 동일 웹 코드)", () => {
    const cfg = read("capacitor.config.ts");
    expect(cfg).toContain('url: "https://mwhabit.com"');
    expect(read("lib/members.ts")).not.toMatch(/getPlatform|userAgent|appVersion/);
  });
});

describe("[2] 수강권 예약조건 일괄 적용", () => {
  const T = (id: string, extra: Partial<{ autoBookDays: number[] | null; existingRules: any[] }> = {}) => ({ id, name: `수강권${id}`, autoBookDays: null, existingRules: [], ...extra });
  it("1개 / 여러 개 적용(요일 여러 개 = 요일별 규칙)", async () => {
    const add = vi.fn(async () => {});
    let r = await applyRulesToProducts([T("a")], { days: [1], startTime: "19:00", classTitle: "" }, add);
    expect(r.succeeded).toEqual([{ id: "a", name: "수강권a", added: 1 }]);
    add.mockClear();
    r = await applyRulesToProducts([T("a"), T("b"), T("c")], { days: [1, 3], startTime: null, classTitle: "안무반" }, add);
    expect(add).toHaveBeenCalledTimes(6);
    expect(add).toHaveBeenCalledWith("b", 3, null, "안무반");
    expect(r.succeeded).toHaveLength(3);
  });
  it("일부 실패는 성공처럼 숨기지 않는다(실패 상품 보고), 나머지는 계속 진행", async () => {
    const add = vi.fn(async (id: string) => { if (id === "b") throw new Error("권한 없음"); });
    const r = await applyRulesToProducts([T("a"), T("b"), T("c")], { days: [null], startTime: null, classTitle: null }, add);
    expect(r.succeeded.map((x) => x.id)).toEqual(["a", "c"]);
    expect(r.failed).toEqual([{ id: "b", name: "수강권b", error: "권한 없음" }]);
    const s = bulkRuleSummary(r);
    expect(s.hasFailure).toBe(true);
    expect(s.message).toContain("1개는 실패했어요");
  });
  it("이미 같은 조건이 있으면 건너뛰고, 요일 고정 수강권은 고정 요일 밖 조건을 추가하지 않는다", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([
      T("a", { existingRules: [{ dayOfWeek: 1, startTime: "19:00", classTitle: null }] }),
      T("b", { autoBookDays: [2] }),
    ], { days: [1], startTime: "19:00", classTitle: null }, add);
    expect(r.skipped).toEqual([{ id: "a", name: "수강권a", reason: "already_exists" }, { id: "b", name: "수강권b", reason: "locked_days" }]);
    expect(add).not.toHaveBeenCalled();
  });
  it("화면: 선택 모드에서만 '예약조건 일괄 설정', 기존 조건 시트 재사용, 성공 시 선택 초기화, 일부 실패 시 시트 유지, 개별 추가 경로 유지", () => {
    const p = read("app/manager/membership-rules/page.tsx");
    expect(p).toContain('extraAction={{ label: "예약조건 일괄 설정", onClick: openBulkRuleSheet }}');
    expect(p).toContain("선택한 <b>{bulkTargets.length}개</b> 수강권 모두에 아래 조건이 <b>추가</b>돼요");
    expect(p).toContain("setBulkTargets(null);\n        exitSelect();");
    expect(p).toContain("setBulkTargets(bulkTargets.filter((p) => failedIds.has(p.id)));");
    expect(p).toContain("if (bulkTargets) { await handleBulkAddRules(); return; }");
    expect(p).toContain("await addRule(ruleFor.id, d, rTime || null, rTitle.trim() || null);");
    expect(read("app/components/BulkSelectBar.tsx")).toContain("disabled={busy || selectedCount === 0} onClick={extraAction.onClick}");
  });
});

describe("[3][4][5] 진도 분류 tree", () => {
  const f = (id: string, parentId: string | null, name = id, sortOrder = 0) => ({ id, parentId, name, sortOrder });
  it("기존 1단계 category + skills(2단계)가 그대로 표시된다", () => {
    const t = buildTree([f("top", null, "점프"), f("s1", "top", "왈츠", 0), f("s2", "top", "살코", 1)]);
    expect(t).toHaveLength(1);
    expect(t[0].depth).toBe(1);
    expect(t[0].children.map((c) => [c.name, c.depth])).toEqual([["왈츠", 2], ["살코", 2]]);
    const g = skillGroups(t);
    expect(g.groups).toEqual([{ path: ["점프"], skills: expect.any(Array) }]);
    expect(g.groups[0].skills.map((s) => s.name)).toEqual(["왈츠", "살코"]);
  });
  it("nested category: 점프 › 싱글 점프 › 엣지 점프 › 왈츠/살코, 경로/그룹/높이", () => {
    const flat = [f("1", null, "점프"), f("2", "1", "싱글 점프"), f("3", "2", "엣지 점프"), f("4", "3", "왈츠"), f("5", "3", "살코")];
    const t = buildTree(flat);
    expect(flattenTree(t).map((n) => n.depth)).toEqual([1, 2, 3, 4, 4]);
    expect(subtreeHeight(t[0])).toBe(4);
    expect(categoryPath("4", flat)).toEqual(["점프", "싱글 점프", "엣지 점프", "왈츠"]);
    expect(skillGroups(t).groups.map((x) => x.path.join(" › "))).toEqual(["점프 › 싱글 점프 › 엣지 점프"]);
  });
  it("depth 7 허용 / depth 8 거부, 7단계 노드는 하위 추가 불가", () => {
    const chain = Array.from({ length: 7 }, (_, i) => f(String(i + 1), i === 0 ? null : String(i), `n${i + 1}`));
    expect(checkParentChange(null, "6", chain)).toEqual({ ok: true });      // 새 항목이 depth 7
    expect(checkParentChange(null, "7", chain)).toEqual({ ok: false, reason: "depth" });   // depth 8
    const t = buildTree(chain);
    const deepest = flattenTree(t).at(-1)!;
    expect(deepest.depth).toBe(MAX_PROGRESS_DEPTH);
    expect(canAddChild(deepest)).toBe(false);
    expect(canAddChild(flattenTree(t)[5])).toBe(true);
  });
  it("cycle / self / cross-center 거부, 이동 시 하위 높이 포함", () => {
    const flat = [f("1", null), f("2", "1"), f("3", "2")];
    expect(checkParentChange("1", "1", flat)).toEqual({ ok: false, reason: "self" });
    expect(checkParentChange("1", "3", flat)).toEqual({ ok: false, reason: "cycle" });
    expect(checkParentChange("2", "9" as any, flat)).toEqual({ ok: true });   // 모르는 부모는 서버 FK/트리거가 최종 판단
    expect(checkParentChange(null, "1", flat, { sameCenter: false })).toEqual({ ok: false, reason: "other_center" });
    expect(checkParentChange("2", null, flat)).toEqual({ ok: true });
    const deep = Array.from({ length: 5 }, (_, i) => f(`d${i}`, i === 0 ? null : `d${i - 1}`));
    expect(checkParentChange("x", "d2", deep, { newSubtreeHeight: 5 })).toEqual({ ok: false, reason: "depth" });
  });
  it("고아/순환 데이터도 화면에서 사라지지 않고 최상위로 올라온다, 들여쓰기는 4단계 상한", () => {
    const t = buildTree([f("a", "zzz", "고아"), f("b", "c", "순환1"), f("c", "b", "순환2")]);
    expect(t.map((n) => n.name).sort()).toEqual(["고아", "순환1", "순환2"].sort());
    expect([1, 2, 5, 6, 7].map(indentLevel)).toEqual([0, 1, 4, 4, 4]);
  });
  it("accordion: 접기/펼치기 버튼(aria-expanded/controls), 입력값은 접어도 유지, 7단계에서 추가 입력 대신 안내", () => {
    const p = read("app/manager/progress/page.tsx");
    expect(p).toContain("aria-expanded={open}");
    expect(p).toContain("aria-controls={panelId}");
    expect(p).toContain("const panel = open && (");
    expect(p).toContain("subInput[node.id]");   // 입력 상태는 페이지 state(접어도 유지)
    expect(p).toContain("입력 중");
    expect(p).toContain("canAddChild(node) ?");
    expect(p).toContain("최대 {MAX_PROGRESS_DEPTH}단계라 더 추가할 수 없어요");
    expect(p).toContain("await addSubCategory(centerId, parent.id, name, parent.children.length);");
  });
  it("정렬 CSS: 제목/행/입력창 좌우 기준 14px 통일, 입력창+추가 버튼 같은 높이(48px), 버튼 규격 통일, 들여쓰기 누적 없음", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\.ptree-row \{[^}]*padding:6px 14px/);
    expect(css).toMatch(/\.ptree-add \{[^}]*padding:10px 14px 12px/);
    expect(css).toMatch(/\.ptree-add \.input-field, \.ptree-add \.outline-action \{[^}]*height:48px/);
    expect(css).toMatch(/\.ptree-actions \.quiet-action \{[^}]*min-height:32px/);
    expect(css).not.toMatch(/\.ptree-panel \{[^}]*margin-left/);
  });
  it("SQL: 순환/깊이/센터 일치 서버 방어선(트리거) + rollback, 삭제는 하위→상위 순서", () => {
    const sql = read("fix_progress_category_tree_20261003.sql").replace(/--.*$/gm, "");
    for (const x of ["자기 자신을 상위 분류로 지정할 수 없어요", "다른 센터의 분류를 상위 분류로 지정할 수 없어요", "하위 분류를 상위 분류로 지정할 수 없어요(순환)", "분류는 최대 7단계까지 만들 수 있어요", "분류의 센터는 바꿀 수 없어요"]) expect(sql).toContain(x);
    expect(sql).toContain("before insert or update of parent_id, center_id on public.progress_categories");
    expect(sql).toContain("if v_parent_depth + 1 + v_below > 7 then");
    expect(read("lib/progress.ts")).toContain("[...ids].reverse()");
    expect(read("rollback_fix_progress_category_tree_20261003.sql")).toContain("drop trigger if exists progress_categories_guard_tree");
  });
});
