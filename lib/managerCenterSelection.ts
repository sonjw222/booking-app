"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
const KEY = "manager_current_center";
const EVENT = "manager-center-changed";
export function currentCenterId(): string | null {
  try { return sessionStorage.getItem(KEY); } catch { return null; }
}
export function preferredCenterId(centers: { id: string }[]): string | null {
  const saved = currentCenterId();
  return centers.find((c) => c.id === saved)?.id ?? centers[0]?.id ?? null;
}
function subscribe(callback: () => void) {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
export function useCurrentCenterId() {
  return useSyncExternalStore(subscribe, currentCenterId, () => null);
}
// Pages own their forms and data fetching. This publishes their chosen center
// to navigation; it does not change another page's open form or grant access.
export function useCenterSelection() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    try { sessionStorage.setItem(KEY, id); } catch { return; }
    window.dispatchEvent(new Event(EVENT));
  }, [id]);
  const setCenter = useCallback((next: string | null) => setId(next), []);
  return [id, setCenter] as const;
}
