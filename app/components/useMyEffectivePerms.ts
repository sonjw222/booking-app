"use client";

/*
  매니저 화면 18곳이 똑같이 쓰던 "내 유효 권한 조회" 로직을 한 곳으로 모은 훅(Issue #274 Batch 1).

  예전 구조(각 page.tsx 마다 복사):
    const [myPerms, setMyPerms] = useState<Set<string> | null>(null);
    useEffect(() => {
      if (!activeCenter) return;
      if (activeCenter.isOwner) { setMyPerms(null); return; }      ← effect 본문의 동기 setState(react-hooks/set-state-in-effect)
      let cancelled = false; setMyPerms(null);                      ← 동기 setState
      fetchMyEffectivePermissionKeys(...).then((keys) => { if (!cancelled) setMyPerms(keys); }).catch(...setError...);
      return () => { cancelled = true; };
    }, [activeCenter]);
  effect 안에서 상태를 "비우는" 동기 setState 때문에 센터가 바뀐 직후 한 번은 이전 센터의 권한이 그대로 보였다가(렌더 → effect → 재렌더) 비워졌다.

  지금 구조: "어느 센터 기준으로 조회한 결과인지(key)"를 결과와 함께 저장하고, 반환값을 렌더 중에 파생한다.
    - 오너: 항상 null (오너는 canSeeManagerMenu 가 권한 집합 없이 true — 예전과 같음).
    - 비오너: 현재 센터의 key 와 저장된 결과의 key 가 같을 때만 권한 집합, 아니면 null = "조회 중"(메뉴 숨김 — 깜빡임 방지 정책 그대로).
    - 센터/역할이 바뀌면 같은 렌더에서 곧바로 null(이전 센터 권한이 한 프레임도 남지 않음). 같은 센터를 다시 조회(centers 재로딩으로 객체만 바뀜)하는 동안은 기존 결과를 유지해 메뉴가 깜빡이지 않는다.
    - 조회 시점·횟수·실패 처리는 예전과 같다: center 객체가 바뀔 때마다 조회(의존성 [center]), 실패하면 호출한 페이지의 setError 로 메시지 전달, 언마운트·재조회 시 이전 응답은 버린다(cancelled).
*/
import { useEffect, useState } from "react";
import { fetchMyEffectivePermissionKeys } from "../../lib/roles";
import { errMsg } from "./errorMessage";

export interface PermissionCenter {
  id: string;
  isOwner: boolean;
  managerCenterId: string;
  roleId: string | null;
}

export function useMyEffectivePerms(
  center: PermissionCenter | undefined,
  onError?: (message: string) => void,
): Set<string> | null {
  const [loaded, setLoaded] = useState<{ key: string; perms: Set<string> } | null>(null);
  const key = center && !center.isOwner ? `${center.id}|${center.managerCenterId}|${center.roleId ?? ""}` : null;

  useEffect(() => {
    if (!center || center.isOwner || key === null) return;
    let cancelled = false;
    fetchMyEffectivePermissionKeys(center.managerCenterId, center.roleId)
      .then((perms) => { if (!cancelled) setLoaded({ key, perms }); })
      .catch((e) => { if (!cancelled) onError?.(errMsg(e)); });
    return () => { cancelled = true; };
  }, [center, key, onError]);

  return key !== null && loaded?.key === key ? loaded.perms : null;
}
