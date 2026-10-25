// @vitest-environment jsdom
// 페이지네이션 검증 규칙(tests/e2e/fixtures/adminPaginationVerify.ts) 자체의 오프라인 검증.
// 1) 합성 응답으로 규칙이 올바른 데이터는 통과시키고 중복·누락·경계 오류는 잡아내는지,
// 2) 실제 화면(app/admin/centers/page.tsx)+실제 lib/admin.fetchCenterPage를 가짜 RPC 서버(supabase.rpc 모킹, 커서·limit+1 재현)에 붙여
//    상태 탭 3개 × 데이터 0/30/31/61건에서 화면 DOM id가 서버 응답과 일치하는지 확인한다. DB·네트워크 접속 없음.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyBoundary, expectedMoreButton, verifyTabPagination, type PageCall } from '../e2e/fixtures/adminPaginationVerify';

const server = vi.hoisted(() => ({ dataset: {} as Record<string, { id: string; created_at: string }[]>, calls: [] as { ids: string[]; body: Record<string, unknown> }[] }));
vi.mock('../../lib/supabaseClient', () => ({
  supabase: {
    rpc: async (name: string, body: Record<string, unknown>) => {
      if (name !== 'admin_list_centers_page') throw new Error(`unexpected rpc ${name}`);
      const all = [...(server.dataset[body.p_status as string] ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const after = body.p_before_id == null ? all
        : all.filter(r => r.created_at < (body.p_before_created_at as string) || (r.created_at === body.p_before_created_at && r.id < (body.p_before_id as string)));
      const rows = after.slice(0, (body.p_limit as number) + 1); // limit + lookahead 1행(서버 규칙)
      server.calls.push({ ids: rows.map(r => r.id), body });
      return { error: null, data: rows.map(r => ({ ...r, name: `센터 ${r.id}`, address: null, phone: null, business_number: null, business_license_url: null, status: body.p_status, reject_reason: null, owner_name: null, owner_phone: null })) };
    },
  },
}));
vi.mock('../../lib/authAccount', () => ({ getMyAccountId: vi.fn() }));
vi.mock('../../lib/admin', async (orig) => ({ ...(await orig<typeof import('../../lib/admin')>()), checkPlatformAdmin: async () => true }));
vi.mock('../../lib/storage', () => ({ getBusinessLicenseUrl: vi.fn() }));
vi.mock('../../lib/navState', () => ({ replaceTabNavigation: vi.fn() }));
vi.mock('../../app/components/UiIcon', () => ({ default: () => null }));
vi.mock('../../app/components/Loading', () => ({ default: () => null }));
import Page from '../../app/admin/centers/page';
vi.stubGlobal('React', React);
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

const mk = (status: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${status}-${String(i).padStart(3, '0')}`, created_at: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString() }));
const synth = (ids: string[], p_before_id: string | null): PageCall => ({ ids, body: { p_before_id, p_limit: 30 }, status: 200 });
const ids = (prefix: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${prefix}${from + i}`);

describe('verifyTabPagination — 규칙 자체', () => {
  it('61행(30+30+1) 정상 응답은 통과하고 첫 페이지 30개를 포함해 61개를 기대한다', () => {
    const all = ids('c', 0, 61);
    const calls = [synth(all.slice(0, 31), null), synth(all.slice(30, 61), 'c29')];
    const v = verifyTabPagination({ calls, domIds: all.slice(0, 60), moreButtonVisibleAtEnd: false });
    // 마지막 응답 31행 → 아직 1행 남음: 3번째 페이지가 필요하므로 위 입력은 '누락'으로 판정돼야 한다.
    expect(v.ok).toBe(false);
    const calls3 = [...calls, synth(all.slice(60, 61), 'c59')];
    const ok = verifyTabPagination({ calls: calls3, domIds: all, moreButtonVisibleAtEnd: false });
    expect(ok.problems).toEqual([]);
    expect(ok.expectedIds).toHaveLength(61);
    expect(ok.boundary).toBe('multi-page');
  });
  it('경계 분류: 29/30/31행', () => {
    expect(classifyBoundary([synth(ids('c', 0, 29), null)])).toBe('single-page-under-30');
    expect(classifyBoundary([synth(ids('c', 0, 30), null)])).toBe('exactly-30');
    expect(classifyBoundary([synth(ids('c', 0, 31), null), synth(['c30'], 'c29')])).toBe('exactly-31');
    expect(expectedMoreButton(synth(ids('c', 0, 30), null))).toBe(false);
    expect(expectedMoreButton(synth(ids('c', 0, 31), null))).toBe(true);
  });
  it('첫 페이지 30개가 화면에서 빠지면(누락) 실패한다', () => {
    const all = ids('c', 0, 31);
    const calls = [synth(all, null), synth(['c30'], 'c29')];
    const v = verifyTabPagination({ calls, domIds: all.slice(10), moreButtonVisibleAtEnd: false });
    expect(v.ok).toBe(false);
    expect(v.problems.join('\n')).toContain('화면에 없는 id 10개');
  });
  it('페이지 간 중복(lookahead 행이 다음 페이지에서 되풀이되지 않고 화면에 두 번 나옴)을 잡는다', () => {
    const all = ids('c', 0, 31);
    const calls = [synth(all, null), synth(['c30'], 'c29')];
    const v = verifyTabPagination({ calls, domIds: [...all, 'c30'], moreButtonVisibleAtEnd: false });
    expect(v.problems.join('\n')).toMatch(/중복/);
  });
  it('커서가 30번째가 아닌 행을 가리키면(31번째 사용 → 1행 누락) 잡는다', () => {
    const all = ids('c', 0, 62);
    const calls = [synth(all.slice(0, 31), null), synth(all.slice(31, 62), 'c30')];
    const v = verifyTabPagination({ calls, domIds: [...all.slice(0, 30), ...all.slice(31, 61)], moreButtonVisibleAtEnd: true });
    expect(v.problems.join('\n')).toMatch(/커서\(p_before_id\)가 .*30번째 행과 다름/);
    expect(v.problems.join('\n')).toMatch(/lookahead/);
  });
  it('서버가 31행을 넘게 돌려주거나 화면에 서버에 없는 카드가 있으면 잡는다', () => {
    const v = verifyTabPagination({ calls: [synth(ids('c', 0, 32), null)], domIds: [...ids('c', 0, 30), 'ghost'], moreButtonVisibleAtEnd: false });
    expect(v.problems.join('\n')).toMatch(/최대 31행/);
    expect(v.problems.join('\n')).toMatch(/서버 응답에 없는데 화면에 있는 id/);
  });
  it('응답이 하나도 없으면 실패(첫 페이지를 검증할 수 없음)', () => {
    expect(verifyTabPagination({ calls: [], domIds: [], moreButtonVisibleAtEnd: false }).ok).toBe(false);
  });
});

describe('실제 화면 + 가짜 RPC 서버 — 상태 탭×데이터 크기별 DOM↔서버 일치', () => {
  const roots: ReturnType<typeof createRoot>[] = [];
  beforeEach(() => { vi.stubEnv('NEXT_PUBLIC_ADMIN_CENTER_PAGINATION', 'true'); server.calls.length = 0; });
  afterEach(async () => { for (const r of roots.splice(0)) await act(() => r.unmount()); document.body.innerHTML = ''; vi.unstubAllEnvs(); });

  const TABS: [string, string][] = [['승인대기', 'pending'], ['승인됨', 'approved'], ['반려됨', 'rejected']];
  const SIZES: [number, string][] = [[0, 'single-page-under-30'], [30, 'exactly-30'], [31, 'exactly-31'], [61, 'multi-page']];

  for (const [label, status] of TABS) for (const [n, boundary] of SIZES) {
    it(`[${label}] ${n}건: 더 보기 끝까지 눌러 DOM id == 서버 응답(첫 페이지 30개 포함), 경계=${boundary}`, async () => {
      server.dataset = { pending: mk('pending', status === 'pending' ? n : 3), approved: mk('approved', status === 'approved' ? n : 3), rejected: mk('rejected', status === 'rejected' ? n : 3) };
      const host = document.createElement('div'); document.body.append(host);
      const root = createRoot(host); roots.push(root);
      await act(async () => root.render(React.createElement(Page)));
      if (status !== 'pending') await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === label)!.click());
      const more = () => [...host.querySelectorAll('button')].find(b => b.textContent === '센터 더 보기');
      const mine = () => server.calls.filter(c => c.body.p_status === status) as unknown as PageCall[];
      let guard = 0;
      while (more() && guard++ < 10) {
        // 30/31 경계: 마지막 응답이 31행일 때만 더 보기가 보인다.
        expect(expectedMoreButton(mine()[mine().length - 1])).toBe(true);
        await act(async () => more()!.click());
      }
      const last = mine()[mine().length - 1];
      expect(expectedMoreButton(last)).toBe(false);
      const domIds = [...host.querySelectorAll('.admin-card')].map(e => e.getAttribute('data-center-id') ?? '');
      const v = verifyTabPagination({ calls: mine(), domIds, moreButtonVisibleAtEnd: !!more() });
      expect(v.problems).toEqual([]);
      expect(v.boundary).toBe(boundary);
      expect(domIds).toHaveLength(n);
      expect(domIds).toEqual(server.dataset[status].map(r => r.id)); // 서버 데이터 전체와도 순서까지 일치(누락·중복 없음)
    });
  }
});
