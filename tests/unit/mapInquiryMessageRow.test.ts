/*
  Low-Egress Fix Batch(2026-09-11) — InquiryChat이 Realtime INSERT 페이로드를
  전체 재조회 대신 이 순수 함수로 바로 화면 상태에 append하도록 바꿨다. fetchMessages()
  (DB 조회)와 실시간 핸들러(app/components/InquiryChat.tsx) 양쪽이 같은 변환 로직을
  공유하므로, 그 로직 자체(mine 판별·null 필드 처리)만 라이브 DB 없이 검증한다.
*/
import { describe, expect, it } from "vitest";
import { mapInquiryMessageRow } from "../../lib/inquiries";

const baseRow = {
  id: "msg-1",
  thread_id: "thread-1",
  sender_account_id: "acc-a",
  sender_role: "member" as const,
  body: "안녕하세요",
  photos: null,
  created_at: "2026-09-11T03:00:00.000Z",
};

describe("mapInquiryMessageRow", () => {
  it("sender_account_id가 myAccountId와 같으면 mine=true", () => {
    expect(mapInquiryMessageRow(baseRow, "acc-a").mine).toBe(true);
  });

  it("sender_account_id가 myAccountId와 다르면 mine=false", () => {
    expect(mapInquiryMessageRow(baseRow, "acc-b").mine).toBe(false);
  });

  it("myAccountId가 null이면(아직 로그인 확인 전) mine=false로 안전하게 처리", () => {
    expect(mapInquiryMessageRow(baseRow, null).mine).toBe(false);
  });

  it("body가 null이면 빈 문자열로 폴백한다", () => {
    expect(mapInquiryMessageRow({ ...baseRow, body: null }, "acc-a").body).toBe("");
  });

  it("id/threadId/senderRole/photos/createdAtRaw를 그대로 옮긴다", () => {
    const msg = mapInquiryMessageRow({ ...baseRow, photos: ["a.jpg", "b.jpg"] }, "acc-a");
    expect(msg.id).toBe("msg-1");
    expect(msg.threadId).toBe("thread-1");
    expect(msg.senderRole).toBe("member");
    expect(msg.photos).toEqual(["a.jpg", "b.jpg"]);
    expect(msg.createdAtRaw).toBe("2026-09-11T03:00:00.000Z");
  });
});
