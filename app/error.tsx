"use client";

import Link from "next/link";
import { useEffect } from "react";
import { reportClientError } from "../lib/errorReporting";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // 렌더 오류를 한 번 기록한다(개인정보/토큰 제거, DSN 없이 동작 — lib/errorReporting.ts).
  useEffect(() => { reportClientError(error, { source: "app/error", digest: error?.digest }); }, [error]);

  return <main className="system-state-v2">
    <div className="system-state-mark">!</div>
    <h1>화면을 불러오지 못했어요</h1>
    <p>잠시 후 다시 시도해 주세요.</p>
    <button type="button" className="app-button app-button-primary" onClick={reset}>다시 시도</button>
    <Link className="app-button app-button-secondary" href="/" prefetch={false}>홈으로 이동</Link>
  </main>;
}
