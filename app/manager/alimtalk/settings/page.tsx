"use client";

/*
  매니저 - 알림톡 발신 설정 (더보기 > 알림톡 > 발신 설정)
  플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송하는 구조라(사용자 결정, 2026-09-01),
  API 키 자체는 여기서 등록/수정하지 않는다(Supabase 대시보드에서 `supabase secrets set`으로만
  관리, CLAUDE.md 5번 규칙) — 이 화면은 연동 여부를 읽기 전용으로 보여주고 안내만 한다.
*/

import { useEffect, useState } from "react";
import { supabase } from "../../../../lib/supabaseClient";

export default function AlimtalkSettingsPage() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.functions.invoke<{ connected: boolean }>("send-alimtalk", {
        body: { action: "status" },
      });
      if (error || !data) { setError("연동 상태를 확인하지 못했어요"); return; }
      setConnected(data.connected);
    })();
  }, []);

  return (
    <div className="app-shell">
      <div className="back-header">
        <a className="side" href="/manager/alimtalk">‹</a>
        <div className="title">발신 설정</div>
        <div className="side" />
      </div>

      <div className="connection-settings" style={{ padding: "20px" }}>
        <section className="connection-card" aria-live="polite">
          <h2 className="menu-section-label">알림톡 연결 상태</h2>
          {error ? <p role="alert">{error}</p> : connected === null ? <p>확인 중</p> : <>
            <strong style={{ color: connected ? "var(--ink)" : "var(--danger)" }}>{connected ? "연결됨" : "연결 필요"}</strong>
            <p>{connected ? "알림톡을 발송할 수 있어요." : "아직 알리고 계정이 연결되지 않았어요. 아래 준비 사항을 확인해주세요."}</p>
          </>}
          <p>모하빗에서 연결 상태를 확인합니다. 도움이 필요하면 운영자에게 문의해주세요.</p>
        </section>
        <h2 className="menu-section-label" style={{ padding: "24px 0 8px" }}>연결 준비</h2>
        <ol className="connection-steps">
          <li>알리고에 가입하고 사업자 인증을 완료하세요.</li>
          <li>카카오톡 채널을 개설하세요.</li>
          <li>알리고에서 카카오 채널을 연결하고 발신프로필을 등록하세요.</li>
          <li><a href="/manager/alimtalk/templates">템플릿 관리</a>에서 문구를 등록하고 카카오 승인을 요청하세요.</li>
          <li>승인된 템플릿을 확인하고, 모하빗 운영자에게 연결 확인을 요청하세요.</li>
        </ol>
      </div>
    </div>
  );
}
