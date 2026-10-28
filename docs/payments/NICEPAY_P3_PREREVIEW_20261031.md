# P3(심사 센터·상품) 사전 검토 — 운영 스키마 읽기 전용 대조 (2026-10-31)

운영 Supabase 에는 **SELECT 만** 실행했다(`supabase db query --linked`, 쓰기 단어·세미콜론 차단 래퍼). P3 SQL·심사관 권한 지정은 실행하지 않았다. 원본 응답: `docs/qa/nicepay-final-merge-prep-20261031/p3-prod-readonly/`(다른 사용자 데이터 없음 — 스키마·집계·사용자 본인 계정 플래그만).

## 호환성 결론
| 확인 | 결과 |
|---|---|
| 센터 1개 생성 가능 | 필수 컬럼은 `centers.name` 뿐(나머지 기본값). `status` check(pending/approved/rejected) 만족. SQL Editor 는 JWT 가 없어 `guard_center_insert` 가 `status`/`is_internal` 을 덮어쓰지 않음 |
| 수강권 3개 생성 가능 | 필수 `products.center_id`·`name`. check 제약(expiry_mode·pass_type·kind·visibility) 만족. `enforce_product_limit` 의 플랜 `max_products` 는 **null(무제한)** |
| `center_settings` | 필수는 `center_id` 뿐. `center_settings_limit_guard` 는 일일 예약·프라이빗 동시 수업 제한이 꺼진 기본값에서 통과 |
| 이용기간 | `expiry_mode='days'` 30/60/90일, 사전예약 0일(시작일=결제일) → NICEPAY 기준(사전예약 ≤60일, 제공기간 ≤1년) 만족 |
| P1 기간 RPC | `fetch_public_storefront_product_periods` 가 운영에 **이미 있음** — 별도 적용 불필요 |
| P2·P2b 상태 | 제한 정책 4개·보조 함수(`nicepay_order_is_review_target`) 존재, 게이트 `off`, 심사관 권한 0, 심사 센터 0 |
| 일반 회원 접근 차단 | P2 제한 정책이 운영에 적용돼 있고, 로컬 격리 QA(일반 회원·토스 심사관·비로그인 0건)로 동작 확인 |
| 기존 센터·상품 영향 | 없음(INSERT 만; 기존 행 읽기/수정 없음). 로컬에서 데이터 지문 불변 확인 |
| 센터 INSERT 부수 효과(트리거) | `center_roles` 3(스튜디오 오너/매니저/강사), `center_payout_accounts` 1(not_registered), `center_settlement_accounts` 1, `center_subscriptions` 1(첫 활성 플랜, `pending_billing_setup` — 기존 센터 5곳과 동일 상태, 회원 구매를 막지 않음) |
| 심사관 계정 `sonjw222@naver.com` | 계정 1행·프로필 1개 존재. `nicepay_review_access=false`(미지정), `pg_checkout_override=false`. **활성 센터 1곳의 매니저** — 아래 주의 |

## ⚠ 계정 주의
이 계정은 운영 센터 1곳을 관리한다. 심사관 권한(`nicepay_review_access=true`)을 주면 이 계정이 **회원으로** 볼 때는 심사 센터만 보인다(운영 센터 탐색·구매 불가). 관리자 화면은 그대로다. 심사 기간 동안 평소 회원 화면 사용이 제한되므로 **심사 전용 별도 계정을 권장**한다. 로컬 QA 의 "매니저 겸 심사관(S)" 페르소나로 이 조합에서도 심사 상품 결제 경로가 동작함은 확인했다.

## 제안 수정(실서비스 형태에 맞춤) — `seed_nicepay_review_center_20261031_proposed.sql`
- 운영 상품 현황(집계): 활성 수강권 18종 전부 횟수제, 가격 100~320,000원(중앙값 50,000원), 이용기간 90일. 기존 시드의 1,000/4,000/10,000원·기간제는 실제 상품과 달라 보인다.
- 제안: 센터명 `모하빗 스튜디오 (NICEPAY 카드사 심사용)`, 수강권 `1회 수업 이용권` 15,000원/30일, `5회 수업 이용권` 60,000원/60일, `10회 수업 이용권` 110,000원/90일(모두 횟수제, 사전예약 없음). 심사 전용임은 센터 소개·상품 설명에 밝힘. **이름·가격·기간은 사용자 확정 사항**이다.
- 가드 강화: P2 정책 3개 이상 존재 확인, 이미 심사 센터가 있으면 중단. 심사관 지정은 별도 `assign_nicepay_reviewer_20261031_proposed.sql`(이메일 확정 필요).
- 로컬 격리 DB 에서 롤백 트랜잭션으로 시험(센터 1·상품 3 INSERT 성공).
