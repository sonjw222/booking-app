"use client";

/*
  세션 만료 처리 (P1) — 토큰 리프레시가 실패하면 supabase-js가 세션을 지우고
  SIGNED_OUT 이벤트를 발생시킨다(명시적 로그아웃도 같은 이벤트를 쓰지만, 그 경우는
  이미 각자 /login으로 직접 이동시키므로 여기서 한 번 더 이동해도 같은 목적지라
  문제 없음). 이 이벤트를 앱 전체에서 한 번만 구독해, 로그인 화면이 아닌 다른 곳에
  있다가 세션이 끊기면 "세션이 만료됐어요" 안내와 함께 로그인 화면으로 보낸다 —
  이전에는 이런 처리가 전혀 없어서 세션이 끊긴 뒤에도 화면은 그대로 있고 그 안의
  개별 데이터 요청들만 하나씩 알 수 없는 에러를 내는 식이었다.

  계정/프로필 부트스트랩(P1, social-auth 배치) — ensureAccountForCurrentUser()는 원래
  app/page.tsx(홈 화면)에서만 호출됐다. 소셜 로그인의 redirectTo가 항상 "/"라 지금까지는
  우연히 항상 호출됐지만, 로그인 방식과 무관하게 "어느 페이지에 있든" 안전하게 계정이
  보장되도록 여기(앱 전체에 한 번만 마운트되는 컴포넌트)로 옮긴다. SIGNED_IN(로그인 직후)과
  INITIAL_SESSION(이미 세션이 있는 상태로 새로고침/재방문) 둘 다에서 호출 — 함수 자체가
  auth_id 존재 여부로 멱등하게 동작하므로 중복 호출은 안전하다(23505 unique_violation 무시).

  휴대폰 번호 입력 모달 — 소셜 가입은 provider가 휴대폰 번호를 안정적으로 안 줘서
  accounts.phone이 null로 남는다(이메일 가입은 폼에서 이미 필수로 받음). ensureAccountForCurrentUser가
  돌려주는 phone이 null이면 이 모달을 띄워 채우기 전까지 계속 다시 뜨게 한다(새로고침으로
  우회 불가 — created 여부가 아니라 실제 phone 값으로 판단하기 때문).
  ⚠️ isSocial(Supabase Auth provider가 email이 아님)인 계정에만 적용한다 — phone이 비었다고
  전부 막으면, 이 기능 이전에 만들어진 기존 이메일 계정(테스트 계정 포함)까지 막혀버린다
  (실제로 E2E 테스트 계정 전체가 로그인마다 이 모달에 막혀 전체 스위트가 무너진 사고,
  2026-08-14 — provider 조건 없이 phone만 봤던 최초 구현의 버그).
*/

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAccountForCurrentUser, completeSocialProfile } from "../../lib/authAccount";
import { sendPhoneOtp, verifyPhoneOtp } from "../../lib/phoneVerification";
import AddressField from "./AddressField";

