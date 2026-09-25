/* 실기기 QA(2026-09-25) — 예약 화면 센터 선택 시트: 선택 상태 계산 + 공용 시트 패턴 재사용 확인. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCenterOptions } from "../../app/components/CenterSelectSheet";

const centers = [{ id: "a", name: "어텐션 피겨팀" }, { id: "b", name: "노는반" }];

describe("buildCenterOptions", () => {
  it("선택 없음 → '전체 센터'만 selected", () => {
    const o = buildCenterOptions(centers, null);
    expect(o.map((x) => x.label)).toEqual(["전체 센터", "어텐션 피겨팀", "노는반"]);
    expect(o.filter((x) => x.selected).map((x) => x.label)).toEqual(["전체 센터"]);
    expect(o[0].id).toBeNull();
  });
  it("특정 센터 선택 → 그 센터만 selected", () => {
    const o = buildCenterOptions(centers, "b");
    expect(o.filter((x) => x.selected).map((x) => x.id)).toEqual(["b"]);
  });
  it("undefined도 '전체'로 취급", () => {
    expect(buildCenterOptions(centers, undefined)[0].selected).toBe(true);
  });
});

describe("센터 선택 시트 UI 계약", () => {
  const css = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
  const tsx = readFileSync(join(__dirname, "../../app/components/CenterSelectSheet.tsx"), "utf-8");
  it("기존 .sheet/.sheet-title/.sheet-close-btn 패턴을 재사용하고 큰 알약(.filter-chip)/별도 닫기 블록(.ghost-btn)을 쓰지 않는다", () => {
    expect(tsx).toContain('className="sheet center-select-sheet"');
    expect(tsx).toContain("sheet-close-btn");
    expect(tsx).not.toMatch(/className=[^\n]*filter-chip/);
    expect(tsx).not.toMatch(/className=[^\n]*ghost-btn/);
  });
  it("선택 행은 전체 채움 없이 체크 + accent 글자, 하단 safe-area 반영", () => {
    expect(css).toMatch(/\.sheet-option\.on \{ color: var\(--accent\)/);
    expect(css).not.toMatch(/\.sheet-option\.on \{[^}]*background/);
    expect(css).toMatch(/\.center-select-sheet \{ padding-bottom: max\(24px, var\(--safe-bottom/);
  });
});
