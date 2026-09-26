# MWHABIT UI QA polish — 2026-09-26

## 검증 범위와 완료 판단

UI 구현과 아래 로컬 Chromium 검증을 완료했다. **실기기까지 포함한 사용자 완료 조건 전체를 충족했다고 선언하지 않는다.** 실제 로그인·결제·예약 저장·알림 발송·WebView 키보드/제스처·운영 데이터는 미검증이다. 이 보고서의 PASS는 합성 테스트 데이터로 명시된 화면/상태를 검사한 결과다.

## 1–4. Git 기준과 변경 목록

- 작업 브랜치: `design/mwhabit-ui-refresh-qa-polish-20260926`
- 기준: `origin/design/mwhabit-ui-refresh-20260925`
- 기준 commit: `be109d2ca8e51046564562a5c526a6f5ef6994e6`
- 기존 main 기반: `9864e44c7724a3377f034aaf8ddec1555754d5b7`
- 기존 6개 commit은 그대로 조상으로 보존. rebase/amend/force push 없음.
- 추가 commit의 정확한 목록과 최종 HEAD는 전달 시 Git 로그로 보고한다. 이 문서 자체가 포함된 commit hash를 문서 내부에 미리 만들지 않는다.

원본 6개 commit (오래된 순):

```text
ed63c32816462b96509786646b51618c267b8553
a53309c508d405bbd68f6750905138dd173a198d
5e28539630926a0d9d29a6109690236e902ad5d6
2e2fe0df8b7acf2a8f92b6fb82e1cbf146ebf931
a7ecbb16e0603b0d806156158c21adb8eddfef68
be109d2ca8e51046564562a5c526a6f5ef6994e6
```

실제 변경 파일은 문서 끝에 전체 목록으로 기록했다.

## 5. 공통 design system

- 기존 navy/neutral 유지. CTA 배경 `--action-bg`와 링크/텍스트 `--accent`를 분리해 dark 배경에서 읽히는 텍스트와 흰 글자를 가진 버튼을 각각 처리.
- 버튼/폼 높이 48px, 작은 조작 44px, 공통 radius·disabled·focus-visible·selected 규칙. destructive는 기존 danger 사용.
- 라이트/다크 `color-scheme`, date/time input, disabled input/CTA, switch ON, 긴 텍스트 wrap, 가로 필터 스크롤 정리.
- 기존 페이지의 닫기 핸들러를 그대로 사용하는 `SheetOverlay`: dialog name, Tab trap, Escape, 이전 focus 복원, 중첩 sheet/confirmation 우선순위, body scroll lock, visualViewport 높이/offset 반영.
- 모바일 bottom sheet, 태블릿/웹 최대 640px 중앙 modal(지도 최대 760px 규칙), 내부 스크롤. 기존 sheet의 업무 동작 보존.
- safe-area 토큰·기존 floating-nav clearance 사용. touch-action/long-press/텍스트 선택 CSS 및 native 브리지는 변경하지 않음.
- 기존 2-column/side navigation breakpoint 보존. 센터 정보는 넓은 화면에서 section grid, 짧은 센터 상세는 tablet/web에서 CTA를 본문 뒤에 배치.

## 6. 화면별 적용/유지 목록

아래는 사용자 요청 영역별 구현 대응이다. 공통 CSS 적용으로 충분한 화면은 독립 페이지 코드를 다시 작성하지 않았다. 목록의 구현 완료와 실기기 검증 완료는 별개다.

