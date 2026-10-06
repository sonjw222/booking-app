// 여러 센터를 운영하는 매니저가 마지막으로 고른 센터를 계정별로 기억한다(2026-10-07).
//  - 순수 UX 힌트: 권한 판단은 그대로 RLS/목록(fetchMyCenters) 기준이며, 저장된 id가 목록에 없으면 버린다.
//  - 계정 단위 key라 다른 계정으로 로그인해도 섞이지 않는다. 저장소 접근 실패/SSR에서는 조용히 무시.
//  - 센터 목록의 첫 번째가 기본값인 기존 동작은 저장값이 없거나 무효일 때 그대로 유지된다.
const KEY_PREFIX = "mwhabit.manager.center.";
export const CENTER_CHANGED_EVENT = "mwhabit:manager-center-changed";
let currentAccountId: string | null = null;

// fetchMyCenters가 계정을 확인한 직후 호출한다(이후 pick/remember가 이 계정 key를 쓴다).
export function setPrefAccount(accountId: string | null): void { currentAccountId = accountId; }

function storage(): Storage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
export function rememberCenterId(centerId: string | null, accountId: string | null = currentAccountId): void {
  if (!accountId || !centerId) return;
  try { storage()?.setItem(KEY_PREFIX + accountId, centerId); } catch { /* 저장 불가 환경 */ }
  // 저장 성공 여부와 무관하게 알린다 — ManagerNav가 선택 센터 기준으로 메뉴 권한을 다시 계산한다.
  try { if (typeof window !== "undefined") window.dispatchEvent(new Event(CENTER_CHANGED_EVENT)); } catch { /* ignore */ }
}
export function readRememberedCenterId(accountId: string | null = currentAccountId): string | null {
  if (!accountId) return null;
  try { return storage()?.getItem(KEY_PREFIX + accountId) ?? null; } catch { return null; }
}
export function clearRememberedCenter(accountId: string | null = currentAccountId): void {
  if (!accountId) return;
  try { storage()?.removeItem(KEY_PREFIX + accountId); } catch { /* ignore */ }
}

// 저장된 센터가 현재 내 센터 목록에 있으면 그것, 아니면 목록의 첫 센터. 목록이 비면 null.
export function pickInitialCenterId<T extends { id: string }>(list: T[], remembered: string | null = readRememberedCenterId()): string | null {
  if (list.length === 0) return null;
  return (remembered && list.find((c) => c.id === remembered)?.id) || list[0].id;
}
