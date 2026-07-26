"use client";

/*
  센터 소개용 간단 리치 텍스트 에디터
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
    if (ref.current) onChangeHtml(ref.current.innerHTML);
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
