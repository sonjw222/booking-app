// @vitest-environment jsdom
/*
  Android/iOS Native Push Auto-Registration P1 Bug Fix(2026-09-20) — 실기기(Samsung
  SM-T975N, Android 13) logcat으로 재현·확인한 버그의 회귀 테스트.

  버그: getNativePushStatus()가 "OS 알림 권한 granted"만 보고 "subscribed"를 반환해,
  autoRegisterNativePushOnLogin()이 실제로는 한 번도 register()를 호출한 적 없는
  기기에서도 "이미 구독 중"이라 착각해 PushNotifications.register() 자체를 건너뛰었다
  (FCM registration 이벤트 없음, native_push_tokens 빈 테이블 — 전부 실기기로 확인됨).

  수정: "이 기기가 실제로 등록을 마쳤는지"를 로컬(localStorage) 플래그로 별도 추적한다.
  account_id+platform으로 DB(native_push_tokens)를 조회해 판정하지 않는다 — 같은
  계정으로 여러 기기를 쓸 수 있어 다른 기기의 등록 여부가 이 기기의 상태를 오염시키면
  안 되기 때문이다(테스트 8번이 이걸 직접 검증).

  이 파일만 jsdom 환경으로 전환한다(localStorage 필요, vitest.config.ts 기본값은 node —
  위 첫 줄의 @vitest-environment jsdom 매직 코멘트로 지정).
*/
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = { isNative: true, platform: "android" as "android" | "ios" | "web" };

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mockState.isNative,
    getPlatform: () => mockState.platform,
  },
  registerPlugin: () => ({
    addListener: vi.fn(),
    getToken: vi.fn().mockResolvedValue({ value: "" }),
  }),
}));

type PermReceive = "granted" | "denied" | "prompt";
const pushMock = {
  checkPermissions: vi.fn<[], Promise<{ receive: PermReceive }>>(),
  requestPermissions: vi.fn<[], Promise<{ receive: PermReceive }>>(),
  register: vi.fn(),
  addListener: vi.fn(),
};
// register() 안에서 등록된 "registration" 리스너를 즉시 호출해 fake token을 흘려보낸다
// (executor 안에서 addListener → register 순으로 동기 실행되므로, register()가 불릴
// 시점엔 리스너가 이미 등록돼 있다). "registrationError"용 리스너는 실패 시나리오
// 테스트에서 개별적으로 직접 호출한다.
let registrationListeners: ((token: { value: string }) => void)[] = [];
let registrationErrorListeners: ((err: { error?: string }) => void)[] = [];
let fakeToken = "fake-fcm-token-value-not-a-real-secret";

vi.mock("@capacitor/push-notifications", () => ({
  PushNotifications: {
    checkPermissions: (...a: any[]) => pushMock.checkPermissions(...(a as [])),
    requestPermissions: (...a: any[]) => pushMock.requestPermissions(...(a as [])),
    register: (...a: any[]) => {
      pushMock.register(...(a as []));
      registrationListeners.forEach((cb) => cb({ value: fakeToken }));
    },
    addListener: (event: string, cb: any) => {
      pushMock.addListener(event, cb);
      if (event === "registration") registrationListeners.push(cb);
      if (event === "registrationError") registrationErrorListeners.push(cb);
      return Promise.resolve({ remove: vi.fn() });
    },
  },
}));

const supabaseMock = {
  upsert: vi.fn().mockResolvedValue({ error: null }),
  fromCalls: [] as string[],
};
vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    from: (table: string) => {
      supabaseMock.fromCalls.push(table);
      return {
        upsert: (...a: any[]) => supabaseMock.upsert(...a),
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      };
    },
  },
}));

const authAccountMock = { accountId: "account-1" as string | null };
vi.mock("../../lib/authAccount", () => ({
  getMyAccountId: () => Promise.resolve(authAccountMock.accountId),
}));

import {
  autoRegisterNativePushOnLogin,
  clearDeviceRegisteredLocally,
  disableNativePush,
  enableNativePush,
  getNativePushStatus,
  isDeviceRegisteredLocally,
} from "../../lib/nativePush";

function resetAll() {
  mockState.isNative = true;
  mockState.platform = "android";
  authAccountMock.accountId = "account-1";
  pushMock.checkPermissions.mockReset().mockResolvedValue({ receive: "granted" });
  pushMock.requestPermissions.mockReset().mockResolvedValue({ receive: "granted" });
  pushMock.register.mockReset();
  pushMock.addListener.mockReset();
  registrationListeners = [];
  registrationErrorListeners = [];
  supabaseMock.upsert.mockReset().mockResolvedValue({ error: null });
  supabaseMock.fromCalls = [];
  localStorage.clear();
}

