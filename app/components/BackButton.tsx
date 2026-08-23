"use client";

import { useRouter } from "next/navigation";

// UX 감사(C-4) — 여러 화면의 뒤로가기(‹)가 브라우저 히스토리가 아니라 고정 경로(주로 "/")로
// href가 박혀있어서, 홈이 아닌 다른 화면(검색 결과 등)을 거쳐 들어왔을 때도 항상 그 고정
// 경로로 튀었다. 이 앱 안에서 이동해온 경우(document.referrer가 같은 origin)에만
// router.back()을 쓰고, 그 외(새 탭으로 열었거나 딥링크로 바로 진입한 경우)엔 앱 밖으로
// 나가면 안 되니 기존처럼 고정 폴백 경로로 이동한다.
export default function BackButton({ fallbackHref, className = "side", label = "뒤로가기" }: {
  fallbackHref: string;
  className?: string;
  label?: string;
}) {
  const router = useRouter();
  function handleClick() {
    const cameFromInsideApp =
      typeof document !== "undefined" &&
      document.referrer.startsWith(window.location.origin) &&
      window.history.length > 1;
    if (cameFromInsideApp) router.back();
    else router.push(fallbackHref);
  }
  return (
    <button type="button" className={className} aria-label={label} onClick={handleClick}>‹</button>
  );
}
