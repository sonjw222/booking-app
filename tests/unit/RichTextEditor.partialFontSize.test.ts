// @vitest-environment jsdom
// UI-001: 선택 영역에만 부분 글자 크기가 적용되는지 검증.
//
// 참고(범위/한계): 이 샌드박스에는 브라우저 자동화 도구가 없어 실제
// document.execCommand("fontSize", ...)가 브라우저 Selection을 기준으로
// 정확히 선택한 부분에만 <font size="7">를 생성하는지는 이번 테스트로
// 검증하지 못한다(이는 브라우저 자체의 기존 검증된 동작이며, 굵게/기울임/
// 밑줄/글자색이 이미 의존하고 있는 것과 동일한 신뢰 전제다). 이 테스트는
// execCommand 실행 "이후" 단계 — 즉 RichTextEditor가 결과 HTML에서
// <font size="7"> 표식만 골라 지정한 px로 치환하고, 표식이 없는 나머지
// 텍스트/태그는 전혀 건드리지 않는지 — 를 검증한다.
import { describe, it, expect } from "vitest";
import {
  promoteFontSizeMarkerToSpan,
  normalizeFontColorToSpan,
} from "../../app/components/RichTextEditor";

describe("promoteFontSizeMarkerToSpan (partial selection scoping)", () => {
  it("converts only the marked <font size=7> segment, leaving surrounding text untouched", () => {
    const html = '안녕 <font size="7">선택된부분</font> 세상';
    const out = promoteFontSizeMarkerToSpan(html, 24);
    expect(out).toBe('안녕 <span style="font-size: 24px">선택된부분</span> 세상');
  });

  it("does not touch other formatting (bold/italic/underline) outside the selection", () => {
    const html = '<b>굵은글자</b> <font size="7">크게</font> <i>기울임</i>';
    const out = promoteFontSizeMarkerToSpan(html, 28);
    expect(out).toContain("<b>굵은글자</b>");
    expect(out).toContain("<i>기울임</i>");
    expect(out).toMatch(/<span style="font-size: 28px">크게<\/span>/);
  });

  it("does not touch a plain <font color> tag that is not the size=7 marker", () => {
    const html = '<font color="#7B2D3B">색깔만</font> <font size="7">크기만</font>';
    const out = promoteFontSizeMarkerToSpan(html, 18);
    // color 태그는 이 함수의 대상이 아니므로 그대로 남아있어야 한다(다음 단계인
    // normalizeFontColorToSpan이 별도로 처리).
    expect(out).toContain('<font color="#7B2D3B">색깔만</font>');
    expect(out).toMatch(/<span style="font-size: 18px">크기만<\/span>/);
  });

  it("handles multiple separate selections marked in the same pass", () => {
    const html = '<font size="7">첫번째</font>중간텍스트<font size="7">두번째</font>';
    const out = promoteFontSizeMarkerToSpan(html, 20);
    expect(out).toBe(
      '<span style="font-size: 20px">첫번째</span>중간텍스트<span style="font-size: 20px">두번째</span>'
    );
  });

  it("preserves a nested color span inside the size-marked segment", () => {
    const html = '<font size="7">앞<span style="color: #7B2D3B">색깔부분</span>뒤</font>';
    const out = promoteFontSizeMarkerToSpan(html, 32);
    expect(out).toContain('<span style="color: #7B2D3B">색깔부분</span>');
    expect(out).toMatch(/^<span style="font-size: 32px">/);
  });

  it("full pipeline: size marker + color font tag together normalize correctly", () => {
    const html = '<font color="#2B4C7E">색</font> <font size="7">크기</font>';
    const sized = promoteFontSizeMarkerToSpan(html, 16);
    const finalHtml = normalizeFontColorToSpan(sized);
    expect(finalHtml).toBe(
      '<span style="color: #2B4C7E">색</span> <span style="font-size: 16px">크기</span>'
    );
  });
});
