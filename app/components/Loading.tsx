"use client";

/*
  공통 로딩 표시 (모든 화면 통일)
  - 텍스트만 있던 "불러오는 중..."을 스피너 + 텍스트로 통일
*/

export default function Loading({ text = "화면을 준비하고 있어요" }: { text?: string }) {
  return (
    <div className="loading-wrap" role="status" aria-live="polite">
      <span className="sr-only">{text}</span>
      <div className="loading-skeleton" aria-hidden="true">
        <i className="loading-skeleton-title" />
        <i className="loading-skeleton-line wide" />
        <i className="loading-skeleton-line" />
        <i className="loading-skeleton-card" />
        <i className="loading-skeleton-line short" />
      </div>
    </div>
  );
}
