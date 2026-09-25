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

  - addEvent: EKEventEditViewController(EventKitUI 표준 일정 추가 화면)에 제목/시작/종료/위치/메모를
    미리 채워 띄운다. 사용자가 화면에서 "추가"를 눌러야만 저장된다(백그라운드 자동 저장 없음).
    · iOS 17+: 시스템 이벤트 UI는 별도 캘린더 권한 없이 동작한다.
    · iOS 15/16: 저장하려면 캘린더 접근 권한이 필요해 requestAccess를 먼저 호출한다(Info.plist의
      NSCalendarsUsageDescription 필요 — 없으면 크래시하므로 키가 없으면 UNAVAILABLE로 reject하고
      JS가 Share Sheet(.ics)로 전환한다).
  - shareIcs: .ics를 임시 파일로 쓰고 UIActivityViewController(시스템 Share Sheet)로 넘긴다. 설치된
    캘린더/ICS 지원 앱 목록은 OS가 결정한다(iOS는 캘린더 앱을 열거하는 공통 API가 없어 앱 이름/URL
    scheme을 추측하지 않는다).
*/
@objc(CalendarEventPlugin)
public class CalendarEventPlugin: CAPPlugin, CAPBridgedPlugin, EKEventEditViewDelegate {
    public let identifier = "CalendarEventPlugin"
    public let jsName = "CalendarEvent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "addEvent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareIcs", returnType: CAPPluginReturnPromise)
    ]

    private let eventStore = EKEventStore()
    private var pendingCall: CAPPluginCall?   // 이벤트 편집 화면이 열려 있는 동안 유지(중복 실행 방지 겸용)
    private var sharing = false

    @objc func addEvent(_ call: CAPPluginCall) {
        guard pendingCall == nil else {
            call.reject("이미 일정 추가 화면이 열려 있어요", "BUSY")
            return
        }
        guard let title = call.getString("title"),
              let startMs = call.getDouble("startMs"),
              let endMs = call.getDouble("endMs") else {
            call.reject("title/startMs/endMs가 필요해요", "INVALID")
            return
        }
        let location = call.getString("location")
        let notes = call.getString("notes")
        pendingCall = call

        let present: () -> Void = { [weak self] in
            self?.presentEditor(title: title, startMs: startMs, endMs: endMs, location: location, notes: notes)
        }
        if #available(iOS 17.0, *) {
            DispatchQueue.main.async(execute: present)
        } else {
            guard Bundle.main.object(forInfoDictionaryKey: "NSCalendarsUsageDescription") != nil else {
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

    private func presentEditor(title: String, startMs: Double, endMs: Double, location: String?, notes: String?) {
        guard let host = bridge?.viewController else {
            finish(reject: "화면을 열 수 없어요", code: "UNAVAILABLE")
            return
        }
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = Date(timeIntervalSince1970: startMs / 1000.0)
        event.endDate = Date(timeIntervalSince1970: endMs / 1000.0)
        event.location = location
        event.notes = notes
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

    private func finish(resolve data: [String: Any]) {
        pendingCall?.resolve(data)
        pendingCall = nil
    }

    private func finish(reject message: String, code: String) {
        pendingCall?.reject(message, code)
        pendingCall = nil
    }

    @objc func shareIcs(_ call: CAPPluginCall) {
        guard let ics = call.getString("ics"), let rawName = call.getString("filename"), let data = ics.data(using: .utf8) else {
            call.reject("ics/filename이 필요해요", "INVALID")
            return
        }
        guard !sharing else {
            call.reject("이미 공유 화면이 열려 있어요", "BUSY")
            return
        }
        let safeName = rawName.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(safeName.hasSuffix(".ics") ? safeName : safeName + ".ics")
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            call.reject("임시 파일을 만들 수 없어요", "IO")
            return
        }
        sharing = true
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let host = self.bridge?.viewController else {
                self?.sharing = false
                call.reject("화면을 열 수 없어요", "UNAVAILABLE")
                return
            }
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
                call.resolve(["completed": completed])
            }
            host.present(sheet, animated: true)
        }
    }
}
