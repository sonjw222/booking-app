"use client";

/*
  비밀번호 재설정 요청 (P1) — 이메일을 입력하면 Supabase가 재설정 링크를 보낸다.
  링크를 클릭하면 /reset-password/confirm 으로 돌아와 새 비밀번호를 입력한다.
  이 화면 자체는 로그인 여부와 무관하게(로그인 안 한 상태에서) 열 수 있어야 한다.
*/

import { useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function ResetPasswordRequestPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);

  async function submit() {
    if (loading) return;
    if (!email.trim()) {
      setMessage({ type: "error", text: "이메일을 입력해주세요" });
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/reset-password/confirm`,
    });
    setLoading(false);
    // 존재하지 않는 이메일이라도 같은 메시지를 보여준다 — 가입 여부를 밖으로 노출하지 않기 위함.
    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }
    setMessage({ type: "ok", text: "비밀번호 재설정 링크를 이메일로 보냈어요. 메일함을 확인해주세요." });
  }

  return (
    <div className="app-shell auth-account-page account-page-v2">
      <div className="back-header">
        <a className="side" href="/login">‹</a>
        <div className="title">비밀번호 재설정</div>
        <div className="side" />
      </div>

      <div className="login-wrap" style={{ paddingTop: 30 }}>
        <div className="perm-guide" style={{ margin: "0 0 18px", width: "100%" }}>
          가입할 때 사용한 이메일을 입력하면, 비밀번호를 다시 설정할 수 있는 링크를 보내드려요.
        </div>

        <input
          className="input-field"
          type="email"
          placeholder="이메일"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        {message && <div className={`auth-msg ${message.type}`}>{message.text}</div>}

        <button className="primary-btn" onClick={submit} disabled={loading}>
          {loading ? "보내는 중..." : "재설정 링크 보내기"}
        </button>
      </div>
    </div>
  );
}
