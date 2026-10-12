// @vitest-environment jsdom
import { writeFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ check: vi.fn(), fetch: vi.fn() }));
vi.mock('../../lib/admin', () => ({ checkPlatformAdmin: api.check, fetchCenters: api.fetch, approveCenter: vi.fn(), rejectCenter: vi.fn(), resetToPending: vi.fn() }));
vi.mock('../../lib/storage', () => ({ getBusinessLicenseUrl: vi.fn() }));
vi.mock('../../lib/navState', () => ({ replaceTabNavigation: vi.fn() }));
vi.mock('../../app/components/UiIcon', () => ({ default: () => null }));
vi.mock('../../app/components/Loading', () => ({ default: () => null }));
import Page from '../../app/admin/centers/page';
vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await act(() => root.unmount()); document.body.innerHTML = ''; vi.clearAllMocks(); });
const centers = Array.from({length: 1000}, (_, i) => ({ id: String(i), name: `센터 ${i}`, status: 'pending', address: null, phone: null, businessNumber: null, businessLicenseUrl: null, createdAt: '', ownerName: null, ownerPhone: null, rejectReason: null }));
it('limits initial card DOM and does not repeat admin check when switching tabs', async () => {
  api.check.mockResolvedValue(true); api.fetch.mockResolvedValue(centers);
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
  await act(() => [...host.querySelectorAll('button')].find(b => b.textContent?.startsWith('센터 더 보기'))!.click());
  expect(host.querySelectorAll('.admin-card')).toHaveLength(60);
  await act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '승인됨')!.click());
  if (process.env.PERF_REPORT) writeFileSync(process.env.PERF_REPORT, JSON.stringify({...metrics, tabSwitchAuthChecks: api.check.mock.calls.length, tabSwitchListQueries: api.fetch.mock.calls.length}));
  expect(api.check).toHaveBeenCalledTimes(1); expect(api.fetch).toHaveBeenCalledTimes(2);
  expect(host.querySelectorAll('.admin-card')).toHaveLength(30);
});
it('does not render a pending response after unmount', async () => {
  api.check.mockResolvedValue(true); let resolveOld!: (rows: typeof centers) => void;
  api.fetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValueOnce([{ ...centers[0], name: '새 탭 센터' }]);
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  await act(async () => root.render(React.createElement(Page)));
  // The loading screen hides tabs, so test overlapping refreshes via mount/unmount below.
  await act(() => root.unmount()); roots.splice(roots.indexOf(root),1);
  await act(async () => resolveOld(centers));
  expect(host.textContent).toBe('');
});
