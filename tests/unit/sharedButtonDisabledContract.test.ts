import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 공용 버튼 disabled 스타일 계약. .ghost-btn은 100곳 이상에서 쓰이는 공용 버튼이라 :disabled 스타일이 없으면 비활성인데도 눌릴 것처럼 보인다.
// (과거 TODO "ghost-btn:disabled 없음"은 app/globals.css의 공용 control-finish 규칙으로 이미 해결돼 있어, 회귀 방지 계약만 둔다.)
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
const ws = readFileSync(path.resolve(__dirname, "../../app/workspace.css"), "utf8");

describe("공용 버튼 disabled 계약", () => {
  it(".ghost-btn:disabled는 다른 보조 버튼(filter-chip/text-btn)과 같은 opacity .5 + cursor default 패턴", () => {
    expect(css).toMatch(/\.ghost-btn:disabled,\s*\n\.filter-chip:disabled,\s*\n\.text-btn:disabled \{ opacity: \.5; cursor: default; \}/);
  });
  it(".primary-btn:disabled는 색 + not-allowed, workspace 공통 규칙도 ghost-btn:disabled에 not-allowed 커서 부여", () => {
    expect(css).toMatch(/\.primary-btn:disabled \{[^}]*cursor: not-allowed/);
    expect(ws).toMatch(/:is\(\.primary-btn,\.app-button,\.ghost-btn,\.outline-action,\.filter-chip\):disabled \{ cursor: not-allowed; \}/);
  });
  it("활성 .ghost-btn 기본 스타일은 disabled 규칙과 분리돼 있다(disabled 선택자로만 opacity를 건다)", () => {
    const base = css.slice(css.indexOf(".ghost-btn {"), css.indexOf("}", css.indexOf(".ghost-btn {")));
    expect(base).not.toMatch(/opacity/);
  });
});