| 요청 | 적용 내용 |
|---|---|
| Home | 헤더 중앙 정렬, 모바일 4×2/최대 8개 기존 slicing 보존, 기존 아이콘 크기·정렬, 프로모션 slot을 종목과 클래스 사이로 이동, footer/목록 중복 하단 여백 축소 |
| 찾기 | navy 검색 CTA, disabled 구분, input/버튼 높이, chip 간격. 자동검색/검색 함수 보존 |
| 센터 상세 | back contrast/접근성 이름, 기존 hero/tab/위치 구조 유지, 공통 CTA 간격, 넓은 화면의 짧은 소개 뒤 CTA 배치, 구매 sheet |
| 예약/내 예약 | primary/secondary tab 간격, 캘린더/목록 기존 responsive 구조 유지, navy 예약 버튼, 선택 날짜 이름/상태, 예약 시트 공통화 |
| Member 마이 | 알림함→내 활동, 알림 설정→설정 유지, row/section 간격, 수강권 이름·progress·만료 상태 우선순위 |
| 관리자 홈 | dark 센터 선택기/모드 전환 표면, neutral 매출 summary, 숫자·action 간격 |
| 관리자 수업 | 실제 DOM에 맞게 날짜 selector 수정, 가벼운 날짜 선택, 공통 등록 CTA/시트, 기존 일정 복사·휴무·직접배치 동작 보존 |
| 관리자 회원 | 등급 전체/상태 전체 고정 버튼과 별도 스크롤 트랙, 긴 등급 truncate, row/toolbar 공통 규칙 |
| 관리자 알림 | destructive 전체 삭제, title/body wrap, 기존 swipe/pin/delete 상태/핸들러 보존, divider/row 공통 규칙 |
| 로그인/회원가입 | 공식 Apple PNG로 깨진 SVG 교체, 소셜 버튼 정렬, form/accessibility 이름, 기존 2단계/OTP/OAuth 보존 |
| 장바구니/구매 | 수량 버튼 44px, 삭제 색, CTA와 nav clearance/본문 padding, 중립 상품 표시, 구매 sheet 내부 스크롤 |
| 프로필 | dark avatar 표면, 이름/대표 badge/삭제 정렬, 취소/저장 위계, 수정 sheet 공통화 |
| 내 정보 | 기존 section 유지, 계정 연결 설명 간결화, 탈퇴 divider/CTA 분리, 마케팅 switch 이름 |
| 알림 설정 | 미지원 알림의 disabled 사유, switch role/name/state, 행 간격 |
| 1:1 문의 | 기존 목록/Realtime 로직 유지, composer/viewport 높이, 메시지·뒤로가기 이름, sheet 공통화 |
| 약관/정책 | 기존 내용/링크 유지, settings/list 공통 높이·폭 제한 적용 |
| 매출·결제 | neutral summary, action/tab 공통 규칙, 결제 등록 primary, form·modal 공통화, 금액 입력 이름 |
| 주문 | 기존 상태·주문 액션 보존, row wrap/이름·내용 min-width, compact action |
| 센터 정보 | section 구분/넓은 화면 grid, map stacking isolation, toolbar/button 정렬, 이미지 순서 버튼 이름 |
| 예약 운영 | 기존 section 구분 유지/간격 개선, input+단위 wrap, switch 이름, 매출 표시 segmented, 수동 저장일 때만 primary CTA/변경 없으면 작은 저장됨 |
| 룸 | 추가 secondary, card/빈 상태 유지, 추가/수정 primary 및 sheet |
| 쿠폰 | 중복 header action 정리, 기존 조건/발급 동작 보존, 공통 card/filter/date/form/sheet |
| 수강권 설정 | 공통 페이지 제목 변경, 약한 marker, action 크기, 조건 영역 secondary, 조건/상품 sheet 및 selected 요일 |
| 상품 관리 | 제목 변경, marker/action, 공통 form, 쉼표 사이즈 chip preview (저장 형식 불변) |
| 스태프/권한 | 기존 역할/권한 스크롤 구조, selected state/compact action/작은 status, permission row, sheet. 실제 코드는 dirty 시 수동 저장이며 그 동작 유지 |
| 직접배치 기록 | 필터 한 줄 스크롤, 선택 요약/reset, 초과 정원 switch 이름, 약한 marker/기존 기록 데이터 보존 |
| 알림톡 메인 | 기존 section/menu 구조 보존, 공통 row/icon/spacing 적용 |
| 알림톡 보내기 | 선택 수 CTA, 전화번호 없는 회원 disabled/전체선택 제외, 발송 직전 현재 선택 대상 검증, 기존 발송 서비스/요금 로직 보존 |
| 자동 발송 규칙 | keyboard 가능한 card, template 미지정 warning, empty CTA. ON/OFF 업무 동작은 기존 그대로 |
| 템플릿 | 첫 템플릿 CTA, 기존 지원 변수만 삽입 chip, textarea count, 공통 sheet |
| 발신 설정 | 실제 연결 상태 card, 운영자 단계 설명, 내부 Supabase/secret 설명 제거. API/secret 처리 불변 |

## 7–12. 테마/반응형 QA

Chrome Headless Shell 131.0.6778.204, 프로덕션 Next build, 합성 Supabase 응답 사용. `burgundy`는 기존 라이트 저장 키, `charcoal`은 다크 저장 키다.

| 구분 | viewport | Light | Dark |
|---|---|---|---|
| Mobile | 390×844, 430×932 | 자동 geometry/runtime PASS | PASS |
| Tablet portrait | 820×1180, 1024×1366 | PASS | PASS |
| Tablet landscape | 1180×820, 1366×1024 | PASS | PASS |
| Desktop/Web | 1280×900, 1360×900, 1440×1000, 1600×1000 | PASS | PASS |

