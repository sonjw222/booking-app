# 기존 앱 NICEPAY 결제창 확인 — UI·버튼 충돌·로딩 복구 (2026-11-05)

## 원인 (코드로 확인)
1. **하단 "처리 중…" + 토스트 "온라인 결제는 아직 사용할 수 없어요"**: 테스트 API(`review-window`)는 실패 시 "테스트 결제창 정보를 확인할 수 없어요" 계열 문구를 쓰고 이 토스트 문구는 만들지 않는다. 이 문구는 실제 결제 서버 게이트(`flow.ts`/`lifecycle.ts`의 `gateAllows`, `NOT_ACTIVE_REPLY`) 응답이다. 지정 계정은 `NICEPAY_CHECKOUT_ACTIVATED=true`(코드) + 심사 권한으로 카드가 선택된 상태라 클라이언트 게이트(`isOnlinePgCheckoutAvailable`)를 통과하고, **하단 실제 결제 버튼**을 누르면 `handlePay → createOrder → prepare` 가 호출되어 서버(`NICEPAY_CHECKOUT_ENABLED=false`)가 거부한다. 즉 테스트 버튼 실패가 아니라 실제 결제 CTA 가 함께 살아 있던 것이 원인(주문이 만들어졌다가 정리됨). 사진의 "결제창 준비 중…"(테스트 버튼 busy)과 "처리 중…"(하단 버튼 busy)이 동시에 보이는 것도 두 CTA 가 독립 상태였기 때문.
2. **"결제창 준비 중…" 고정**: 모바일 WebView 에서 NICEPAY SDK `goPay` 는 form 을 `target=_top` 으로 NICEPAY 도메인에 제출한다. 기존 앱 바이너리의 Capacitor `allowNavigation` 에는 NICEPAY 도메인이 없어(`capacitor.config.ts`) 이동이 앱 밖(시스템 브라우저)으로 넘어가거나 막힌다. 이때 `nicepayClose` 콜백이 오지 않아 이전 코드의 `windowOpen=true`/`busy` 가 영구히 남았다.
3. **UI**: `menu-section`/`secondary-btn` 은 globals.css 에 정의가 없어 브라우저 기본 스타일로 표시됐다.

## 네이티브(기존 App Store 바이너리) 확인
- iOS Info.plist: 구글 로그인 URL scheme 만 있고 NICEPAY 전용 scheme·`LSApplicationQueriesSchemes`(카드사 앱 호출) 없음. `App.entitlements` 에 `applinks:mwhabit.com` 있음(유니버설 링크).
- `capacitor.config.ts` `allowNavigation`: kakao/naver/google/apple/supabase 만. NICEPAY(`*.nicepay.co.kr`) 없음.
- 코드에서 `WapUrl`/`IspCancelUrl`/`MobileYN` 사용 없음.
- 구분: **기존 바이너리로 가능** — HTTPS ReturnURL(서버 HMAC 검증)·결과 페이지·복귀 후 상태 복구(이번 수정). **네이티브 업데이트 필요** — NICEPAY 도메인 `allowNavigation`, 카드사 앱 호출용 `LSApplicationQueriesSchemes`/Android `queries`, WapUrl/IspCancelUrl 복귀 scheme(값은 NICEPAY 확인 전, 임의 추가하지 않음), 인증 후 앱 복귀(유니버설 링크는 사용자가 링크를 눌러야 앱이 열리므로 자동 복귀 보장 불가). 미등록 scheme 을 추가해 해결됐다고 보고하지 않는다.
- ⚠ 확인 필요: 이 form 은 `accept-charset=euc-kr` 인데 params 는 `CharSet=utf-8` 이다(NICEPAY 문서 예시 대비 인코딩 조합은 실제 창에서 확인 필요).

## 수정
`NicepayReviewWindow.tsx`(카드 UI·상태·복구), `checkout/page.tsx`(CTA 잠금·handlePay 가드), `globals.css`. 서버 route·HMAC·MID·서명·승인 코드는 변경 없음.