export default function SessionWatcher() {
  const [phoneGateAccountId, setPhoneGateAccountId] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [addressBase, setAddressBase] = useState("");
  const [addressDetail, setAddressDetail] = useState("");
  const [saving, setSaving] = useState(false);
  const [gateError, setGateError] = useState<string | null>(null);

  // 휴대폰 인증(OTP) — app/login/page.tsx 이메일 가입과 동일한 절차/제약(2026-09-05).
  const [otpCode, setOtpCode] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [otpMessage, setOtpMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);
  const [otpDevCode, setOtpDevCode] = useState<string | null>(null);

  useEffect(() => {
    if (otpCooldown <= 0) return;
    const t = setTimeout(() => setOtpCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [otpCooldown]);

  function handlePhoneChange(value: string) {
    setPhone(value);
    if (otpSent || otpVerified) {
      setOtpSent(false);
      setOtpVerified(false);
      setOtpCode("");
      setOtpMessage(null);
      setOtpDevCode(null);
    }
  }

  async function handleSendOtp() {
    if (otpSending || otpCooldown > 0) return;
    if (!phone.trim()) {
      setOtpMessage({ type: "error", text: "휴대폰 번호를 먼저 입력해주세요" });
      return;
    }
    setOtpSending(true);
    setOtpMessage(null);
    const res = await sendPhoneOtp(phone.trim());
    setOtpSending(false);
    if (!res.ok) {
      setOtpMessage({ type: "error", text: res.error ?? "인증번호 발송에 실패했어요" });
      setOtpCooldown(res.retryAfterSeconds ?? 0);
      return;
    }
    setOtpSent(true);
    setOtpCooldown(60);
    setOtpDevCode(res.devCode ?? null);
    setOtpMessage({ type: "ok", text: "인증번호를 보냈어요. 카카오톡 또는 문자를 확인해주세요." });
  }

  async function handleVerifyOtp() {
    if (otpVerifying) return;
    if (!otpCode.trim()) {
      setOtpMessage({ type: "error", text: "인증번호를 입력해주세요" });
      return;
    }
    setOtpVerifying(true);
    setOtpMessage(null);
    const res = await verifyPhoneOtp(phone.trim(), otpCode.trim());
    setOtpVerifying(false);
    if (!res.ok) {
      setOtpMessage({ type: "error", text: res.error ?? "인증번호가 일치하지 않아요" });
      return;
    }
    setOtpVerified(true);
    setOtpMessage({ type: "ok", text: "휴대폰 인증이 완료됐어요." });
  }

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        void ensureAccountForCurrentUser().then((account) => {
          setPhoneGateAccountId(account && account.isSocial && !account.phone ? account.id : null);
        });
        return;
      }
      if (event !== "SIGNED_OUT") return;
      setPhoneGateAccountId(null);
      if (window.location.pathname.startsWith("/login")) return;
      if (window.location.pathname.startsWith("/reset-password")) return;
      window.location.href = "/login?expired=1";
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function handleCompletePhone() {
    if (!phoneGateAccountId) return;
    if (!phone.trim()) {
      setGateError("휴대폰 번호를 입력해주세요");
      return;
    }
    if (!otpVerified) {
      setGateError("휴대폰 인증을 완료해주세요");
      return;
    }
    setSaving(true);
    setGateError(null);
    try {
      const address = addressDetail.trim() ? `${addressBase} ${addressDetail}`.trim() : addressBase.trim();
      await completeSocialProfile(phoneGateAccountId, phone.trim(), address || null);
      setPhoneGateAccountId(null);
    } catch (e: any) {
      setGateError(e.message ?? "저장에 실패했어요");
    } finally {
      setSaving(false);
    }
  }

  if (phoneGateAccountId) {
    return (
      <div className="sheet-overlay">
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheet-title">휴대폰 번호를 입력해주세요</div>
          <div className="perm-guide" style={{ margin: "0 0 12px" }}>
            소셜 계정 가입은 휴대폰 번호가 자동으로 전달되지 않아요.
            센터 운영자가 예약자 확인 시 볼 수 있도록 입력해주세요.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input-field"
              type="tel"
              placeholder="휴대폰 번호"
              value={phone}
              onChange={(e) => handlePhoneChange(e.target.value)}
              disabled={otpVerified}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="ghost-btn"
              onClick={handleSendOtp}
              disabled={otpSending || otpCooldown > 0 || otpVerified}
              style={{ flex: "0 0 auto", width: "auto", whiteSpace: "nowrap" }}
            >
              {otpVerified ? "인증완료" : otpCooldown > 0 ? `재전송(${otpCooldown}초)` : otpSending ? "전송 중..." : otpSent ? "재전송" : "인증번호 받기"}
            </button>
          </div>
          {otpSent && !otpVerified && (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input
                className="input-field"
                type="text"
                inputMode="numeric"
                placeholder="인증번호 6자리"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleVerifyOtp()}
                style={{ flex: 1 }}
              />
              <button type="button" className="ghost-btn" onClick={handleVerifyOtp} disabled={otpVerifying} style={{ flex: "0 0 auto", width: "auto", whiteSpace: "nowrap" }}>
                {otpVerifying ? "확인 중..." : "인증하기"}
              </button>
            </div>
          )}
          {otpDevCode && (
            <div className="perm-guide" data-testid="otp-dev-code" style={{ marginTop: 8 }}>테스트 인증번호: {otpDevCode}</div>
          )}
          {otpMessage && <div className={`auth-msg ${otpMessage.type}`} style={{ marginTop: 8 }}>{otpMessage.text}</div>}
          <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>주소 (선택)</div>
          <AddressField
            base={addressBase}
            detail={addressDetail}
            onChangeBase={setAddressBase}
            onChangeDetail={setAddressDetail}
            disabled={saving}
          />
          {gateError && <div className="auth-msg error" style={{ marginTop: 10 }}>{gateError}</div>}
          <button className="primary-btn" style={{ marginTop: 14 }} onClick={handleCompletePhone} disabled={saving || !otpVerified}>
            {saving ? "저장 중..." : "완료"}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
