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
import UiIcon from "../components/UiIcon";
import CenterRegistrationForm, { type CenterFieldsValue } from "../components/CenterRegistrationForm";
import AddressField from "../components/AddressField";
import { validateCenterRegistrationInput, registerCenterForAccount } from "../../lib/centers";
import { setBootstrapSuppressed } from "../../lib/authAccount";
import { startNaverLogin } from "../../lib/naverAuth";
import { startKakaoLogin } from "../../lib/kakaoAuth";
import { stashPostLoginNext } from "../../lib/postLoginReturn";

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
  // 도로명주소(선택) — 다음 우편번호 팝업으로 채우는 base + 직접 입력하는 상세주소, 합쳐서 accounts.address에 저장
  const [addressBase, setAddressBase] = useState("");
  const [addressDetail, setAddressDetail] = useState("");

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
    } else if (params.get("withdrawn") === "1") {
      setMessage({ type: "ok", text: "탈퇴가 완료됐어요. 그동안 이용해주셔서 감사합니다." });
    } else if (params.get("oauth_error")) {
      setMessage({ type: "error", text: `소셜 로그인에 실패했어요: ${params.get("oauth_error")}` });
    }
    // 로그인이 필요해 여기로 온 경우("?next=/checkout?..." 등) — 로그인 성공 후 어느
    // 경로(이메일/구글/애플/카카오/네이버)로 완료되든 전부 홈에 도착하므로, 그 값을
    // 세션스토리지에 담아두고 실제 이동은 app/page.tsx가 한 곳에서 처리한다.
    stashPostLoginNext(params.get("next"));
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

    // signUp()도 SIGNED_IN 이벤트를 내보내는데, 앱 전체에 마운트된 SessionWatcher가 이걸 듣고
    // ensureAccountForCurrentUser()를 같이 호출하면 이 함수가 아래에서 만드는 accounts 행과
    // 경합해 auth_id unique 제약 위반으로 가입이 실패할 수 있다(lib/authAccount.ts 참고) —
    // 이 함수가 계정 생성을 끝내고 로그아웃할 때까지 그 전역 부트스트랩을 꺼둔다.
    setBootstrapSuppressed(true);
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { name } },
      });
      if (error) {
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
            setMessage({
              type: "error",
              text: "가입은 됐지만 자동 로그인이 안 됐어요. Supabase에서 Authentication → Providers → Email → 'Confirm email'을 꺼주세요.",
            });
            return;
          }
        }

        // 1) accounts 행 생성 (회원+매니저 여부 표시)
        const address = addressDetail.trim() ? `${addressBase} ${addressDetail}`.trim() : addressBase.trim();
        const { data: account, error: accErr } = await supabase
          .from("accounts")
          .insert({
            auth_id: data.user.id,
            name,
            phone,
            address: address || null,
            is_member: true, // 매니저도 기본적으로 회원 역할은 가짐
            is_manager: role === "manager",
          })
          .select("id")
          .single();

        if (accErr || !account) {
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
            await registerCenterForAccount({ ...centerFields, licenseFile });
          } catch (e: any) {
            setMessage({ type: "error", text: e.message });
            return;
          }
        }

        // 위 단계까지 오면 session이 이미 확보돼 있다(= 이메일 인증이 꺼져 있어 확인 메일 자체가
        // 발송되지 않는 상태) — accounts/profiles/centers insert에만 필요했던 세션이므로, 로그인
        // 화면으로 돌아가려면 로그아웃해서 실제로 "로그인이 필요한" 상태로 되돌려야 한다.
        await supabase.auth.signOut();
      }

      setMessage({ type: "ok", text: SIGNUP_SUCCESS_MESSAGE });
      setMode("login");
    } finally {
      setBootstrapSuppressed(false);
      setLoading(false);
    }
  }

  async function handleSocial(provider: "kakao" | "apple" | "google" | "naver" | string) {
    if (socialLoading) return; // 중복 클릭/중복 콜백 실행 방지
    setMessage(null);
    setSocialLoading(provider);
    // 소셜 로그인도 "로그인 상태 유지" 설정을 그대로 따른다 — 이 탭에서 리다이렉트로
    // 나갔다가 돌아오므로, 세션이 실제로 만들어지기 전에 미리 저장해둬야 한다.
    localStorage.setItem(REMEMBER_ME_KEY, rememberMe ? "1" : "0");

    // 네이버는 Supabase의 기본 제공 OAuth provider가 아니라 signInWithOAuth를 못 쓴다 —
    // 커스텀 authorize URL + Edge Function 흐름을 대신 쓴다(lib/naverAuth.ts,
    // app/login/naver-callback/page.tsx, AUTH_SETUP.md 3-3절).
    if (provider === "naver") {
      const clientId = process.env.NEXT_PUBLIC_NAVER_CLIENT_ID;
      if (!clientId) {
        setSocialLoading(null);
        setMessage({ type: "error", text: "네이버 로그인 설정이 아직 안 되어 있어요 (AUTH_SETUP.md 참고)" });
        return;
      }
      startNaverLogin(clientId);
      return;
    }

    // 카카오도 같은 이유로 signInWithOAuth를 못 쓴다 — Supabase 기본 제공 Kakao provider는
    // 서버 쪽에서 account_email 스코프를 무조건 같이 요청하는데, 이 프로젝트의 카카오
    // 앱은 이메일 항목이 "권한없음"(사업자 인증 필요) 상태라 "Invalid scope:
    // account_email"로 거부된다(AUTH_SETUP.md 3-1절). 네이버와 동일한 커스텀 흐름으로
    // 우회한다(lib/kakaoAuth.ts, app/login/kakao-callback/page.tsx).
    if (provider === "kakao") {
      const clientId = process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID;
      if (!clientId) {
        setSocialLoading(null);
        setMessage({ type: "error", text: "카카오 로그인 설정이 아직 안 되어 있어요 (AUTH_SETUP.md 참고)" });
        return;
      }
      startKakaoLogin(clientId);
      return;
    }

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
    <div className="app-shell auth-page-v2">
      <div className="auth-scene">
        <a className="auth-home-link" href="/">우리동네 클래스</a>
        <div className="auth-scene-copy">
          <span>MOVE · BOOK · ENJOY</span>
          <h1>오늘의 움직임을<br />가볍게 시작하세요.</h1>
          <p>필라테스부터 피겨스케이팅까지<br />내 주변 수업을 한곳에서 만나보세요.</p>
        </div>
        <div className="auth-activities" aria-hidden="true">
          <div><UiIcon name="pilates" size={25} /><span>필라테스</span></div>
          <div><UiIcon name="skate" size={25} /><span>피겨</span></div>
          <div><UiIcon name="swim" size={25} /><span>수영</span></div>
          <div><UiIcon name="golf" size={25} /><span>골프</span></div>
        </div>
      </div>

      <section className={`auth-panel ${mode}`}>

        <div className="mode-tabs">
          <button className={`mode-tab ${mode === "login" ? "on" : ""}`} onClick={() => { setMode("login"); setMessage(null); }}>
            로그인
          </button>
          <button className={`mode-tab ${mode === "signup" ? "on" : ""}`} onClick={() => { setMode("signup"); setMessage(null); }}>
            회원가입
          </button>
        </div>

        <div className="auth-panel-heading">
          <h2>{mode === "login" ? "다시 만나서 반가워요" : "계정을 만들어볼까요?"}</h2>
          <p>{mode === "login" ? "가입한 이메일로 로그인하세요." : "예약에 필요한 기본 정보만 입력해주세요."}</p>
        </div>

        {/* 회원가입일 때만 역할 선택 */}
        {mode === "signup" && (
          <div className="role-select">
            <button className={`role-btn ${role === "member" ? "on" : ""}`} onClick={() => setRole("member")}>
              <div className="role-emoji"><UiIcon name="user" size={25} /></div>
              <div className="role-name">일반 회원</div>
              <div className="role-desc">수업 검색과 예약</div>
            </button>
            <button className={`role-btn ${role === "manager" ? "on" : ""}`} onClick={() => setRole("manager")}>
              <div className="role-emoji"><UiIcon name="building" size={25} /></div>
              <div className="role-name">센터 운영자</div>
              <div className="role-desc">센터 등록과 운영</div>
            </button>
          </div>
        )}

        {mode === "signup" && (
          <input className="input-field" placeholder={role === "manager" ? "대표자 이름" : "이름"} value={name} onChange={(e) => setName(e.target.value)} />
        )}
        {mode === "signup" && (
          <input className="input-field" type="tel" placeholder={role === "manager" ? "대표자 휴대폰 번호" : "휴대폰 번호"} value={phone} onChange={(e) => setPhone(e.target.value)} />
        )}
        {mode === "signup" && (
          <AddressField
            base={addressBase}
            detail={addressDetail}
            onChangeBase={setAddressBase}
            onChangeDetail={setAddressDetail}
            disabled={loading}
          />
        )}
        <div className="menu-section-label" style={{ padding: "12px 0 6px" }}>
          {mode === "signup" ? "이메일로 가입하기" : "이메일로 로그인"}
        </div>
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

        <div className="menu-section-label" style={{ padding: "0 0 6px" }}>
          {mode === "signup" ? "소셜 계정으로 간편 가입" : "소셜 계정으로 로그인"}
        </div>
        {mode === "signup" && (
          <div className="perm-guide" style={{ margin: "0 0 10px" }}>
            가입 후 휴대폰 번호 확인 화면이 한 번 더 나와요.
          </div>
        )}

        {/* 원형 아이콘 버튼 행 — 라벨 텍스트는 화면에 안 보이고 스크린리더용으로만 남긴다. */}
        <div className="social-list">
          <button className="social-btn google" onClick={() => handleSocial("google")} disabled={!!socialLoading}>
            <span className="social-ic" aria-hidden="true">G</span>
            <span className="sr-only">{socialLoading === "google" ? "이동 중..." : mode === "signup" ? "Google로 가입하기" : "Google로 계속하기"}</span>
          </button>
          <button className="social-btn kakao" onClick={() => handleSocial("kakao")} disabled={!!socialLoading}>
            <span className="social-ic" aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4C6.5 4 2 7.4 2 11.6c0 2.7 1.9 5.1 4.7 6.4-.2.7-.8 2.7-.9 3.1 0 0-.1.3.1.4.2.1.4 0 .4 0 .6-.1 3-2 3.9-2.7.6.1 1.2.1 1.8.1 5.5 0 10-3.4 10-7.6C22 7.4 17.5 4 12 4Z"/></svg>
            </span>
            <span className="sr-only">{socialLoading === "kakao" ? "이동 중..." : mode === "signup" ? "카카오로 가입하기" : "카카오로 시작하기"}</span>
          </button>
          <button className="social-btn naver" onClick={() => handleSocial("naver")} disabled={!!socialLoading}>
            <span className="social-ic" aria-hidden="true">N</span>
            <span className="sr-only">{socialLoading === "naver" ? "이동 중..." : mode === "signup" ? "네이버로 가입하기" : "네이버로 시작하기"}</span>
          </button>
          <button className="social-btn apple" onClick={() => handleSocial("apple")} disabled={!!socialLoading}>
            <span className="social-ic" aria-hidden="true">
              {/* viewBox를 path의 실제 bbox(-0.5 1.9 22 22, getBBox()로 측정)에 맞춰
                  정사각형으로 잘라 시각 중앙에 오도록 함 — 원래 "0 0 24 24"는 심볼
                  자체가 왼쪽으로 치우쳐 있어 원 안에서 중앙정렬이 안 맞았다. */}
              <svg width="27" height="27" viewBox="-0.5 1.9 22 22" fill="currentColor"><path d="M16.7 2.3c.1 1-.3 2-.9 2.7-.6.7-1.6 1.3-2.6 1.2-.1-1 .4-2 .9-2.6.6-.8 1.7-1.3 2.6-1.3ZM20.5 17c-.6 1.3-.9 1.9-1.6 3-1 1.5-2.5 3.4-4.3 3.4-1.6 0-2-1-4.1-1s-2.6 1-4.2 1c-1.8 0-3.2-1.7-4.2-3.2C.4 17-.4 12.7 1.6 9.7c1-1.5 2.6-2.4 4.2-2.4 1.6 0 2.7 1.1 4 1.1 1.3 0 2.1-1.1 4-1.1 1.3 0 2.7.7 3.7 1.9-3.3 1.8-2.8 6.5.3 7.8Z"/></svg>
            </span>
            <span className="sr-only">{socialLoading === "apple" ? "이동 중..." : mode === "signup" ? "Apple로 가입하기" : "Apple로 계속하기"}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
