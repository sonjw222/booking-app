// @vitest-environment jsdom
import { writeFileSync } from 'node:fs';
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
const centers = Array.from({length: 1000}, (_, i) => ({ id: String(i), name: `센터 ${i}`, status: 'pending', address: null, phone: null, businessNumber: null, businessLicenseUrl: null, createdAt: '', ownerName: null, ownerPhone: null, rejectReason: null }));
it('limits initial card DOM and does not repeat admin check when switching tabs', async () => {
  api.check.mockResolvedValue(true); api.fetch.mockResolvedValue({centers:centers.slice(0,30),nextCursor:{createdAt:"2026-10-01",id:"30"}});
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  const start = performance.now(); await act(async () => root.render(React.createElement(Page)));
  const metrics = { fixtureRows: 1000, initialCards: host.querySelectorAll('.admin-card').length, initialRenderMs: performance.now()-start, authChecks: api.check.mock.calls.length, listQueries: api.fetch.mock.calls.length };
  if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify(metrics));
  if (process.env.PERF_BASELINE) {
    await act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '승인됨')!.click());
    if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify({...metrics, tabSwitchAuthChecks: api.check.mock.calls.length, tabSwitchListQueries: api.fetch.mock.calls.length}));
    return;
  }
  expect(host.querySelectorAll('.admin-card')).toHaveLength(30);
  api.fetch.mockResolvedValueOnce({centers:centers.slice(30,60),nextCursor:{createdAt:'2026-10-01',id:'60'}});
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('센터 더 보기'))!.click());
  expect(host.querySelectorAll('.admin-card')).toHaveLength(60);
  await act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '승인됨')!.click());
  if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify({...metrics, tabSwitchAuthChecks: api.check.mock.calls.length, tabSwitchListQueries: api.fetch.mock.calls.length}));
  expect(api.check).toHaveBeenCalledTimes(1); expect(api.fetch).toHaveBeenCalledTimes(3);
  expect(host.querySelectorAll('.admin-card')).toHaveLength(30);
});
it('does not render a pending response after unmount', async () => {
  api.check.mockResolvedValue(true); let resolveOld!: (rows: {centers: typeof centers;nextCursor:null}) => void;
  api.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce([{ ...centers[0], name: '새 탭 센터' }]);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(Page)));
  // The loading screen hides tabs, so test overlapping refreshes via mount/unmount below.
  await act(() => root.unmount()); roots.splice(roots.indexOf(root),1);
  await act(async () => resolveOld({centers, nextCursor:null}));
  expect(host.textContent).toBe('');
});
it('keeps tabs available during loading, ignores old page response and searches with current tab', async () => {
  api.check.mockResolvedValue(true);
  let resolveOld!: (value: unknown) => void;
  api.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValue({centers:[{...centers[0],name:'승인 센터'}],nextCursor:null});
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);roots.push(root);
  await act(async()=>root.render(React.createElement(Page)));
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='승인됨')!.click());
  await act(async()=>resolveOld({centers:[{...centers[0],name:'오래된 응답'}],nextCursor:null}));
  expect(host.textContent).toContain('승인 센터');expect(host.textContent).not.toContain('오래된 응답');
  const input=host.querySelector('input')!;
  await act(()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'검색');input.dispatchEvent(new Event('input',{bubbles:true}));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,350));});
  expect(api.fetch).toHaveBeenLastCalledWith('approved','검색',null);
});