32 routes × 10 viewports × 2 themes = **640개 조합**. 문서의 JSON 증거는 마지막 센터 상세 변경에 대한 20개 재검사 결과를 합친 최종 결과다. 390/820/1180/1440에서는 양 테마 스크린샷을 생성했다. 대표 모바일/태블릿/웹 화면과 시트 이미지를 육안 확인했다. 모든 640개의 이미지를 개별 육안 판정한 것은 아니다.

시트·navigation·회원가입 단계·선택 등 **104개 interaction 검사 PASS**. viewport 높이를 500px 이하로 줄여 dialog가 visible viewport 안에 남는 것을 검사했다. 이는 실제 OS 소프트 키보드 시험이 아니다.

## 13. 지도 겹침

기존 Leaflet pane/control의 높은 z-index가 page header와 경쟁할 수 있었으므로 `.map-preview`, `.map-picker-canvas`에 `position:relative; isolation:isolate; z-index:0`를 적용해 지도 내부 stacking context에 제한했다. 기존 overflow clipping 유지. 헤더 z-index를 임의로 올리지 않았다.

실제 Leaflet 1.9.4 JS/CSS를 로컬 응답으로 로드한 뒤 8개 theme/viewport 조합에서 scroll 및 header 위치 hit testing을 통과했다. 지도 타일/marker 이미지는 차단했으므로 실제 지리·타일 가용성·현재 위치는 미검증.

## 14–15. overflow / nav / CTA

- 640 조합에서 `documentElement.scrollWidth > innerWidth + 1` 없음. tabs/filter strips만 의도적 가로 스크롤.
- 화면 상단 위치의 center/cart/recipient/classes CTA와 보이는 bottom nav bounding rectangle 교차 0.
- 장바구니는 scroll bottom에서도 8개 조합 교차 0. 각 시트는 내부 스크롤·Tab 이동·Escape 닫기 확인.
- 회원/관리자 app-shell의 기존 하단 clearance 유지, 장바구니/알림톡은 CTA 높이까지 본문 여유 확보.
- fixed nav가 full-page screenshot 중간에 찍히는 것은 viewport 위치를 유지하는 캡처 특성이다. 스크롤 접근성과 기하 검사를 함께 사용했다.
- 실제 home indicator/Android navigation bar/inset 값은 물리 기기 미검증.

## 16. 접근성

dialog name/aria-modal/Tab trap/Escape/scroll lock/focus 복원, nested alertdialog 양보 회귀 테스트 추가. input 이름·switch role/aria-checked·filter aria-pressed·캘린더 날짜 이름·focus-visible·reduced motion 추가/보강. 기존 nav aria-current 및 segmented aria-selected 구조 유지. 모든 페이지의 모든 스크린리더 조합이나 전체 WCAG 감사를 완료한 것은 아니다.

## 17–18. build / tests

- 작업 전 baseline: build PASS, 65 unit files / 472 tests PASS.
- 최종: `npm run build` PASS (TypeScript 포함).
- 최종: `npm test` = 66 files / 475 tests PASS.
- 합성 환경: `NEXT_PUBLIC_SUPABASE_URL=https://qa-placeholder.supabase.co`, `NEXT_PUBLIC_SUPABASE_ANON_KEY=qa-placeholder`. 운영 비밀키 사용 없음.
- 기존 white-avatar/desktop-drawer snapshot 계약 2개를 이번 theme surface/centered modal 요구에 맞게 갱신.
- 저장소 CLAUDE.md에 명시된 ESLint 설정 부재로 build 타입검사를 사용. lint 설정을 새로 만들지 않음.
- live Supabase integration suite는 실행하지 않음. 전체 unit suite와 혼동하지 않는다.

## 19. 브라우저에서 실제 연 화면

`/`, `/search`, `/center/[id]`, `/reservation`, `/my-reservations`, `/mypage`, `/manager`, `/manager/classes`, `/manager/members`, `/manager/notifications`, `/login`, `/cart`, `/profiles`, `/manager/center-info`, `/manager/settings`, `/manager/membership-rules`, `/manager/goods`, `/manager/staff`, `/manager/alimtalk/send`, `/mypage/info`, `/settings/notifications`, `/inquiries`, `/legal`, `/manager/sales`, `/manager/orders`, `/manager/rooms`, `/manager/coupons`, `/manager/admin-assignments`, `/manager/alimtalk`, `/manager/alimtalk/rules`, `/manager/alimtalk/templates`, `/manager/alimtalk/settings`.

