import Foundation
import UIKit
import EventKit
import EventKitUI
import Capacitor

/*
  iOS 전용 — WKWebView의 오버스크롤(rubber-band) 배경색을 앱의 현재 라이트/다크 테마에
  맞춰 런타임에 바꾼다.

  릴리스 폴리시 배치(2026-09-14, 2차) — capacitor.config.ts의 정적 backgroundColor 하나만
  으로는 라이트 테마 기준 색(#FBFBFA)으로 고정돼, 사용자가 다크(차콜) 테마를 쓰면 오버스크롤
  구간에서 여전히 어긋나 보였다("navy strip"과 같은 종류의 문제 — 실기기 진단
  2026-09-11/2026-09-14 참고). 두 단계로 해결:
  1. SceneDelegate.swift가 앱 기동 시 iOS 시스템 라이트/다크 설정을 자동으로 따라가는
     동적 UIColor(dynamicProvider:)를 baseline으로 설정 — "시스템 설정 따르기"가 기본값인
     사용자는 이것만으로 이미 맞다.
  2. 이 앱은 시스템 설정과 별개로 앱 안에서 라이트/다크를 직접 고를 수도 있어(설정 화면),
     그 명시적 선택까지 반영하려면 JS가 "지금 실제로 적용된 테마가 뭔지" 알려줘야 한다 —
     이 플러그인이 그 마지막 다리 역할(작은 로컬 커스텀 플러그인, FcmTokenPlugin.swift와
     동일한 선례 — 신규 npm 의존성 없음). app/layout.tsx의 하이드레이션 전 인라인 테마
     스크립트(콜드 스타트 커버)와 app/settings/theme/page.tsx의 applyTheme()(런타임 전환
     커버) 양쪽에서 호출한다.
*/
@objc(WebViewThemePlugin)
public class WebViewThemePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebViewThemePlugin"
    public let jsName = "WebViewTheme"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setBackground", returnType: CAPPluginReturnPromise)
    ]

    @objc func setBackground(_ call: CAPPluginCall) {
        guard let hex = call.getString("hex"), let color = UIColor(mwhabitHex: hex) else {
            call.reject("유효한 hex 색상(#RRGGBB)이 필요해요")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.bridge?.webView else {
                call.resolve()
                return
            }
            webView.backgroundColor = color
            webView.scrollView.backgroundColor = color
            if #available(iOS 15.0, *) {
                // 오버스크롤(elastic scrolling) 중 실제 페이지 콘텐츠 밖에 보이는 색을
                // 위한 공식 API(Apple 문서) — scrollView.backgroundColor와 함께 둘 다
                // 맞춰준다(Capacitor 자체가 scrollView.backgroundColor 쪽만 쓰므로 그게
                // 실기기에서 확인된 핵심 레이어이지만, 최신 API도 같이 맞추는 게 안전).
                webView.underPageBackgroundColor = color
            }
            call.resolve()
        }
    }
}

private extension UIColor {
    // "#RRGGBB" 형식만 지원 — 이 앱의 CSS 커스텀 프로퍼티(--bg)가 전부 이 형식이라
    // 그 이상은 필요 없다.
    convenience init?(mwhabitHex hex: String) {
        var s = hex
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        let r = CGFloat((value >> 16) & 0xFF) / 255.0
        let g = CGFloat((value >> 8) & 0xFF) / 255.0
        let b = CGFloat(value & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b, alpha: 1)
    }
}

