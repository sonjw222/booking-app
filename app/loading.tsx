import Loading from "./components/Loading";

// 실기기 QA(2026-09-25) — 예전엔 <main className="system-state-v2">(오류/404용 "화면 정중앙에
// 좁은 콘텐츠" 레이아웃: flex column + align-items:center)로 감쌌다. 그 안에서 .loading-wrap이
// flex item으로 내용 폭만큼 줄어들어 스켈레톤이 화면 가운데의 좁은 세로 띠로 깨졌다.
// 로딩 전용 래퍼(.route-loading)로 분리 — 실제 콘텐츠 폭/패딩 그대로, safe-area와 하단
// 네비 여백만 반영한다.
export default function AppLoading() {
  return <main className="route-loading"><Loading text="화면을 준비하고 있어요" /></main>;
}
