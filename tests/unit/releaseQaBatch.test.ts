/*
  출시 전 실기기 QA 후속 배치(2026-10-03): Google URL scheme / white flash / 회원 이름·등록 노출·검색 / 예약조건 일괄 / 진도 7단계 tree.
  실제 Client ID/URL scheme 값은 어디에도 출력하지 않는다(존재 여부와 형식만 검증).
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");

// ---- 가짜 supabase (members.ts 검색/목록)
const calls: { table: string; ilike: [string, string][]; select: string }[] = [];
let tables: Record<string, any[]> = {};
const rpcCalls: [string, any][] = [];
let rpcData: any[] = [];
let rpcError: { code?: string; message: string } | null = null;
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      const rec = { table, ilike: [] as [string, string][], select: "" };
      const chain: any = {
        select(s: string) { rec.select = s; return chain; },
        eq() { return chain; }, in() { return chain; }, order() { return chain; }, limit() { return chain; }, range() { return chain; }, is() { return chain; },
        ilike(c: string, v: string) { rec.ilike.push([c, v]); return chain; },
        then(res: any) { calls.push(rec); return Promise.resolve({ data: tables[table] ?? [], error: null }).then(res); },
      };
      return chain;
    },
    rpc: async (name: string, args: any) => { rpcCalls.push([name, args]); return { data: rpcData, error: rpcError }; },
  },
}));
import { fetchMembers, searchAccountsForMember } from "../../lib/members";
import { displayMemberName, isSyntheticMemberName, UNNAMED_MEMBER_LABEL } from "../../lib/memberName";
import { applyRulesToProducts, bulkRuleSummary } from "../../lib/ruleBulk";

describe("[0] Google callback URL scheme", () => {
  const plist = read("ios/App/App/Info.plist");
  it("Info.plist CFBundleURLTypes에 Google callback scheme(com.googleusercontent.apps.*)이 있고 중복 항목이 없다 — 값은 출력하지 않는다", () => {
    // CI(Ubuntu)에서도 돌도록 plutil(macOS 전용) 없이 Info.plist XML 문자열만 파싱한다. 실제 scheme 값은 assertion 메시지/로그에 넣지 않는다(boolean만 검사).
    const arrayAfterKey = (xml: string, key: string): string[] => {   // `<key>K</key>` 뒤 첫 <array>…</array> 안쪽 문자열(중첩 depth 계산), 키마다 하나씩
      const out: string[] = [];
      const re = new RegExp(`<key>${key}</key>\\s*<array>`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml))) {
        let depth = 1; let i = m.index + m[0].length; const start = i;
        const tok = /<array>|<\/array>/g; tok.lastIndex = i;
        let t: RegExpExecArray | null;
        while ((t = tok.exec(xml))) { depth += t[0] === "<array>" ? 1 : -1; if (depth === 0) { out.push(xml.slice(start, t.index)); break; } i = tok.lastIndex; }
      }
      return out;
    };
    const urlTypesBlocks = arrayAfterKey(plist, "CFBundleURLTypes");
    expect(urlTypesBlocks).toHaveLength(1);                                                    // 1. CFBundleURLTypes 존재(4. key 중복 없음과도 연결)
    const schemes = arrayAfterKey(urlTypesBlocks[0], "CFBundleURLSchemes")
      .flatMap((arr) => [...arr.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].trim()));
    const google = schemes.filter((v) => v.startsWith("com.googleusercontent.apps."));
    expect(google.length >= 1).toBe(true);                                                     // 2. Google callback scheme 1개 이상
    expect(google.every((v) => v.length > "com.googleusercontent.apps.".length)).toBe(true);   //    접두사만 있는 빈 값 아님
    expect(new Set(schemes).size === schemes.length).toBe(true);                               // 3. scheme 중복 없음
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
    expect(w).toContain("isAutoGeneratedName(account.name, account.emailLocalPart)");
    expect(w).toContain("completeSocialProfile(phoneGateAccountId, phone.trim(), address || null, agreeMarketing, realName.trim())");
    const a = read("lib/authAccount.ts");
    expect(a).toContain("if (realName) await saveCanonicalName(accountId, realName);");
    expect(a).toContain('.update({ name: realName }).eq("account_id", accountId).eq("is_primary", true)');
  });
});

describe("[7][8] 회원 검색/등록/목록", () => {
  beforeEach(() => { calls.length = 0; tables = {}; rpcCalls.length = 0; rpcData = []; rpcError = null; });
  it("검색(2026-10-03 Batch A): profiles/accounts 직접 조회 없이 서버 RPC search_member_candidates만 호출, 2글자 미만은 호출 안 함, 합성 이름은 표시 대체", async () => {
    rpcData = [{ profile_id: "p1", name: "92wr87mcz5", phone: "010-****-8674", already_member: false }, { profile_id: "p2", name: "홍길동", phone: "01011112222", already_member: true }];
    const r = await searchAccountsForMember("c1", "010-2666-8674");
    expect(calls.length).toBe(0);   // 어떤 테이블도 직접 조회하지 않는다
    expect(rpcCalls).toEqual([["search_member_candidates", { p_center_id: "c1", p_keyword: "010-2666-8674" }]]);
    expect(r).toEqual([{ profileId: "p1", name: UNNAMED_MEMBER_LABEL, phone: "010-****-8674", alreadyMember: false }, { profileId: "p2", name: "홍길동", phone: "01011112222", alreadyMember: true }]);
    rpcCalls.length = 0;
    expect(await searchAccountsForMember("c1", "가")).toEqual([]);
    expect(rpcCalls.length).toBe(0);
    rpcError = { code: "PGRST202", message: "not found" };
    await expect(searchAccountsForMember("c1", "홍길동")).rejects.toThrow("사용할 수 없어요");
    rpcError = { code: "P0001", message: "회원 등록 권한이 없어요" };
    await expect(searchAccountsForMember("c1", "홍길동")).rejects.toThrow("회원 등록 권한이 없어요");
    rpcError = null;
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
  it("이미 같은 조건이 있으면 중복 없이 정상(already_exists), 요일 고정 수강권이 요청 요일을 다 받을 수 있으면 정상", async () => {
    const add = vi.fn(async () => {});
    const r = await applyRulesToProducts([
      T("a", { existingRules: [{ dayOfWeek: 1, startTime: "19:00", classTitle: null }] }),
      T("b", { autoBookDays: [1, 2] }),
    ], { days: [1], startTime: "19:00", classTitle: null }, add);
    expect(r.skipped).toEqual([{ id: "a", name: "수강권a", reason: "already_exists" }]);
    expect(r.succeeded).toEqual([{ id: "b", name: "수강권b", added: 1 }]);
    expect(add).toHaveBeenCalledTimes(1);
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

describe("[Batch A] 회원 추가 검색 UI/서버 계약", () => {
  it("lib: direct profiles/accounts ilike 검색 제거, centerId와 함께 RPC만", () => {
    const m = read("lib/members.ts");
    const fn = m.slice(m.indexOf("export async function searchAccountsForMember"), m.indexOf("export async function", m.indexOf("export async function searchAccountsForMember") + 10));
    expect(fn).toContain('supabase.rpc("search_member_candidates", { p_center_id: centerId, p_keyword: kw })');
    expect(fn).not.toMatch(/\.from\(|ilike/);
    const sheet = read("app/components/MemberAddSheet.tsx");   // 2026-10-04: +회원 시트를 별도 컴포넌트로 분리
    expect(sheet).toContain("searchAccountsForMember(cid, query)");
    expect(sheet).toContain("전체 휴대폰 번호");
    expect(sheet).toContain("r.alreadyMember");
    expect(read("app/manager/members/page.tsx")).toContain("<MemberAddSheet key={centerId}");
  });
});
