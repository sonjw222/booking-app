/*
  P2(social-auth-notifications 배치): 알림 설정 토글(app/settings/notifications) → 실시간
  팝업(NotificationToaster) 연결의 kind→카테고리 매핑 단위 테스트.

  기존 구조 감사 결과, 이 4개 토글은 localStorage에만 저장되고 서버 트리거/클라이언트
  어디에서도 읽지 않는 죽은 설정이었다(알림 자체는 항상 만들어짐). 팝업 표시 여부만이라도
  이 값을 실제로 반영하도록 연결했고, 그 판단 로직(어떤 kind가 어떤 토글에 속하는지)이
  정확한지 이 테스트로 고정한다.
*/
import { describe, expect, it } from "vitest";
import { notiPrefKeyForKind, getNotiPrefs, NOTI_PREF_STORAGE_KEY, NOTI_PREF_DEFAULTS } from "../../lib/notifications";

// vitest.config.ts는 environment: "node"라 브라우저 localStorage가 없다 — getNotiPrefs()는
// 실제로는 브라우저에서만 호출되지만, 이 순수 폴백 로직 테스트를 위해 최소 스텁만 둔다.
if (typeof (globalThis as any).localStorage === "undefined") {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

describe("notiPrefKeyForKind", () => {
  it("예약 확정·취소·관리자 배치/취소·노쇼는 reservation 카테고리", () => {
    expect(notiPrefKeyForKind("reservation_confirmed")).toBe("reservation");
    expect(notiPrefKeyForKind("reservation_canceled")).toBe("reservation");
    expect(notiPrefKeyForKind("admin_assigned")).toBe("reservation");
    expect(notiPrefKeyForKind("admin_cancelled")).toBe("reservation");
    expect(notiPrefKeyForKind("no_show")).toBe("reservation");
  });

  it("대기 등록·승격은 waitlist 카테고리", () => {
    expect(notiPrefKeyForKind("reservation_waitlisted")).toBe("waitlist");
    expect(notiPrefKeyForKind("waitlist_promoted")).toBe("waitlist");
  });

  it("수업 임박 알림은 reminder 카테고리", () => {
    expect(notiPrefKeyForKind("reservation_3days")).toBe("reminder");
    expect(notiPrefKeyForKind("reservation_today")).toBe("reminder");
  });

  it("공지/문의/매니저 전용 알림 등 4개 토글 대상이 아닌 종류는 null(항상 팝업)", () => {
    expect(notiPrefKeyForKind("announcement")).toBeNull();
    expect(notiPrefKeyForKind("new_inquiry")).toBeNull();
    expect(notiPrefKeyForKind("inquiry_reply")).toBeNull();
    expect(notiPrefKeyForKind("new_order")).toBeNull();
    expect(notiPrefKeyForKind("new_review")).toBeNull();
    expect(notiPrefKeyForKind("pass_expired")).toBeNull();
    expect(notiPrefKeyForKind("pass_used_up")).toBeNull();
  });
});

describe("getNotiPrefs", () => {
  it("저장된 값이 없으면 기본값(reservation/waitlist/reminder=on, marketing=off)을 반환한다", () => {
    localStorage.removeItem(NOTI_PREF_STORAGE_KEY);
    expect(getNotiPrefs()).toEqual(NOTI_PREF_DEFAULTS);
  });

  it("저장된 값이 있으면 기본값 위에 덮어써서 반환한다", () => {
    localStorage.setItem(NOTI_PREF_STORAGE_KEY, JSON.stringify({ reservation: false }));
    expect(getNotiPrefs()).toEqual({ ...NOTI_PREF_DEFAULTS, reservation: false });
  });

  it("저장된 값이 손상돼도(JSON 파싱 실패) 기본값으로 안전하게 폴백한다", () => {
    localStorage.setItem(NOTI_PREF_STORAGE_KEY, "{invalid json");
    expect(getNotiPrefs()).toEqual(NOTI_PREF_DEFAULTS);
  });
});