describe("nativePush 기기 등록 상태 판정 — P1 버그 회귀 테스트", () => {
  beforeEach(resetAll);

  it("1. unsupported 플랫폼 — permission 조회 자체를 안 하고 즉시 반환", async () => {
    mockState.isNative = false;
    const status = await getNativePushStatus();
    expect(status).toBe("unsupported");
    await autoRegisterNativePushOnLogin();
    expect(pushMock.checkPermissions).not.toHaveBeenCalled();
    expect(pushMock.register).not.toHaveBeenCalled();
  });

  it("2. permission denied — register()를 호출하지 않고, requestPermissions()로 재요청하지 않음(팝업 반복 방지)", async () => {
    pushMock.checkPermissions.mockResolvedValue({ receive: "denied" });
    expect(await getNativePushStatus()).toBe("unsubscribed");
    await autoRegisterNativePushOnLogin();
    expect(pushMock.requestPermissions).not.toHaveBeenCalled();
    expect(pushMock.register).not.toHaveBeenCalled();
  });

  it("3. permission prompt — requestPermissions()로 요청하고, 승인되면 register() 진행", async () => {
    pushMock.checkPermissions.mockResolvedValue({ receive: "prompt" });
    pushMock.requestPermissions.mockResolvedValue({ receive: "granted" });
    await autoRegisterNativePushOnLogin();
    expect(pushMock.requestPermissions).toHaveBeenCalledTimes(1);
    expect(pushMock.register).toHaveBeenCalledTimes(1);
    expect(supabaseMock.upsert).toHaveBeenCalledTimes(1);
  });

  it("4. permission granted + 이 기기 미등록(버그 재현 시나리오) — register() 경로로 반드시 진행됨", async () => {
    // 실기기에서 재현된 정확한 상황: OS 권한은 이미 granted, 이 기기는 등록한 적 없음
    // (localStorage 비어 있음). 수정 전 코드였다면 getNativePushStatus()가 permission만
    // 보고 "subscribed"를 반환해 아래 register()가 전혀 호출되지 않았을 것이다.
    expect(isDeviceRegisteredLocally()).toBe(false);
    expect(await getNativePushStatus()).toBe("unsubscribed");

    await autoRegisterNativePushOnLogin();

    expect(pushMock.register).toHaveBeenCalledTimes(1);
    expect(supabaseMock.fromCalls).toContain("native_push_tokens");
    expect(supabaseMock.upsert).toHaveBeenCalledWith(
      { account_id: "account-1", platform: "android", token: fakeToken },
      { onConflict: "token" }
    );
    expect(isDeviceRegisteredLocally()).toBe(true);
    expect(await getNativePushStatus()).toBe("subscribed");
  });

  it("5. 동일 세션에서 auth 이벤트 중복 발생 — register()가 딱 한 번만 호출됨(in-flight dedupe)", async () => {
    const p1 = autoRegisterNativePushOnLogin();
    const p2 = autoRegisterNativePushOnLogin();
    await Promise.all([p1, p2]);
    expect(pushMock.register).toHaveBeenCalledTimes(1);
    expect(supabaseMock.upsert).toHaveBeenCalledTimes(1);
  });

  it("6. registration 토큰 수신 시 native_push_tokens에 정확한 컬럼으로 upsert됨", async () => {
    await enableNativePush();
    expect(supabaseMock.upsert).toHaveBeenCalledWith(
      { account_id: "account-1", platform: "android", token: fakeToken },
      { onConflict: "token" }
    );
  });

  it("7. upsert 실패는 throw하지 않고, 로컬 등록 플래그도 세워지지 않음(다음 시도 때 재시도 가능)", async () => {
    supabaseMock.upsert.mockResolvedValue({ error: { message: "network down" } });
    await expect(autoRegisterNativePushOnLogin()).resolves.toBeUndefined();
    expect(isDeviceRegisteredLocally()).toBe(false);
    expect(await getNativePushStatus()).toBe("unsubscribed");
  });

  it("8. getNativePushStatus()는 native_push_tokens 테이블을 절대 조회하지 않는다(다른 기기/다른 계정 row 존재 여부에 영향받지 않음)", async () => {
    // account_id+platform row 존재 여부로 판정하는 방식은 의도적으로 쓰지 않았다 — 같은
    // 계정으로 다른 기기가 이미 등록해놨어도 "지금 이 기기"의 등록 여부와는 무관해야 한다.
    await getNativePushStatus();
    expect(supabaseMock.fromCalls).not.toContain("native_push_tokens");
  });

  it("9. disableNativePush() 이후 — 로컬 플래그가 지워져 다음 로그인 때 재등록이 진행됨(로그아웃/계정전환 회귀 방지)", async () => {
    await autoRegisterNativePushOnLogin();
    expect(isDeviceRegisteredLocally()).toBe(true);

    await disableNativePush();
    expect(isDeviceRegisteredLocally()).toBe(false);
    expect(await getNativePushStatus()).toBe("unsubscribed");

    pushMock.register.mockClear();
    supabaseMock.upsert.mockClear();
    await autoRegisterNativePushOnLogin();
    expect(pushMock.register).toHaveBeenCalledTimes(1);
    expect(isDeviceRegisteredLocally()).toBe(true);
  });

  it("10. disableNativePush()는 계정 조회가 실패해도(로그아웃 진행 중 등) 로컬 플래그를 먼저 지운다", async () => {
    await autoRegisterNativePushOnLogin();
    expect(isDeviceRegisteredLocally()).toBe(true);

    authAccountMock.accountId = null;
    const result = await disableNativePush();
    expect(result.ok).toBe(true);
    expect(isDeviceRegisteredLocally()).toBe(false);
  });

  it("11. clearDeviceRegisteredLocally()는 unsupported 플랫폼에서도 예외를 던지지 않는다", () => {
    mockState.isNative = false;
    expect(() => clearDeviceRegisteredLocally()).not.toThrow();
  });

  it("12. iOS에서도 동일한 로컬 등록 플래그 로직을 공유한다(플랫폼별 분기 없음 확인)", async () => {
    mockState.platform = "ios";
    expect(isDeviceRegisteredLocally()).toBe(false);
    expect(await getNativePushStatus()).toBe("unsubscribed");
    // iOS는 FcmToken 커스텀 플러그인 경로를 타므로 이 테스트에서는 registration 이벤트가
    // 안 온다(registerPlugin mock의 getToken이 빈 값 반환) — 여기서는 getNativePushStatus()
    // 자체가 플랫폼과 무관하게 "permission + 로컬 플래그"만 본다는 것만 고정한다.
  });
});
