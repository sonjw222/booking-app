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

describe("B-9/B-10/B-11 — 수업 등록 sheet drag-to-dismiss", () => {
  it("drag handle 전용 요소에만 pointer 핸들러가 붙는다(폼 내부 스크롤과 분리)", () => {
    const block = classesSource.slice(classesSource.indexOf('className="sheet-drag-handle"'), classesSource.indexOf('className="sheet-drag-handle"') + 400);
    expect(block).toContain("onPointerDown={handleDragHandlePointerDown}");
    expect(block).toContain("onPointerMove={handleDragHandlePointerMove}");
    expect(block).toContain("onPointerUp={handleDragHandlePointerUp}");
    expect(block).toContain("onPointerCancel={handleDragHandlePointerUp}");
  });

  it("아래로만 반응한다(위로 끌면 0에서 멈춤 — Math.max(0, ...))", () => {
    const fn = classesSource.slice(classesSource.indexOf("function handleDragHandlePointerMove"), classesSource.indexOf("function handleDragHandlePointerMove") + 300);
    expect(fn).toContain("Math.max(0, e.clientY - dragStartY.current)");
  });

  it("velocity가 아니라 거리(sheet 높이의 35%)만으로 닫힘 여부를 정한다(B-10, 실수 방지 우선)", () => {
    const fn = classesSource.slice(classesSource.indexOf("function handleDragHandlePointerUp"), classesSource.indexOf("function handleDragHandlePointerUp") + 600);
    expect(fn).toContain("dragY > height * 0.35");
    // 코드(주석 제외)에 velocity/speed 기반 판정 로직이 없는지 확인 — 이 파일 자체의
    // 설명 주석("velocity가 아니라...")이 스스로 오탐하지 않도록 주석을 먼저 제거한다.
    const code = fn.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/velocity|speed/i);
  });

  it("threshold 미달이면 원위치로(dragY를 0으로)만 돌아가고 닫히지 않는다", () => {
    const fn = classesSource.slice(classesSource.indexOf("function handleDragHandlePointerUp"), classesSource.indexOf("function handleDragHandlePointerUp") + 600);
    expect(fn).toMatch(/else \{\s*setDragY\(0\);/);
  });

  it("드래그로 닫힐 때도 closeFormSheet를 그대로 호출한다(취소 버튼과 완전히 같은 동작, B-11)", () => {
    const fn = classesSource.slice(classesSource.indexOf("function handleDragHandlePointerUp"), classesSource.indexOf("function handleDragHandlePointerUp") + 600);
    expect(fn).toContain("closeFormSheet();");
  });
});

describe("B-12 — 애니메이션: 드래그 중엔 transition 없음, 놓으면 스냅백/닫힘에 transition, reduced-motion 대응", () => {
  it("드래그 중(dragging=true)엔 인라인 style.transition을 없앤다", () => {
    expect(classesSource).toContain('transition: dragging ? "none" : undefined,');
  });

  it(".direct-member-sheet에 transform transition이 정의돼 있다(놓았을 때 쓰임)", () => {
    expect(css).toMatch(/\.direct-member-sheet\s*\{\s*transition:\s*transform/);
  });

  it("prefers-reduced-motion에서는 transition이 없다", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.direct-member-sheet\s*\{\s*transition:\s*none;/);
  });

  it("새 거대 애니메이션 라이브러리를 도입하지 않았다(순수 CSS transition + React state)", () => {
    expect(classesSource).not.toMatch(/framer-motion|react-spring|gsap/i);
  });
});
