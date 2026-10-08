"use client";

import { useEffect } from "react";
import { reportClientError } from "../lib/errorReporting";

// 루트 레이아웃 자체가 실패했을 때의 마지막 보루 — 이 경우 전역 CSS/레이아웃(디자인 토큰)이 없으므로 하드코딩 색 대신 CSS 시스템 색(Canvas/CanvasText/GrayText, 라이트/다크 자동)과 최소한의 인라인 스타일만 쓴다.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { reportClientError(error, { source: "app/global-error", digest: error?.digest }); }, [error]);

  return (
    <html lang="ko">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "Canvas", color: "CanvasText" }}>
        <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>화면을 불러오지 못했어요</h1>
          <p style={{ margin: 0, color: "GrayText" }}>잠시 후 다시 시도해 주세요.</p>
          <button type="button" onClick={reset} style={{ padding: "12px 20px", borderRadius: 12, border: 0, background: "CanvasText", color: "Canvas", fontSize: 16 }}>다시 시도</button>
        </main>
      </body>
    </html>
  );
}
