import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// 모든 .back-header 는 (a) BackButton / app-back-btn / ‹ 텍스트의 .side 링크 — 공용 back 정책(findBackControl)이 누를 수 있는 컨트롤을 갖거나,
// (b) 아래 알려진 예외(뒤로가기를 ManagerChrome 공통 상단바가 그리거나 root 탭이라 back 이 없는 화면)여야 한다. 새 화면이 (a)(b) 둘 다 아니면 실패한다.
const SPACER_ONLY = new Set([
  "app/manager/alimtalk/rules/page.tsx", "app/manager/alimtalk/templates/page.tsx", "app/manager/classes/page.tsx",
  "app/manager/members/page.tsx", "app/reset-password/confirm/page.tsx", "app/my-reservations/page.tsx",
]);
const files = execFileSync("grep", ["-rl", "back-header", "app", "--include=*.tsx"], { encoding: "utf8" }).split("\n").filter(Boolean);

describe("back-header 와 공용 back 정책(findBackControl) 호환", () => {
  it("대상 화면을 찾았다", () => expect(files.length).toBeGreaterThan(50));
  it("컨트롤 없는 화면은 알려진 예외뿐", () => {
    const unexpected: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      const headers = [...s.matchAll(/<div className="back-header[^"]*">([\s\S]*?)<div className="title/g)].map((m) => m[1]);
      const hasControl = headers.length === 0 || headers.every((h) => h.includes("<BackButton") || h.includes("app-back-btn") || (h.includes('className="side"') && h.includes("‹")));
      if (!hasControl && !SPACER_ONLY.has(f)) unexpected.push(f);
    }
    expect(unexpected).toEqual([]);
  });
  it("정책이 찾는 셀렉터와 BackButton 마크업이 일치", () => {
    const bb = readFileSync("app/components/BackButton.tsx", "utf8"), bp = readFileSync("lib/backPolicy.ts", "utf8");
    expect(bp).toContain(".back-header a.side, .back-header button.side, .app-back-btn");
    expect(bb).toMatch(/app-back-btn|back-header|side/);
    expect(bb).toContain("‹");
  });
});
