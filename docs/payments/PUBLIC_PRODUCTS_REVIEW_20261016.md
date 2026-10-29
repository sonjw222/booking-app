# 공개 상품(/products) 카드사 심사 점검 — 2026-10-16

방법: 코드·SQL 저장소 분석 + `https://mwhabit.com/products` 읽기 전용 열람. **DB 접속·변경 없음. 센터/상품 ID는 이 방식으로 확인할 수 없어 미확인**(아래 읽기 전용 조회 제안 참고).

## 1. 노출 현황 (2026-10-16 열람)
센터 2곳 / 상품 9개. 의심 항목: ① A10TION 피겨팀의 "테스트"(수강권 1회 100원) ② 센터 "P3 타센터-격리테스트"의 "P3 타센터전용패스"(999회 0원).

## 2. 원인 분석
| 질문 | 분석 |
|---|---|
| 용도 | ②는 이름상 **다른 센터 상품과의 격리(교차 센터 권한) 검증용 QA 센터**(P3 = 보안/격리 테스트 배치 이름 추정). ①은 실제 센터 내부의 결제/구매 테스트용 상품으로 보임. 저장소에서 두 이름은 SQL·테스트에 하드코딩되어 있지 않음 → QA가 UI로 만든 운영 데이터 |
| 왜 공개 RPC에 나오나 | `fetch_public_storefront_products`는 `status='approved' AND is_active AND is_on_sale AND visibility_type='all'`만 본다. 저장소의 최신 정의(`add_internal_qa_center_flag.sql`)는 `NOT is_internal`도 요구한다. 그런데 ②가 보인다는 것은 (a) 센터의 `is_internal`이 false이거나 (b) 해당 flag migration이 **운영 DB에 적용되지 않았다**(CHANGELOG: "production 미실행")는 뜻. ①은 일반 센터의 정상 공개 상품이라 RPC 관점에서는 의도대로 노출 |
| 비공개 처리가 QA에 미치는 영향 | ②를 `is_internal=true`로 전환하면 멤버/관리자/플랫폼 관리자에게만 보임(교차 센터 격리 QA는 해당 센터 멤버 계정으로 계속 가능, 비멤버 계정의 "안 보임" 검증은 오히려 정확해짐). 단 `confirm_test_payment`(Mock)는 internal 센터에서만 동작하므로 그쪽 QA에는 유리. 상품 `is_on_sale=false`는 구매만 막고 기존 수강권·예약은 유지 |
| 삭제 없이 제외 | ① 상품: 센터 매니저 UI에서 "판매 중지"(`is_on_sale=false`) — 삭제 아님, 기존 수강권 영향 없음, 언제든 복구. ② 센터: `centers.is_internal=true`(전제: `add_internal_qa_center_flag.sql` 적용 확인) 또는 해당 상품 판매중지 |
| 내부 QA 센터 비가시성 정책과의 연관 | 정책 SQL이 이미 저장소에 있으나(flag, 공개 RPC 제외, 12개 테이블 후속 `fix_internal_qa_center_public_relations_20261004.sql`) 운영 적용 여부 미확인. **적용 여부 확인이 선행 과제** |

## 3. 읽기 전용 확인 SQL (제안 — 실행하지 않음, 사용자가 SQL Editor에서 실행)
```sql
-- 1) flag 마이그레이션 적용 여부
select column_name from information_schema.columns where table_name='centers' and column_name='is_internal';
select pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure) like '%is_internal%' as storefront_hides_internal;
-- 2) 대상 식별
select c.id, c.name, c.status, c.is_internal, p.id as product_id, p.name as product_name, p.price, p.is_active, p.is_on_sale, p.visibility_type
from products p join centers c on c.id = p.center_id
where c.status='approved' and (p.name ilike '%테스트%' or c.name ilike '%격리테스트%' or p.name ilike '%P3%');
-- 3) Mock 확정 가드가 라이브에도 있는지
select pg_get_functiondef('public.confirm_test_payment(uuid,text)'::regprocedure) like '%is_internal%' as mock_confirm_internal_only;
```

