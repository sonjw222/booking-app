# NICEPAY 카드사 심사 — 운영 상태 및 제출 전 차단 조건 (2026-10-30)

> **읽기 전용 점검 결과와 제출 체크리스트**. 이 문서는 DB 변경·결제 활성화·법적 정책 반영 승인 문서가 아니다. 기록 시점: 2026-10-30 KST. 현황은 이후 바뀔 수 있으므로 제출 직전에 다시 확인한다.
>
> **기준**: GitHub `main` (PR #258 병합 후), Draft PR #254(법적 고지), #259(NICEPAY 공용 테스트 인증창 QA), Vercel Production 환경 변수의 값 판정(비밀값 미조회), Supabase Production 읽기 전용 SQL. 운영 사이트 HTTP 응답/화면은 이번 점검에서 직접 확인하지 못했다.

## 1. 운영 상태 (변경하지 않음)

| 항목 | 확인된 상태 | 유의 |
| --- | --- | --- |
| Production `NICEPAY_CHECKOUT_ENABLED` | `false` | 실제 승인/청구 열지 않음 |
| Production `NEXT_PUBLIC_PG_CHECKOUT_ENABLED` | `false` | 일반회원 온라인 카드 OFF |
| Production `NEXT_PUBLIC_SHOW_BUSINESS_ADDRESS_IN_FOOTER` | `true` | 변수는 확인했으나 브라우저에서 실제 사업장 주소 렌더링을 별도 재확인해야 함. **주소 본문/개인정보는 이 문서에 복제하지 않는다.** |
| DB `nicepay_checkout_gate.mode` | `reviewer` | 기존 문서의 `off` 서술을 그대로 믿지 말 것 |
| NICEPAY 심사관 `nicepay_review_access` | 1명 | 사용자 로그인 확인 완료 보고 |
| NICEPAY 전용 센터 `is_nicepay_review` | 1개 | 심사용 상품 3종이 앱에서 보임(사용자 실기기 확인) |
| PR #254 | Draft OPEN | 약관·환불·개인정보·사업자정보의 NICEPAY 문구는 현재 main에 미반영 |
| PR #259 | Draft OPEN | 공용 테스트 MID 사용 QA 전용; main 병합 금지 |
| PR #256 | MERGED | 2026-10-30 사전 공지 코드 배포. 게시 시점과 링크의 HTTP 표시 여부는 최종 현장 확인 필요 |
| 실제 공용 테스트 MID 결제창 | BLOCKED | `nicepay00m`의 MerchantKey 전체를 공용 계정에서 확인 못함. 기술지원 회신 대기 |

### NICEPAY 이메일 의존 사항

- 2026-10-30 기술지원 답변: 공용 테스트 MID `nicepay00m`, 테스트 상점키는 가맹점 관리자에서 확인 안내; 인증 성공과 최종 승인(2TR)은 별개. 공용 테스트 계정의 비밀번호 변경 금지.
- 2026-10-30 후속 문의 발송: 공용 계정에서 상점키가 마스킹되고 정산계좌 인증이 통과되지 않아 별도 열람·전달 절차 요청. **MerchantKey 또는 비밀번호는 GitHub/로그/채팅에 기록하지 않는다.**
- 영업·심사부서에 계약 법인명·위탁업무 범위·심사용 실제 상품 허용 범위 문의 발송. 회신·계약 원문 확인 전 법인명과 개인정보 보유기간을 추측해서 게시하지 않는다.

## 2. 비회원 공개 상품 — 가장 시급한 심사 전 장애

2026-10-30 Production DB에서 `public.fetch_public_storefront_products(NULL::uuid)`를 **읽기 전용** 조회한 결과는 다음 3건이었다. `products` 테이블의 `is_active/is_on_sale`만으로 공개 상품을 계산하면 안 된다. 내부 센터·가시성·RPC 조건이 다르기 때문이다.

| 상품(공개 RPC) | 센터 | 현재 설명 | 조치 제안 |
| --- | --- | --- | --- |
| `피겨화 대여` (6,000원부터) | A10TION 피겨팀 | 품목 `goods`, 종료일 2026-10-30 | 10/31 이후에도 공개되는지 재조회. 수강권 자체를 대표할 수 없음 |
| `테스트` (100원) | A10TION 피겨팀 | `pass`, 설명 없음, `expiry_mode=none` | **사용자 승인 후** 센터 관리 UI에서 판매 중지 권장. 임의 SQL 변경 금지 |
| `10월 어텐션 파티 수강권` (50,000원) | A10TION 피겨팀 | `pass`, 종료일 2026-10-30 | 종료 뒤 자동 숨김 확인, 신규 실판매 상품 필요 |

**발견**: 일반 고객·심사관이 비로그인으로 확인할 수 있는 실제 판매 수강권의 구성이 부족하다. 이 상태에서 `테스트`만 남으면 카드사에 허위·불완전한 상점으로 오해받을 수 있다. 기존 Draft PR #254의 설명에도 이 위험이 언급돼 있으며 최신 RPC 결과로 재확인했다.

**대책 (실제 비즈니스 판단 필요)**

1. 실제 제공 가능한 센터가 실판매 수강권 1개 이상을 *정상 공개* 상태로 준비(상품명·가격·센터·횟수/기간·설명·환불정책 연결). 필요하면 `expiry_mode=days`로 30/60/90일 등 확정된 제공기간을 명시한다. 내용과 가격을 임의로 창작하지 않는다.
2. 상품이 공개 RPC와 실제 `/products` 웹 화면에 표시되는지 확인.
3. `테스트`(100원)를 판매 중단할지는 사용자·센터 운영자가 승인/결정. 사용자 승인 없이 상품을 변경하지 않는다.
4. 심사관 전용 상품(1/5/10회)과 **일반 공개 실판매 상품은 별개**. 심사용 상품만으로 판매실체를 증명했다고 간주하지 않는다.

### 제출 직전 읽기 전용 DB 확인

```sql
SELECT mode FROM public.nicepay_checkout_gate WHERE id = true;
SELECT count(*) AS review_accounts FROM public.accounts WHERE nicepay_review_access = true;
SELECT count(*) AS review_centers FROM public.centers WHERE is_nicepay_review = true;
SELECT p.name, p.center_name, p.price, p.product_kind
FROM public.fetch_public_storefront_products(NULL::uuid) AS p
ORDER BY p.center_name, p.name;
```
> 위 SQL은 전부 **SELECT만 수행**한다. 어떤 설정도 변경하지 않는다. 이 검증을 Production에서 자동 실행하도록 연결하지 않는다.

## 3. 운영 사이트 시연 체크리스트 (모바일 가능)

- [ ] `https://mwhabit.com/`: 홈 하단 상호·대표자·사업자번호·통신판매업번호·**사업장 주소** 실제 표시 확인(공개 여부 결정 상태 재확인)
- [ ] `https://mwhabit.com/legal/business`: 등록 정보·고객센터·운영 주체·거래 중개 안내 정확성 확인
- [ ] `https://mwhabit.com/products`: **실제 제공 상품** 1개 이상 공개, 가격·기간·상품 설명·환불 링크 확인, `테스트` 노출 정리
- [ ] `https://mwhabit.com/legal/notices/nicepay-20261030`: 사전 공지 실제 표시·공지일(10/30)·시행예정일(11/9) 확인, 공개 경로 저장
- [ ] 심사관 계정: 로그인 → 전용 센터 → 3개 수강권 및 제공기간 → 카드 선택 → 결제 차단 안내 (현재 정상)
- [ ] 일반회원 계정: 결제수단 카드 미노출 확인
- [ ] NICEPAY 공용 테스트 결제창: 실 MID/KEY 아닌 `nicepay00m` 전용 키 + 비운영 DB의 격리 QA에서만 인증 **전 열기·닫기**. 외부 승인·실과금 0. PR #259는 병합하지 않음
- [ ] NICEPAY 심사 접수 전: 제출 방식·실제 제공 상품 기준·심사관 접근 방식·계약 표기 정보 영업팀 답변 대조

## 4. 정책·출시 순서

1. **2026-10-30**: 사전 공지 PR #256 병합. 실제 Production에 10/30부터 게시되었는지 HTTP/화면 증거 확인 필요.
2. **2026-11-09 이후(예정)**: 공지기간·계약 당사자·위탁내용을 대조해 Draft PR #254를 별도 검증 및 승인 후 반영. **11/9이 자동 배포일은 아니다.**
3. 운영 서버의 `NICEPAY_CHECKOUT_ENABLED=false`, 일반회원 `NEXT_PUBLIC_PG_CHECKOUT_ENABLED=false`는 별도 실결제 허용 절차 전까지 **그대로** 둔다.
4. 심사관 전용 실거래 허용/취소 처리는 NICEPAY 안내와 사용자 사전승인이 있을 때만 개별 실행. 공용 테스트 계정으로 운영 MID 또는 실제 카드 승인 사용 금지.
5. NICEPAY 회신을 받아도 앱 내부 WebView 인증 복귀(`WapUrl`, `IspCancelUrl` 등)는 별도 실기기 QA 필요. 브라우저에서 열린다는 이유로 iOS/Android 통과라고 판단하지 않는다.

## 5. 다음 의사결정 / 담당

| 우선순위 | 담당 | 작업 | 현재 판정 |
| --- | --- | --- | --- |
| P0 | 센터 운영자/사용자 | 실제 판매 가능한 **공개 수강권 등록**, 테스트 상품의 판매 중단 결정 | **BLOCKED — 비즈니스 확인 필요** |
| P0 | NICEPAY 기술지원 | 공용 테스트 MID 상점키 표시 방법/별도 전달 | **회신 대기** |
| P0 | NICEPAY 영업 | 심사접수·계약 법인명·개인정보 처리위탁·시험상품 허용 범위 안내 | **회신 대기** |
| P1 | 사용자(아이폰 가능) | 홈 주소·공지 링크·공개 제품 화면 실제 표시 캡처 | **현장 확인 필요** |
| P1 | 개발/검토 | PR #254 날짜·문구·계약 검증 후 11/9 이후 별도 승인 | **Draft 유지** |
| P1 | QA | PR #259 실제 외부 결제창 열기·닫기(테스트 전용) | **MerchantKey/비운영 DB 필요** |

### 변경·실행 보고

1. 변경 파일: 이 문서 1개.
2. SQL 실행 필요: **NO**.
3. SQL 파일 경로: **없음**(이 문서의 SELECT는 수동 검증 예시).
4. SQL 실행 순서: **해당 없음**.
5. Supabase에 직접 실행할 **변경 SQL**: **없음**.
6. 검증: GitHub 문서가 Draft PR에 추가된 것만 확인. Production SQL·Vercel 설정·공개 상품·결제 로직 무변경.
7. NotebookLM: 이 파일을 최신 NICEPAY 심사 현황·차단조건 요약으로 사용. Graphify: 결제/DB 흐름 변화 없음, 갱신 불필요.