/*
  iOS 전용 — "캘린더에 추가"(2026-09-26). 이 앱 전용 작은 로컬 플러그인(FcmTokenPlugin.swift와 동일한
  선례 — 신규 npm 의존성 없음). jsName "CalendarEvent" — JS 쪽은 lib/calendarAdd.ts.

  이 클래스를 별도 파일이 아니라 이 파일에 둔 이유: 새 .swift 파일을 프로젝트에 넣으려면
  App.xcodeproj/project.pbxproj를 수정해야 하는데, 그 파일은 배포용 로컬 변경(서명/빌드 설정)이
  미커밋 상태로 들어 있어 이번 커밋에 섞이면 안 된다. 기존 추적 파일에 붙이면 pbxproj 변경이 필요 없다.

  - addEvent(1건): EKEventEditViewController(EventKitUI 표준 일정 추가 화면)에 제목/시작/종료(또는
    하루 종일)/위치/메모를 미리 채워 띄운다. 사용자가 화면에서 "추가"를 눌러야만 저장된다.
    · iOS 17+: 시스템 이벤트 UI는 별도 캘린더 권한 없이 동작한다.
    · iOS 15/16: 저장하려면 캘린더 접근 권한이 필요해 requestAccess를 먼저 호출한다(Info.plist의
      NSCalendarsUsageDescription 필요 — 없으면 크래시하므로 키가 없으면 UNAVAILABLE로 reject).
  - addEvents(여러 건, 2026-09-26 2차): 사용자가 앱 시트에서 "기본 캘린더에 추가"를 누른 뒤 호출된다.
    · iOS 17+: requestWriteOnlyAccessToEvents — 쓰기 전용 접근(기존 캘린더 내용을 읽지 않음). Info.plist의
      NSCalendarsWriteOnlyAccessUsageDescription 필요(없으면 크래시 → 키가 없으면 UNAVAILABLE).
    · iOS 15/16: requestAccess(to: .event)(쓰기 전용 API가 없음 — NSCalendarsUsageDescription).
    · 기기 기본 캘린더(defaultCalendarForNewEvents)에 저장하고 commit은 한 번. 결과는 {saved, failed}.
  - openIcs: .ics를 임시 파일로 쓰고 UIDocumentInteractionController의 "Open In" 메뉴로 연다 — 이 파일을 열
    수 있다고 OS에 등록된 설치 앱만 표시된다(앱 이름/URL scheme 추측 없음). 표시할 앱이 없으면
    시스템 Share Sheet(UIActivityViewController)로 자동 전환한다.
  - shareIcs: Share Sheet 직접 호출(기존 호환).
*/
@objc(CalendarEventPlugin)
public class CalendarEventPlugin: CAPPlugin, CAPBridgedPlugin, EKEventEditViewDelegate, UIDocumentInteractionControllerDelegate {
    public let identifier = "CalendarEventPlugin"
    public let jsName = "CalendarEvent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "addEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "addEvents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openIcs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareIcs", returnType: CAPPluginReturnPromise)
    ]

    private let eventStore = EKEventStore()
    private var pendingCall: CAPPluginCall?   // 이벤트 편집 화면/batch 저장이 진행 중인 동안 유지(중복 실행 방지 겸용)
    private var sharing = false
    private var docController: UIDocumentInteractionController?
    private var docCall: CAPPluginCall?
    private var docTempURL: URL?
    private var docSentToApp = false

    // MARK: - 공용 파싱

    /// 하루 종일 일정용 "yyyy-MM-dd" → 기기 로컬 시간대 자정.
    private static func localMidnight(_ day: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: day)
    }

    /// JS payload → EKEvent(저장은 하지 않음). 잘못된 값이면 nil.
    private func makeEvent(_ obj: [String: Any]) -> EKEvent? {
        guard let title = obj["title"] as? String else { return nil }
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        if (obj["allDay"] as? Bool) == true {
            guard let startDay = obj["startDay"] as? String, let endExclusive = obj["endDayExclusive"] as? String,
                  let start = CalendarEventPlugin.localMidnight(startDay),
                  let endEx = CalendarEventPlugin.localMidnight(endExclusive),
                  let last = Calendar.current.date(byAdding: .day, value: -1, to: endEx) else { return nil }
            // EventKit all-day: endDate는 마지막 날(포함). iCalendar의 DTEND(exclusive)에서 하루를 뺀다.
            event.isAllDay = true
            event.startDate = start
            event.endDate = max(last, start)
        } else {
            guard let startMs = (obj["startMs"] as? NSNumber)?.doubleValue,
                  let endMs = (obj["endMs"] as? NSNumber)?.doubleValue else { return nil }
            event.startDate = Date(timeIntervalSince1970: startMs / 1000.0)
            event.endDate = Date(timeIntervalSince1970: endMs / 1000.0)
        }
        event.location = obj["location"] as? String
        event.notes = obj["notes"] as? String
        return event
    }

    private func hasPlistKey(_ key: String) -> Bool {
        return Bundle.main.object(forInfoDictionaryKey: key) != nil
    }

    // MARK: - addEvent (1건, 표준 편집 화면)

    @objc func addEvent(_ call: CAPPluginCall) {
        guard pendingCall == nil else {
            call.reject("이미 일정 추가 화면이 열려 있어요", "BUSY")
            return
        }
        guard call.getString("title") != nil else {
            call.reject("title이 필요해요", "INVALID")
            return
        }
        var raw: [String: Any] = [:]
        for key in ["title", "allDay", "startDay", "endDayExclusive", "startMs", "endMs", "location", "notes"] {
            if let v = call.options[key] { raw[key] = v }
        }
        pendingCall = call

        let present: () -> Void = { [weak self] in
            guard let self = self else { return }
            guard let event = self.makeEvent(raw) else {
                self.finish(reject: "일정 정보가 올바르지 않아요", code: "INVALID")
                return
            }
            self.presentEditor(event)
        }
        if #available(iOS 17.0, *) {
            DispatchQueue.main.async(execute: present)
        } else {
            guard hasPlistKey("NSCalendarsUsageDescription") else {
                finish(reject: "캘린더 권한 설명이 앱에 없어요", code: "UNAVAILABLE")
                return
            }
            eventStore.requestAccess(to: .event) { [weak self] granted, _ in
                DispatchQueue.main.async {
                    if granted { present() } else { self?.finish(reject: "캘린더 접근이 허용되지 않았어요", code: "DENIED") }
                }
            }
        }
    }

    private func presentEditor(_ event: EKEvent) {
        guard let host = bridge?.viewController else {
            finish(reject: "화면을 열 수 없어요", code: "UNAVAILABLE")
            return
        }
        if let calendar = eventStore.defaultCalendarForNewEvents { event.calendar = calendar }
        let editor = EKEventEditViewController()
        editor.eventStore = eventStore
        editor.event = event
        editor.editViewDelegate = self
        host.present(editor, animated: true)
    }

    public func eventEditViewController(_ controller: EKEventEditViewController, didCompleteWith action: EKEventEditViewAction) {
        let result: String
        switch action {
        case .saved: result = "saved"
        case .deleted: result = "deleted"
        default: result = "canceled"
        }
        controller.dismiss(animated: true) { [weak self] in
            self?.finish(resolve: ["result": result])
        }
    }

    // MARK: - addEvents (여러 건 batch 저장)

    @objc func addEvents(_ call: CAPPluginCall) {
        guard pendingCall == nil else {
            call.reject("이미 일정 추가가 진행 중이에요", "BUSY")
            return
        }
        guard let events = call.options["events"] as? [[String: Any]], !events.isEmpty else {
            call.reject("events가 필요해요", "INVALID")
            return
        }
        pendingCall = call

        let save: () -> Void = { [weak self] in self?.saveBatch(events) }
        if #available(iOS 17.0, *) {
            // 쓰기 전용 — 기존 캘린더 내용을 읽지 않는다.
            guard hasPlistKey("NSCalendarsWriteOnlyAccessUsageDescription") else {
                finish(reject: "캘린더 권한 설명이 앱에 없어요", code: "UNAVAILABLE")
                return
            }
            eventStore.requestWriteOnlyAccessToEvents { [weak self] granted, _ in
                if granted { save() } else { self?.finish(reject: "캘린더 쓰기가 허용되지 않았어요", code: "DENIED") }
            }
        } else {
            guard hasPlistKey("NSCalendarsUsageDescription") else {
                finish(reject: "캘린더 권한 설명이 앱에 없어요", code: "UNAVAILABLE")
                return
            }
            eventStore.requestAccess(to: .event) { [weak self] granted, _ in
                if granted { save() } else { self?.finish(reject: "캘린더 접근이 허용되지 않았어요", code: "DENIED") }
            }
        }
    }

    private func saveBatch(_ events: [[String: Any]]) {
        guard let calendar = eventStore.defaultCalendarForNewEvents else {
            finish(reject: "기본 캘린더를 찾을 수 없어요", code: "NO_CALENDAR")
            return
        }
        var saved = 0
        var failed = 0
        var pending: [EKEvent] = []
        for raw in events {
            guard let event = makeEvent(raw) else { failed += 1; continue }
            event.calendar = calendar
            do {
                try eventStore.save(event, span: .thisEvent, commit: false)
                pending.append(event)
                saved += 1
            } catch {
                failed += 1
            }
        }
        do {
            try eventStore.commit()
        } catch {
            // commit 실패 = 실제로는 하나도 저장되지 않음 — 성공으로 보고하지 않는다.
            eventStore.reset()
            failed += saved
            saved = 0
        }
        finish(resolve: ["saved": saved, "failed": failed])
    }

    private func finish(resolve data: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.pendingCall?.resolve(data)
            self?.pendingCall = nil
        }
    }

    private func finish(reject message: String, code: String) {
        DispatchQueue.main.async { [weak self] in
            self?.pendingCall?.reject(message, code)
            self?.pendingCall = nil
        }
    }

    // MARK: - openIcs (Open In → 없으면 Share Sheet)

    private func writeTempIcs(_ call: CAPPluginCall) -> URL? {
        guard let ics = call.getString("ics"), let rawName = call.getString("filename"), let data = ics.data(using: .utf8) else {
            call.reject("ics/filename이 필요해요", "INVALID")
            return nil
        }
        let safeName = rawName.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName.hasSuffix(".ics") ? safeName : safeName + ".ics")
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            call.reject("임시 파일을 만들 수 없어요", "IO")
            return nil
        }
    }

    @objc func openIcs(_ call: CAPPluginCall) {
        guard !sharing else {
            call.reject("이미 공유 화면이 열려 있어요", "BUSY")
            return
        }
        guard let url = writeTempIcs(call) else { return }
        sharing = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else {
                self?.sharing = false
                call.reject("화면을 열 수 없어요", "UNAVAILABLE")
                return
            }
            let controller = UIDocumentInteractionController(url: url)
            controller.delegate = self
            let anchor = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
            // 이 파일 형식을 열 수 있는 설치 앱이 하나도 없으면 false — 그때만 Share Sheet로 전환.
            if controller.presentOpenInMenu(from: anchor, in: host.view, animated: true) {
                self.docController = controller
                self.docCall = call
                self.docTempURL = url
                self.docSentToApp = false
            } else {
                self.presentShareSheet(url: url, host: host, call: call, method: "share")
            }
        }
    }

    public func documentInteractionController(_ controller: UIDocumentInteractionController, didEndSendingToApplication application: String?) {
        docSentToApp = true
    }

    public func documentInteractionControllerDidDismissOpenInMenu(_ controller: UIDocumentInteractionController) {
        let call = docCall
        let completed = docSentToApp
        if let url = docTempURL, !completed { try? FileManager.default.removeItem(at: url) }
        docController = nil
        docCall = nil
        docTempURL = nil
        docSentToApp = false
        sharing = false
        call?.resolve(["completed": completed, "method": "openIn"])
    }

    // MARK: - shareIcs / Share Sheet

    @objc func shareIcs(_ call: CAPPluginCall) {
        guard !sharing else {
            call.reject("이미 공유 화면이 열려 있어요", "BUSY")
            return
        }
        guard let url = writeTempIcs(call) else { return }
        sharing = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else {
                self?.sharing = false
                call.reject("화면을 열 수 없어요", "UNAVAILABLE")
                return
            }
            self.presentShareSheet(url: url, host: host, call: call, method: "share")
        }
    }

    private func presentShareSheet(url: URL, host: UIViewController, call: CAPPluginCall, method: String) {
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        // iPad는 popover로만 표시할 수 있다 — 화면 중앙 기준.
        if let pop = sheet.popoverPresentationController {
            pop.sourceView = host.view
            pop.sourceRect = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 0, height: 0)
            pop.permittedArrowDirections = []
        }
        sheet.completionWithItemsHandler = { [weak self] _, completed, _, _ in
            try? FileManager.default.removeItem(at: url)
            self?.sharing = false
            call.resolve(["completed": completed, "method": method])
        }
        host.present(sheet, animated: true)
    }
}
