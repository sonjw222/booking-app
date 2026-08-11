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
*/

import { useEffect } from "react";
import { supabase } from "../../lib/supabaseClient";
import { ensureAccountForCurrentUser } from "../../lib/authAccount";

export default function SessionWatcher() {
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "INITIAL_SESSION") {
        void ensureAccountForCurrentUser();
        return;
      }
      if (event !== "SIGNED_OUT") return;
      if (window.location.pathname.startsWith("/login")) return;
      if (window.location.pathname.startsWith("/reset-password")) return;
      window.location.href = "/login?expired=1";
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return null;
}
