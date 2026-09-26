/*
  실기기 QA(2026-09-25) — 예약 캘린더 "내 캘린더에 추가"/"캘린더에 추가"/"저장" 버튼.
  기존 원인: blob + <a download> 클릭은 iOS WKWebView에서 조용히 무시된다. exportIcs는 Web Share를
  먼저 쓰고, 앱(WebView)에서 둘 다 불가하면 조용히 넘어가지 않고 에러를 던진다.
*/
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportIcs, reservationsToIcs, type CalReservation } from "../../lib/mypage";

const item = {
  id: "r1", title: "필라테스", centerName: "노는반", profileName: "손", memo: "", status: "confirmed",
  date: "2026-09-05", time: "11:44", startIso: "2026-09-05T02:44:00.000Z", endIso: "2026-09-05T03:44:00.000Z",
} as unknown as CalReservation;

afterEach(() => { vi.unstubAllGlobals(); });

describe("exportIcs", () => {
  it("ICS 본문에 일정 정보가 들어간다", () => {
    const ics = reservationsToIcs([item]);
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("SUMMARY:필라테스 · 노는반");
  });

  it("Web Share로 파일 공유가 가능하면 공유 시트를 열고 'shared'를 돌려준다", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await exportIcs([item], "a.ics")).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0][0];
    expect(arg.files[0].name).toBe("a.ics");
    expect(arg.files[0].type).toBe("text/calendar");
  });

  it("사용자가 공유 시트를 닫으면(AbortError) 'cancelled' — 실패로 취급하지 않는다", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("x", "AbortError"));
    vi.stubGlobal("navigator", { share, canShare: () => true });
    expect(await exportIcs([item], "a.ics")).toBe("cancelled");
  });

  it("네이티브 앱(WebView)인데 공유가 불가하면 조용히 넘어가지 않고 에러를 던진다", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => true } });
    await expect(exportIcs([item], "a.ics")).rejects.toThrow(/캘린더/);
  });
});

describe("예약 캘린더 화면 — 버튼이 실제 핸들러에 연결돼 있다", () => {
  const src = readFileSync(join(__dirname, "../../app/mypage/calendar/page.tsx"), "utf-8");
  it("상단 '내 캘린더에 추가'는 현재 표시 중인 달(cal.y/cal.m) 기준으로 시트를 연다", () => {
    expect(src).toContain('onClick={openMonthSheet}');
    expect(src).toContain("filterEventsByMonth(upcoming, cal.y, cal.m)");
    expect(src).toContain("`${cal.y}년 ${cal.m}월 일정`");
  });
  it("카드의 '캘린더에 추가'는 같은 공용 서비스(addCalendarEvents/시트)를 쓴다", () => {
    expect(src).toContain("void addOne(r)");
    expect(src).toContain('mode: "single"');
    expect(src).toContain("addCalendarEvents([item]");
  });
  it("'저장'은 저장 성공 후에만 '저장됨'을 표시하고, 실패는 에러로 알린다", () => {
    expect(src).toContain('savedId === r.id ? "저장됨"');
    expect(src).toMatch(/await updateReservationMemo\(r\.id, val\);[\s\S]*setSavedId\(r\.id\)/);
    expect(src).toContain("catch (e: any) { setError(e.message); }");
  });
});
