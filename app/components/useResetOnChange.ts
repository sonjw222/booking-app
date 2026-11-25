"use client";

/*
  "의존값이 바뀌면 상태를 초기화한다" 를 effect 없이 처리하는 훅(Issue #274 Batch 2).

  예전 패턴:
    useEffect(() => { setX([]); setY(null); }, [dep]);      ← effect 본문의 동기 setState(react-hooks/set-state-in-effect)
  effect 는 커밋 뒤에 실행되므로 dep 가 바뀐 렌더가 먼저 화면에 반영되고(이전 값이 한 번 보임) 곧바로 다시 렌더된다.

  이 훅은 React 공식 패턴("렌더 중에 이전 렌더 정보로 상태 조정")을 그대로 쓴다: 이전 deps 를 state 로 기억하고, 렌더 중에 deps 가
  달라진 것을 발견하면 같은 컴포넌트의 상태를 즉시 초기화한다. React 가 그 렌더를 버리고 초기화된 값으로 바로 다시 렌더하므로
  이전 값이 화면에 한 번도 커밋되지 않는다. 초기화가 일어나는 조건(deps 비교는 useEffect 와 같은 Object.is)과 초기화 내용은 예전 effect 와 같다.

  주의:
  - onReset 은 "이 컴포넌트 자신의 setState" 만 호출해야 한다(렌더 중 다른 컴포넌트 상태/ref/외부 부작용 금지).
    ref 갱신·타이머·네트워크 호출처럼 렌더 밖에서 해야 하는 일은 기존처럼 useEffect 에 남긴다.
  - runOnMount: 예전 effect 가 마운트 직후에도 초기화를 실행했고 그 결과가 초기 상태와 다를 수 있을 때만 켠다(기본 꺼짐 — 초기 상태가 이미 초기화된 값이면 불필요).
*/
import { useState } from "react";

export function useResetOnChange(
  deps: readonly unknown[],
  onReset: () => void,
  options?: { runOnMount?: boolean },
): void {
  const [prev, setPrev] = useState<readonly unknown[] | null>(options?.runOnMount ? null : deps);
  const changed = prev === null
    || prev.length !== deps.length
    || deps.some((d, i) => !Object.is(d, prev[i]));
  if (changed) {
    setPrev(deps);
    onReset();
  }
}
