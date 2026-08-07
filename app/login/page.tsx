"use client";

/*
  로그인 / 회원가입 화면 (Supabase Auth 연동)
  - 회원가입 시 일반(member) / 센터 운영자(manager) 가입 유형 선택 — 내부 role 값은
    그대로지만 화면 표시는 UI-003 정책에 따라 "일반"/"센터 운영자"로 바꿨다.
    (ACL-005: 이 선택은 최초 온보딩 분기일 뿐, 이후 관리자 모드 진입 자격과는 무관하다 —
     진입 자격은 오직 active manager_centers 소속 여부로만 판단한다.)
  - 센터 운영자 선택 시 센터 정보 입력란 표시(app/components/CenterRegistrationForm.tsx,
    마이페이지 "내 센터 등록하기"와 공용)
  - 가입 성공 시:
      · 공통: accounts 행 생성
      · 일반: 본인 profiles 행 생성 (is_primary=true)
      · 센터 운영자: centers 행 + manager_centers(owner) 행 생성(lib/centers.ts 공용 로직)
  - 소셜 로그인: 카카오 / 네이버 / 애플
*/

import { useEffect, useState } from "react";
import { supabase, REMEMBER_ME_KEY } from "../../lib/supabaseClient";
import CenterRegistrationForm, { type CenterFieldsValue } from "../components/CenterRegistrationForm";
import { validateCenterRegistrationInput, registerCenterForAccount } from "../../lib/centers";

type Mode = "login" | "signup";
// 내부 키는 그대로 유지(회원=member/센터 운영자=manager) — UI-003은 화면 표시 문구만 바꾼다.
type SignupRole = "member" | "manager";

const EMPTY_CENTER_FIELDS: CenterFieldsValue = { name: "", address: "", phone: "", businessNumber: "", licenseFileName: "" };

