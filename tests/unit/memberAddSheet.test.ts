// @vitest-environment jsdom
/* 관리자 > 회원 > +회원 검색 UI(2026-10-04): 서버 RPC가 준 결과가 화면에서 사라지지 않게 하는 클라이언트 방어 — jsdom + react-dom 실제 렌더(실제 OAuth/RPC 호출 없음). */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const search = vi.fn();
vi.mock("../../lib/members", () => ({ searchAccountsForMember: (...a: unknown[]) => search(...a) }));
import MemberAddSheet from "../../app/components/MemberAddSheet";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  search.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ width: 20, height: 20 }] as unknown as DOMRectList);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); vi.restoreAllMocks(); });

const JIYUN = { profileId: "p-1", name: "손지윤", phone: "01023265051", alreadyMember: true };
const OUTSIDER = { profileId: "p-2", name: "홍길동", phone: "010-****-5678", alreadyMember: false };
type Props = Partial<{ centerId: string; centerName: string; busy: boolean; onClose: () => void; onAdd: (id: string) => void }>;
const render = (p: Props = {}) => act(() => root.render(createElement(MemberAddSheet, { centerId: "c1", centerName: "A10TION 피겨팀", onClose: () => {}, onAdd: () => {}, ...p })));
const input = () => host.querySelector("input") as HTMLInputElement;
const setValue = (v: string) => act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(input(), v); input().dispatchEvent(new Event("input", { bubbles: true })); });
const clickSearch = () => act(() => { [...host.querySelectorAll("button")].find((b) => b.textContent === "검색")!.click(); });
const enter = () => act(() => { input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
const text = () => host.textContent ?? "";
const deferred = <T,>() => { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("결과 표시", () => {
  it("1/2. RPC가 이미 등록된 회원을 반환하면 이름·전화번호와 '이미 이 센터에 등록된 회원이에요'가 반드시 표시된다(결과가 숨겨지지 않음, 등록 버튼 없음)", async () => {
    search.mockResolvedValue([JIYUN]);
    render(); setValue("01023265051"); clickSearch(); await flush();
    expect(search).toHaveBeenCalledWith("c1", "01023265051");
    expect(text()).toContain("손지윤 · 01023265051");
    expect(text()).toContain("이미 이 센터에 등록된 회원이에요");
    expect(text()).toContain("검색 결과 1명");
    expect(text()).not.toContain("검색 결과가 없어요");
    expect([...host.querySelectorAll("button")].some((b) => b.textContent === "등록")).toBe(false);
  });
  it("3. 센터 밖 회원(already_member=false)은 마스킹된 번호와 등록 버튼 — 누르면 onAdd(profileId)", async () => {
    const onAdd = vi.fn(); search.mockResolvedValue([OUTSIDER]);
    render({ onAdd }); setValue("010-1234-5678"); enter(); await flush();
    expect(text()).toContain("홍길동 · 010-****-5678");
    const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "등록")!;
    act(() => btn.click());
    expect(onAdd).toHaveBeenCalledWith("p-2");
  });
  it("8. 진짜 0건/검색 전/오류 메시지가 서로 구분되고, 결과가 있으면 0건 문구가 보이지 않는다", async () => {
    render();
    expect(text()).toContain("전체 휴대폰 번호로 검색해보세요");
    search.mockResolvedValueOnce([]); setValue("01099999999"); clickSearch(); await flush();
    expect(text()).toContain("검색 결과가 없어요");
    search.mockRejectedValueOnce(new Error("회원 등록 권한이 없어요")); clickSearch(); await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("회원 등록 권한이 없어요");
    expect(text()).not.toContain("검색 결과가 없어요");                  // 오류는 0건과 다르게 표시
    search.mockResolvedValueOnce([JIYUN]); setValue("01023265051"); clickSearch(); await flush();
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(text()).toContain("손지윤");
  });
  it("대상 센터 이름을 시트에 표시(다중 센터 관리자가 어느 센터에서 검색하는지 알 수 있다)", () => {
    render({ centerName: "A10TION 피겨팀" });
    expect(text()).toContain("A10TION 피겨팀");
  });
});

describe("stale response / race", () => {
  it("4. 느린 이전 검색 A 뒤에 빠른 최신 검색 B가 끝나면, A 응답이 늦게 도착해도 B 결과를 덮지 않는다", async () => {
    const a = deferred<any[]>(), b = deferred<any[]>();
    search.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(); setValue("01011111111"); clickSearch();
    setValue("01023265051"); clickSearch();
    expect(search).toHaveBeenCalledTimes(2);
    b.resolve([JIYUN]); await flush();
    expect(text()).toContain("손지윤");
    a.resolve([OUTSIDER]); await flush();
    expect(text()).toContain("손지윤"); expect(text()).not.toContain("홍길동");   // 늦은 A는 무시
    expect(text()).not.toContain("검색 중...");
  });
  it("5. stale 요청의 오류도 최신 성공 결과를 지우지 않는다", async () => {
    const a = deferred<any[]>(), b = deferred<any[]>();
    search.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    render(); setValue("01011111111"); clickSearch(); setValue("01023265051"); clickSearch();
    b.resolve([JIYUN]); await flush();
    a.reject(new Error("timeout")); await flush();
    expect(text()).toContain("손지윤"); expect(host.querySelector('[role="alert"]')).toBeNull();
  });
  it("6. Enter 연타/같은 검색의 in-flight 중복은 요청을 만들지 않고, 다른 검색어는 이전 요청을 대체한다", async () => {
    const a = deferred<any[]>(); search.mockReturnValueOnce(a.promise);
    render(); setValue("01023265051");
    enter(); enter(); clickSearch(); enter();
    expect(search).toHaveBeenCalledTimes(1);                                   // 같은 요청은 한 번만
    a.resolve([JIYUN]); await flush();
    expect(text()).toContain("손지윤");
    search.mockResolvedValueOnce([OUTSIDER]); clickSearch(); await flush();      // 끝난 뒤 같은 검색어로 다시 검색은 가능
    expect(search).toHaveBeenCalledTimes(2);
    expect(text()).toContain("홍길동");
  });
  it("검색 시작 시점의 센터/검색어를 snapshot해서 요청한다(공백 trim, 입력이 나중에 바뀌어도 요청값 불변)", async () => {
    const a = deferred<any[]>(); search.mockReturnValueOnce(a.promise);
    render(); setValue("  010-2326-5051  "); clickSearch();
    setValue("다른 입력");                                                         // 요청 후 입력 변경
    expect(search).toHaveBeenCalledWith("c1", "010-2326-5051");
    a.resolve([JIYUN]); await flush();
    expect(text()).toContain("손지윤");
  });
  it("7. 센터가 바뀌면 이전 센터 검색 결과/오류/진행 중 응답이 새 센터 시트에 나타나지 않는다", async () => {
    const a = deferred<any[]>(); search.mockReturnValueOnce(a.promise);
    render({ centerId: "c1" }); setValue("01023265051"); clickSearch();
    render({ centerId: "c2", centerName: "다른 센터" });                          // 센터 전환(진행 중 요청 존재)
    a.resolve([JIYUN]); await flush();
    expect(text()).not.toContain("손지윤");
    expect(text()).toContain("전체 휴대폰 번호로 검색해보세요");
    expect(text()).not.toContain("검색 중...");
    // 이미 표시된 이전 센터 결과도 센터 전환 시 초기화
    search.mockResolvedValueOnce([OUTSIDER]); setValue("01012345678"); clickSearch(); await flush();
    expect(text()).toContain("홍길동");
    render({ centerId: "c1" });
    expect(text()).not.toContain("홍길동");
  });
  it("검색 시작 시 입력칸을 blur해 모바일 키보드가 결과를 가리지 않게 한다", async () => {
    search.mockResolvedValue([JIYUN]);
    render(); input().focus(); expect(document.activeElement).toBe(input());
    setValue("01023265051"); clickSearch(); await flush();
    expect(document.activeElement).not.toBe(input());
  });
});

describe("정적 계약", () => {
  const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
  it("로그에 검색어/이름/전화번호를 남기지 않고(console 호출 없음), 페이지는 시트를 key={centerId}로 마운트한다", () => {
    const s = read("app/components/MemberAddSheet.tsx");
    expect(s).not.toMatch(/console\.(log|error|warn|debug)/);
    const page = read("app/manager/members/page.tsx");
    expect(page).toContain("<MemberAddSheet key={centerId} centerId={centerId} centerName={activeCenter?.name ?? null}");
    expect(page).not.toContain("searchAccountsForMember");
  });
});
