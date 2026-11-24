// @vitest-environment jsdom
// 매니저 18개 화면이 공유하는 useMyEffectivePerms 훅(Issue #274 Batch 1)의 동작 계약 — DB 접속 없음, lib/roles 모킹.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../lib/roles', () => ({ fetchMyEffectivePermissionKeys: api.fetch }));
import { useMyEffectivePerms, type PermissionCenter } from '../../app/components/useMyEffectivePerms';
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const r of roots.splice(0)) await act(() => r.unmount()); document.body.innerHTML = ''; vi.resetAllMocks(); });

const staff = (id: string, over: Partial<PermissionCenter> = {}): PermissionCenter => ({ id, isOwner: false, managerCenterId: `mc-${id}`, roleId: `role-${id}`, ...over });
const owner = (id: string): PermissionCenter => ({ id, isOwner: true, managerCenterId: `mc-${id}`, roleId: null });

// 렌더 시점마다 훅 반환값을 기록한다(중간 렌더의 stale 값도 잡기 위해 최종값만 보지 않는다).
function setup(initial: PermissionCenter | undefined, onError?: (m: string) => void) {
  const seen: Array<string | null> = [];
  let setCenter!: (c: PermissionCenter | undefined) => void;
  function Probe() {
    const [center, set] = React.useState<PermissionCenter | undefined>(initial);
    setCenter = set;
    const perms = useMyEffectivePerms(center, onError);
    seen.push(perms === null ? null : [...perms].sort().join(','));
    return null;
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  return { seen, mount: () => act(async () => root.render(React.createElement(Probe))), change: (c: PermissionCenter | undefined) => act(async () => setCenter(c)), last: () => seen[seen.length - 1] };
}

it('센터가 없으면 null 이고 조회하지 않는다', async () => {
  const t = setup(undefined); await t.mount();
  expect(t.last()).toBeNull(); expect(api.fetch).not.toHaveBeenCalled();
});

it('오너는 항상 null(권한 집합 없이 canSeeManagerMenu 가 true)이고 조회하지 않는다', async () => {
  const t = setup(owner('a')); await t.mount();
  expect(t.last()).toBeNull(); expect(api.fetch).not.toHaveBeenCalled();
});

it('비오너: 조회 중에는 null(메뉴 숨김), 완료되면 권한 집합, 조회는 1회', async () => {
  let resolve!: (v: Set<string>) => void;
  api.fetch.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const t = setup(staff('a')); await t.mount();
  expect(t.last()).toBeNull(); expect(api.fetch).toHaveBeenCalledTimes(1); expect(api.fetch).toHaveBeenCalledWith('mc-a', 'role-a');
  await act(async () => resolve(new Set(['customer.progress', 'pass.create'])));
  expect(t.last()).toBe('customer.progress,pass.create'); expect(api.fetch).toHaveBeenCalledTimes(1);
});

it('센터를 바꾸면 같은 렌더에서 곧바로 null — 이전 센터 권한이 한 번도 보이지 않는다', async () => {
  api.fetch.mockResolvedValueOnce(new Set(['A.perm']));
  let resolveB!: (v: Set<string>) => void;
  api.fetch.mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
  const t = setup(staff('a')); await t.mount();
  expect(t.last()).toBe('A.perm');
  const before = t.seen.length;
  await t.change(staff('b'));
  // 센터 b 로 바뀐 이후의 모든 렌더에서 A 의 권한이 나오면 안 된다(예전 구조는 effect 가 비우기 전 한 번 노출).
  expect(t.seen.slice(before).includes('A.perm')).toBe(false);
  expect(t.last()).toBeNull();
  await act(async () => resolveB(new Set(['B.perm'])));
  expect(t.last()).toBe('B.perm');
});

it('빠른 센터 전환: 늦게 도착한 이전 센터 응답은 버려진다(stale 방지)', async () => {
  const pending: Record<string, (v: Set<string>) => void> = {};
  api.fetch.mockImplementation((mc: string) => new Promise((r) => { pending[mc] = r; }));
  const t = setup(staff('a')); await t.mount();
  await t.change(staff('b'));
  await act(async () => pending['mc-b'](new Set(['B.perm'])));
  await act(async () => pending['mc-a'](new Set(['A.late'])));   // a 응답이 b 뒤에 도착
  expect(t.last()).toBe('B.perm'); expect(t.seen.includes('A.late')).toBe(false);
});

it('조회 실패: 호출한 화면의 오류 처리(onError)로 메시지를 전달하고 권한은 null 유지', async () => {
  api.fetch.mockRejectedValue(new Error('권한 조회 실패'));
  const onError = vi.fn();
  const t = setup(staff('a'), onError); await t.mount();
  expect(onError).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenCalledWith('권한 조회 실패');
  expect(t.last()).toBeNull();
});

it('같은 센터를 다시 조회(객체만 새로 만들어짐)하는 동안 기존 권한을 유지해 메뉴가 깜빡이지 않는다', async () => {
  api.fetch.mockResolvedValueOnce(new Set(['A.perm']));
  let resolve2!: (v: Set<string>) => void;
  api.fetch.mockImplementationOnce(() => new Promise((r) => { resolve2 = r; }));
  const t = setup(staff('a')); await t.mount();
  const before = t.seen.length;
  await t.change({ ...staff('a') });   // centers 재로딩으로 같은 센터의 새 객체
  expect(api.fetch).toHaveBeenCalledTimes(2);   // 예전과 같이 객체가 바뀌면 다시 조회
  expect(t.seen.slice(before).every((v) => v === 'A.perm')).toBe(true);
  await act(async () => resolve2(new Set(['A.perm', 'A.new'])));
  expect(t.last()).toBe('A.new,A.perm');
});

it('오너로 바뀌면 null, 비오너로 돌아오면 다시 조회', async () => {
  api.fetch.mockResolvedValue(new Set(['X']));
  const t = setup(staff('a')); await t.mount();
  expect(t.last()).toBe('X');
  await t.change(owner('a'));
  expect(t.last()).toBeNull();
  await t.change(staff('a'));
  expect(api.fetch).toHaveBeenCalledTimes(2); expect(t.last()).toBe('X');
});

it('언마운트 뒤 도착한 응답은 상태를 바꾸지 않는다(경고·오류 없음)', async () => {
  let resolve!: (v: Set<string>) => void;
  api.fetch.mockImplementation(() => new Promise((r) => { resolve = r; }));
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const t = setup(staff('a')); await t.mount();
  const root = roots.pop()!; await act(() => root.unmount());
  await act(async () => resolve(new Set(['late'])));
  expect(err).not.toHaveBeenCalled(); err.mockRestore();
});
