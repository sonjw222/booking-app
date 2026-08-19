"use client";

/*
  네이버 로그인 콜백 화면.

  네이버는 Supabase Auth의 기본 제공 provider가 아니라(AUTH_SETUP.md 3-3절) app/login/page.tsx의
  handleSocial("naver")가 signInWithOAuth 대신 네이버 authorize URL로 직접 리다이렉트한다.
  네이버가 그 결과(?code=...&state=...)를 이 화면으로 돌려보내면:
    1) state를 sessionStorage에 저장해둔 값과 대조해 CSRF를 막고
    2) supabase/functions/naver-login Edge Function에 code를 넘겨 (client_secret이 필요한
       토큰 교환은 그 함수 안, 서버 쪽에서만 이뤄진다) email + token_hash를 받은 뒤
    3) supabase.auth.verifyOtp()로 실제 로그인 세션을 확보한다.
  세션이 확보되면 이후 계정/프로필 부트스트랩(ensureAccountForCurrentUser)은 다른 소셜
  로그인과 동일하게 app/components/SessionWatcher.tsx의 SIGNED_IN 리스너가 처리한다.
*/

import { useEffect, useState } from "react";
import { supabase } from "../../../lib/supabaseClient";
import { NAVER_OAUTH_STATE_KEY } from "../../../lib/naverAuth";
import { edgeFunctionErrorMessage } from "../../../lib/edgeFunctions";
import Loading from "../../components/Loading";

export default function NaverCallbackPage() {
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
      const savedState = sessionStorage.getItem(NAVER_OAUTH_STATE_KEY);
      sessionStorage.removeItem(NAVER_OAUTH_STATE_KEY);

      if (!code || !state || !savedState || state !== savedState) {
        fail("로그인 요청이 만료됐거나 올바르지 않아요. 다시 시도해주세요.");
        return;
      }

      const { data, error } = await supabase.functions.invoke<{ email: string; tokenHash: string }>(
        "naver-login",
        { body: { code, redirectUri: `${window.location.origin}/login/naver-callback` } }
      );
      if (error || !data) {
        fail(await edgeFunctionErrorMessage(error, "네이버 로그인 처리에 실패했어요"));
        return;
      }

      // token_hash로 검증할 땐 email을 같이 보내면 안 된다(Supabase Auth API가 "Only the
      // token_hash and type should be provided"로 거부함 — email은 6자리 token과 짝지어
      // 쓰는 다른 조합 전용). data.email은 이제 안 쓰지만, Edge Function이 디버깅용으로
      // 계속 돌려주는 값이라 타입에는 남겨둔다.
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

  return <Loading text={errorText ?? "네이버 로그인 처리 중이에요"} />;
}
