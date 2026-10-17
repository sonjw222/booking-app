/* 목록 → 상세 → 뒤로가기에서 목록 스크롤 위치를 복원한다.
   상세로 들어가기 직전에 rememberListScroll()로 저장하고, 목록이 다시 마운트될 때 consumeListScroll()로 한 번만 꺼낸다.
   브라우저/제스처 뒤로가기(popstate)로 돌아온 경우에만 복원한다 — 같은 목록을 새로 열 때(홈 → 종목)는 항상 맨 위에서 시작. */
import { arrivedByHistoryBack } from "./appHistory";

const PREFIX = "mwhabit_list_scroll:";
const MAX_AGE_MS = 30 * 60 * 1000;

export function rememberListScroll(key: string): void {
  try { sessionStorage.setItem(PREFIX + key, JSON.stringify({ y: Math.max(0, Math.round(window.scrollY)), at: Date.now() })); } catch { /* 사생활 모드 */ }
}

export function consumeListScroll(key: string): number | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    sessionStorage.removeItem(PREFIX + key);
    if (!raw || !arrivedByHistoryBack(3000)) return null;
    const parsed = JSON.parse(raw) as { y?: unknown; at?: unknown };
    if (typeof parsed.y !== "number" || typeof parsed.at !== "number" || Date.now() - parsed.at > MAX_AGE_MS) return null;
    return parsed.y;
  } catch { return null; }
}
