/*
  횟수 선택형 가격표 편집기 개선(2026-10-02): 최대 횟수 동적 행, 12회 초과 기존 데이터 보존, 입력칸/버튼 레이아웃.
  DB/서버는 변경 없음(product_count_prices는 이미 임의 count 지원) — 클라이언트 순수 로직 + 정적 계약 검사.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TIER_COUNT, TIER_ROWS, draftsFromTiers, fillDraftsFromUnit, highestActiveCount, maxTierCount, resizeTierDrafts,
} from "../../lib/goodsForm";
import { draftsToTiers, validateTierDrafts, type TierDraft } from "../../lib/selectableCount";

const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf-8");
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const active = (rows: TierDraft[]) => rows.filter((r) => r.enabled && r.price !== "").map((r) => r.count);

describe("최대 횟수 → 행 생성", () => {
  it("새 상품의 기본 최대 횟수 행(기본 12)이 생성된다(체크 해제·빈 가격)", () => {
    const rows = draftsFromTiers([]);
    expect(rows).toHaveLength(TIER_ROWS);
    expect(rows.every((r) => !r.enabled && r.price === "")).toBe(true);
  });
  it("최대 횟수 8 → 1~8, 20 → 1~20", () => {
    const base = draftsFromTiers([]);
    const r8 = resizeTierDrafts(base, 8);
    expect(r8.rows.map((r) => r.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const r20 = resizeTierDrafts(r8.rows, 20);
    expect(r20.rows).toHaveLength(20);
    expect(r20.rows[19].count).toBe(20);
    expect(maxTierCount(r20.rows)).toBe(20);
  });
  it("확장 시 기존 입력값(체크/가격)이 유지되고 새 행은 비어 있다", () => {
    const filled = fillDraftsFromUnit(6000, draftsFromTiers([]));
    filled[5] = { ...filled[5], price: "34000" };
    const grown = resizeTierDrafts(filled, 15);
    expect(grown.rows).toHaveLength(15);
    expect(grown.rows[5].price).toBe("34000");
    expect(grown.rows[0].price).toBe("6000");
    expect(grown.rows[13]).toEqual({ count: 14, price: "", enabled: false });
    expect(grown.blockedBy).toBeNull();
  });
  it("상한(100) 초과/0/NaN 입력은 안전하게 보정", () => {
    expect(resizeTierDrafts(draftsFromTiers([]), 500).rows).toHaveLength(MAX_TIER_COUNT);
    expect(resizeTierDrafts(draftsFromTiers([]), 0).rows).toHaveLength(1);
    expect(resizeTierDrafts(draftsFromTiers([]), Number.NaN).rows).toHaveLength(1);
  });
});

describe("기존 12회 초과 데이터 호환", () => {
  const saved = [{ count: 1, price: 6000 }, { count: 6, price: 34000 }, { count: 15, price: 80000 }];
  it("저장된 15회 가격표는 편집 시 15회까지 행이 유지된다(12로 잘리지 않음)", () => {
    const rows = draftsFromTiers(saved);
    expect(rows).toHaveLength(15);
    expect(active(rows)).toEqual([1, 6, 15]);
    expect(highestActiveCount(rows)).toBe(15);
  });
  it("저장 시 값이 그대로 나간다(재저장해도 15회 가격 보존)", () => {
    expect(draftsToTiers(draftsFromTiers(saved))).toEqual(saved);
  });
  it("최대 횟수를 줄여도 판매 중인 큰 회차 가격은 조용히 유실되지 않는다(경고용 blockedBy + 행 유지)", () => {
    const rows = draftsFromTiers(saved);
    const res = resizeTierDrafts(rows, 8);
    expect(res.blockedBy).toBe(15);
    expect(res.effectiveMax).toBe(15);
    expect(active(res.rows)).toEqual([1, 6, 15]);
  });
  it("관리자가 큰 회차의 체크를 해제(또는 가격 삭제)하면 그때 줄어든다 — 데이터 없는 큰 행만 제거", () => {
    const rows = draftsFromTiers(saved).map((r) => (r.count === 15 ? { ...r, enabled: false } : r));
    const res = resizeTierDrafts(rows, 8);
    expect(res.blockedBy).toBeNull();
    expect(res.rows).toHaveLength(8);
    expect(active(res.rows)).toEqual([1, 6]);
    const cleared = draftsFromTiers(saved).map((r) => (r.count === 15 ? { ...r, price: "" } : r));
    expect(resizeTierDrafts(cleared, 8).rows).toHaveLength(8);
  });
  it("줄이기 중간 값(8→10→8)에서도 중간 행의 가격이 사라지지 않는다", () => {
    const rows = draftsFromTiers([{ count: 10, price: 50000 }]);
    const shrunk = resizeTierDrafts(rows, 3);
    expect(shrunk.rows).toHaveLength(10);
    expect(shrunk.rows[9].price).toBe("50000");
  });
});

describe("기본 가격 채우기 — 동적 행 수", () => {
  it("현재 행 수만큼 unit×count로 채운다(8행이면 1~8, 20행이면 1~20), 이후 행별 수정 가능", () => {
    const eight = fillDraftsFromUnit(6000, resizeTierDrafts(draftsFromTiers([]), 8).rows);
    expect(eight).toHaveLength(8);
    expect(eight[7]).toEqual({ count: 8, price: "48000", enabled: true });
    const twenty = fillDraftsFromUnit(1000, resizeTierDrafts(draftsFromTiers([]), 20).rows);
    expect(twenty).toHaveLength(20);
    expect(twenty[19].price).toBe("20000");
    twenty[5] = { ...twenty[5], price: "5500" };   // 독립 수정
    expect(validateTierDrafts(twenty)).toBeNull();
    expect(draftsToTiers(twenty)[5].price).toBe(5500);
  });
});

describe("편집기/레이아웃 계약", () => {
  const editor = read("app/components/CountPriceEditor.tsx");
  const css = read("app/globals.css");
  it("최대 횟수 입력 필드가 가격 행보다 먼저 있다", () => {
    expect(editor.indexOf('aria-label="판매 최대 횟수"')).toBeGreaterThan(-1);
    expect(editor.indexOf('aria-label="판매 최대 횟수"')).toBeLessThan(editor.indexOf("count-price-rows"));
    expect(editor).toContain("resizeTierDrafts(rows, n)");
    expect(editor).toContain("판매 중인 가격이 있어 줄일 수 없어요");
  });
  it("1~12 고정 가정이 편집기/폼 로직에 남아 있지 않다(12는 기본 최대 횟수 상수 하나뿐)", () => {
    const code = stripTs(editor);
    expect(code).not.toMatch(/\b12\b/);
    const form = stripTs(read("lib/goodsForm.ts"));
    expect((form.match(/\b12\b/g) ?? []).length).toBe(1);   // TIER_ROWS = 12
    expect(stripTs(read("lib/selectableCount.ts"))).toContain("maxCount = 12");   // fillTiersFromUnit 기본 인자일 뿐(호출부는 현재 행 수를 넘김)
  });
  it("두 화면(/manager/goods, /manager/membership-rules)이 같은 공용 편집기를 쓴다", () => {
    for (const p of ["app/manager/goods/page.tsx", "app/manager/membership-rules/page.tsx"]) {
      expect(read(p)).toContain("<CountPriceEditor rows={pTiers} onChange={setPTiers} disabled={busy} />");
    }
  });
  it("가격 input이 남는 공간을 모두 차지: grid minmax(0,1fr), 좁은 라벨 영역, 16px, 패딩 축소", () => {
    expect(css).toMatch(/\.count-price-row \{[^}]*grid-template-columns: 22px 38px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.count-price-editor \.input-field \{[^}]*min-width: 0[^}]*font-size: 16px; padding: 11px 12px/);
  });
  it("채우기 버튼은 작고(width:auto) 컨테이너 밖으로 나가지 않으며, 좁은 화면에서는 세로로 쌓는다(가로 스크롤 없음)", () => {
    expect(css).toMatch(/\.count-price-fill \.ghost-btn\.count-price-fill-btn \{[^}]*width: auto[^}]*padding: 9px 12px; font-size: 13px/);
    expect(css).toMatch(/\.count-price-fill \{[^}]*min-width: 0; max-width: 100%/);
    expect(css).toMatch(/@media \(max-width: 420px\) \{\s*\.count-price-fill \{ flex-direction: column/);
    expect(css).toMatch(/\.count-price-editor \{ min-width: 0; max-width: 100%/);
  });
});
