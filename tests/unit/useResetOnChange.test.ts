// @vitest-environment jsdom
// useResetOnChange(Issue #274 Batch 2) 동작 계약 — effect 없이 "의존값이 바뀔 때만" 상태를 초기화하는지, 이전 값이 커밋되지 않는지 검증.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useResetOnChange } from '../../app/components/useResetOnChange';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await act(() => r.unmount()); document.body.innerHTML = ''; });

// dep 가 바뀔 때 value 를 비우는 컴포넌트. 매 "커밋"된 렌더의 value 를 기록한다(커밋 안 된 렌더는 기록하지 않음).
function setup(opts?: { runOnMount?: boolean; initialValue?: string }) {
  const committed: string[] = []; const resets = vi.fn();
  let setDep!: (d: string) => void; let setValue!: (v: string) => void;
  function Probe() {
    const [dep, sd] = React.useState('a'); setDep = sd;
    const [value, sv] = React.useState(opts?.initialValue ?? 'typed'); setValue = sv;
    useResetOnChange([dep], () => { resets(); sv(''); }, { runOnMount: opts?.runOnMount });
    React.useEffect(() => { committed.push(value); });
    return null;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  return { committed, resets, mount: () => act(async () => root.render(React.createElement(Probe))), setDep: (d: string) => act(async () => setDep(d)), setValue: (v: string) => act(async () => setValue(v)) };
}

it('마운트 시에는 초기화하지 않는다(기본) — 초기 상태가 그대로 유지된다', async () => {
  const t = setup(); await t.mount();
  expect(t.resets).not.toHaveBeenCalled(); expect(t.committed).toEqual(['typed']);
});

it('runOnMount 를 켜면 마운트 직후 한 번 초기화한다', async () => {
  const t = setup({ runOnMount: true }); await t.mount();
  expect(t.resets).toHaveBeenCalledTimes(1); expect(t.committed.at(-1)).toBe('');
});

it('의존값이 바뀌면 초기화하고, 이전 값은 한 번도 커밋되지 않는다', async () => {
  const t = setup(); await t.mount();
  const before = t.committed.length;
  await t.setDep('b');
  expect(t.resets).toHaveBeenCalledTimes(1);
  expect(t.committed.slice(before)).toEqual(['']);   // 'typed' 가 dep=b 렌더에 커밋되지 않음(effect 방식은 한 번 보였다 사라짐)
});

it('의존값이 같으면(같은 값으로 갱신·다른 상태 변경) 초기화하지 않고 사용자 입력을 보존한다', async () => {
  const t = setup(); await t.mount();
  await t.setDep('a'); await t.setValue('hello'); await t.setDep('a');
  expect(t.resets).not.toHaveBeenCalled(); expect(t.committed.at(-1)).toBe('hello');
});

it('바뀐 뒤 다시 입력한 값은 다음 변경 전까지 유지되고, 다음 변경에서 다시 초기화된다', async () => {
  const t = setup(); await t.mount();
  await t.setDep('b'); await t.setValue('second'); expect(t.committed.at(-1)).toBe('second');
  await t.setDep('c'); expect(t.resets).toHaveBeenCalledTimes(2); expect(t.committed.at(-1)).toBe('');
});

it('여러 deps 중 하나만 바뀌어도 초기화하고, 배열 identity 가 매번 새로워도(같은 값이면) 초기화하지 않는다', async () => {
  const resets = vi.fn(); let setA!: (v: number) => void; let setB!: (v: number) => void;
  function P() { const [a, sa] = React.useState(1); const [b, sb] = React.useState(1); setA = sa; setB = sb; useResetOnChange([a, [1, 2].length, b], resets); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(P)));
  await act(async () => setA(1)); expect(resets).not.toHaveBeenCalled();
  await act(async () => setB(2)); expect(resets).toHaveBeenCalledTimes(1);
});

it('언마운트 후에는 아무 일도 하지 않는다(경고·오류 없음)', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const t = setup(); await t.mount(); const root = roots.pop()!; await act(() => root.unmount());
  expect(err).not.toHaveBeenCalled(); err.mockRestore();
});
