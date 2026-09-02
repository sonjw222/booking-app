"use client";

/*
  매니저 - 알림톡 발신 설정 (더보기 > 알림톡 > 발신 설정)
  플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송하는 구조라(사용자 결정, 2026-09-01),
  API 키 자체는 여기서 등록/수정하지 않는다(Supabase 대시보드에서 `supabase secrets set`으로만
  관리, CLAUDE.md 5번 규칙) — 이 화면은 연동 여부를 읽기 전용으로 보여주고 안내만 한다.
*/

import { useEffect, useState } from "react";
import Loading from "../../../components/Loading";
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

      <div style={{ padding: "20px" }}>
        <div className="menu-section-label" style={{ padding: "0 0 8px" }}>알리고 연동 상태</div>
        {connected === null ? (
          <Loading />
        ) : error ? (
          <div className="daylist-empty">{error}</div>
        ) : (
          <div className="holiday-notice">
            <div className="holiday-chip">
              <span className="hc-dot" style={{ background: connected ? "var(--accent)" : "var(--danger)" }} />
              {connected ? "연결됨 — 알림톡을 발송할 수 있어요" : "연결 안 됨 — 아직 알리고 계정이 등록되지 않았어요"}
            </div>
          </div>
        )}

        <div className="menu-section-label" style={{ padding: "20px 0 8px" }}>연동 절차</div>
        <div className="perm-guide" style={{ lineHeight: 1.7 }}>
          1. 알리고(aligo.in) 가입 + 사업자 인증<br />
          2. 카카오톡 채널 개설 후 알리고와 연결(발신프로필 등록)<br />
          3. <a href="/manager/alimtalk/templates">템플릿 관리</a>에서 보낼 문구를 등록하고 카카오 승인 요청<br />
          4. 승인이 끝나면 발급된 템플릿 코드를 템플릿 관리 화면에 입력<br />
          5. 플랫폼 운영자가 Supabase 대시보드에서 API 키를 시크릿으로 등록하면 이 화면의 상태가
          "연결됨"으로 바뀌어요(여기서는 키를 직접 입력하지 않아요 — 유출 방지)
        </div>
      </div>
    </div>
  );
}