## 검증
- 로컬 모의: vitest 전체 2968 통과(신규 16: 상태 전달·확인 실패·복구·재시도·더블클릭·경로 한정·CTA 잠금 정적 계약), `npm run build`(더미 env) 성공.
- 실제 외부: NICEPAY SDK URL 로드(HTTP 200, `goPay` 정의 확인)만 수행. 실제 `goPay` 호출/결제창은 열지 않음(공용 테스트 MerchantKey 가 이 환경에 없음, 승인 API 호출 0회).
- 화면: `review_window_ui/` 의 iPhone 폭(390px) 렌더 — 전/후, 상태별, 다크, 큰 글자. 실기기 iOS 확인은 미실시.

## 보완 (커밋 e522248 검토 반영, 2026-11-05)
1. **계정 판별 중 구간** — 이전: 컴포넌트·부모 초기값이 `hidden` 이라 `sessionNow()` 가 끝나기 전에는 일반 회원과 구분되지 않아 실제 카드 결제 버튼이 열려 있었다. 수정: `ReviewWindowStatus` 에 `resolving` 추가(초기값·인증 변경 직후), 지정 계정이 아님이 확정돼야 `hidden`. checkout 초기값도 `resolving`, 잠금은 비-direct 에만 적용, handlePay 는 ref 로 최신 상태를 읽어 `createOrder` 이전에 중단. 세션 조회 실패는 `denied`.
   테스트: 실제 `app/checkout/page.tsx` 를 jsdom 렌더(`nicepay.checkout.reviewResolving.test.ts`) — getSession 지연 중 버튼 disabled·클릭해도 createOrder/prepare/createPayment 없음, 지정 계정 확정 후에도 잠김, 일반 회원 확정 시 활성화·정상 접수, 세션 실패 시 잠김, 직접결제 유지. 초기값·마운트 알림을 일부러 제거하면 실패하는 것을 확인(변이 검증).
2. **요청 제한 시간·취소** — 12초 AbortController(check/open), 준비 중 "준비 취소" 버튼, 시도별 id 로 늦은 응답·오류 무시(`nicepay.reviewWindow.attempts.test.ts`: 타임아웃 복구, check 타임아웃→denied, 취소 후 늦은 응답, 취소→재시도→이전 응답, 이전 시도의 늦은 오류, 이전 창 닫기 콜백, 더블 클릭).
3. **창 열기 시도 식별자** — `openNicepayV3Window` 가 시도 id·타이머 id·소유권 확인을 갖는다. 테스트는 mock 없이 실제 helper(`nicepay.v3.window.attempts.test.ts`, jsdom + fake timers): 첫 창 닫기 → 초기화 → 새 창 열기 → 이전 콜백 시점 경과 후에도 새 창(form·전역 핸들러) 유지, 이전 cleanup 이 새 핸들러를 지우지 않음, 정리된 시도의 submit 무시, goPay 예외 정리.

### 미검증 (명확히)
- **기존 App Store 바이너리에서 실제 NICEPAY 결제창이 열리는지는 검증하지 못했다.** 원인 분석상 모바일 `goPay` 는 `target=_top` 으로 NICEPAY 도메인에 form 을 제출하고, 기존 바이너리의 Capacitor `allowNavigation` 에 NICEPAY 도메인이 없어 이동이 앱 밖(시스템 브라우저)으로 나가거나 막힐 수 있다. 실기기·실제 외부 창은 확인하지 않았고(공용 테스트 MerchantKey 없음), 이 보완은 그 경우에도 화면이 "준비 중"에 갇히지 않게 하는 복구·잠금 로직이다. 네이티브 업데이트가 필요한 항목은 위 "네이티브" 절 참고.
- 검증: vitest 전체 2990 통과, `npm run build`(더미 env) 성공. 승인·망취소·환불 API 호출 0회, 카드 인증 없음.
