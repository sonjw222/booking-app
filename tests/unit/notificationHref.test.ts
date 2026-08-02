/*
  notificationHref()의 URL/thread_id 파싱 단위 테스트(NOTIF-001 딥링크 재검증).

  실브라우저 QA에서 "알림 클릭 시 문의 목록까지만 이동하고 채팅방이 바로 열리지 않는다"는
  보고를 받고 전체 경로를 재추적한 결과, 회원 알림 목록/매니저 알림 목록 페이지의 클릭
  핸들러는 이미 thread_id를 딥링크에 반영하고 있었지만, 실시간 토스트 팝업
  (NotificationToaster)이 단순 `n.link`만 사용해 이 분기 자체가 빠져 있었던 게 실제 원인
  이었다. 세 곳(회원 목록/매니저 목록/토스트)이 이제 이 함수 하나만 공유한다.
*/
import { describe, expect, it } from "vitest";
import { notificationHref } from "../../lib/notifications";

describe("notificationHref", () => {
  it("new_inquiry + thread_id + link이 있으면 ?thread= 쿼리를 붙인다(매니저용)", () => {
    expect(
      notificationHref({ kind: "new_inquiry", link: "/manager/inquiries", data: { thread_id: "t1" } })
    ).toBe("/manager/inquiries?thread=t1");
  });

  it("inquiry_reply + thread_id + link이 있으면 ?thread= 쿼리를 붙인다(회원용)", () => {
    expect(
      notificationHref({ kind: "inquiry_reply", link: "/inquiries", data: { thread_id: "t2" } })
    ).toBe("/inquiries?thread=t2");
  });

  it("문의 알림이라도 thread_id가 없으면 link 그대로 사용한다", () => {
    expect(
      notificationHref({ kind: "inquiry_reply", link: "/inquiries", data: null })
    ).toBe("/inquiries");
  });

  it("문의 알림이 아니면 thread_id가 있어도 무시하고 link 그대로 사용한다", () => {
    expect(
      notificationHref({ kind: "reservation_canceled", link: "/my-reservations", data: { thread_id: "t3" } })
    ).toBe("/my-reservations");
  });

  it("link 자체가 없으면 알림 목록으로 fallback한다", () => {
    expect(notificationHref({ kind: "announcement", link: null, data: null })).toBe("/notifications");
  });
});
