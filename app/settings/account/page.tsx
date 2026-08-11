"use client";

/*
  계정 설정 (P1) — 로그인 상태에서 비밀번호를 바꾼다. 이메일/비밀번호로 가입한 계정 전용
  기능이라(카카오/네이버/애플/구글 등 소셜 로그인 계정은 애초에 비밀번호가 없음),
  provider가 email이 아니면 안내만 보여주고 폼은 숨긴다.
*/

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import BottomNav from "../../components/BottomNav";

export default function AccountSettingsPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [isEmailProvider, setIsEmailProvider] = useState(true);
  const [loadingUser, setLoadingUser] = useState(true);

  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setEmail(data.user?.email ?? null);
      setIsEmailProvider((data.user?.app_metadata?.provider ?? "email") === "email");
      setLoadingUser(false);
    });
  }, []);

  async function changePassword() {
    if (saving) return;
    if (password.length < 6) {
      setMessage({ type: "error", text: "새 비밀번호는 6자 이상이어야 해요" });
      return;
    }
    if (password !== password2) {
      setMessage({ type: "error", text: "새 비밀번호가 서로 달라요" });
      return;
    }
    setSaving(true);
    setMessage(null);
    const { error } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (error) {
      setMessage({ type: "error", text: error.message });
      return;
    }
    setPassword("");
    setPassword2("");
    setMessage({ type: "ok", text: "비밀번호가 변경됐어요." });
  }

  return (
    <div className="app-shell account-page-v2 settings-page-v2">
      <div className="back-header">
        <a className="side" href="/mypage">‹</a>
        <div className="title">계정 설정</div>
        <div className="side" />
      </div>

      {!loadingUser && (
        <>
          <div className="perm-guide" style={{ margin: "8px 20px" }}>
            {email ? `로그인 이메일: ${email}` : ""}
          </div>

          {!isEmailProvider ? (
            <div className="perm-guide" style={{ margin: "0 20px" }}>
              소셜 로그인 계정은 여기서 바꿀 비밀번호가 없어요. 로그인에 사용한 서비스(카카오/네이버/애플/구글)
              쪽에서 계정을 관리해주세요.
            </div>
          ) : (
            <div className="login-wrap" style={{ padding: "10px 20px 40px", alignItems: "stretch" }}>
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
                onKeyDown={(e) => e.key === "Enter" && changePassword()}
              />
              {message && <div className={`auth-msg ${message.type}`}>{message.text}</div>}
              <button className="primary-btn" onClick={changePassword} disabled={saving}>
                {saving ? "변경 중..." : "비밀번호 변경"}
              </button>
            </div>
          )}
        </>
      )}

      <BottomNav />
    </div>
  );
}
