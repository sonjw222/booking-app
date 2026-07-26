"use client";

/*
  로그인 / 회원가입 화면 (Supabase Auth 연동)
  - 회원가입 시 회원(member) / 매니저(manager) 역할 선택
  - 매니저 선택 시 센터 정보 입력란 표시 (필드는 나중에 손장욱님이 업데이트 예정)
  - 가입 성공 시:
      · 공통: accounts 행 생성
      · 회원: 본인 profiles 행 생성 (is_primary=true)
      · 매니저: is_manager=true + centers 행 + manager_centers 행 생성
  - 소셜 로그인: 카카오 / 네이버 / 애플
*/

import { useState } from "react";
import { supabase } from "../../lib/supabaseClient";
import { uploadBusinessLicense } from "../../lib/storage";

type Mode = "login" | "signup";
type SignupRole = "member" | "manager";

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [role, setRole] = useState<SignupRole>("member");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState(""); // 회원·매니저 공통 필수

  // 매니저 가입용 센터 정보
  const [centerName, setCenterName] = useState("");
  const [centerAddress, setCenterAddress] = useState("");
  const [centerPhone, setCenterPhone] = useState("");
  const [businessNumber, setBusinessNumber] = useState(""); // 사업자등록번호 (필수)
  const [licenseFileName, setLicenseFileName] = useState(""); // 사업자등록증 파일명 (필수)
  const [licenseFile, setLicenseFile] = useState<File | null>(null); // 실제 파일

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "ok"; text: string } | null>(null);

  async function handleLogin() {
    setLoading(true);
    setMessage(null);
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
      if (!centerName.trim()) {
        setMessage({ type: "error", text: "센터 이름을 입력해주세요" });
        return;
      }
      if (!centerAddress.trim()) {
        setMessage({ type: "error", text: "센터 주소를 입력해주세요" });
        return;
      }
      if (!centerPhone.trim()) {
        setMessage({ type: "error", text: "센터 대표번호를 입력해주세요" });
        return;
      }
      if (!businessNumber.trim()) {
        setMessage({ type: "error", text: "사업자등록번호를 입력해주세요" });
        return;
      }
      if (!licenseFileName.trim()) {
        setMessage({ type: "error", text: "사업자등록증을 첨부해주세요" });
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

      // 3) 매니저면 센터 + manager_centers 생성
      if (role === "manager") {
        // TODO: 실제 파일 업로드는 Supabase Storage에 올린 뒤 그 경로를 저장해야 함.
        //       지금은 파일명만 기록 (업로드 로직은 Storage 연동 시 추가)
        //
        // 중요: insert 뒤에 .select() 를 붙이면 "쓰기 후 읽기"라 SELECT 정책도 통과해야 합니다.
        //   그런데 갓 만든 센터는 status='pending' 이고 manager_centers 연결도 아직 없어서
        //   조회 정책에 걸려 막힙니다(= RLS 위반). 그래서 id를 미리 만들어 보내고
        //   .select() 없이 insert만 합니다.
        const newCenterId = crypto.randomUUID();

        // 사업자등록증 파일을 Storage에 업로드 → 경로 확보
        let licensePath = licenseFileName;
        if (licenseFile) {
          licensePath = await uploadBusinessLicense(licenseFile);
        }

        const { error: centerErr } = await supabase.from("centers").insert({
          id: newCenterId,
          name: centerName,
          address: centerAddress,
          phone: centerPhone,
          business_number: businessNumber,
          business_license_url: licensePath, // Storage 파일 경로
          // status는 기본값 'pending' → 운영자 승인 후 'approved'가 되어야 회원에게 노출됨
        });

        if (centerErr) {
          setLoading(false);
          setMessage({ type: "error", text: "센터 생성 중 문제가 발생했어요: " + centerErr.message });
          return;
        }

        // 센터-매니저 연결을 먼저 만든다.
        // (이 행이 있어야 위 조회 정책의 "내 센터" 조건이 충족되어 이후 조회가 가능해짐)
        const { error: mcErr } = await supabase.from("manager_centers").insert({
          account_id: account.id,
          center_id: newCenterId,
          // 센터를 직접 만든 사람이므로 바로 active
          // (다른 스태프가 나중에 합류할 때는 pending → 오너가 승인)
          status: "active",
        });

        if (mcErr) {
          setLoading(false);
          setMessage({ type: "error", text: "매니저 연결 중 문제가 발생했어요: " + mcErr.message });
          return;
        }

        // 이제 내 센터로 인식되므로 조회 가능.
        // 센터 생성 시 트리거가 만든 기본 역할 중 '스튜디오 오너'를 찾아 연결한다.
        const { data: ownerRole } = await supabase
          .from("center_roles")
          .select("id")
          .eq("center_id", newCenterId)
          .eq("role_key", "owner")
          .single();

        if (ownerRole) {
          await supabase
            .from("manager_centers")
            .update({ role_id: ownerRole.id })
            .eq("account_id", account.id)
            .eq("center_id", newCenterId);
        }
      }
    }

    setLoading(false);
    setMessage({
      type: "ok",
      text: "가입 완료! 확인 메일이 발송됐어요. 메일 인증 후 로그인해주세요",
    });
    setMode("login");
  }

  async function handleSocial(provider: "kakao" | "apple" | string) {
    setMessage(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as any,
      options: { redirectTo: `${window.location.origin}/` },
    });
    if (error) {
      const label = provider === "kakao" ? "카카오" : provider === "apple" ? "애플" : "네이버";
      setMessage({ type: "error", text: `${label} 로그인 설정이 아직 안 되어 있어요 (AUTH_SETUP.md 참고)` });
    }
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
              <div className="role-name">회원</div>
              <div className="role-desc">수업 예약·수강</div>
            </button>
            <button className={`role-btn ${role === "manager" ? "on" : ""}`} onClick={() => setRole("manager")}>
              <div className="role-emoji">🏢</div>
              <div className="role-name">매니저</div>
              <div className="role-desc">센터 운영·관리</div>
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

        {/* 매니저 가입 시 센터 정보 */}
        {mode === "signup" && role === "manager" && (
          <div className="center-fields">
            <div className="center-fields-label">센터 정보</div>
            <input className="input-field" placeholder="센터 이름" value={centerName} onChange={(e) => setCenterName(e.target.value)} />
            <input className="input-field" placeholder="센터 주소" value={centerAddress} onChange={(e) => setCenterAddress(e.target.value)} />
            <input className="input-field" placeholder="센터 대표번호" value={centerPhone} onChange={(e) => setCenterPhone(e.target.value)} />
            <input className="input-field" placeholder="사업자등록번호" value={businessNumber} onChange={(e) => setBusinessNumber(e.target.value)} />
            <label className="file-field">
              <span className="file-label">
                {licenseFileName ? `📎 ${licenseFileName}` : "사업자등록증 첨부"}
              </span>
              <input
                type="file"
                accept="image/*,.pdf"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setLicenseFile(f);
                  setLicenseFileName(f?.name ?? "");
                }}
              />
            </label>
            <div className="center-fields-note">※ 센터 정보는 모두 필수입니다. 등급 체계는 추후 안내 예정</div>
          </div>
        )}

        {message && <div className={`auth-msg ${message.type}`}>{message.text}</div>}

        <button className="primary-btn login-submit" onClick={submit} disabled={loading}>
          {loading ? "처리 중..." : mode === "login" ? "로그인" : role === "manager" ? "매니저로 가입하기" : "회원으로 가입하기"}
        </button>

        <div className="divider-line">
          <div className="line" /><span>또는</span><div className="line" />
        </div>

        <div className="social-list">
          <button className="social-btn kakao" onClick={() => handleSocial("kakao")}>
            <span className="social-ic" style={{ background: "#3C1E1E", color: "#FEE500" }}>K</span>
            카카오로 시작하기
          </button>
          <button className="social-btn naver" onClick={() => handleSocial("naver")}>
            <span className="social-ic">N</span>
            네이버로 시작하기
          </button>
          <button className="social-btn apple" onClick={() => handleSocial("apple")}>
            <span className="social-ic"></span>
            Apple로 계속하기
          </button>
        </div>
      </div>
    </div>
  );
}
