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
import { clearSocialNameStash, stashSocialName } from "../../../lib/socialName";
import Loading from "../../components/Loading";

export default function KakaoCallbackPage() {
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const providerError = params.get("error_description") || params.get("error");
      if (providerError) {
        clearSocialNameStash();   // provider가 취소/거부한 경우 이전 시도의 stash가 남지 않게
        fail(providerError);
        return;
      }

      const code = params.get("code");
      const state = params.get("state");
      const savedState = sessionStorage.getItem(KAKAO_OAUTH_STATE_KEY);
      sessionStorage.removeItem(KAKAO_OAUTH_STATE_KEY);

      if (!code || !state || !savedState || state !== savedState) {
        clearSocialNameStash();   // state 누락/불일치(만료·위조) 시에도 stash 제거
        fail("로그인 요청이 만료됐거나 올바르지 않아요. 다시 시도해주세요.");
        return;
      }

      const { data, error } = await supabase.functions.invoke<{ email: string; tokenHash: string; providerName?: string | null }>(
        "kakao-login",
        { body: { code, redirectUri: `${window.location.origin}/login/kakao-callback` } }
      );
      if (error || !data) {
        clearSocialNameStash();
        fail(await edgeFunctionErrorMessage(error, "카카오 로그인 처리에 실패했어요"));
        return;
      }

      // 이번 로그인에서 조회한 provider 이름은 verifyOtp "전에" 저장한다 — verifyOtp가 SIGNED_IN을 발생시키면 SessionWatcher가 즉시 ensureAccountForCurrentUser()를 실행할 수 있어서
      // 그 뒤에 저장하면 race가 생긴다. 카카오 nickname은 실명 보장이 없어 이름 입력칸 prefill 전용(자동 저장 안 함). 이름이 없으면 이전 stash도 지운다. 이름 값은 로그에 남기지 않는다.
      stashSocialName("kakao", data.providerName, { autoSave: false });
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        token_hash: data.tokenHash,
        type: "email",
      });
      if (verifyErr) {
        clearSocialNameStash();   // 실패한 로그인이 남긴 후보가 다음 로그인에 적용되지 않게
        fail(verifyErr.message);
        return;
      }

      // 릴리스 폴리시 배치 8차(2026-09-17) — replace로: push면 /login으로 뒤로가기가 가능해짐.
      window.location.replace("/");
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
