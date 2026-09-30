"use client";

/*
  매니저 - 알림톡 발신 설정 (더보기 > 알림톡 > 발신 설정)
  플랫폼(sonjw) 단일 알리고 계정으로 전 센터를 대행 발송하는 구조라(사용자 결정, 2026-09-01),
  API 키 자체는 여기서 등록/수정하지 않는다(Supabase 대시보드에서 `supabase secrets set`으로만
  관리, CLAUDE.md 5번 규칙) — 이 화면은 연동 여부를 읽기 전용으로 보여주고 안내만 한다.

  실기기 QA(2026-09-30) — 이전 화면은 "알리고 가입 → 사업자 인증 → 카카오 채널 개설 → 발신
  프로필 등록 → 모하빗 운영자에게 연결 확인 요청" 같은 1~5단계 안내를 그대로 보여줬는데,
  실제로는 센터 관리자가 전혀 거치지 않는 절차다(센터마다 개별 Aligo 연동을 하는 SaaS 구조가
  아니라, 플랫폼 공용 send-alimtalk → Oracle 고정 IP 프록시 → 단일 Aligo 계정 → 모하빗
  카카오 채널을 모든 센터가 함께 쓴다). 센터 관리자가 실제로 해야 할 일이 없는 기술 절차를
  보여주는 대신, "이미 연결돼 있고 템플릿만 등록하면 된다"는 사실만 전달한다. API key/sender
  key/Oracle proxy 등 내부 인프라 정보는 원래도 화면에 없었고 이번에도 추가하지 않는다.
  Edge Function 호출("status" 액션)과 연결 상태 판정 로직 자체는 손대지 않았다.
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
          <h2 className="menu-section-label">모하빗 알림톡 발송 서비스</h2>
          {error ? <p role="alert">{error}</p> : connected === null ? <p>확인 중</p> : <>
            <strong style={{ color: connected ? "var(--ink)" : "var(--danger)" }}>{connected ? "사용 가능" : "일시적으로 이용할 수 없어요"}</strong>
            <p>{connected ? "승인된 알림톡 템플릿으로 회원에게 메시지를 보낼 수 있어요." : "지금은 알림톡 발송이 어려워요. 잠시 후 다시 시도하거나 운영자에게 문의해주세요."}</p>
          </>}
        </section>
        <div className="perm-guide" style={{ margin: "16px 0 0" }}>
          별도의 알리고 가입이나 카카오톡 채널 연결 없이 모하빗 알림톡 서비스를 바로 이용할 수 있어요.
          <br />
          <a href="/manager/alimtalk/templates">템플릿 관리</a>에서 승인된 알림톡 템플릿을 등록하면 회원에게 자동으로 메시지를 보낼 수 있어요.
          <br />
          알림톡 발송이 실패하면 문자로 대체 발송될 수 있어요.
        </div>
      </div>
    </div>
  );
}
