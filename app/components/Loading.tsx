"use client";

/*
  공통 로딩 표시 (모든 화면 통일)
  - 텍스트만 있던 "불러오는 중..."을 스피너 + 텍스트로 통일
*/

export default function Loading({ text = "불러오는 중..." }: { text?: string }) {
  return (
    <div className="loading-wrap">
      <div className="loading-spinner" />
      <div className="loading-text">{text}</div>
    </div>
  );
}