## 4. 비공개 전환안 (승인 전 변경 금지)
| 대상 | 변경 | 영향 | 복구 |
|---|---|---|---|
| "테스트" 상품(ID 미확인, §3-2로 확인) | 센터 매니저 UI에서 판매 중지(`is_on_sale=false`) | /products·구매 목록에서 사라짐, 기존 수강권/주문 무영향 | 판매 재개 |
| "P3 타센터-격리테스트" 센터(ID 미확인) | `update centers set is_internal = true where id = '<확인된 ID>';` (flag 적용 확인 후) | 일반 사용자/anon에게 센터·상품 숨김, 멤버·관리자는 유지 | `set is_internal=false` |
| flag migration 미적용 시 | `add_internal_qa_center_flag.sql`(+ 후속 fix, verify) 적용 — **별도 승인·검토 필요**(정책 변경 범위 큼) | 위 | `rollback_add_internal_qa_center_flag.sql` |
TEST/샘플 상품은 새로 만들지 않았다. 심사용 "실제 상품"은 A10TION 피겨팀의 정상 상품 7~8개(가격·횟수 표시)로 충족.

## 5. 이용기간 표시 SQL 설계안 (적용하지 않음)
현재 공개 RPC는 `expiry_mode/expiry_days/expiry_date`(products 컬럼, `add_product_expiry_options.sql`)를 반환하지 않아 /products에 이용기간이 없다.
```sql
-- (설계) 반환 컬럼 추가는 반환 타입 변경이라 create or replace 불가 → 의존 객체 확인 후:
-- drop function if exists fetch_public_storefront_products(uuid);
-- create function fetch_public_storefront_products(p_center_id uuid default null) returns table ( …기존 17개…, expiry_mode text, expiry_days int, expiry_date date ) …
--   select …, p.expiry_mode, p.expiry_days, p.expiry_date …  (기존 where 절 유지, is_internal 제외 유지)
-- revoke all … from public; grant execute … to anon, authenticated;   -- 기존 권한 재부여 필수
-- 롤백: 기존 정의로 drop/create 재실행(rollback_add_public_storefront_products.sql 참고)
```
앱 변경: `lib/center.ts`의 `PublicStorefrontProduct`/매핑에 3필드, `/products`에서 "이용기간 N일 / ~YYYY-MM-DD까지 / 제한 없음" 표시. SQL 적용 전에는 앱 변경도 하지 않는다(필드가 없으면 undefined).

## 6. 카드사 심사 체크리스트 갱신
| 항목 | 상태 |
|---|---|
| 하단 사업자 정보(상호·대표·사업자번호·통신판매업·고객센터) | PASS (주소는 사용자 결정으로 비공개 — NICEPAY 요건과 충돌 시 NEEDS_APPROVAL) |
| 실제 상품 2~3개 이상, 상품명·가격·횟수 | PASS |
| 이용기간 | NEEDS_WORK (SQL 승인 필요, §5) |
| 환불·취소 조건 | PASS(링크) / 문구의 PG명은 승인 후 갱신 |
| 판매자·서비스 제공자 정보 | PASS(사업자 정보 링크). 중개자 vs 대금 수납 주체 설명은 NEEDS_APPROVAL(`PG_MIGRATION_TOSS_TO_NICEPAY.md` §6) |
| 테스트 상품 노출 | NEEDS_WORK (운영 데이터, §4 승인 필요) |
| 구매 진입 경로 | PASS(센터에서 보기 → 로그인 후 구매). 비회원/심사용 로그인 계정 정책은 계약 후 NICEPAY 안내에 따름 |
| 모바일/PC 표시 | 기존 `.app-shell` 반응형 레이아웃(이번 변경은 텍스트 블록만). 실기기 확인은 미실시 |
