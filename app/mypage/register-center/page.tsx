"use client";

/*
  마이페이지 "내 센터 등록하기" — 로그인 화면으로 돌려보내지 않고 바로 센터 등록 폼을
  보여준다(ACL-005/UI-003). 회원가입의 "센터 운영자" 흐름과 완전히 동일한 검증/저장
  로직(lib/centers.ts의 registerCenterForAccount())과 동일한 입력 컴포넌트
  (app/components/CenterRegistrationForm.tsx)를 재사용한다.

  진입 조건: 로그인 상태만 요구 — 가입 유형(일반/센터 운영자)이나 기존 active manager
  센터 보유 여부와 무관하게 모든 로그인 사용자가 새 센터를 등록할 수 있다(정책 B).
*/

import { useState } from "react";
import { useRouter } from "next/navigation";
import CenterRegistrationForm, { type CenterFieldsValue } from "../../components/CenterRegistrationForm";
import { registerCenterForAccount } from "../../../lib/centers";
import { supabase } from "../../../lib/supabaseClient";

const EMPTY: CenterFieldsValue = { name: "", address: "", phone: "", businessNumber: "", licenseFileName: "" };

export default function RegisterCenterPage() {
  const router = useRouter();
  const [fields, setFields] = useState<CenterFieldsValue>(EMPTY);
  const [licenseFile, setLicenseFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit() {
    if (busy) return; // 중복 제출 방지
    setError(null);
    setBusy(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) throw new Error("로그인이 필요해요");
      const { data: acc, error: accErr } = await supabase
        .from("accounts").select("id").eq("auth_id", authData.user.id).single();
      if (accErr || !acc) throw new Error("계정 정보를 찾을 수 없어요: " + (accErr?.message ?? ""));

      await registerCenterForAccount(acc.id, { ...fields, licenseFile });
      setDone(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="app-shell account-page-v2 register-center-page-v2">
        <div className="holiday-notice" style={{ marginTop: 60 }}>
          <div className="holiday-chip">
            <span className="hc-dot" />
            신청이 접수됐어요. 운영자 승인 후 관리자 모드에서 이용할 수 있어요.
          </div>
        </div>
        <div style={{ padding: 20 }}>
          <a className="primary-btn" href="/mypage">마이페이지로</a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell account-page-v2 register-center-page-v2">
      <div className="section-title" style={{ paddingTop: 20 }}>내 센터 등록하기</div>
      <div className="hist-sub" style={{ padding: "0 16px 12px" }}>
        새 센터 정보를 등록하고 운영 승인을 요청합니다.
      </div>

      <div style={{ padding: "0 16px" }}>
        <CenterRegistrationForm
          value={fields}
          onChange={(patch) => setFields((f) => ({ ...f, ...patch }))}
          onFileSelect={setLicenseFile}
          disabled={busy}
        />
        {error && <div className="auth-msg error">{error}</div>}
        <button className="primary-btn login-submit" onClick={handleSubmit} disabled={busy}>
          {busy ? "처리 중..." : "등록 신청하기"}
        </button>
        <button className="ghost-btn" style={{ marginTop: 8 }} onClick={() => router.back()} disabled={busy}>
          취소
        </button>
      </div>
    </div>
  );
}
