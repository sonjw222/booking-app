"use client";

import Link from "next/link";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="system-state-v2">
    <div className="system-state-mark">!</div>
    <h1>화면을 불러오지 못했어요</h1>
    <p>잠시 후 다시 시도해 주세요.</p>
    <button type="button" className="app-button app-button-primary" onClick={reset}>다시 시도</button>
    <Link className="app-button app-button-secondary" href="/" prefetch={false}>홈으로 이동</Link>
  </main>;
}
