# Universal Link 진단 (2026-10-03) — 코드/설정 결함 없음, 코드 수정 안 함

## 조사 결과 (코드·설정·서버)
| 항목 | 결과 |
|---|---|
| AASA 라우트 `app/.well-known/apple-app-site-association/route.ts` | `appIDs: ["6TKYLJJSD5.com.mwhabit.app"]` + `components: /checkout/success, /checkout/fail`(두 경로만) |
| live AASA `https://mwhabit.com/.well-known/apple-app-site-association` | 200 · `application/json` · redirect 없음 · 132 bytes · 위 JSON과 동일 (2026-10-03 curl) |
| Apple CDN `app-site-association.cdn-apple.com/a/v1/mwhabit.com` | 200 · 같은 JSON (최신 AASA를 보고 있음) |
| `ios/App/App/App.entitlements` | `applinks:mwhabit.com` 포함(Apple Sign In 등과 함께) |
| TestFlight 1.0.2(6) archive 서명 entitlement (이전 진단 세션) | `applinks:mwhabit.com` + application-identifier `6TKYLJJSD5.com.mwhabit.app`, Store profile에 Associated Domains 포함 |
| `SceneDelegate.swift` | `scene(_:continue:)` → `SceneDelegateProxy`, `openURLContexts`는 Google 콜백 후 proxy — 충돌 없음 |
| `CapacitorBootstrap.tsx` / `lib/paymentUniversalLink.ts` | appUrlOpen + getLaunchUrl(세션 1회) → origin이 정확히 `https://mwhabit.com`이고 pathname이 위 두 경로일 때만 앱 WebView에서 열기 |

→ **앱 라우팅은 OS가 앱을 연 뒤에만 실행**된다. Notes에서 링크를 눌렀는데 Safari가 열렸다면 그 이전 단계(OS의 association 선택)이므로 이 코드로는 바꿀 수 없다. 코드/설정에 명확한 결함이 없어 수정하지 않았다.

## 남은 가능성 (코드 밖)
1. 테스트한 앱이 Associated Domains가 없는 App Store 1.0.1 계열일 가능성
2. 이전에 링크 길게 누르기 메뉴에서 "Safari에서 열기"를 선택해 iOS가 그 선택을 기억(도메인별 설정)
3. 기기의 swcd association 캐시가 오래됨(삭제/재설치로 갱신)
4. (결제 콜백 경로가 아닌 일반 링크는 AASA에 없으므로 앱으로 열리지 않는 것이 정상 — 예: `/` , `/login`)

## 실기기 진단 절차 (한 단계씩)
1. **어느 앱인지 확인**: 설정 > 일반 > iPhone 저장 공간 > MWHABIT 에서 버전/빌드(1.0.2(6) 이상이어야 함).
2. **링크 길게 누르기 메뉴 확인**: 메모 앱에서 `https://mwhabit.com/checkout/success` 를 길게 누른다. 메뉴에 **"MWHABIT에서 열기"** 가 보이면 association 정상 → 그것을 한 번 선택하면 이후 기본값이 앱으로 바뀐다. "Safari에서 열기"만 보이면 association이 안 잡힌 것.
3. **설정 앱 진단(iOS 16.4+, 개발자 모드 필요)**: 설정 > 개발자 > Universal Links > 진단 → URL 입력 → 결과(어떤 앱이 열리는지 / AASA 상태) 확인.
4. **재설치로 association 갱신**: TestFlight 앱 삭제 → 재설치(필요 시 iPhone 재시작) → 메모 링크 재테스트.
5. **Mac에서 로그 확인(원인 불명일 때)**: iPhone을 Mac에 연결 → Console.app → 기기 선택 → 검색창에 `swcd` 입력 → 앱 설치/링크 탭 직후 `applinks`/`mwhabit.com` 관련 줄 확인.
6. 결과(어느 단계에서 "Safari에서 열기"만 나왔는지, 3번 화면의 문구)를 전달하면 다음 판단 가능.

※ 이 진단 때문에 새 TestFlight/App Store 빌드를 올릴 필요는 없다.
