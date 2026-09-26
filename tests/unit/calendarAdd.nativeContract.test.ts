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
  it("1건은 표준 시스템 일정 UI(EKEventEditViewController) — 사용자가 저장을 눌러야 확정", () => {
    expect(swift).toContain("EKEventEditViewController()");
    expect(swift).toContain("didCompleteWith action");
  });
  it("여러 건 batch 저장은 addEvents(사용자가 시트에서 CTA를 누른 뒤 호출)에서만, 권한 승인 후에만 save", () => {
    expect(swift).toContain('CAPPluginMethod(name: "addEvents"');
    const saves = swift.match(/eventStore\.save\(/g) ?? [];
    expect(saves).toHaveLength(1); // saveBatch 안 한 곳뿐
    const batch = swift.slice(swift.indexOf("@objc func addEvents"), swift.indexOf("private func finish(resolve"));
    expect(batch).toContain("eventStore.save(event, span: .thisEvent, commit: false)");
    expect(batch).toContain("try eventStore.commit()");
    // commit 실패는 성공으로 보고하지 않는다
    expect(batch).toContain("saved = 0");
  });
  it("iOS 17+는 write-only 접근(기존 캘린더를 읽지 않음), 15/16은 event access", () => {
    expect(swift).toContain("requestWriteOnlyAccessToEvents");
    expect(swift).toContain('hasPlistKey("NSCalendarsWriteOnlyAccessUsageDescription")');
    expect(swift).toContain("requestAccess(to: .event)");
    expect(swift).toContain('hasPlistKey("NSCalendarsUsageDescription")');
    expect(swift).not.toContain("requestFullAccessToEvents");
    expect(swift).toContain("UNAVAILABLE");
  });
  it("하루 종일 일정: EventKit endDate는 마지막 날(포함) — DTEND(exclusive)에서 하루를 뺀다", () => {
    expect(swift).toContain("event.isAllDay = true");
    expect(swift).toContain("byAdding: .day, value: -1");
  });
  it("다른 앱 선택은 UIDocumentInteractionController Open In → 앱이 없으면 Share Sheet — 앱 이름/URL scheme 추측 없음", () => {
    expect(swift).toContain('CAPPluginMethod(name: "openIcs"');
    expect(swift).toContain("presentOpenInMenu(from:");
    expect(swift).toContain("UIActivityViewController(activityItems: [url]");
    expect(swift).not.toMatch(/googlecalendar|ms-outlook|naver|canOpenURL/i);
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
  it("여러 건은 FileProvider(cache)로 .ics를 ACTION_VIEW(text/calendar) — 기존 provider 재사용", () => {
    expect(java).toContain("public void openIcs");
    expect(java).toContain("Intent.ACTION_VIEW");
    expect(java).toContain('"text/calendar"');
    expect(java).toContain("FileProvider.getUriForFile");
    expect(java).toContain('getPackageName() + ".fileprovider"');
    expect(java).toContain("EXTRA_EVENT_ALL_DAY");
    const manifest = read("android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain("${applicationId}.fileprovider");
    expect(read("android/app/src/main/res/xml/file_paths.xml")).toContain("cache-path");
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
    // iOS 17+ write-only(batch 저장) — 읽기 권한 문구(FullAccess)는 요구하지 않는다
    expect(plist).toContain("<key>NSCalendarsWriteOnlyAccessUsageDescription</key>");
    expect(plist).toContain("캘린더 쓰기 권한이 필요합니다");
    expect(plist).not.toContain("NSCalendarsFullAccessUsageDescription");
  });
});
