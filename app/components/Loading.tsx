"use client";

/*
  공통 로딩 표시 (모든 화면 통일)
  - 텍스트만 있던 "불러오는 중..."을 스피너 + 텍스트로 통일
*/

// 릴리스 폴리시 배치 8차(2026-09-18), 2-1 — 감사 결과: 이 공용 스켈레톤이 title+line×2+
// card+line 하나로 고정 높이(약 250px)라, 대부분의 실제 화면(목록형 — 회원/알림/센터/
// 예약 등)보다 훨씬 짧아서 화면 상단에 작은 스켈레톤 블록만 몰려 있고 중앙~하단은
// 그냥 빈 배경으로 보였다("큰 margin-top으로 중앙에 내려놓기" 같은 임시 처리는 하지
// 않음 — 대신 실제 목록 화면과 비슷한 모양의 row를 몇 개 더 반복해 자연스럽게 화면
// 아래쪽까지 채운다). 화면마다 정확히 다른 모양의 스켈레톤을 새로 그리는 건 이번
// 배치 범위를 넘는 화면별 커스텀 작업이라(대상 화면이 너무 많음), 이 공용 컴포넌트
// 하나를 "list-row가 여러 개 있는 화면" 일반형에 더 가깝게 다듬어 재사용률을 유지한다.
// 실기기 QA(2026-09-25): row를 넉넉히(10) 그리고 .loading-wrap이 usable viewport 높이로
// overflow를 잘라, 화면 크기(모바일/태블릿/데스크톱)와 무관하게 상단에만 몰리지 않고
// 하단 네비 바로 위까지 자연스럽게 채운다.
export default function Loading({ text = "화면을 준비하고 있어요", rows = 10 }: { text?: string; rows?: number }) {
  return (
    <div className="loading-wrap" role="status" aria-live="polite">
      <span className="sr-only">{text}</span>
      <div className="loading-skeleton" aria-hidden="true">
        <i className="loading-skeleton-title" />
        <i className="loading-skeleton-line wide" />
        <i className="loading-skeleton-line" />
        <i className="loading-skeleton-card" />
        <i className="loading-skeleton-line short" />
        {Array.from({ length: rows }).map((_, idx) => (
          <div className="loading-skeleton-row" key={idx}>
            <i className="loading-skeleton-row-icon" />
            <div className="loading-skeleton-row-lines">
              <i className="loading-skeleton-line" />
              <i className="loading-skeleton-line short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
