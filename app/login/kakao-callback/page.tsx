"use client";

/*
  카카오 로그인 콜백 화면. app/login/naver-callback/page.tsx와 완전히 같은 패턴 —
  Supabase 기본 제공 Kakao provider가 account_email 스코프를 강제해서 이 프로젝트(이메일
  항목 미승인)에서는 못 쓰기 때문에(AUTH_SETUP.md 3-1절) handleSocial("kakao")가
  signInWithOAuth 대신 카카오 authorize URL로 직접 리다이렉트한다.
*/

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { KAKAO_OAUTH_STATE_KEY } from "../../../lib/kakaoAuth";
import { edgeFunctionErrorMessage } from "../../../lib/edgeFunctions";
import Loading from "../../components/Loading";

export default function KakaoCallbackPage() {
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const providerError = params.get("error_description") || params.get("error");
      if (providerError) {
        fail(providerError);
        return;
      }

      const code = params.get("code");
      const state = params.get("state");
      const savedState = sessionStorage.getItem(KAKAO_OAUTH_STATE_KEY);
      sessionStorage.removeItem(KAKAO_OAUTH_STATE_KEY);

      if (!code || !state || !savedState || state !== savedState) {
        fail("로그인 요청이 만료됐거나 올바르지 않아요. 다시 시도해주세요.");
        return;
      }

      const { data, error } = await supabase.functions.invoke<{ email: string; tokenHash: string }>(
        "kakao-login",
        { body: { code, redirectUri: `${window.location.origin}/login/kakao-callback` } }
      );
      if (error || !data) {
        fail(await edgeFunctionErrorMessage(error, "카카오 로그인 처리에 실패했어요"));
        return;
      }

      const { error: verifyErr } = await supabase.auth.verifyOtp({
        token_hash: data.tokenHash,
        type: "email",
      });
      if (verifyErr) {
        fail(verifyErr.message);
        return;
      }

      window.location.href = "/";
    })();

    function fail(reason: string) {
      setErrorText(reason);
      window.setTimeout(() => {
        window.location.href = `/login?oauth_error=${encodeURIComponent(reason)}`;
      }, 1200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <Loading text={errorText ?? "카카오 로그인 처리 중이에요"} />;
}
