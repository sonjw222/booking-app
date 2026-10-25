// @vitest-environment jsdom
// 검색어 변경 → debounce(300ms) → 로딩 → 응답 사이에 이전 검색/탭 결과의 카드·승인/반려 버튼이 남지 않는지,
// 그리고 응답 순서 역전(A 요청 보류 → B 완료 → A 뒤늦게 도착)에서 B 결과만 남는지 검증한다.
// DB 접속 없음: lib/admin을 모킹하고 각 요청의 resolve를 테스트가 직접 쥐고 있다(타이머 지연으로 흉내내지 않는다).
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ check: vi.fn(), fetch: vi.fn() }));
vi.mock('../../lib/admin', () => ({ checkPlatformAdmin: api.check, fetchCenterPage: api.fetch, approveCenter: vi.fn(), rejectCenter: vi.fn(), resetToPending: vi.fn() }));
vi.mock('../../lib/storage', () => ({ getBusinessLicenseUrl: vi.fn() }));
vi.mock('../../lib/navState', () => ({ replaceTabNavigation: vi.fn() }));
vi.mock('../../app/components/UiIcon', () => ({ default: () => null }));
vi.mock('../../app/components/Loading', () => ({ default: () => null }));
import Page from '../../app/admin/centers/page';
vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

type Page = { centers: ReturnType<typeof row>[]; nextCursor: { createdAt: string; id: string } | null };
type Call = { status: string; keyword: string; cursor: unknown; resolve: (v: Page) => void; reject: (e: Error) => void };
const calls: Call[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
const row = (id: string, name: string, status = 'pending') => ({ id, name, status, address: null, phone: null, businessNumber: null, businessLicenseUrl: null, createdAt: '', ownerName: null, ownerPhone: null, rejectReason: null });
const page = (...centers: ReturnType<typeof row>[]): Page => ({ centers, nextCursor: null });

beforeEach(() => {
  vi.useFakeTimers();
  calls.length = 0;
  api.check.mockResolvedValue(true);
  // 첫 호출(초기 로드)은 즉시 완료, 이후 호출은 테스트가 resolve/reject를 직접 호출할 때까지 보류.
  api.fetch.mockImplementation((status: string, keyword: string, cursor: unknown) => {
    if (calls.length === 0) { calls.push({ status, keyword, cursor, resolve: () => {}, reject: () => {} }); return Promise.resolve({ centers: [row('old-1', '이전 센터 1'), row('old-2', '이전 센터 2')], nextCursor: null }); }
    return new Promise<Page>((resolve, reject) => { calls.push({ status, keyword, cursor, resolve, reject }); });
  });
});
afterEach(async () => { for (const root of roots.splice(0)) await act(() => root.unmount()); document.body.innerHTML = ''; vi.useRealTimers(); vi.resetAllMocks(); });

async function mount() {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(Page)));
  return host;
}
async function type(host: HTMLElement, value: string) {
  const input = host.querySelector('input.input-field') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map(b => b.textContent);
const hasManageButtons = (host: HTMLElement) => buttons(host).some(t => t === '승인' || t === '반려');

it('검색어 입력 직후(debounce 대기 중)에는 이전 결과의 카드와 승인/반려 버튼이 보이지 않는다', async () => {
  const host = await mount();
  expect(host.textContent).toContain('이전 센터 1');
  expect(hasManageButtons(host)).toBe(true);
  await type(host, '새검색');
  await advance(100); // 300ms debounce 이전
  expect(calls).toHaveLength(1); // 아직 새 요청 없음
  expect(host.querySelectorAll('.admin-card')).toHaveLength(0);
  expect(hasManageButtons(host)).toBe(false);
  // 로딩 중이지 "검색 결과가 없어요"가 아니다(빈 결과로 오인되면 안 된다).
  expect(host.textContent).not.toContain('검색 결과가 없어요');
});

it('debounce 이후 응답 도착 전(로딩 중)에도 이전 결과가 남지 않고, 응답이 오면 새 결과만 보인다', async () => {
  const host = await mount();
  await type(host, '새검색');
  await advance(300);
  expect(calls).toHaveLength(2);
  expect(calls[1].keyword).toBe('새검색');
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.querySelectorAll('.admin-card')).toHaveLength(0);
  expect(hasManageButtons(host)).toBe(false);
  await act(async () => calls[1].resolve(page(row('new-1', '새 센터'))));
  expect(host.textContent).toContain('새 센터');
  expect(host.textContent).not.toContain('이전 센터');
});

