"use client";

// PERF-013 — 회원 화면이 오래 백그라운드(앱 전환/탭 숨김)였다가 다시 보일 때만 "중요 데이터"를
// 조용히 한 번 재조회하는 훅. 모든 화면에 강제로 적용하지 않고, 예약 상태/수강권 잔액/내 예약처럼
// 오래되면 안 되는 화면에서만 명시적으로 쓴다. 관리자 쪽 ManagerNav의 visibilitychange 패턴과
// 같은 이벤트를 쓰되, 짧은 전환(알림 확인 등)에는 재조회하지 않도록 "숨겨져 있던 시간"이
// 임계값 이상일 때만 실행한다. 예약 확정/취소 같은 쓰기 동작의 정합성은 서버(RPC)가 보장하며
// 이 훅은 화면 표시용 읽기 데이터의 최신성만 높인다.
import { useEffect, useRef } from "react";

export const RESUME_REFRESH_MIN_HIDDEN_MS = 5 * 60 * 1000;

// 순수 판정 함수(단위 테스트용): 숨겨진 시각이 기록돼 있고 임계값 이상 지났을 때만 true.
export function shouldRefreshOnResume(hiddenAt: number | null, now: number, minHiddenMs: number = RESUME_REFRESH_MIN_HIDDEN_MS): boolean {
  if (hiddenAt == null) return false;
  return now - hiddenAt >= minHiddenMs;
}

export function useResumeRefresh(refresh: () => void | Promise<void>, minHiddenMs: number = RESUME_REFRESH_MIN_HIDDEN_MS) {
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    let hiddenAt: number | null = null;
    let inFlight = false;
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        if (hiddenAt == null) hiddenAt = Date.now();
        return;
      }
      const wasHiddenAt = hiddenAt;
      hiddenAt = null;
      if (!shouldRefreshOnResume(wasHiddenAt, Date.now(), minHiddenMs)) return;
      if (inFlight) return;   // 동시 중복 조회 방지
      inFlight = true;
      Promise.resolve(refreshRef.current()).catch(() => { /* 조용한 재조회 — 실패해도 기존 화면 유지 */ }).finally(() => { inFlight = false; });
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [minHiddenMs]);
}
