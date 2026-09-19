import { expect, it, vi } from "vitest";
const send = vi.hoisted(() => vi.fn());
vi.mock("../../lib/messaging", () => ({ getMessageService: () => ({ send }) }));
import { sendAlimtalkToMembers } from "../../lib/members";
it("separates known failures from lost responses and identifies duplicate names by index", async () => {
  send.mockResolvedValueOnce({ status: "sent" }).mockResolvedValueOnce({ status: "failed" }).mockRejectedValueOnce(new Error("timeout"));
  const result = await sendAlimtalkToMembers([{ name: "동명이인", phone: "1" }, { name: "동명이인", phone: "2" }, { name: "미확인", phone: "3" }, { name: "번호없음", phone: null }], "test", "center");
  expect(send).toHaveBeenCalledTimes(3);
  expect(result).toMatchObject({ sent: 1, failed: 2, skipped: 1 });
  expect(result.recipients.map(({ index, status }) => [index, status])).toEqual([[0, "sent"], [1, "failed"], [2, "unknown"], [3, "skipped"]]);
});