it('검색 요청이 실패해도 이전 결과의 승인/반려 버튼이 남지 않는다', async () => {
  const host = await mount();
  await type(host, '실패');
  await advance(300);
  await act(async () => calls[1].reject(new Error('센터 목록을 불러오지 못했어요: network')));
  expect(host.querySelector('.error-toast')).not.toBeNull();
  expect(host.querySelectorAll('.admin-card')).toHaveLength(0);
  expect(hasManageButtons(host)).toBe(false);
});

it('검색어 지우기 버튼을 눌러도 이전 검색 결과가 로딩 중에 남지 않는다', async () => {
  const host = await mount();
  await type(host, '새검색');
  await advance(300);
  await act(async () => calls[1].resolve(page(row('s-1', '검색 결과 센터'))));
  expect(host.textContent).toContain('검색 결과 센터');
  await act(async () => (host.querySelector('.admin-center-search-clear') as HTMLButtonElement).click());
  expect(calls).toHaveLength(3);
  expect(calls[2].keyword).toBe('');
  expect(host.textContent).not.toContain('검색 결과 센터');
  expect(hasManageButtons(host)).toBe(false);
});

it('응답 순서 역전(검색): A 요청을 보류한 채 B가 먼저 완료되고 A가 뒤늦게 도착해도 B 결과만 남는다', async () => {
  const host = await mount();
  await type(host, 'A');
  await advance(300); // 요청 A 발송(보류)
  await type(host, 'AB');
  await advance(300); // 요청 B 발송
  expect(calls.map(c => c.keyword)).toEqual(['', 'A', 'AB']);
  await act(async () => calls[2].resolve(page(row('b-1', 'B 결과 센터'))));
  expect(host.textContent).toContain('B 결과 센터');
  await act(async () => calls[1].resolve(page(row('a-1', 'A 결과 센터')))); // 뒤늦은 A 응답 전달
  expect(host.textContent).toContain('B 결과 센터');
  expect(host.textContent).not.toContain('A 결과 센터');
  expect(host.querySelectorAll('.admin-card')).toHaveLength(1);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

it('응답 순서 역전(실패 응답): 늦게 도착한 A의 오류가 B의 정상 결과를 지우거나 오류를 띄우지 않는다', async () => {
  const host = await mount();
  await type(host, 'A');
  await advance(300);
  await type(host, 'AB');
  await advance(300);
  await act(async () => calls[2].resolve(page(row('b-1', 'B 결과 센터'))));
  await act(async () => calls[1].reject(new Error('늦은 A 오류')));
  expect(host.textContent).toContain('B 결과 센터');
  expect(host.querySelector('.error-toast')).toBeNull();
});

it('응답 순서 역전(탭): 승인됨 요청을 보류한 채 반려됨이 먼저 완료되고 승인됨이 뒤늦게 도착해도 반려됨 결과만 남는다', async () => {
  const host = await mount();
  const tab = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
  await act(async () => tab('승인됨').click());
  await act(async () => tab('반려됨').click());
  expect(calls.map(c => c.status)).toEqual(['pending', 'approved', 'rejected']);
  await act(async () => calls[2].resolve(page(row('r-1', '반려 센터', 'rejected'))));
  await act(async () => calls[1].resolve(page(row('a-1', '승인 센터', 'approved'))));
  expect(host.textContent).toContain('반려 센터');
  expect(host.textContent).not.toContain('승인 센터');
  expect(host.querySelector('.center-chip.on')?.textContent).toBe('반려됨');
});

it('더 보기 회귀 없음: 기존 카드는 유지된 채 다음 페이지가 이어 붙고, 중복 없이 끝난다', async () => {
  api.fetch.mockReset();
  const cursor = { createdAt: '2026-01-01T00:00:00Z', id: 'c-2' };
  api.fetch.mockResolvedValueOnce({ centers: [row('c-1', '센터 1'), row('c-2', '센터 2')], nextCursor: cursor })
    .mockResolvedValueOnce({ centers: [row('c-3', '센터 3')], nextCursor: null });
  const host = await mount();
  expect(host.querySelectorAll('.admin-card')).toHaveLength(2);
  const more = () => [...host.querySelectorAll('button')].find(b => b.textContent === '센터 더 보기');
  await act(async () => more()!.click());
  expect(api.fetch).toHaveBeenLastCalledWith('pending', '', cursor);
  expect([...host.querySelectorAll('.admin-center-name')].map(e => e.textContent)).toEqual(['센터 1', '센터 2', '센터 3']);
  expect(more()).toBeUndefined();
});
