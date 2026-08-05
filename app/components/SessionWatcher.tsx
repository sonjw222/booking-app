"use client";

/*
  세션 만료 처리 (P1) — 토큰 리프레시가 실패하면 supabase-js가 세션을 지우고
  SIGNED_OUT 이벤트를 발생시킨다(명시적 로그아웃도 같은 이벤트를 쓰지만, 그 경우는
  이미 각자 /login으로 직접 이동시키므로 여기서 한 번 더 이동해도 같은 목적지라
  문제 없음). 이 이벤트를 앱 전체에서 한 번만 구독해, 로그인 화면이 아닌 다른 곳에
  있다가 세션이 끊기면 "세션이 만료됐어요" 안내와 함께 로그인 화면으로 보낸다 —
  이전에는 이런 처리가 전혀 없어서 세션이 끊긴 뒤에도 화면은 그대로 있고 그 안의
  개별 데이터 요청들만 하나씩 알 수 없는 에러를 내는 식이었다.
  INITIAL_SESSION(최초 마운트 시, 로그인 여부와 무관하게 항상 한 번 발생)은 무시한다 —
  SIGNED_OUT만 "세션이 있다가 끊긴" 신호로 취급한다.
*/

import { useEffect } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function SessionWatcher() {
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_OUT") return;
      if (window.location.pathname.startsWith("/login")) return;
      if (window.location.pathname.startsWith("/reset-password")) return;
      window.location.href = "/login?expired=1";
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return null;
}
