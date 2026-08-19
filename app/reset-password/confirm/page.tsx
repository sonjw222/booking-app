"use client";

/*
  비밀번호 재설정 확정 (P1) — 이메일로 받은 링크를 클릭하면 이 화면으로 돌아온다.
  Supabase 클라이언트가 URL의 recovery 토큰을 자동으로 감지해(detectSessionInUrl,
  기본값) 임시 세션을 만들어주므로, 여기서는 그 세션 상태로 바로 updateUser({password})만
  호출하면 된다 — 로그인 폼을 다시 거치지 않는다.
*/

import { useState } from "react";
import { supabase } from "../../../lib/supabaseClient";

export default function ResetPasswordConfirmPage() {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (loading) return;
    if (password.length < 6) {
      setMessage({ type: "error", text: "비밀번호는 6자 이상이어야 해요" });
      return;
    }
    if (password !== password2) {
      setMessage({ type: "error", text: "비밀번호가 서로 달라요" });
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      const msg = error.message.includes("session")
        ? "재설정 링크가 만료됐거나 이미 사용됐어요. 다시 요청해주세요."
        : error.message;
      setMessage({ type: "error", text: msg });
      return;
    }
    // 새 비밀번호로 실제 로그인 화면부터 다시 시작하도록 이 임시 세션은 로그아웃한다.
    await supabase.auth.signOut();
    setDone(true);
  }

  if (done) {
    return (
      <div className="app-shell auth-account-page account-page-v2">
        <div className="back-header">
          <div className="title">비밀번호 재설정</div>
        </div>
        <div className="login-wrap" style={{ paddingTop: 30 }}>
          <div className="auth-msg ok" style={{ width: "100%" }}>비밀번호가 변경됐어요. 새 비밀번호로 로그인해주세요.</div>
          <a className="primary-btn" style={{ marginTop: 14, textDecoration: "none" }} href="/login">로그인하러 가기</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell auth-account-page account-page-v2">
      <div className="back-header">
        <div className="title">새 비밀번호 설정</div>
      </div>

      <div className="login-wrap" style={{ paddingTop: 30 }}>
        <input
          className="input-field"
          type="password"
          placeholder="새 비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <input
          className="input-field"
          type="password"
          placeholder="새 비밀번호 확인"
          value={password2}
          onChange={(e) => setPassword2(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        {message && <div className={`auth-msg ${message.type}`}>{message.text}</div>}

        <button className="primary-btn" onClick={submit} disabled={loading}>
          {loading ? "변경 중..." : "비밀번호 변경하기"}
        </button>
      </div>
    </div>
  );
}
