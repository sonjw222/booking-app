"use client";

import { useEffect, useState } from "react";
import { kstToday } from "./servicePeriod";

/** 오늘(KST) 날짜 문자열. 화면을 열어 둔 채 KST 자정이 지나거나(타이머), 탭이 다시 보이면(visibilitychange) 갱신돼서 만료 상품 필터가 새로고침 없이 다시 계산된다. */
export function useKstToday(): string {
  const [today, setToday] = useState<string>(() => kstToday());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => setToday((prev) => { const t = kstToday(); return t === prev ? prev : t; });
    const schedule = () => {
      const now = new Date(); const kstNow = new Date(now.getTime() + 9 * 3600_000);
      const nextMidnightKst = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate() + 1) - 9 * 3600_000;
      timer = setTimeout(() => { refresh(); schedule(); }, Math.min(Math.max(nextMidnightKst - now.getTime() + 1000, 1000), 2 ** 31 - 1));
    };
    schedule();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, []);
  return today;
}