추가 interaction: 센터 구매/프로필/룸/상품/수강권/쿠폰/결제 시트, 역할별 권한, 검색 enabled와 실행·home→manager 이동, 회원가입 2단계, 연락처 없는 수신자 비선택/1명 선택 composer, cart scroll bottom, center info map scroll.

## 20–21. 미검증 / 회귀 위험

- 실제 회원·센터 계정 인증, OAuth 4종, OTP, 실결제/주문확정/수강권발급/예약취소/대기 처리/운영 DB 저장.
- 실제 알림톡 전송, Realtime 채팅 왕복, 파일 업로드, 위치 권한·지도 타일.
- iOS/Android WebView 실기기 키보드, safe-area 실측, swipe/long-press native 제스처, VoiceOver/TalkBack.
- Safari/WebKit, Firefox, 실제 iPad 13-inch, Vercel Preview 가용성.
- 일부 관리 화면은 합성 empty state 중심이다. 대량 주문/알림/이미지/긴 다국어 텍스트/모든 권한 조합까지 검증하지 않았다.
- 주요 회귀 지점: 공통 sheet focus/scroll lock과 native keyboard, 공통 CSS specificity, 관리자 dirty 저장 UX, 알림톡 필터 후 선택 검증. 이 부분은 실기기/실계정 회귀 대상이다.
- Graphify 산출물/실행 환경이 없어 그래프를 재생성하지 않았다.

## 22–27. DB/native 안전

- SQL 필요 여부: **NO**.
- SQL 파일 경로: 없음.
- SQL 실행 순서: 해당 없음.
- Supabase에서 직접 실행해야 할 SQL 전문: **없음. 실행하지 않는다.**
- DB/SQL/RLS/결제/예약·취소·대기·수강권 핵심 서비스/auth/OAuth 라이브러리 변경 없음.
- native 변경: **NO**. `project.pbxproj` 등 보호 native 파일 변경: **NO**.
- 다른 native 캘린더 브랜치를 가져오지 않음.

## 28–31. 전달 상태

최종 `git status`, HEAD, push 결과는 commit 후 전달 메시지에 정확한 값으로 보고한다. main merge/main push/force push는 수행하지 않는다. 인증으로 push가 실패하면 재시도 없이 bundle을 생성·검증해 전달한다.

## 재현 자료

- `scripts/qa/ui-polish/README.md`와 실행 스크립트
- `docs/qa/ui-polish-20260926.json`: route/viewport별 결과와 104개 interaction 결과
- 최종 변경 목록 (기준 branch 대비):

```text
app/cart/page.tsx
app/center/[id]/page.tsx
app/components/InquiryChat.tsx
app/components/ManagerChrome.tsx
app/components/SheetOverlay.tsx
app/globals.css
app/inquiries/page.tsx
app/layout.tsx
app/login/page.tsx
app/manager/admin-assignments/page.tsx
app/manager/alimtalk/rules/page.tsx
app/manager/alimtalk/send/page.tsx
app/manager/alimtalk/settings/page.tsx
app/manager/alimtalk/templates/page.tsx
app/manager/announcements/page.tsx
app/manager/center-info/MapPicker.tsx
app/manager/center-info/page.tsx
app/manager/class-revenue/page.tsx
app/manager/classes/page.tsx
app/manager/coupons/page.tsx
app/manager/goods/page.tsx
app/manager/holidays/page.tsx
app/manager/leads/page.tsx
app/manager/members/page.tsx
app/manager/membership-rules/page.tsx
app/manager/page.tsx
app/manager/progress/record/page.tsx
app/manager/reviews/page.tsx
app/manager/rooms/page.tsx
app/manager/sales/page.tsx
app/manager/settings/page.tsx
app/manager/staff/page.tsx
app/mypage/info/page.tsx
app/mypage/page.tsx
app/notifications/page.tsx
app/page.tsx
app/profiles/page.tsx
app/reservation/page.tsx
app/settings/notifications/page.tsx
app/workspace.css
docs/CHANGELOG.md
docs/TODO.md
docs/UI_QA_POLISH_20260926.md
docs/qa/ui-polish-20260926.json
public/brand/README.md
public/brand/apple-signin.png
scripts/qa/ui-polish/README.md
scripts/qa/ui-polish/fixture.cjs
scripts/qa/ui-polish/interactions.cjs
scripts/qa/ui-polish/matrix.cjs
tests/unit/SheetOverlay.keyboard.test.ts
tests/unit/designSystem.contract.test.ts
tests/unit/responsiveLayout.contract.test.ts
```
