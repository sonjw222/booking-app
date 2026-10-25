// @vitest-environment jsdom
// 탭 전환 중/실패 후 이전 탭의 카드·관리 버튼이 남지 않는지 검증(DB 접속 없음, lib/admin 모킹).
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ check: vi.fn(), fetch: vi.fn() }));
vi.mock('../../lib/admin', () => ({ checkPlatformAdmin: api.check, fetchCenterPage: api.fetch, approveCenter: vi.fn(), rejectCenter: vi.fn(), resetToPending: vi.fn() }));
vi.mock('../../lib/storage', () => ({ getBusinessLicenseUrl: vi.fn() }));
vi.mock('../../lib/navState', () => ({ replaceTabNavigation: vi.fn() }));
vi.mock('../../app/components/UiIcon', () => ({ default: () => null }));
vi.mock('../../app/components/Loading', () => ({ default: () => null }));
import Page from '../../app/admin/centers/page';
vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(() => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks(); });
const row = (id: string, name: string, status: string) => ({ id, name, status, address: null, phone: null, businessNumber: null, businessLicenseUrl: null, createdAt: '', ownerName: null, ownerPhone: null, rejectReason: null });
const tabBtn = (host: HTMLElement, label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
async function mount() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(Page)));
  return host;
}

it('탭 전환 요청이 실패하면 이전 탭의 카드와 관리 버튼을 남기지 않는다', async () => {
  api.check.mockResolvedValue(true);
  api.fetch.mockResolvedValueOnce({ centers: [row('1', '대기 센터', 'pending')], nextCursor: null })
    .mockRejectedValueOnce(new Error('센터 목록을 불러오지 못했어요: network'));
  const host = await mount();
  expect(host.textContent).toContain('대기 센터');
  await act(async () => tabBtn(host, '승인됨').click());
  expect(host.querySelector('.error-toast')).not.toBeNull();
  expect(host.querySelectorAll('.admin-card')).toHaveLength(0);
  expect(host.textContent).not.toContain('대기 센터');
  expect([...host.querySelectorAll('button')].some(b => b.textContent === '승인' || b.textContent === '반려')).toBe(false);
});

it('탭 전환 응답이 오기 전에는 이전 탭 카드(승인/반려 버튼)가 보이지 않는다', async () => {
  api.check.mockResolvedValue(true);
  let resolveNext!: (v: unknown) => void;
  api.fetch.mockResolvedValueOnce({ centers: [row('1', '대기 센터', 'pending')], nextCursor: null })
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  const host = await mount();
  await act(async () => tabBtn(host, '승인됨').click());
  expect(host.querySelectorAll('.admin-card')).toHaveLength(0);
  await act(async () => resolveNext({ centers: [row('2', '승인 센터', 'approved')], nextCursor: null }));
  expect(host.textContent).toContain('승인 센터');
  expect(host.textContent).not.toContain('대기 센터');
});

it('빠른 탭 전환(대기→승인→반려)에서 늦게 도착한 이전 응답이 반려 탭을 덮지 않는다', async () => {
  api.check.mockResolvedValue(true);
  const pending: Record<string, (v: unknown) => void> = {};
  api.fetch.mockResolvedValueOnce({ centers: [row('1', '대기 센터', 'pending')], nextCursor: null })
    .mockImplementation((status: string) => new Promise(resolve => { pending[status] = resolve; }));
  const host = await mount();
  await act(async () => tabBtn(host, '승인됨').click());
  await act(async () => tabBtn(host, '반려됨').click());
  await act(async () => pending.rejected({ centers: [row('3', '반려 센터', 'rejected')], nextCursor: null }));
  await act(async () => pending.approved({ centers: [row('2', '승인 센터', 'approved')], nextCursor: null }));
  expect(host.textContent).toContain('반려 센터');
  expect(host.textContent).not.toContain('승인 센터');
  expect(host.querySelector('.center-chip.on')?.textContent).toBe('반려됨');
});