// 실제로는 이메일 인증(Confirm email)을 쓰지 않는데도 "확인 메일이 발송됐어요"라고 안내하던
// 문제(섹션 1) — signUp 직후 세션이 바로 확보되는 것 자체가 이 프로젝트에서 이메일 인증이
// 꺼져 있다는 증거이므로, 발송 여부를 거짓으로 안내하지 않는 문구로 고정한다.
export const SIGNUP_SUCCESS_MESSAGE = "회원가입이 완료되었습니다. 로그인해주세요.";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [role, setRole] = useState<SignupRole>("member");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(""); // 일반·센터 운영자 공통 필수

  // 센터 운영자 가입용 센터 정보 — app/mypage/register-center/page.tsx와 완전히 같은
  // 필드 타입/입력 컴포넌트(CenterRegistrationForm)·저장 로직(lib/centers.ts)을 공유한다.
  const [centerFields, setCenterFields] = useState<CenterFieldsValue>(EMPTY_CENTER_FIELDS);
  const [licenseFile, setLicenseFile] = useState<File | null>(null); // 실제 파일

  const [loading, setLoading] = useState(false);
  // 소셜 버튼 각각의 리다이렉트 진행 상태 — 성공하면 곧바로 provider 페이지로 페이지 전체가
  // 이동하므로 별도로 false로 되돌릴 필요는 없다(에러일 때만 되돌림).
  const [socialLoading, setSocialLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);
  // "로그인 상태 유지"(remember me, P1) — 기본 체크(기존과 동일하게 localStorage에 세션 저장).
  // 해제하면 이 브라우저 탭/창을 닫을 때 세션도 같이 사라진다(sessionStorage로 저장, P1).
  const [rememberMe, setRememberMe] = useState(true);

  // 세션 만료로 SessionWatcher(app/components/SessionWatcher.tsx)가 이 화면으로 보낸
  // 경우 안내 문구를 보여준다 — useSearchParams 대신 window.location으로 직접 읽어
  // Suspense 경계 없이도(이 파일의 다른 navigation과 동일한 방식) 동작하게 한다.
  // oauth_error는 app/page.tsx가 소셜 로그인 콜백 URL(#error=...)을 감지해 이 화면으로
  // 되돌려보낼 때 실어 보내는 값 — provider 거부/사용자 취소 등 실제 콜백 실패를 안내한다.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("expired") === "1") {
      setMessage({ type: "error", text: "세션이 만료됐어요. 다시 로그인해주세요." });
    } else if (params.get("oauth_error")) {
      setMessage({ type: "error", text: `소셜 로그인에 실패했어요: ${params.get("oauth_error")}` });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleLogin() {
    setLoading(true);
    setMessage(null);
    localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? "1" : "0");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      const msg = error.message.includes("Invalid login credentials")
        ? "이메일 또는 비밀번호가 올바르지 않아요"
        : error.message.includes("Email not confirmed")
        ? "이메일 인증이 아직 완료되지 않았어요. 메일함을 확인해주세요"
        : error.message;
      setMessage({ type: "error", text: msg });
      return;
    }
    window.location.href = "/";
  }

  async function handleSignup() {
    if (!name.trim()) {
      setMessage({ type: "error", text: "이름을 입력해주세요" });
      return;
    }
    if (!phone.trim()) {
      setMessage({ type: "error", text: "휴대폰 번호를 입력해주세요" });
      return;
    }
    if (role === "manager") {
      const centerValidationError = validateCenterRegistrationInput({ ...centerFields, licenseFile });
      if (centerValidationError) {
        setMessage({ type: "error", text: centerValidationError });
        return;
      }
    }
    setLoading(true);
    setMessage(null);

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) {
      setLoading(false);
      const msg = error.message.includes("already registered")
        ? "이미 가입된 이메일이에요"
        : error.message.includes("Password should be")
        ? "비밀번호는 6자 이상이어야 해요"
        : error.message;
      setMessage({ type: "error", text: msg });
      return;
    }

    if (data.user) {
      // 세션 확인: signUp 직후 세션이 없으면 이후 insert가 anon 권한으로 나가서
      // RLS에 막힙니다. (Supabase의 "Confirm email"이 켜져 있으면 세션이 안 생김)
      let session = data.session;
      if (!session) {
        // 이메일 인증이 꺼져 있는 경우 바로 로그인해서 세션 확보
        const { data: signInData, error: signInErr } =
          await supabase.auth.signInWithPassword({ email, password });
        session = signInData?.session ?? null;
        if (signInErr || !session) {
          setLoading(false);
          setMessage({
            type: "error",
            text: "가입은 됐지만 자동 로그인이 안 됐어요. Supabase에서 Authentication → Providers → Email → 'Confirm email'을 꺼주세요.",
          });
          return;
        }
      }

      // 1) accounts 행 생성 (회원+매니저 여부 표시)
      const { data: account, error: accErr } = await supabase
        .from("accounts")
        .insert({
          auth_id: data.user.id,
          name,
          phone,
          is_member: true, // 매니저도 기본적으로 회원 역할은 가짐
          is_manager: role === "manager",
        })
        .select("id")
        .single();

      if (accErr || !account) {
        setLoading(false);
        setMessage({ type: "error", text: "계정 생성 중 문제가 발생했어요: " + (accErr?.message ?? "") });
        return;
      }

      // 2) 본인 대표 프로필 생성 (회원 역할)
      await supabase.from("profiles").insert({
        account_id: account.id,
        name,
        is_primary: true,
      });

      // 3) 센터 운영자면 센터 + manager_centers 생성 — app/mypage/register-center/page.tsx와
      //    완전히 같은 저장 로직(lib/centers.ts)을 재사용한다(로직 복제 금지, UI-003/ACL-005).
      if (role === "manager") {
        try {
          await registerCenterForAccount(account.id, { ...centerFields, licenseFile });
        } catch (e: any) {
          setLoading(false);
          setMessage({ type: "error", text: e.message });
          return;
        }
      }

      // 위 단계까지 오면 session이 이미 확보돼 있다(= 이메일 인증이 꺼져 있어 확인 메일 자체가
      // 발송되지 않는 상태) — accounts/profiles/centers insert에만 필요했던 세션이므로, 로그인
      // 화면으로 돌아가려면 로그아웃해서 실제로 "로그인이 필요한" 상태로 되돌려야 한다.
      await supabase.auth.signOut();
    }

    setLoading(false);
    setMessage({ type: "ok", text: SIGNUP_SUCCESS_MESSAGE });
    setMode("login");
  }

  async function handleSocial(provider: "kakao" | "apple" | "google" | string) {
    if (socialLoading) return; // 중복 클릭/중복 콜백 실행 방지
    setMessage(null);
    setSocialLoading(provider);
    // 소셜 로그인도 "로그인 상태 유지" 설정을 그대로 따른다 — 이 탭에서 리다이렉트로
    // 나갔다가 돌아오므로, 세션이 실제로 만들어지기 전에 미리 저장해둬야 한다.
    localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? "1" : "0");
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as any,
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) {
      setSocialLoading(null);
      const label = provider === "kakao" ? "카카오" : provider === "apple" ? "애플" : provider === "google" ? "구글" : "네이버";
      setMessage({ type: "error", text: `${label} 로그인 설정이 아직 안 되어 있어요 (AUTH_SETUP.md 참고)` });
    }
    // 에러가 없으면 이 시점부터 브라우저가 provider 페이지로 이동하므로 loading을 되돌리지 않는다.
  }

  function submit() {
    if (loading) return;
    if (!email.trim() || !password.trim()) {
      setMessage({ type: "error", text: "이메일과 비밀번호를 입력해주세요" });
      return;
    }
    if (mode === "login") handleLogin();
    else handleSignup();
  }

  return (
    <div className="app-shell">
      <div className="login-wrap">
        <div className="login-logo">🩰</div>
        <div className="login-title">우리동네 클래스</div>
        <div className="login-sub">발레·필라테스·피겨스케이팅까지, 한 앱으로 예약</div>

        <div className="mode-tabs">
          <button className={`mode-tab ${mode === "login" ? "on" : ""}`} onClick={() => { setMode("login"); setMessage(null); }}>
            로그인
          </button>
          <button className={`mode-tab ${mode === "signup" ? "on" : ""}`} onClick={() => { setMode("signup"); setMessage(null); }}>
            회원가입
          </button>
        </div>

        {/* 회원가입일 때만 역할 선택 */}
        {mode === "signup" && (
          <div className="role-select">
            <button className={`role-btn ${role === "member" ? "on" : ""}`} onClick={() => setRole("member")}>
              <div className="role-emoji">🧘‍♀️</div>
              <div className="role-name">일반</div>
              <div className="role-desc">센터 검색, 예약, 수강권 이용 등 일반 회원 기능을 사용합니다.</div>
            </button>
            <button className={`role-btn ${role === "manager" ? "on" : ""}`} onClick={() => setRole("manager")}>
              <div className="role-emoji">🏢</div>
              <div className="role-name">센터 운영자</div>
              <div className="role-desc">센터 정보를 등록하고 승인 후 운영 기능을 사용합니다.</div>
            </button>
          </div>
        )}

        {mode === "signup" && (
          <input className="input-field" placeholder={role === "manager" ? "대표자 이름" : "이름"} value={name} onChange={(e) => setName(e.target.value)} />
        )}
        {mode === "signup" && (
          <input className="input-field" type="tel" placeholder={role === "manager" ? "대표자 휴대폰 번호" : "휴대폰 번호"} value={phone} onChange={(e) => setPhone(e.target.value)} />
        )}
        <input className="input-field" type="email" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          className="input-field"
          type="password"
          placeholder="비밀번호 (6자 이상)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />

        {mode === "login" && (
          <div className="login-row-options">
            <label className="remember-me">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              로그인 상태 유지
            </label>
            <a className="forgot-pw-link" href="/reset-password">비밀번호를 잊으셨나요?</a>
          </div>
        )}

        {/* 센터 운영자 가입 시 센터 정보 — app/mypage/register-center/page.tsx와 같은 컴포넌트 재사용 */}
        {mode === "signup" && role === "manager" && (
          <CenterRegistrationForm
            value={centerFields}
            onChange={(patch) => setCenterFields((f) => ({ ...f, ...patch }))}
            onFileSelect={setLicenseFile}
            disabled={loading}
          />
        )}

        {message && <div className={`auth-msg ${message.type}`}>{message.text}</div>}

        <button className="primary-btn login-submit" onClick={submit} disabled={loading}>
          {loading ? "처리 중..." : mode === "login" ? "로그인" : role === "manager" ? "센터 운영자로 가입하기" : "일반으로 가입하기"}
        </button>

        <div className="divider-line">
          <div className="line" /><span>또는</span><div className="line" />
        </div>

        <div className="social-list">
          <button className="social-btn google" onClick={() => handleSocial("google")} disabled={!!socialLoading}>
            <span className="social-ic" style={{ background: "#fff", color: "#4285F4", border: "1px solid var(--line)" }}>G</span>
            {socialLoading === "google" ? "이동 중..." : "Google로 계속하기"}
          </button>
          <button className="social-btn kakao" onClick={() => handleSocial("kakao")} disabled={!!socialLoading}>
            <span className="social-ic" style={{ background: "#3C1E1E", color: "#FEE500" }}>K</span>
            {socialLoading === "kakao" ? "이동 중..." : "카카오로 시작하기"}
          </button>
          <button className="social-btn naver" onClick={() => handleSocial("naver")} disabled={!!socialLoading}>
            <span className="social-ic">N</span>
            {socialLoading === "naver" ? "이동 중..." : "네이버로 시작하기"}
          </button>
          <button className="social-btn apple" onClick={() => handleSocial("apple")} disabled={!!socialLoading}>
            <span className="social-ic"></span>
            {socialLoading === "apple" ? "이동 중..." : "Apple로 계속하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
