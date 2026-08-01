"use client";

/*
  공용 간단 리치 텍스트 에디터 (공지사항 / 리뷰 답변 / 센터소개 / 회원 리뷰 작성 공용)
  - 원하는 글자만 선택해서 굵게 / 기울임 / 색상 / 크기 적용
  - 블록 전체 정렬 (왼쪽/가운데/오른쪽)
  - contentEditable + document.execCommand 사용 (별도 라이브러리 불필요)
*/

import { useEffect, useRef } from "react";

type Align = "left" | "center" | "right";

type Props = {
  html: string;
  align: Align;
  fontSize: number;
  onChangeHtml: (html: string) => void;
  onChangeAlign: (a: Align) => void;
  onChangeFontSize: (n: number) => void;
};

const COLORS = ["#1a1a1a", "#7B2D3B", "#2B4C7E", "#5E7C6B", "#C0392B", "#B48A3C", "#888888"];

// 선택 영역에만 적용하는 부분 글자 크기 후보값(워드 스타일).
// 편집기 전체 크기 조절용 +/- 버튼(아래 fontSize prop)과는 별개 기능이다.
const PARTIAL_FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];

// execCommand('foreColor', ...)는 styleWithCSS 없이 쓰면 브라우저가
// <font color="..">를 생성한다. 저장 형식을 <span style="color:..">로
// 통일하기 위해, 색상 적용 직후 결과 HTML의 <font> 태그를 <span style>로
// 정규화한다(굵게/기울임/밑줄은 <b>/<i>/<u> 그대로 유지, 색상만 대상).
export function normalizeFontColorToSpan(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  const fonts = Array.from(container.querySelectorAll("font"));
  for (const f of fonts) {
    const span = document.createElement("span");
    const color = f.getAttribute("color");
    if (color) span.setAttribute("style", `color: ${color}`);
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  }
  return container.innerHTML;
}

// execCommand('fontSize', false, '7')은 임의 px를 받지 않고 1~7 레거시
// 상대값만 받는다. 항상 표식값 "7"을 준 뒤, 선택 직후(=실제 px를 아는
// 시점)에 생성된 <font size="7">만 정확한 <span style="font-size:Npx">로
// 즉시 치환한다. size="7"이 아닌 다른 font 태그(색상용 등)는 건드리지 않는다.
export function promoteFontSizeMarkerToSpan(html: string, px: number): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  const markers = Array.from(container.querySelectorAll('font[size="7"]'));
  for (const f of markers) {
    const span = document.createElement("span");
    span.setAttribute("style", `font-size: ${px}px`);
    while (f.firstChild) span.appendChild(f.firstChild);
    f.replaceWith(span);
  }
  return container.innerHTML;
}

export default function RichTextEditor({
  html, align, fontSize, onChangeHtml, onChangeAlign, onChangeFontSize,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // 외부 값이 바뀌었을 때만 DOM 갱신 (입력 중 커서 튐 방지)
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== html) {
      ref.current.innerHTML = html;
    }
  }, [html]);

  function exec(cmd: string, value?: string) {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    if (ref.current) {
      const normalized = normalizeFontColorToSpan(ref.current.innerHTML);
      if (ref.current.innerHTML !== normalized) ref.current.innerHTML = normalized;
      onChangeHtml(normalized);
    }
  }

  // 선택한 글자에만 부분 글자 크기 적용(편집기 전체 크기 조절용 +/-와는 별개).
  function execPartialFontSize(px: number) {
    ref.current?.focus();
    document.execCommand("fontSize", false, "7");
    if (ref.current) {
      const sized = promoteFontSizeMarkerToSpan(ref.current.innerHTML, px);
      const normalized = normalizeFontColorToSpan(sized);
      if (ref.current.innerHTML !== normalized) ref.current.innerHTML = normalized;
      onChangeHtml(normalized);
    }
  }

  function handleInput() {
    if (ref.current) onChangeHtml(ref.current.innerHTML);
  }

  return (
    <div className="rte">
      {/* 툴바 */}
      <div className="rte-toolbar">
        <button className="rte-btn" title="굵게" onClick={() => exec("bold")}><b>B</b></button>
        <button className="rte-btn" title="기울임" onClick={() => exec("italic")}><i>I</i></button>
        <button className="rte-btn" title="밑줄" onClick={() => exec("underline")}><u>U</u></button>

        <span className="rte-divider" />

        <button className={`rte-btn ${align === "left" ? "on" : ""}`} title="왼쪽 정렬" onClick={() => onChangeAlign("left")}>≡</button>
        <button className={`rte-btn ${align === "center" ? "on" : ""}`} title="가운데 정렬" onClick={() => onChangeAlign("center")}>≣</button>
        <button className={`rte-btn ${align === "right" ? "on" : ""}`} title="오른쪽 정렬" onClick={() => onChangeAlign("right")}>≡</button>

        <span className="rte-divider" />

        <span className="rte-size">
          <button className="rte-btn" title="글자 작게" onClick={() => onChangeFontSize(Math.max(10, fontSize - 1))}>−</button>
          <span className="rte-size-val">{fontSize}pt</span>
          <button className="rte-btn" title="글자 크게" onClick={() => onChangeFontSize(Math.min(40, fontSize + 1))}>+</button>
        </span>
      </div>

      {/* 색상 팔레트 */}
      <div className="rte-colors">
        <span className="rte-colors-label">글자색</span>
        {COLORS.map((c) => (
          <button key={c} className="rte-color" style={{ background: c }} title={c}
            onClick={() => exec("foreColor", c)} />
        ))}
      </div>

      {/* 선택 글자 크기(부분 적용) */}
      <div className="rte-colors">
        <span className="rte-colors-label">선택 글자 크기</span>
        {PARTIAL_FONT_SIZES.map((px) => (
          <button key={px} className="rte-btn" title={`${px}px`}
            onClick={() => execPartialFontSize(px)}>
            {px}
          </button>
        ))}
      </div>

      {/* 입력 영역 */}
      <div
        ref={ref}
        className="rte-area"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        style={{ textAlign: align, fontSize }}
        data-placeholder="내용을 입력하세요"
      />
      <div className="perm-guide" style={{ margin: "4px 0 0" }}>
        글자를 드래그해서 선택한 뒤 B/I/U·색상을 누르면 그 부분만 바뀌어요.
      </div>
    </div>
  );
}
