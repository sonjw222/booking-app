/*
  NICEPAY 결제창(심사 인증창 확인)을 열고 닫는 동안 쌓이는 history entry 를 정리하기 위한 순수 계산 + 브라우저 보조.
  문제: 결제창은 같은 탭에서 최상위 이동(gwPayment → smartPayment → … → 종료 안내)으로 열려 entry 가 여러 개 쌓인다. 종료 안내에서 `location.replace(결제경로)` 를 하면
        결제 화면이 그 entry 들 "뒤"에 놓여, 이후 ‹ 가 센터가 아니라 NICEPAY 페이지 entry 로 가고 반복할 때마다 더 쌓인다.
  해결: 결제창을 열기 직전의 결제 화면 entry 위치(anchor = 그 entry 의 history 인덱스)를 sessionStorage 에 기록하고,
        종료 안내에서 `history.go(-n)` 으로 그 entry 로 되돌아간다(n = 현재 마지막 인덱스 − anchor). 새 entry 를 만들지 않으므로 반복해도 쌓이지 않는다.
  anchor 를 정확히 알기 위해: 열기 직전에 같은 주소를 pushState 해 "앞으로 가기" 쪽 오래된 entry 를 잘라 length 를 확정(lo)한 뒤 back 으로 원래 entry 로 돌아온다.
  검증 실패(길이 한도·값 이상·시간 초과)면 호출자는 기존 방식(location.replace)으로 폴백한다 — 잘못된 n 으로 엉뚱한 곳으로 가지 않는다.
*/
export const REVIEW_HISTORY_KEY = "mwhabit.nicepayReviewHist";
export const REVIEW_HISTORY_TTL_MS = 30 * 60 * 1000;
export const REVIEW_HISTORY_MAX_STEPS = 15;   // 결제창 안에서 쌓일 수 있는 entry 상한(이보다 크면 비정상으로 보고 폴백)
const BROWSER_HISTORY_CAP = 50;               // 브라우저가 보관하는 entry 상한 — 근처면 오래된 entry 가 밀려 인덱스가 어긋나므로 쓰지 않는다

/** 종료 안내 화면에서 anchor entry 로 돌아가기 위한 뒤로 가기 횟수. 쓸 수 없으면 null(→ replace 폴백). */
export function computeReturnSteps(raw: string | null, historyLength: number, now: number): number | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { anchor?: unknown; at?: unknown };
    if (typeof v.anchor !== "number" || !Number.isInteger(v.anchor) || v.anchor < 0 || typeof v.at !== "number") return null;
    if (now - v.at < 0 || now - v.at > REVIEW_HISTORY_TTL_MS) return null;
    if (!Number.isInteger(historyLength) || historyLength >= BROWSER_HISTORY_CAP) return null;
    const n = historyLength - 1 - v.anchor;
    return n >= 1 && n <= REVIEW_HISTORY_MAX_STEPS ? n : null;
  } catch { return null; }
}

type HistoryWin = Pick<Window, "history" | "location" | "addEventListener" | "removeEventListener"> & { sessionStorage: Storage };

/** 결제창을 열기 직전에 호출 — 현재(결제 화면) entry 의 anchor 를 기록한다. 실패해도 결제창 열기는 막지 않는다(폴백이 있다). */
export async function prepareHistoryForPayment(win: HistoryWin, now = Date.now(), waitMs = 1200): Promise<boolean> {
  try {
    const marker = `mwpay-${now}`;
    win.history.pushState({ ...(win.history.state ?? {}), __mwPay: marker }, "", win.location.href);   // 뒤쪽(forward) 오래된 entry 를 잘라 length 확정
    const lo = win.history.length;
    const back = new Promise<void>((resolve) => {
      const done = () => { win.removeEventListener("popstate", done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, waitMs);
      win.addEventListener("popstate", done);
    });
    win.history.back();
    await back;
    const stillOnMarker = (win.history.state as { __mwPay?: string } | null)?.__mwPay === marker;
    const anchor = stillOnMarker ? lo - 1 : lo - 2;   // 서 있는 entry 의 인덱스(되돌아오지 못했다면 중복 entry 에 서 있다)
    win.sessionStorage.setItem(REVIEW_HISTORY_KEY, JSON.stringify({ anchor, at: now }));
    return true;
  } catch { return false; }
}
