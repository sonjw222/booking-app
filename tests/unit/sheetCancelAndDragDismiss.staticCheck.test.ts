/*
  Batch B-6~B-12 — sheet 취소 버튼/3:7 비율/drag-to-dismiss(2026-10-01).
  - 수업 등록 sheet: 예전엔 "등록하기" 하나뿐 → 취소 추가 + drag handle.
  - 수강권 추가 sheet: 기존 취소 버튼에 3:7 비율만 추가.
  - class-revenue 회차별 금액 수정 sheet: 전체 SheetOverlay 감사에서 발견한 또 다른
    "저장 버튼만 있던" sheet — 취소 추가.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const classesSource = readFileSync(join(__dirname, "../../app/manager/classes/page.tsx"), "utf-8");
const membershipSource = readFileSync(join(__dirname, "../../app/manager/membership-rules/page.tsx"), "utf-8");
const revenueSource = readFileSync(join(__dirname, "../../app/manager/class-revenue/page.tsx"), "utf-8");
const cssRaw = readFileSync(join(__dirname, "../../app/globals.css"), "utf-8");
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, "");

describe("B-6 — 수업 등록 sheet에 명시적 취소 버튼이 생겼다", () => {
  it("취소 버튼이 closeFormSheet를 호출한다(배경 탭과 동일 동작, B-11)", () => {
    const block = classesSource.slice(classesSource.indexOf('sheet-actions-37" style={{ marginTop: 20 }}'), classesSource.indexOf('sheet-actions-37" style={{ marginTop: 20 }}') + 300);
    expect(block).toContain('onClick={closeFormSheet}>취소</button>');
  });

  it("SheetOverlay의 배경 탭도 같은 closeFormSheet를 쓴다", () => {
    expect(classesSource).toContain('<SheetOverlay className="sheet-overlay" onClick={closeFormSheet}>');
  });

  it("버튼 행에 3:7 비율 클래스가 붙어있다", () => {
    expect(classesSource).toContain('className="add-profile-actions sheet-actions-37" style={{ marginTop: 20 }}');
  });
});

describe("B-7 — 수강권 추가 sheet는 기존 취소 버튼 + 새 3:7 비율", () => {
  it("resetProdSheet(기존 취소 핸들러)는 그대로 재사용한다(회귀 없음)", () => {
    expect(membershipSource).toContain('onClick={resetProdSheet}>취소</button>');
  });

  it("버튼 행에 sheet-actions-37이 추가됐다", () => {
    expect(membershipSource).toContain('className="add-profile-actions sheet-actions-37" style={{ marginTop: 14 }}>\n              <button className="ghost-btn" onClick={resetProdSheet}>취소</button>');
  });
});

describe("B-8 — 전체 sheet 감사에서 발견한 또 다른 '저장만 있던' sheet(회차별 금액 수정)도 고쳤다", () => {
  it("취소 버튼이 생겼고 저장 중엔 비활성화된다(기존 저장 버튼 disabled 조건과 별개로 안전)", () => {
    const block = revenueSource.slice(revenueSource.indexOf("sheet-actions-37"), revenueSource.indexOf("sheet-actions-37") + 400);
    expect(block).toContain('disabled={editSaving} onClick={() => setEditTarget(null)}>취소</button>');
  });
});

describe("B-6/B-7/B-8 공용 — sheet-actions-37 CSS가 정확히 3:7이고 기존 .add-profile-actions(다른 ~20개 화면 공용 계약)는 건드리지 않았다", () => {
  it(".sheet-actions-37 .ghost-btn/.primary-btn에만 flex 3/7을 준다(추가 클래스, 기존 규칙 그대로)", () => {
    expect(css).toContain(".sheet-actions-37 .ghost-btn { flex: 3; }");
    expect(css).toContain(".sheet-actions-37 .primary-btn { flex: 7; }");
  });

  it(".add-profile-actions 기존 규칙 자체(display/gap/margin-top)는 그대로다", () => {
    expect(css).toContain(".add-profile-actions { display: flex; gap: 10px; margin-top: 4px; }");
  });
});

const sheetOverlaySource = readFileSync(join(__dirname, "../../app/components/SheetOverlay.tsx"), "utf-8");
const sheetDragSource = readFileSync(join(__dirname, "../../lib/sheetDrag.ts"), "utf-8");

describe("B-9/B-10/B-11 — drag-to-dismiss는 공용 SheetOverlay/lib/sheetDrag로 승격됐다(2026-10-01)", () => {
  it("수업 등록 sheet에는 더 이상 로컬 dragY/pointer handler가 없다(중복 gesture 금지)", () => {
    const code = classesSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/dragY|dragStartY|handleDragHandlePointer|sheetBoxRef|setDragging/);
  });

  it("공용 SheetOverlay가 handle을 심고 attachSheetDrag를 쓴다", () => {
    expect(sheetOverlaySource).toContain("attachSheetDrag");
    expect(sheetOverlaySource).toContain("sheet-drag-handle");
  });

  it("아래로만 반응 + 거리(sheet 높이의 35%)만으로 닫힘 여부를 정한다(velocity 없음)", () => {
    expect(sheetDragSource).toContain("export const DISMISS_RATIO = 0.35;");
    expect(sheetDragSource).toContain("dy > 0 ? dy : 0");
    const code = sheetDragSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/velocity|speed/i);
  });

  it("닫기는 배경 탭/ESC와 같은 경로(overlay.click → closeFormSheet)를 탄다", () => {
    expect(sheetOverlaySource).toContain("onDismiss: () => overlay.click()");
    expect(classesSource).toContain('<SheetOverlay className="sheet-overlay" onClick={closeFormSheet}>');
  });
});

describe("B-12 — 애니메이션: 드래그 중 transition 없음, 놓으면 slide-out/snap-back, reduced-motion 대응", () => {
  it("드래그 중엔 inline transition을 끈다", () => {
    expect(sheetDragSource).toContain('sheet.style.transition = transition ?? "none";');
  });

  it("prefers-reduced-motion이면 애니메이션 없이 즉시 처리한다", () => {
    expect(sheetDragSource).toContain("prefers-reduced-motion: reduce");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.sheet, \.sheet-overlay \{ transition: none !important; \}/);
  });

  it("새 거대 애니메이션 라이브러리를 도입하지 않았다", () => {
    expect(sheetDragSource + sheetOverlaySource).not.toMatch(/framer-motion|react-spring|gsap/i);
  });
});
