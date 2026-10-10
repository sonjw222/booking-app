import { describe, it, expect, vi, beforeEach } from "vitest";

// PERF-050/051: getMyAccountId in-flight 공유 + 짧은 TTL, 알림 구독 ref-count 공유.
type AuthCb = (event: string) => void;
const state = {
  uid: "u1" as string | null,
  rpcCalls: 0,
  rpcImpl: async (): Promise<{ data: string | null; error: { message: string } | null }> => ({ data: "acc-" + state.uid, error: null }),
  authCbs: [] as AuthCb[],
  channels: [] as { name: string; handler?: (p: { new: Record<string, unknown> }) => void; removed: boolean }[],
};

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    rpc: async () => { state.rpcCalls += 1; return state.rpcImpl(); },
    auth: {
      getSession: async () => ({ data: { session: state.uid ? { user: { id: state.uid } } : null } }),
      onAuthStateChange: (cb: AuthCb) => { state.authCbs.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
    },
    channel: (name: string) => {
      const ch: { name: string; handler?: (p: { new: Record<string, unknown> }) => void; removed: boolean; on: unknown; subscribe: unknown } = {
        name, removed: false,
        on(_t: string, _f: unknown, h: (p: { new: Record<string, unknown> }) => void) { ch.handler = h; return ch; },
        subscribe() { return ch; },
      };
      state.channels.push(ch);
      return ch;
    },
    removeChannel: (ch: { removed: boolean }) => { ch.removed = true; },
  },
}));

beforeEach(() => {
  vi.resetModules();
  state.uid = "u1"; state.rpcCalls = 0; state.authCbs = []; state.channels = [];
  state.rpcImpl = async () => ({ data: "acc-" + state.uid, error: null });
  (globalThis as { window?: unknown }).window = globalThis;
});

describe("getMyAccountId (PERF-050)", () => {
  it("동시 호출은 RPC 1회로 합쳐진다", async () => {
    const { getMyAccountId } = await import("../../lib/authAccount");
    const r = await Promise.all([getMyAccountId(), getMyAccountId(), getMyAccountId()]);
    expect(r).toEqual(["acc-u1", "acc-u1", "acc-u1"]);
    expect(state.rpcCalls).toBe(1);
  });
  it("TTL 내 재호출은 재사용, 인증 이벤트 후에는 다시 조회한다", async () => {
    const { getMyAccountId } = await import("../../lib/authAccount");
    await getMyAccountId(); await getMyAccountId();
    expect(state.rpcCalls).toBe(1);
    state.authCbs.forEach((cb) => cb("SIGNED_OUT"));
    await getMyAccountId();
    expect(state.rpcCalls).toBe(2);
  });
  it("사용자가 바뀌면 이전 사용자 값을 재사용하지 않는다", async () => {
    const { getMyAccountId } = await import("../../lib/authAccount");
    expect(await getMyAccountId()).toBe("acc-u1");
    state.uid = "u2";
    expect(await getMyAccountId()).toBe("acc-u2");
    state.uid = null;
    state.rpcImpl = async () => ({ data: null, error: null });
    expect(await getMyAccountId()).toBeNull();
  });
  it("오류/null 결과는 캐시하지 않고 다음 호출에서 재시도한다", async () => {
    const { getMyAccountId } = await import("../../lib/authAccount");
    state.rpcImpl = async () => ({ data: null, error: { message: "x" } });
    expect(await getMyAccountId()).toBeNull();
    state.rpcImpl = async () => ({ data: null, error: null });
    expect(await getMyAccountId()).toBeNull();
    state.rpcImpl = async () => ({ data: "acc-u1", error: null });
    expect(await getMyAccountId()).toBe("acc-u1");
    expect(state.rpcCalls).toBe(3);
  });
  it("TTL 경과 후에는 다시 조회한다", async () => {
    vi.useFakeTimers();
    try {
      const { getMyAccountId, MY_ACCOUNT_ID_TTL_MS } = await import("../../lib/authAccount");
      await getMyAccountId();
      vi.setSystemTime(Date.now() + MY_ACCOUNT_ID_TTL_MS + 1);
      await getMyAccountId();
      expect(state.rpcCalls).toBe(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("subscribeNotifications 공유 (PERF-051)", () => {
  it("여러 구독자가 채널 1개를 공유하고 모두 알림을 받으며 마지막 해제 시 채널을 제거한다", async () => {
    const { subscribeNotifications } = await import("../../lib/notifications");
    const a = vi.fn(), b = vi.fn();
    const [ua, ub] = await Promise.all([subscribeNotifications(a), subscribeNotifications(b)]);
    expect(state.channels.length).toBe(1);
    expect(state.rpcCalls).toBe(1);
    state.channels[0].handler?.({ new: { id: "n1", kind: "x", title: "t", body: "b", created_at: "2026-01-01T00:00:00Z" } });
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(1);
    ua(); ua();
    expect(state.channels[0].removed).toBe(false);
    state.channels[0].handler?.({ new: { id: "n2", kind: "x", title: "t", body: "b", created_at: "2026-01-01T00:00:00Z" } });
    expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(2);
    ub();
    expect(state.channels[0].removed).toBe(true);
    await subscribeNotifications(vi.fn());
    expect(state.channels.length).toBe(2);
  });
  it("로그아웃 시 채널을 닫고 다른 계정으로 로그인하면 새 계정 필터로 다시 구독한다", async () => {
    const { subscribeNotifications } = await import("../../lib/notifications");
    const a = vi.fn();
    await subscribeNotifications(a);
    state.uid = null; state.rpcImpl = async () => ({ data: null, error: null });
    state.authCbs.forEach((cb) => cb("SIGNED_OUT"));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.channels[0].removed).toBe(true);
    state.uid = "u2"; state.rpcImpl = async () => ({ data: "acc-u2", error: null });
    state.authCbs.forEach((cb) => cb("SIGNED_IN"));
    await new Promise((r) => setTimeout(r, 10));
    expect(state.channels.length).toBe(2);
    expect(state.channels[1].name).toContain("acc-u2");
    state.channels[1].handler?.({ new: { id: "n3", kind: "x", title: "t", body: "b", created_at: "2026-01-01T00:00:00Z" } });
    expect(a).toHaveBeenCalledTimes(1);
  });
});
