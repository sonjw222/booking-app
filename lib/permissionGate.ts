"use client";
import { useEffect, useState } from "react";
import { fetchMyEffectivePermissionKeys } from "./roles";
import type { ManagedCenter } from "./manager";

/* 매니저 화면 접근 게이트 — 메뉴(app/manager/page.tsx, ManagerNav)와 같은 권한 키·같은 규칙(오너는 전권, 그 외는 유효 권한 키 집합에 키가 있어야 함).
   핵심 원칙: **권한 조회 중(loading)·조회 실패(error)는 절대 allowed 가 아니다**(fail-closed). 서버 정책·권한 키는 바꾸지 않는다(UI 안내일 뿐, 실제 차단은 서버/RLS). */
export type GateState = "loading" | "allowed" | "denied" | "error";
export type PermLookup = { status: "idle" } | { status: "ok"; keys: Set<string> } | { status: "error" };

/** 순수 판정(단위 테스트 대상). center 가 아직 없거나 조회가 끝나지 않으면 loading, 실패면 error. */
export function resolvePermissionGate(center: Pick<ManagedCenter, "isOwner"> | undefined, lookup: PermLookup, key: string): GateState {
  if (!center) return "loading";
  if (center.isOwner) return "allowed";
  if (lookup.status === "ok") return lookup.keys.has(key) ? "allowed" : "denied";
  if (lookup.status === "error") return "error";
  return "loading";
}

/** 여러 센터 중 하나라도 allowed 이면 allowed(센터 선택이 없는 홈 화면용). 조회 중이 하나라도 있고 allowed 가 없으면 loading, 그 외 error 가 있으면 error. */
export function combineGates(states: GateState[]): GateState {
  if (states.length === 0) return "loading";
  if (states.includes("allowed")) return "allowed";
  if (states.includes("loading")) return "loading";
  if (states.includes("error")) return "error";
  return "denied";
}

/** 선택된 센터에 대한 권한 게이트. 센터가 바뀌면 이전 센터의 조회 결과는 쓰지 않는다(centerId 가 다르면 idle). */
export function useCenterPermissionGate(centers: ManagedCenter[], centerId: string | null, key: string): GateState {
  const center = centers.find((c) => c.id === centerId);
  const [res, setRes] = useState<{ centerId: string; lookup: PermLookup } | null>(null);
  useEffect(() => {
    if (!center || center.isOwner) return;
    let cancelled = false;
    fetchMyEffectivePermissionKeys(center.managerCenterId, center.roleId)
      .then((keys) => { if (!cancelled) setRes({ centerId: center.id, lookup: { status: "ok", keys } }); })
      .catch(() => { if (!cancelled) setRes({ centerId: center.id, lookup: { status: "error" } }); });
    return () => { cancelled = true; };
  }, [center]);
  const lookup: PermLookup = res && center && res.centerId === center.id ? res.lookup : { status: "idle" };
  return resolvePermissionGate(center, lookup, key);
}

/** 모든 소속 센터를 합쳐 판정(센터 선택이 없는 화면). */
export function useAnyCenterPermissionGate(centers: ManagedCenter[], loaded: boolean, key: string): GateState {
  const [res, setRes] = useState<Record<string, PermLookup>>({});
  useEffect(() => {
    let cancelled = false;
    for (const c of centers) {
      if (c.isOwner) continue;
      fetchMyEffectivePermissionKeys(c.managerCenterId, c.roleId)
        .then((keys) => { if (!cancelled) setRes((r) => ({ ...r, [c.id]: { status: "ok", keys } })); })
        .catch(() => { if (!cancelled) setRes((r) => ({ ...r, [c.id]: { status: "error" } })); });
    }
    return () => { cancelled = true; };
  }, [centers]);
  if (!loaded) return "loading";
  if (centers.length === 0) return "denied";
  return combineGates(centers.map((c) => resolvePermissionGate(c, res[c.id] ?? { status: "idle" }, key)));
}
