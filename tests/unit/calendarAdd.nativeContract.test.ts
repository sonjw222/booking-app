/*
  2026-09-26 — 네이티브 브릿지 존재/계약 정적 검증. (Swift/Java는 vitest로 컴파일할 수 없으므로
  등록·메서드명·JS 계약 일치와 "사용자 확인 없이 저장하지 않음" 같은 정책만 고정한다.)
*/
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf-8");

describe("iOS CalendarEvent 플러그인", () => {
  const swift = read("ios/App/App/WebViewThemePlugin.swift");
  it("jsName/메서드가 JS 계약(lib/calendarAdd.ts)과 일치", () => {
    expect(swift).toContain('public let jsName = "CalendarEvent"');
    expect(swift).toContain('CAPPluginMethod(name: "addEvent"');
    expect(swift).toContain('CAPPluginMethod(name: "shareIcs"');
    const ts = read("lib/calendarAdd.ts");
    expect(ts).toContain('registerPlugin<CalendarEventPlugin>("CalendarEvent")');
  });
  it("표준 시스템 일정 UI(EKEventEditViewController) — 사용자가 저장을 눌러야 확정, EKEventStore.save 직접 호출 없음", () => {
    expect(swift).toContain("EKEventEditViewController()");
    expect(swift).not.toMatch(/eventStore\.save\(/);
    expect(swift).toContain("didCompleteWith action");
  });
  it("다른 앱 선택은 시스템 Share Sheet(UIActivityViewController) — 앱 이름/URL scheme 추측 없음", () => {
    expect(swift).toContain("UIActivityViewController(activityItems: [url]");
    expect(swift).not.toMatch(/googlecalendar|ms-outlook|canOpenURL/);
  });
  it("iOS 15/16 접근 요청은 Info.plist 키가 있을 때만(없으면 UNAVAILABLE → JS가 Share로 전환)", () => {
    expect(swift).toContain('forInfoDictionaryKey: "NSCalendarsUsageDescription"');
    expect(swift).toContain("UNAVAILABLE");
  });
  it("중복 실행 방지(pendingCall/sharing)", () => {
    expect(swift).toContain("guard pendingCall == nil");
    expect(swift).toContain("guard !sharing");
  });
  it("SceneDelegate에 등록되어 있다", () => {
    expect(read("ios/App/App/SceneDelegate.swift")).toContain("registerPluginInstance(CalendarEventPlugin())");
  });
  it("새 .swift 파일을 만들지 않아 project.pbxproj 수정이 필요 없다(WebViewThemePlugin.swift에 포함)", () => {
    expect(existsSync(join(root, "ios/App/App/CalendarEventPlugin.swift"))).toBe(false);
  });
});

describe("Android CalendarEvent 플러그인", () => {
  const java = read("android/app/src/main/java/com/mwhabit/app/CalendarEventPlugin.java");
  it("CalendarContract ACTION_INSERT + chooser 옵션(createChooser)", () => {
    expect(java).toContain('@CapacitorPlugin(name = "CalendarEvent")');
    expect(java).toContain("Intent.ACTION_INSERT");
    expect(java).toContain("CalendarContract.Events.CONTENT_URI");
    expect(java).toContain("Intent.createChooser");
    for (const f of ["Events.TITLE", "EXTRA_EVENT_BEGIN_TIME", "EXTRA_EVENT_END_TIME", "Events.EVENT_LOCATION", "Events.DESCRIPTION"]) {
      expect(java).toContain(f);
    }
  });
  it("캘린더 DB에 직접 쓰지 않는다(ContentResolver insert 없음) — 사용자가 시스템 화면에서 저장", () => {
    expect(java).not.toMatch(/getContentResolver|ContentValues/);
  });
  it("MainActivity에 등록", () => {
    expect(read("android/app/src/main/java/com/mwhabit/app/MainActivity.java")).toContain("registerPlugin(CalendarEventPlugin.class)");
  });
  it("AndroidManifest에 캘린더 권한이 필요 없다(인텐트 방식)", () => {
    expect(read("android/app/src/main/AndroidManifest.xml")).not.toMatch(/WRITE_CALENDAR|READ_CALENDAR/);
  });
});

describe("Info.plist", () => {
  it("NSCalendarsUsageDescription(사용자에게 의미가 명확한 문구)", () => {
    const plist = read("ios/App/App/Info.plist");
    expect(plist).toContain("<key>NSCalendarsUsageDescription</key>");
    expect(plist).toContain("예약한 수업을 내 캘린더에 추가하기 위해");
  });
});
