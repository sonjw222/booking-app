# NICEPAY 앱(WebView) 호스트·네이티브 설정 점검 (2026-11-09)

통합 브랜치 `integration/ux-native-review-20261109` — `capacitor.config.ts` `server.allowNavigation` 의 NICEPAY 항목은 **정확한 호스트 3개**뿐이다(와일드카드 없음, `tests/unit/nicepayNativeParity.test.ts` 가 주석 제외 실제 항목으로 고정).

| 호스트 | 근거(실제 호출 경로) |
|---|---|
| `pg-web.nicepay.co.kr` | SDK `goPay()` 가 결제 form 을 `target=_top` **POST** 로 보내는 곳(`/v3/gwPayment.jsp`). 이 호스트가 allowNavigation 에 없으면 Capacitor(iOS)가 `UIApplication.open(url)`+취소로 처리해 POST 본문이 사라진다(2026-11-08 실기기 진단). SDK 스크립트 로드(`<script src>`)는 이동이 아니라 허용 목록과 무관. |
| `dc1-web.nicepay.co.kr` | gwPayment 응답의 자동 POST 가 향하는 결제창 본체(`/v3/smart/smartPayment.jsp`, billing/payment.jsp) — 실기기 관찰. |
| `web.nicepay.co.kr` | 실기기에서 관찰된 NICEPAY 오류/안내 페이지. |

- 서버 호출용 호스트(`webapi/api/sandbox-api/pay/sandbox-pay.nicepay.co.kr`)는 서버(Next API)가 호출하며 WebView 이동이 아니므로 allowNavigation 대상이 아니다.
- **추가 호스트 필요 여부: 근거 없음 → 추가하지 않음.** 위험: NICEPAY GSLB 가 `dc1` 외 노드(예: `dc2-web`)를 배정하면 해당 이동이 외부 브라우저로 나간다(와일드카드로 풀지 않음 — 확인되면 정확한 호스트를 추가하고 앱 재빌드). 카드사·ISP 인증 호스트는 이번 범위(심사 인증창 첫 화면 확인)에 불필요하며 NICEPAY 확인 전이다. Safe Area 보정(`NicepaySafeAreaObserver`)도 같은 3개 호스트에서만 동작한다(`dc2-web` 등은 보정 안 함 — 소스 계약 테스트).
- 네이티브 등록 확인: iOS `SceneDelegate` — `NavigationPolicyPlugin`, `NicepayAppBridgePlugin` 모두 `registerPluginInstance`; Android `MainActivity` — `registerPlugin(NicepayAppBridgePlugin.class)`. #264 의 앱 복귀(WapUrl/IspCancelUrl)는 서버 설정 OFF(`NICEPAY_APP_RETURN_ENABLED`)라 동작하지 않는다.
- ⚠ **결정 필요**: #264 의 복귀 scheme(`mwhabitnicepay`, 제안·미확정)이 Info.plist/AndroidManifest 에 등록되어 있다. **스토어 제출 후에는 변경할 수 없다** — NICEPAY 기술지원 확인 전에는 App Store 심사 제출(TestFlight 내부 테스트는 무관)을 하지 않는 것을 권장.
- 충돌 확인: 앱 내부 결제창(외부 NICEPAY 페이지) 위에서 `NavigationPolicyPlugin` 의 가장자리 back 은 웹 정책이 없으므로 `webView.goBack()`; X 종료 후 복귀는 서버 종료 화면 → 저장된 결제 경로. 두 동작은 서로 다른 계층(네이티브 제스처 vs 서버 렌더 화면)이며 격리 브라우저 QA(`returnFlow.mjs`)와 iOS Debug/Release 빌드로 확인했다. 실기기 결제창 위 제스처·X 동작은 BLOCKED(실기기).
