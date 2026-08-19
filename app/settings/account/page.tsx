"use client";

/*
  계정 설정 (P1) — 로그인 상태에서 비밀번호를 바꾼다. 이메일/비밀번호로 가입한 계정 전용
  기능이라(카카오/네이버/애플/구글 등 소셜 로그인 계정은 애초에 비밀번호가 없음),
  provider가 email이 아니면 안내만 보여주고 폼은 숨긴다.
*/

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { deactivateCurrentAccount } from "../../../lib/accountDeletion";

const WITHDRAW_CONFIRM_PHRASE = "탈퇴합니다";

export default function AccountSettingsPage() {
  const [email, setEmail] = useState<string | null>(null);
  const [isEmailProvider, setIsEmailProvider] = useState(true);
  const [loadingUser, setLoadingUser] = useState(true);

  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);

  // 탈퇴 재인증(AUTH-08) — 이메일 계정은 현재 비밀번호로 실제 재인증한다. 소셜 계정(카카오/
  // 네이버/애플/구글)은 이 화면 범위에서 provider 재로그인 왕복까지 구현하지 않고(별도
  // 과제, docs/TODO.md P1-18) 확인 문구 입력으로 낮은 문턱만 둔다 — 실수/충동 클릭 방지가
  // 목적이며, 이미 이 앱의 비밀번호 변경(위 changePassword)도 재인증 없이 동작하므로 이
  // 정도로도 기존 대비 더 신중한 확인 절차다.
  const [withdrawPassword, setWithdrawPassword] = useState("");
  const [withdrawConfirmText, setWithdrawConfirmText] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawMessage, setWithdrawMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);

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

  async function withdraw() {
    if (withdrawing) return;
    setWithdrawMessage(null);

    if (isEmailProvider) {
      if (!withdrawPassword) {
        setWithdrawMessage({ type: "error", text: "본인 확인을 위해 현재 비밀번호를 입력해주세요" });
        return;
      }
      if (!email) {
        setWithdrawMessage({ type: "error", text: "계정 정보를 불러오지 못했어요. 새로고침 후 다시 시도해주세요" });
        return;
      }
      setWithdrawing(true);
      const { error: reauthErr } = await supabase.auth.signInWithPassword({ email, password: withdrawPassword });
      if (reauthErr) {
        setWithdrawing(false);
        setWithdrawMessage({ type: "error", text: "비밀번호가 올바르지 않아요" });
        return;
      }
    } else if (withdrawConfirmText !== WITHDRAW_CONFIRM_PHRASE) {
      setWithdrawMessage({ type: "error", text: `확인을 위해 "${WITHDRAW_CONFIRM_PHRASE}"를 정확히 입력해주세요` });
      return;
    } else {
      setWithdrawing(true);
    }

    try {
      await deactivateCurrentAccount();
    } catch (e: any) {
      setWithdrawing(false);
      setWithdrawMessage({ type: "error", text: e.message ?? "탈퇴 처리에 실패했어요" });
      return;
    }

    window.location.href = "/login?withdrawn=1";
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

          <div className="login-wrap" style={{ padding: "10px 20px 40px", alignItems: "stretch" }}>
            <h3 style={{ margin: "12px 0 4px" }}>계정 탈퇴</h3>
            <div className="perm-guide" style={{ margin: "0 0 8px" }}>
              탈퇴하면 이 계정으로 다시 로그인할 수 없어요. 예약·구매·결제 내역은 법적 보관
              목적으로 남지만 더 이상 접근할 수 없어요.
            </div>

            {isEmailProvider ? (
              <input
                className="input-field"
                type="password"
                placeholder="본인 확인을 위한 현재 비밀번호"
                value={withdrawPassword}
                onChange={(e) => setWithdrawPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && withdraw()}
              />
            ) : (
              <input
                className="input-field"
                type="text"
                placeholder={`확인을 위해 "${WITHDRAW_CONFIRM_PHRASE}" 입력`}
                value={withdrawConfirmText}
                onChange={(e) => setWithdrawConfirmText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && withdraw()}
              />
            )}

            {withdrawMessage && <div className={`auth-msg ${withdrawMessage.type}`}>{withdrawMessage.text}</div>}
            <button className="danger-btn" onClick={withdraw} disabled={withdrawing}>
              {withdrawing ? "탈퇴 처리 중..." : "탈퇴하기"}
            </button>
          </div>
        </>
      )}

    </div>
  );
}
