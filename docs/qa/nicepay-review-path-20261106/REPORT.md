# NICEPAY 심사 경로 — 격리 브라우저 QA (2026-11-06/07)

## 환경(운영 연결 없음)
- 세 번째 로컬 Supabase 스택 `mwhabit-reviewpath`(127.0.0.1:54621~, `scripts/qa/reviewPath/stack.sh`) — 다른 작업의 `mwhabit-isolated`(5442x)·`mwhabit-adminqa`(5452x)·포트 3100·터널은 건드리지 않았다. 종료 시 이 스택만 내림.
- 운영 baseline 스키마 + P2 격리 + 만료 상품 숨김 + 허용 목록 SQL + **허용 1행 SQL(`grant_nicepay_review_real_center_20261106_proposed.sql`, 운영 UID·센터 ID 와 동일한 값)** 을 그대로 적용(audit SQL 도 같은 스택에서 실행 통과, 중복 실행 중단 확인).
- 앱: 운영 빌드(`next build` + `next start`, 포트 3216, 깨끗한 환경). `https://mwhabit.com` origin 고정 검사 때문에 Chromium `host-resolver-rules` + 자체 서명 https 프록시(3217)로 mwhabit.com 을 로컬로 매핑 — 실제 mwhabit.com 요청 0.
- 결제 설정: `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false`, `NICEPAY_CHECKOUT_ENABLED=false`(OFF 유지), review-window 만 활성(공용 테스트 MID 고정, 가짜 키).
- NICEPAY SDK 는 stub(goPay 호출만 기록, 제출 안 함), 그 밖 외부 호스트는 차단·집계 → **차단된 외부 호스트 0**.

## 로그인 방식 구분
**모의 로그인**: 격리 스택에 만든 계정(심사 계정은 운영과 같은 UID·이메일 형태, 무작위 비밀번호). **실제 로그인(운영 niceqa 자격증명)은 사용하지 않았다 → BLOCKED**(안전하게 제공된 자격증명 없음, 운영 Supabase 미연결).

## 결과: 27/27 PASS (`browser-qa-results.json`)
| 구분 | 확인 |
|---|---|
| 심사관 | 홈에 "수강권 및 결제 확인 센터" 섹션·A10TION 표시, 별도 심사 센터·'심사용' 문구 없음 / `/products` 에 판매 중 수강권 3종만(만료 10월·심사 센터 제외) / 센터 상세 3종·구매·담기·예약 버튼 없음·"결제 화면 · 카드 결제창 확인" 링크 3개 / 결제 화면 실제 결제 버튼 비활성("조회 전용") / "카드 결제창 확인(승인 없음)" 카드 → goPay 1회(MID nicepay00m, 금액=상품 기본가, 전용 복귀 URL) / 열림 상태 잠금·"상태 초기화" |
| 결제 API | 인증창 확인 중 호출된 결제 API 는 review-window check/open POST 뿐(승인·prepare·return-token·confirm 0) |
| 서버 차단 | 심사관 JWT 로 create_order_secure·장바구니·구매신청 거부, A10TION 주문·장바구니·구매신청·수강권 0건, 허용 RPC 1건(can_purchase=false) |
| 일반 회원 | 홈에 심사관 섹션·심사 센터 없음, A10TION 정상(구매 버튼), 심사 센터 직접 URL 정보 미노출, 결제 화면에 인증창 카드·카드 결제 없음 |
| 비로그인 | 홈 심사관 섹션 없음, 심사 센터 직접 URL 미노출, review-window check 거부 |

## QA 가 발견해 수정한 결함 2건
1. **/products 가 심사관에게 별도 심사 센터의 테스트 상품까지 보여 줌** — 서버 RPC 는 심사 센터를 심사관에게 허용하기 때문. 허용 센터가 있으면 전체 상품 목록도 그 센터만 보이게 `fetchPublicStorefrontProducts` 에서 같은 기준으로 거름(+단위 테스트).
2. **인증창 대상 판정이 심사 센터 행의 존재에 의존** — 심사 센터가 없거나 id 가 다른 환경에서 실제 센터 상품도 거부됨. 심사 센터 행은 심사 센터 상품일 때만 요구하도록 분리(+단위 테스트).

## 스크린샷
`screenshots/` 7장(심사관 홈·/products·센터 상세(조회 전용)·결제 화면·인증창 열림(stub), 일반 회원 홈·심사 센터 직접 URL). 이메일·비밀번호·토큰은 화면에 없다. 로컬 시험 데이터 이름(`[로컬] …`)이 보이는 것은 격리 스택 시드라서다.

## 한계
- 상품 이름·가격은 운영 값이 아닌 로컬 시드(구조는 운영과 같음). 운영의 A10TION 상품 14개·판매 조건 3종은 사용자 확인 결과를 근거로 한다.
- 실제 NICEPAY 외부 창은 열지 않았다(stub). 기존 App Store 앱(네이티브)에서 열리는지는 계속 미검증.
