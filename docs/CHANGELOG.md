# CHANGELOG

이 저장소는 2026-07-26 `Initial commit`에 그 이전까지 개발된 기능이 통째로 들어왔습니다
(초기 개발은 zip 파일 전달 방식으로 진행됨 — `SETUP_INSTRUCTIONS.md` 참고).
따라서 **초기 스냅샷 이전의 기능별 이력은 Git 커밋만으로 알 수 없으며**, 이후 변경은 실제 commit과 아래 재구성 기록을 함께 확인해야 합니다.

아래는 두 가지 근거를 함께 사용해 재구성한 변경 이력입니다.
1. **Git 커밋 로그** (2026-07-26 이후, 실제 날짜 있음)
2. **SQL 마이그레이션 파일 + `TEST_CHECKLIST*.md` 문서**에 남아 있는 롤아웃 순서 (날짜 없음, 상대적 순서만 확인 가능)

## 2026-08-14 — SEC-102/103 accounts/profiles 시스템 전체 검색 노출 구현(코드+SQL, SQL 미실행)

**SQL 실행 없음(코드는 커밋됨), main merge 없음.** `"매니저 계정 검색"`/`"매니저 대표프로필
검색"` RLS 정책이 권한 체크 없이 "어디서든 active 매니저이기만 하면" accounts/profiles
테이블 전체를 검색 대상으로 허용하던 문제(SEC-101과 독립적으로 존재) 수정. 유일한 소비처인
`lib/members.ts`의 `searchAccountsForMember()`(신규 회원 등록 검색)를 전수 조사해
`center_members` 스코핑이 이 기능 목적과 모순됨을 확인 — 대신 `customer.member.create`
권한을 확인하고 최소 필드(profile_id/name/phone)만 반환하는 `search_accounts_for_member()`
RPC로 교체, 원래의 무제한 RLS 정책 2개는 제거. `fix_staff_search.sql`의 "계정 조회"
정책(스태프 초대 검색)은 이미 별도 권한 체크가 있어 이번 범위 밖으로 확인.

신규 회귀 테스트 `tests/integration/account-search-scope.test.ts`(SEARCH-SEC-A~D).
`npm run build`(TypeScript 포함) 통과, `npm run test`(unit) 217/217 통과 확인.

## 2026-08-13 — ✅ SEC-118 orders.amount 클라이언트 신뢰 문제 Live 적용 완료

**사용자가 SQL 직접 실행, Live 적용 완료.** `pg_get_functiondef('fulfill_order(uuid)')`로
실제 Live 본문을 먼저 확인해(6개 파일에 흩어진 정의 중 `direct_amount` 분기가 포함된
버전이 Live였음) SQL을 정정한 뒤 적용. 적용 후 read-only 확인: `orders.verified` 컬럼
존재, `create_order_secure`/`fulfill_order`/`confirm_test_payment` 3개 함수 전부
`security_type='DEFINER'`. 기존 pending/paid 주문 790건 중 `products.price`와 금액이
불일치하는 것은 0건 — 이번 재검증 도입으로 새로 막히는 기존 주문이 없음을 확인.

## 2026-08-13 — SEC-118 orders.amount 클라이언트 신뢰 문제 구현(코드+SQL, SQL 미실행)

**SQL 실행 없음(코드는 커밋됨), main merge 없음.** 설계 문서(D안: RPC화 + 이중 방어)를 그대로
구현. `create_order_secure()` 신규 RPC가 `products.price`를 서버에서 직접 계산해 주문을
만들고(`orders.verified=true`), `fulfill_order()`/`confirm_test_payment()`는 `verified=false`
(레거시/직접 insert) 주문만 현재 `products.price`와 대조하는 재검증을 거친다. 포인트 사용도
RPC 내부에서 `use_points()`를 직접 호출해 원자적으로 처리해, "포인트를 이만큼 썼다"는
클라이언트 주장을 그대로 믿던 잔여 취약점까지 닫았다.

`lib/orders.ts`의 `createOrder()` 시그니처를 변경(centerId/amount/productName/couponCode/
discountAmount 제거)하고 `app/checkout/page.tsx`/`app/cart/page.tsx` 호출부를 갱신 — 쿠폰
할인(데모 기능, 서버 검증 없음)은 의도적으로 실제 청구 금액에 반영하지 않음(TODO.md SEC-118
항목에 알려진 부작용으로 기록). 기존 `auto-book-membership-security.test.ts`의
`AUTO-SEC-L`이 가정하던 임의 금액(10000)과 상품 가격(기본값 0) 불일치를 새 재검증이 잡아내는
회귀를 발견해 함께 수정. 신규 회귀 테스트 `tests/integration/orders-amount-tampering.test.ts`
(AMOUNT-SEC-A~F, 조작된 금액으로 직접 orders insert 시 거부되는 것을 실제로 재현·검증).

`npm run build`(TypeScript 포함) 통과, `npm run test`(unit) 217/217 통과 확인.

## 2026-08-13 — ✅ SEC-101/112/113 manager_centers 권한 모델 Live 적용 완결(SQL 실행 완료)

**사용자가 SQL 직접 실행, Live 적용 완료.** 마지막까지 미적용이던 defense-in-depth 2종을
사용자가 Live에 실행:
- `trg_manager_centers_role_center_match` BEFORE INSERT/UPDATE 트리거(role_id/center_id
  정합성을 RLS와 독립적으로 테이블 레벨에서 강제) — `pg_trigger.tgenabled='O'`로 활성 확인.
- `has_permission()`의 `r.center_id = mc.center_id` cross-center join 하드닝(security
  definer 전환은 이미 hotfix v2로 적용돼 있었음) — `information_schema.routines.
  security_type='DEFINER'`로 확인.

이로써 SEC-101(임의 센터 self-join)/SEC-112(self-promote)/SEC-113(마지막 행 self-delete →
orphan → 재클레임) RLS 정책 4종 + RLS 무한 재귀 4겹 hotfix(center_roles/has_permission/
manager_centers 자기참조/centers) + 사용자가 직접 추가한 강화 조건 2종(centers.status=
'pending' 체크, self-UPDATE has_any_row 체크) + defense-in-depth 2종(trigger, cross-center
join) **전부 Live 적용·확인 완료**. 회귀 테스트(Integration) GREEN 확인은 2026-08-13 당일
여러 세션의 동시 CI 실행으로 인한 인프라 부하(SQL과 무관)로 보류 — 부하가 가라앉은 뒤
재확인 필요.

## 2026-08-13 — E2E `.sheet-overlay` 타이밍 플레이키니스 근본 수정(테스트 파일만)

CI 재실행을 반복하는 과정에서 `.sheet-overlay` 관련 실패가 매번 다른 파일에서 발생하는 걸
관찰(같은 `daily-book-limit.spec.ts`가 알려진 사례였던 것과 동일 계열) — 사용자가 3연속 같은
지점 실패를 지적해 원인 조사함. `await expect(page.locator(".sheet-overlay")).toHaveCount(0)`
(예약 확정 후 시트 닫힘 대기) 패턴이 `tests/e2e/` 13개 파일 33곳에서 기본 10초 타임아웃을
쓰고 있었고, 공유 테스트 계정에 누적된 데이터로 응답이 느려지는 이미 알려진 원인(다른
곳들은 이미 30~120초로 개별 연장돼 있었음)이 이 지점만 예외적으로 남아있었음. 이번 P0
배치가 수정한 어떤 SQL(manager_centers/center_roles/centers/has_permission)도 회원 예약
흐름에 관여하지 않아 회귀가 아님을 코드 경로로 확인 — 33곳 전부 30초로 통일.

## 2026-08-13 — hotfix v4(4번째 재귀 경로) + 사용자 직접 강화 조건 2개를 canonical 파일에 반영(SQL 미실행)

**SQL 실행 없음, main merge 없음.**

다른 세션과 실시간 cross-session 조율 중, `[1]`(매니저센터 생성)에 추가된 `centers.status=
'pending'` 체크가 `centers`→`manager_centers` raw 참조 순환을 새로 드러냈고, 다른 세션이
hotfix v4(`fix_centers_manager_centers_recursion_draft_proposed.sql`, `my_center_ids_any_
status()` 신규 헬퍼)로 Live 적용·확인 완료함. 이 파일 `[8]`번으로 동일 내용 재선언 추가.

read-only 진단([6]) 결과, 사용자가 Live에 직접 추가한 강화 조건 2개도 확인·동의를 거쳐 반영:
- `[1]` "매니저센터 생성"에 `centers.status='pending'` 체크 — approved된 센터가 orphan이
  되더라도 self-INSERT로 재클레임 못 하게 막는 추가 방어선. PART 3에서 "새 컬럼 필요"로
  봤던 provenance 문제를 기존 `status` 필드 생애주기로 해결(스키마 변경 없음).
- `[3]` "오너 스태프 수정" self 분기에 `not manager_centers_has_any_row(center_id, id)` —
  self-INSERT~self-UPDATE 사이 out-of-band 경로로 다른 행이 끼어드는 경우까지 방어.

`diagnose_manager_centers_orphan_and_mismatch_readonly.sql`에 centers 정책 확인([13]),
manager_centers with_check의 centers 참조 확인([14]) 추가. rollback 파일도 centers 정책 원복 +
`my_center_ids_any_status()` DROP을 포함하도록 갱신.

재귀 경로는 이제 총 4겹 전부 Live 적용·확인됨. 이 canonical 파일에서 Live 대비 남은 진짜
신규 변경은 여전히 `[5]`번 trigger와 `[6]`번 has_permission()의 cross-center join 조건 2가지뿐.

## 2026-08-13 — `fix_manager_centers_privilege_model_draft_proposed.sql`을 Live 적용된 hotfix 3종에 맞춰 재조정(SQL 미실행)

**SQL 실행 없음, main merge 없음.**

병렬 세션이 아래 hotfix 3종을 Live에 적용·확인한 사실을 뒤늦게 발견(같은 브랜치
`security/p0-batch-consolidation`에 커밋으로 남아 있었음, fast-forward로 로컬에 반영).
`fix_manager_centers_privilege_model_draft_proposed.sql`(이 세션이 작성한 canonical 파일)이
hotfix 3종 적용 이전의 구버전 정책/함수 본문을 그대로 담고 있어, **이 파일을 나중에 그대로
적용하면 hotfix v2(has_permission security definer)와 v3(manager_centers 자기참조 helper
함수화)를 되돌려 재귀 버그가 재현될 위험**이 있음을 확인 — 즉시 재조정함:

- `[0]` 신규: helper 함수 3종(`manager_centers_has_any_row`/`role_id_belongs_to_center`/
  `role_id_is_owner_for_center`, hotfix v3와 동일) 추가.
- `[1]~[4]`: "매니저센터 생성"/"오너 스태프 초대"/"오너 스태프 수정"/"오너 스태프 삭제"
  정책을 hotfix v3와 동일하게(helper 함수 사용) 재작성.
- `[6]`: `has_permission()`을 hotfix v2(security definer 전환)와 이 파일의 원래 계획(PART 5,
  `r.center_id = mc.center_id` cross-center join 조건)을 합친 최종본으로 작성 — hotfix v2
  단독 적용 상태에는 이 join 조건이 없었으므로, 이 부분만 진짜 신규(아직 Live 미적용).
- `[7]`: hotfix v1과 동일 재선언(멱등).
- rollback 파일에 helper 함수 3종 DROP 추가 + "이 롤백을 실행하면 hotfix 3종이 전부
  되돌아가 스태프 초대가 다시 깨진다"는 경고를 상단에 명시.
- `diagnose_manager_centers_orphan_and_mismatch_readonly.sql`에 has_permission()
  security_type 확인([11]), helper 함수 3종 존재 확인([12]) 추가.

이 재조정 후 이 파일에서 hotfix 3종 대비 남는 진짜 신규 변경은 `[5]`번 trigger(role_id/
center_id 정합성, RLS 우회 경로까지 방어)와 `[6]`번 has_permission()의 cross-center join
조건 2가지뿐 — 둘 다 아직 Live 미적용.

## 2026-08-13 — `center_roles`/`manager_centers` RLS 무한 재귀 긴급 hotfix 3종 적용(Live, 사용자 확인) — 스태프 초대 기능 복구

**Live SQL 3건 사용자가 직접 실행·확인 완료.** SEC-101/112/113(`fix_manager_centers_privilege_escalation_draft_proposed.sql`, 2026-08-12 Live 적용)이 도입한 cross-center role_id 검사가 `manager_centers`/`center_roles` 상호 참조와 결합해 `infinite recursion detected in policy for relation "manager_centers"`로 스태프 초대(`/manager/staff`)가 완전히 깨져 있던 문제를 확정·수정.

원인은 한 겹이 아니라 raw(비-`security definer`) 서브쿼리 3곳이 겹쳐 있었음(순서대로 적용해야 각각 다음 겹을 드러냄):

1. `fix_center_roles_manager_centers_recursion_draft_proposed.sql` — `center_roles`의 "내 센터 역할 조회" SELECT 정책이 `manager_centers`를 raw 서브쿼리로 되짚던 것을 `my_managed_center_ids()`(security definer) 기반으로 교체.
2. `fix_has_permission_manager_centers_recursion_draft_proposed.sql` — `has_permission()`이 security definer가 아니어서 `manager_centers`/`center_roles`를 caller 권한으로 raw JOIN하던 것을 security definer로 전환(로직/반환값 불변).
3. `fix_manager_centers_self_reference_recursion_draft_proposed.sql` — `manager_centers` 자신의 INSERT("매니저센터 생성")/DELETE("오너 스태프 삭제") 정책에 함수 없이 직접 박혀 있던 자기참조 서브쿼리, 그리고 INSERT/UPDATE 정책의 `role_id`↔`center_roles` 교차참조를 신규 helper 함수(`manager_centers_has_any_row`/`role_id_belongs_to_center`/`role_id_is_owner_for_center`, 전부 security definer)로 치환. 조건식 자체는 전혀 바꾸지 않음 — 표현 방식만 rewriter에 opaque한 함수 호출로 변경.

세 파일 모두 각자 독립 rollback 포함, BEGIN/COMMIT 트랜잭션. 정상 스태프 초대 재현 확인(사용자 실측)으로 완료 확인.

## 2026-08-13 — 🚨 CI에서 발견: center_roles RLS 무한 재귀 버그 수정(SQL 미실행, 이미 Live에 존재하는 버그로 추정)

**SQL 실행 없음, main merge 없음.**

- **root cause**: `security/p0-batch-consolidation` 브랜치 4번째 CI Integration 실행에서
  `infinite recursion detected in policy for relation "manager_centers"` 실패를 실제로 확인.
  2026-08-12에 이미 Live 적용된 `fix_manager_centers_privilege_escalation_draft_proposed.sql`의
  "오너 스태프 초대"/"오너 스태프 수정" 정책이 `center_roles`를 조회하는데, `center_roles`의
  기존 "내 센터 역할 조회" SELECT 정책(`reservation_functions.sql`)이 `manager_centers`를
  security-definer 헬퍼 없이 raw 서브쿼리로 되짚어 순환이 발생함(`manager_centers`의 "오너
  스태프 조회" 정책은 이미 `my_managed_center_ids()`를 써서 문제 없음 — `center_roles` 쪽만
  이 패턴 미적용). **이 버그는 이번 배치의 신규 변경([1]~[6])과 무관하게 이미 2026-08-12
  적용분에서부터 존재할 수 있어, 지금 Live에서 스태프 초대 기능이 깨져 있을 가능성이 있음.**
- **수정**: `fix_manager_centers_privilege_model_draft_proposed.sql`에 [7]번 섹션 추가 —
  "내 센터 역할 조회"를 `center_id in (select my_managed_center_ids())`로 교체(이미 검증된
  안전 패턴과 동일). rollback 파일도 원복 시 이 recursion이 재현될 수 있음을 명시하며 함께
  갱신.
- `docs/TODO.md` SEC-101/112/113 항목에 이 발견을 기록. SQL은 draft 파일 수정만 하고 직접
  실행하지 않음 — 사용자 적용 대기.

## 2026-08-13 — manager_centers 권한 모델 완결: has_permission defense-in-depth + trigger (SQL 미실행)

**SQL 실행 없음, main merge 없음, app/CSS/디자인 브랜치 무변경.**

- **SEC-113 재확정 + 최종 아키텍처 설계**: 기존 Live 적용된 SEC-101/112/113 RLS 정책(4종)만으로는
  cross-center role injection과 role_id/center_id mismatch에 대한 2차 방어가 없음을 확인 —
  `has_permission()`이 `center_roles.center_id`를 검증하지 않고, role_id/center_id 정합성이
  RLS에만 의존(service_role/미래 RPC 우회 가능)했다.
- **`fix_manager_centers_privilege_model_draft_proposed.sql`(신규, 미적용)**: 기존 RLS 정책
  4종은 재선언(변경 없음)하고, (1) `manager_centers` BEFORE INSERT/UPDATE trigger로 role_id/
  center_id 정합성을 테이블 레벨에서 강제(RLS 우회 경로까지 방어) (2) `has_permission()`의
  `center_roles` join에 `r.center_id = mc.center_id` 조건 추가(정상 데이터엔 영향 없는
  defense-in-depth) — 두 가지를 새로 추가. `fix_manager_centers_privilege_escalation_draft_
  proposed.sql`을 대체.
- **설계안 4종(A/B/C/D) 비교**: 현재 RLS+trigger 방식(A, 즉시 적용)을 최소 수정안으로 채택,
  센터 생성+오너 부트스트랩을 atomic RPC로 통합하는 방식(C)을 장기 권장 아키텍처로 `docs/TODO.md`에
  기록(코드 변경 필요해 이번 배치 범위 밖).
- **회귀 테스트 재구성**: `tests/integration/manager-centers-privilege-model.test.ts`(SEC-MC-A~S,
  19개 케이스) — 기존 `manager-centers-privilege-escalation.test.ts`(A~T)를 흡수·확장, 신규로
  role_id/center_id mismatch 직접 차단(N, service_role client로도 trigger가 막는지 확인) +
  has_permission() defense-in-depth(O) 추가.
- **SEC-102/103 재확인(설계만, 이번 배치에 미포함)**: `accounts`/`profiles` "매니저 계정/대표프로필
  검색" RLS가 검색 대상과 무관하게 "어디서든 active 매니저이기만 하면" 테이블 전체를 노출하는
  것을 코드로 재확인. SEC-101을 완전히 막아도 정상적으로 자기 센터를 부트스트랩한 오너라면
  여전히 이 조건을 만족해 **독립적으로 남는 문제**임을 확정, `docs/TODO.md`에 후속 설계 방향만
  기록.
- **Live orphan 진단**: `diagnose_manager_centers_orphan_and_mismatch_readonly.sql`(신규,
  READ-ONLY) — 이미 orphan된 center, role_id/center_id mismatch 기존 데이터, owner 없는 센터
  여부를 사용자가 직접 확인할 수 있도록 작성. 이 세션에서는 Live DB에 직접 접근할 수 없어
  실행하지 않음.
- **static audit**: `npx tsc --noEmit` 신규 테스트 파일 0 에러, `npm run test`(unit) 217/217,
  신규 integration 테스트 import/구문 검증 완료(env 누락까지 정상 도달).

## 2026-08-13 — P0 보안 산출물 통합·정리(SEC-101/112/113/114/115/117/118) — SQL 미실행 (security/p0-batch-consolidation)

**SQL 실행 없음, main merge 없음, app/CSS/디자인 브랜치 무변경. SQL draft/rollback/설계문서/
회귀테스트만 정리.**

- **병렬 세션 산출물 발견 및 통합**: 이 저장소 밖(다른 worktree)에서 최소 2개의 독립 세션이
  같은 보안 이슈들을 동시에 조사·수정 중이었음을 발견 — 전부 read-only로 비교한 뒤 하나의
  canonical 세트로 통합했다(사용자 확인 거쳐 auto_book_membership은 B안 `my_managed_center_ids()`
  로 최종 확정).
- **SEC-101+SEC-112+SEC-113 통합**: 기존 SEC-101/112 canonical SQL에 신규 SEC-113(마지막
  manager_centers 행 self-delete → orphan → 제3자 self-claim, 2026-08-13 P1/P2에서 P0로
  재평가) DELETE 정책 수정을 같은 트랜잭션으로 통합. 회귀 테스트에 P~T(5개 케이스) 추가.
- **SEC-114 canonical 확정(B안) + pass_selection_mode 보정**: `my_managed_center_ids()` 기반
  authorization을 채택하면서, 함수 내부 `class_allowed_products` 필터가 구식 "행 존재 여부"
  패턴을 쓰던 것을 최신 `classes.pass_selection_mode` 컬럼을 reserve_class와 정확히 동일한
  형태로 직접 참조하도록 수정. 회귀 테스트는 canonical(B안) 테스트에 다른 세션 A안의
  고유 커버리지(AUTO-SEC-K platform admin, AUTO-SEC-L fulfill_order end-to-end)를 이식,
  A안 전용이던 "저권한 스태프 거부" 기대값은 B안 설계와 양립하지 않아 폐기.
- **SEC-115 canonical 채택**: 다른 세션이 작성한 `manager_set_attendance` membership 무결성
  수정(waitlisted 취소 시 오복구 방지, waitlisted→confirmed 무차감 확정 차단)을 canonical로
  채택 — 상태 기반(`status in (...)`) 체크가 `membership_consumed` 컬럼 직접 참조보다 더
  견고함을 확인. 기존 BUG-116/BUG-117은 이 번호로 통합, 폐기 처리.
- **SEC-117/119 분리**: 다른 세션이 "SEC-116"으로 등록했던 EXECUTE 최소화 하드닝 항목이
  이 저장소의 기존 SEC-116(fulfill_order 세분권한 미사용)과 번호가 충돌 — SEC-119로
  재배정하고 canonical 번호 매핑 표를 `docs/TODO.md`에 신규 작성.
- **SEC-118 신규(설계만)**: `orders.amount`가 클라이언트 신뢰 값이고 `product.price` 서버
  재계산이 없어 가격 조작이 가능함을 확정 — `docs/25_SEC118_Orders_Amount_Design.md`에 4개
  설계안 비교 + 권장 아키텍처(D안: 신규 RPC + fulfill_order 방어적 재검증) 작성. 코드/SQL은
  이번 배치에 포함하지 않음, 별도 P0 Batch로 분리.
- **refund_membership 환불 후 예약 잔존 문제 신규(설계만)**: 환불된 membership이 여전히
  살아있는 미래 예약을 가질 수 있고, 그 예약이 나중에 취소되면 이미 환불된 membership에
  유령 잔여횟수가 생기는 경로를 확인 — `docs/TODO.md`에 4개 해결안 비교 기록, SQL 미작성.
- **static audit**: `npx tsc --noEmit` 신규/수정 테스트 파일 3개 전부 에러 0건, `npm run test`
  (unit) 217/217 통과, 신규 integration 테스트 3개 파일 전부 env 누락 단계까지 정상 도달
  (import/구문 오류 없음, 실제 실행은 SQL 미적용이라 하지 않음).

## 2026-08-11 — 담당 강사 복수 지정 + 수강권 허용 정책 변경 Batch 최종 완료: 전체 CI 2연속 Green (feature/social-auth-notifications-attendance-dashboard)

두 번째 SQL(`add_class_trainer_names_rpc_draft_proposed.sql`)까지 적용 완료되면서 이
Batch가 최종 완료됐다. 사용자 리뷰로 RPC 권한을 강화(public/anon EXECUTE 명시적 차단,
authenticated만 허용 + `auth.uid() is not null` 이중 방어)한 뒤 적용 — anon 호출이
401 `permission denied for function class_trainer_names`로 정상 차단됨을 read-only로
확인. `lib/reservations.ts`가 이 RPC(`class_trainer_names`)를 쓰도록 전환하는 코드도
함께 push.

전체 CI(E2E/Unit/Integration/Build) **2연속 Green**으로 최종 검증(run
`31487777454`/`31489758487`, 둘 다 first-attempt·재시도 없음 — E2E 45/45, Unit
213/213, Integration 133/133). `class-trainers-and-pass-selection-mode.test.ts`의
"담당 강사가 지정된 수업은 instructorNames에 이름이 채워진다" 케이스(1차 SQL만 적용된
상태에서 실패했던 바로 그 테스트)도 이제 통과. 기존 P0~P4/P1-15/P1-17 관련 테스트
전부 회귀 없이 통과 확인.

## 2026-08-11 — SQL 적용 완료 + 관리자 UI를 SQL 원래 설계대로 수정 (feature/social-auth-notifications-attendance-dashboard)

`add_class_trainers_pass_selection_mode_draft_proposed.sql`을 Supabase에 적용 완료(사용자
실행, 오류 없음). Read-only 확인: `classes.pass_selection_mode` 컬럼 존재,
`all`=389건/`selected`=85건/합계 474건으로 migration 헤더 주석이 예고한 수치와 정확히
일치. anon PATCH 시도는 RLS에 막혀 0행 no-op임을 별도 확인(쓰기 회귀 없음).

SQL 적용 검증 중 발견한 설계 불일치를 사용자 확인 후 수정: SQL 헤더 주석은 "수강권
0개 선택 시 저장 금지 + '전체 선택' 버튼으로 명시적 전체허용 표현"을 원래 설계로
명시했는데, 이전 세션에서 만든 `app/manager/classes/page.tsx`는 예전 방식("0개 선택 =
자동으로 전체허용")을 그대로 유지하고 있었다. 이번에 SQL 설계대로 수정:
- `resolvePassSelection()` 헬퍼 추가 — 선택 0개면 저장 자체를 막고(신규/반복/수정 모든
  경로), 선택 개수가 그 센터의 pass 전체 개수와 같으면 `mode='all'`(class_allowed_products는
  비워서 저장, 스냅샷 아님), 그 사이면 `mode='selected'`(정확히 선택된 목록만 저장).
- "전체 선택"/"전체 해제" 버튼 추가(기존 "선택 해제(모든 수강권 허용으로 전환)" 버튼
  대체). 신규 등록 폼은 기본값 'all'을 "모든 chip 체크"로 시각화하기 위해 열 때부터
  전체 체크 상태로 시작. 수정 폼은 `c.passSelectionMode`를 읽어 'all'이면 전체 체크,
  'selected'면 실제 저장된 목록으로 정확히 재구성.
- 이 변경으로 기존 E2E가 가정하던 "빈 선택=전체허용" 상호작용이 전부 깨져서(디폴트가
  이제 전체 체크라 특정 pass 1개를 고르려면 먼저 전체 해제부터 해야 함) 영향받는 3개
  스펙 파일(`class-allowed-products.spec.ts`, `new-class-creation.spec.ts`,
  `membership-schedule-rules.spec.ts`)의 관련 테스트를 새 상호작용 순서(전체 해제 →
  개별 선택)와 새 상태 표현("전체 체크 개수" 기준, 0개 기준 아님)에 맞춰 수정. 로직
  검증(RPC가 실제로 무엇을 허용/거부하는지)은 그대로 유지 — 이번 수정은 순수하게
  "UI가 그 상태에 도달하는 상호작용 순서"만 바꾼 것.
- `npm run build` 타입체크 + 단위테스트 213/213 통과 확인(로컬). Integration/E2E는
  로컬에 테스트 자격증명이 없어 브랜치 push 후 GitHub Actions CI로 검증(아래 별도 기록).

**CI 1차 실행에서 발견 + 수정(진짜 앱 버그, race condition)**: E2E 3건이 재진입 시
"1개만 선택됨"을 기대했는데 "14개(그 센터 pass 전체) 선택됨"으로 실패(run
`31484011506`). 원인: `save()`가 `setFormOpen(false)`(시트가 즉시 닫힘)를
`await loadClasses(...)`(목록 재조회) 완료 **전에** 실행해, 저장 직후 곧바로 같은
수업을 재클릭하면 `openEdit()`이 아직 갱신 전인 stale `ManagedClass.passSelectionMode`를
읽고 있었다(실제로는 방금 'selected'로 저장됐는데 목록엔 여전히 옛 'all'이 남아 있어
전체 체크로 잘못 표시). 수정: `lib/classes.ts`의 스케줄 복사 전용 내부 함수였던
`fetchClassPassMode()`를 `fetchClassPassSelectionMode()`로 공개(export)하고,
`openEdit()`이 목록 캐시 대신 이 함수로 그 class의 실제 현재 `pass_selection_mode`를
다시 조회해 하이드레이트하도록 변경 — 목록이 아직 안 갱신됐어도 항상 정확한 값을 보여줌.

## 2026-08-11 — 담당 강사 복수 지정 + 수강권 허용 정책 변경 Batch (feature/social-auth-notifications-attendance-dashboard)

P3-1(수업 구분과 복수 강사 배정) 중 "복수 강사 배정"을 로드맵에 포함하기로 결정하고
구현. SQL은 `add_class_trainers_pass_selection_mode_draft_proposed.sql`(+ rollback)에
작성만 해뒀고 **아직 Supabase에 실행하지 않음**(STOP 규칙 유지, 사용자 승인 후 별도 실행
필요).

- **강사 복수 지정**: 기존에 있었지만 앱 코드가 전혀 쓰지 않던 `class_trainers` 테이블을
  재사용. 강사 후보는 "스태프 & 권한"의 해당 센터 active 스태프 전체(역할 구분 없음).
  `lib/classes.ts`에 `fetchClassTrainers`/`setClassTrainers`/`setClassTrainersBulk` 추가.
  `app/manager/classes/page.tsx`(수업 등록/수정 시트)에 기존 "예약 가능 수강권" chip
  선택 UI와 동일한 패턴으로 담당 강사 다중 선택 UI 추가(단건 등록·반복 등록·수정 전부
  지원). 회원 예약 화면(`app/reservation/page.tsx`, `lib/reservations.ts`
  `fetchMonthData()`)에는 지정된 강사 이름을 "이름 외 N명" 형식으로 노출.
- **수강권 허용 정책 변경(0건=전체허용 → 명시적 선택제)**: `classes.pass_selection_mode`
  (`'all'|'selected'`) 컬럼 신규 추가. 관리자 UI에서 "예약 가능 수강권"을 하나도 선택하지
  않으면 `'all'`(기존 0건=전체허용과 100% 동일 동작), 하나 이상 선택하면 `'selected'`로
  저장 — `selectedProducts.length`로부터 파생시켜 UI에 별도 토글을 추가하지 않았다.
  `usable_memberships`/`usable_memberships_for_classes`/`reserve_class`/
  `reserve_with_membership` 4개 RPC의 cap 체크·P1-17 override 체크 기준을
  "class_allowed_products 행 존재 여부"에서 "pass_selection_mode 값"으로 변경(SQL,
  미실행). 기존 474개 class는 migration으로 100% 동일 동작 보존(0건=`'all'`, 1건
  이상=`'selected'`, class_allowed_products 자체는 한 행도 안 건드림).
- **반복 그룹 일괄적용 시 정책 불일치 방지**: `updateClassGroup()`은 title/start/end/
  capacity만 그룹 전체에 반영하고 개별 인스턴스의 다른 컬럼은 안 건드리는 기존 설계라,
  그 경로에서도 수정 중인 인스턴스의 `pass_selection_mode`만 selectedProducts와 어긋나지
  않도록 `lib/classes.ts`에 좁은 setter `updateClassPassSelectionMode()`를 추가해 별도로
  맞춰줌(다른 필드 전체를 재작성하는 `updateClass()` 대신).
- **스케줄 복사(`copySchedule`/`insertCopiedClasses`)**: 원본 수업의 `pass_selection_mode`
  와 담당 강사도 함께 복사하도록 확장. `copySchedule()` 자체는 어떤 UI에서도 호출되지
  않는 미사용 함수로 확인돼(grep) 갱신하지 않음(도달 불가능한 코드라 위험 없음) — 실제
  사용되는 `copyByWeekday`/`copyByDate`만 수정.
- **기존 회귀 테스트 2건, 새 RPC 기준에 맞춰 수정(중요)**: `pass_selection_mode` 도입으로
  RPC의 override/cap 판정 기준이 바뀌면서, `class_allowed_products`에 직접 행만 넣고
  `pass_selection_mode`는 신경 쓰지 않던 기존 통합 테스트들이 SQL 적용 후 조용히 의미를
  잃거나(예: F가 실제로는 아무것도 증명하지 못한 채 우연히 통과) 뒤집힐 수 있었음(예: E가
  기대하던 override 성공이 거부로 바뀜) — 실행 전에 코드 리뷰로 미리 발견해 수정:
  `tests/integration/setup.ts`의 `createFutureTestClass()`에 `passSelectionMode` 옵션
  추가(값을 명시적으로 안 넘기면 기존 동작과 완전히 동일, 기존 테스트 전부 무영향),
  `class-allowed-products-enforcement.test.ts`의 거부 케이스 1곳과
  `schedule-rule-override.test.ts`의 D~J 전부(7곳)에 `passSelectionMode: "selected"`를
  명시.
- **신규 통합 테스트**: `tests/integration/class-trainers-and-pass-selection-mode.test.ts`
  추가 — class_trainers CRUD/신규 RLS(비스태프 계정 거부)/`instructorNames` 노출/
  `pass_selection_mode` 저장·조회/`updateClassPassSelectionMode()` 단독 동작/
  `copyByDate()`의 정책·강사 복사까지 커버. SQL 미실행 상태에서는 `pass_selection_mode`
  관련 케이스와 복사 테스트, 신규 RLS 케이스가 실패하는 것이 정상(예상된 실패).
- `npm run build` 타입체크 통과 확인(SQL은 미실행이라 실제 통합 테스트 실행/CI 검증은
  SQL 적용 후 별도로 필요 — `docs/TODO.md` P3-1 참고).

## 2026-08-11 — PR #44 안정화 Batch(Phase 1~4) 최종 완료: 전체 CI 2연속 Green (feature/social-auth-notifications-attendance-dashboard)

P1-17(Phase 1, 신규 예약 override 정책)/RES-002(Phase 2)/TEST-004(Phase 3)/TEST-003
(Phase 4) 4개 Phase를 하나의 배치로 순서대로 진행 후, 전체 CI(E2E/Unit/Integration/Build)
2연속 Green으로 최종 검증(run `31459078105`/`31460392240`, 둘 다 first-attempt·재시도
없음 — E2E 45/45, Unit 213/213, Integration 123/123). 검증 과정에서 신규 통합 테스트
자체의 결함 2건을 실측으로 발견해 수정(둘 다 test bug, 앱/SQL 무관):
(1) `schedule-rule-override.test.ts`의 A/B/C가 `reserve_class`(자동 매칭)를 써서, 공유
테스트센터에 있던 다른 membership으로 우연히 통과/실패할 수 있던 문제 →
`reserve_with_membership`으로 membership_id를 직접 지정하도록 수정.
(2) `month-data-memberships-row-limit-regression.test.ts`가 `beforeAll` 마지막에 남은
managerB 세션인 채로 managerA 계정의 `fetchMonthData()`를 호출해 RLS에 막혀 전부 빈
배열이 돌아오던 문제(세션 전환 누락) + 실제로 만들지 않은 centerA class를 기대하던
잘못된 대조군 assert 제거. 각 Phase의 상세 내용은 아래 개별 항목 참고. PR #44는 여전히
MERGE BLOCKED(main merge는 별도 명시적 요청 전까지 하지 않음).

## 2026-08-11 — TEST-003(#43, Phase 4) 근본 원인 확정 + 수정: daily-book-limit.spec.ts CI noise (feature/social-auth-notifications-attendance-dashboard)

"그냥 flaky"로 단정하지 않고 실제 실패 로그(run `31393468107`)를 직접 조사 — 정확한 실패
지점을 특정함: `expect(locator).toBeVisible()` (`.class-row`의 "취소" 버튼), timeout
10000ms, 첫 시도 실패 → 재시도 즉시 통과. 코드 추적 결과 `app/reservation/page.tsx`의
`doReserve()`/`handleCancel()`은 RPC 성공 → `setConfirmClass(null)`(시트 닫힘, 이 체크는
바로 통과) → `await load()`(전체 재조회) 순서로 동작해, 시트가 닫히는 시점과
`.class-row` 버튼이 갱신되는 시점 사이에 실제 간격이 존재한다. 이 스펙은 예약/취소
왕복을 최대 9회 반복하는 유일한 파일이라(파일 자체 주석에 이미 문서화됨) CI 부하 시 그
간격이 Playwright 기본 expect timeout(10초)을 넘기는 사례가 실측됨 — 예약 자체는 이미
성공한 뒤였으므로 앱/RPC 버그도 아니고, assert 자체도 실제로 유효한 상태 전이를 기다리는
것이라 test-logic 결함도 아니다. 분류: CI 인프라/타이밍 이슈. 수정:
`tests/e2e/settings/daily-book-limit.spec.ts`에서 정확히 이 버튼 상태 assert 5곳만
timeout을 20초로 확장(무조건적인 전체 timeout 증가나 retry 추가가 아니라, 진단된 병목
지점에만 적용). CI 검증은 다음 단계에서 진행.

## 2026-08-11 — TEST-004(#45, Phase 3) 수정: 공유 테스트센터 classes 누적 self-healing sweep (feature/social-auth-notifications-attendance-dashboard)

Read-only 재진단(사용자가 Supabase SQL Editor에서 직접 조회) 결과 공유 테스트센터
(`통합테스트센터-da48c9`)에 classes가 1761건까지 누적돼 있음을 확인 — 이미 문서화된
"CI 취소 시 afterAll 미실행"(예: `admin-assignment-security.test.ts`의 "성공경로-*" 8종
~812건) 외에, `diagnose-settings-live-values.test.ts`가 **매 실행 결정적으로** leak하고
있던 별도 원인을 새로 발견: `cleanupTestClass()`(매니저 세션 RLS 기준)가 confirmed 상태
예약의 delete를 조용히 0건으로 실패시켜(private-class-capacity.test.ts에서 이미 확인된
것과 동일한 RLS 정책 원인) reservations/classes가 성공적인 실행에서도 항상 남았다(141건,
2026-08-03부터).

수정: `tests/integration/setup.ts`의 `getOrCreateOwnedTestCenter()`에 self-healing sweep
추가 — start_time이 1시간 이상 과거인 class를 이름이 "통합테스트센터-%"인 센터에서만
자동 정리(파일마다 정리 로직을 따로 만들 필요 없이, 거의 모든 통합 테스트 파일이 이
함수를 beforeAll에서 호출하므로 스위트 전체가 자동으로 self-healing됨).
`diagnose-settings-live-values.test.ts`는 `daily-book-limit-wiring.test.ts`로 정리 —
당일예약 describe는 `operational-settings-wiring.test.ts`와 완전 중복이라 제거, 일일한도
describe(저장소에서 유일한 daily_book_limit 통합 커버리지)는 유지하되 admin(service_role)
기반 `cleanupTestClassAdmin()`으로 교체해 leak을 근본적으로 막았다. 이미 쌓인 1761건은
별도 cleanup SQL 없이 다음 CI 실행에서 sweep이 자동으로 정리한다(전부 start_time이 이미
과거라 즉시 대상). CI 검증은 다음 단계에서 진행.

## 2026-08-11 — RES-002(#42, Phase 2) 수정: fetchMonthData()의 myMems 1000행 cap (feature/social-auth-notifications-attendance-dashboard)

`lib/reservations.ts`의 `fetchMonthData()`가 "내가 수강권을 보유한 센터 집합"을 구하는
`memberships` 쿼리(`myMems`)에 `.range()` 페이지네이션이 없어, 한 계정이 여러 프로필로
1000개 넘는 memberships를 가지면 1000번째 이후 행이 잘려 그 안에만 있던 센터가 통째로
회원 화면(달력)에서 안 보일 수 있었다 — 같은 함수의 `classRows`(이미 수정됨)와 동일한
PostgREST 기본 응답 행 수 제한 문제. `classRows`/`fetchUsableMembershipsByClass`와 동일한
`.range()` 반복 조회 패턴으로 수정(순수 코드 수정, SQL 변경 없음). 회귀 테스트
`tests/integration/month-data-memberships-row-limit-regression.test.ts` 신규 추가 — 1005개
필러 membership 뒤에 있는 target membership(자녀 프로필 소유)이 여전히 정확히 감지되는지,
가족 profile 간 membership 공유 구조가 페이지네이션 추가로 깨지지 않는지 함께 검증. CI
검증은 다음 단계에서 진행.

## 2026-08-11 — P1-17(Phase 1): 신규 정책 "관리자 직접 지정 수강권은 schedule_rules보다 우선" (feature/social-auth-notifications-attendance-dashboard)

PR #44 안정화 Batch의 Phase 1. `usable_memberships`/`usable_memberships_for_classes`/
`reserve_class`/`reserve_with_membership` 4개 함수에 "class_allowed_products에 이 product가
명시적으로 지정돼 있으면 membership_schedule_rules를 무시한다"는 override 조건을 추가
(`fix_membership_schedule_rule_override_draft_proposed.sql`, 사용자가 Supabase SQL Editor에서
적용 완료). git의 `reservation_functions.sql`이 PR #32 이후 라이브와 어긋나 있어(P2-16 기존
문서화) 사용자가 `pg_get_functiondef()`로 직접 추출한 라이브 본문을 기준으로 재작성. 그
과정에서 `reserve_with_membership`(실제 회원 예약 확정 RPC)이 지금까지 membership_schedule_
rules를 전혀 확인하지 않던 별도 갭도 함께 발견해 수정(목록 표시 정책과 실제 예약 정책이
이제 일치). `admin_assign_reservation`은 이미 두 제한을 전부 우회하도록 설계돼 있어 변경
없음. 관리자 UI(`app/manager/classes/page.tsx`)의 schedule-rule 경고를 "모든 수강권 허용"
(danger)과 "특정 수강권 지정"(override 안내, info) 모드로 분리. Regression: 신규
`tests/integration/schedule-rule-override.test.ts`(A~J), `membership-schedule-rules.spec.ts`
갱신(D+F+K/J). CI 검증은 다음 단계에서 진행.

## 2026-08-10 — P1-15 cleanup SQL 적용 + 사후 read-only 재검증 완료 (feature/social-auth-notifications-attendance-dashboard)

사용자가 `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql`을 Supabase SQL Editor에서
A(preview)/B(BEGIN...COMMIT, guard 포함 delete)/C(post-verification) 순서로 직접 실행,
`remaining_target_rules=0` 확인 보고. 이후 임시 read-only 진단(`_diag_p1_15_postcleanup_verify.test.ts`,
workflow_dispatch 전용, 검증 완료 후 삭제)으로 실제 QA 계정/센터 데이터 기준 재확인:
"수강권" 상품(`f6010b96-...`)의 `membership_schedule_rules`가 독립 재조회에서도 0건,
실제 회원(memberB)의 "수강권" memberships 3건 전부가 "테스트" class에서 `usable예측=true`로
재계산됨(status/remaining/expires/classAllowed/scheduleRule 전 조건 true), `class_allowed_products`는
여전히 0건("모든 수강권 허용" 유지). "새로 구매한 수강권"과 "특정 수강권 지정" 케이스는 실제
QA 계정에 새 데이터를 쓰지 않고 격리된 E2E 회귀 테스트(`membership-schedule-rules.spec.ts`
test E/C+D+F)로 그 일반 메커니즘을 검증. 재검증 중 CI도 2연속 Green(run `31419033306`/
`31421494819`, 둘 다 first-attempt) 재확인, 이후 임시 진단 job/워크플로 입력/테스트 파일 전부 제거.
PR #44는 여전히 MERGE BLOCKED(main merge는 별도 명시적 요청 전까지 하지 않음).

## 2026-08-10 — P1-15/P1-16 최종 완료: 실제 QA 버그 root cause 확정·UX 수정, 무관한 GRANT 버그 발견·수정, 전체 CI 2연속 Green (feature/social-auth-notifications-attendance-dashboard)

- **P1-15**: PR #44 수동 QA로 100% 재현된 "모든 수강권 허용해도 사용 가능한 수강권 없음"
  버그의 root cause를 실제 계정 데이터로 확정. `membership_schedule_rules`(수강권 자체의
  요일/시간/수업명 조건)가 `class_allowed_products`("모든 수강권 허용")와 완전히 별개로
  계속 적용되는 게 원인 — RPC는 설계대로 정확히 동작해 로직은 바꾸지 않고, 수업 등록/수정
  화면에 이 상호작용을 미리 알려주는 경고(`.schedule-rule-warning`)를 추가했다
  (`app/manager/classes/page.tsx`, `lib/passes.ts`). unit 1개 + E2E 3개(B/C+D+F/E)
  regression test 작성.
- 실제 QA 계정의 schedule_rules 2건이 무엇 때문에 생겼는지도 read-only로 추적 — 그 규칙이
  가리키는 "수업" 제목의 class가 실제로 2건 존재했고, 각 규칙의 생성 시각이 대응 class의
  생성 시각과 초 단위로 거의 동시라 이미 고쳐진 옛 자동생성 부수효과 버그의 흔적으로
  판단됨. `cleanup_p1_15_stale_schedule_rules_draft_proposed.sql` 작성(미실행, 사용자 결정
  대기).
- **P1-16**(무관한 발견): 위 조사 중 `accounts` 테이블에 service_role GRANT가 없어(처음엔
  SELECT만 추가) `auth-account-bootstrap.test.ts`가 반복 실패하는 걸 발견. 최초 가설
  (`lib/authAccount.ts`의 profiles insert 에러 미확인)은 임시 진단 로그로 실측 검증한 결과
  틀렸음을 확인하고 즉시 원복 — 진짜 원인은 그 테스트의 `beforeAll`이 admin으로 낡은
  throwaway 계정을 정리하려다 GRANT 부족으로 "permission denied"가 나는 것이었다.
  INSERT/UPDATE/DELETE GRANT 추가 SQL 적용 후 해당 테스트 2회 연속 통과 확인.
- 전체 CI(E2E/Unit/Integration/Build) 2회 연속 Green — run `31411383724`(완전
  first-attempt, 재시도 없음), `31413532650`(무관한 기존 flaky 테스트 1건만 1회 재시도,
  P1-15/16 관련 테스트는 전부 first-attempt).
- 상세: `docs/TODO.md` P1-15, P1-16.

## 2026-08-10 — P1-14 최종 완료: cleanup SQL 적용, 사후 검증 중 발견한 self-healing 성능 버그 수정, 전체 CI 2연속 Green (feature/social-auth-notifications-attendance-dashboard)

- 사용자가 `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql`을 Supabase SQL
  Editor에서 적용(C-1: memberB_centerA_waitlisted_remaining=0). read-only 진단으로
  독립적으로도 재확인.
- 적용 직후 재실행한 Integration이 다른 증상(`Hook timed out in 30000ms`)으로 계속
  실패 — read-only로 memberB waitlisted가 이미 0건임을 확인해 원래 버그의 재발이 아님을
  먼저 배제한 뒤 조사. 원인은 새로 추가한 `beforeAll` self-healing sweep이 class 하나당
  `cleanupTestClassAdmin()`을 순차 await로 호출했는데, cleanup SQL이 대상으로 삼지 않은
  다른 3개 title에 과거부터 쌓여있던 잔여 class 24건 때문에 순차 round-trip(최대 48회)이
  vitest hookTimeout(30초)을 초과한 것(test bug, 타임아웃 재발/앱 버그 아님). 타임아웃 값을
  올리는 우회 대신 class id를 모아 bulk delete 2회로 바꿔 round-trip 수 자체를 없앴다 —
  부수적으로 다른 4개 title의 역사적 잔여 class 24건도 함께 정리됨.
- 이 수정을 반영한 전체 CI(E2E→Unit→Integration→Build)를 2회 연속 실행 — 둘 다
  first-attempt Green(재시도 없음): run `31367089839`(pull_request), `31368870324`
  (workflow_dispatch), 둘 다 headSha `80889d7`. `attendance-policy.test.ts` 5/5 통과,
  두 run 모두 사후 read-only 진단으로 memberB waitlisted=0 재확인 — 두 번째 run은 이
  테스트가 그 사이 새 waitlisted 예약을 만들었다가 afterAll이 정상적으로 지운 뒤의 상태라
  cleanup 로직이 구조적으로 작동함을 실측으로 증명함(우연히 DB가 깨끗했던 게 아님).
- `new-class-creation.spec.ts`(TEST1/2/4/5/6)와 `class-allowed-products.spec.ts`(5개
  테스트) 전부 같은 CI run에서 회귀 없이 통과 확인 — 신규 테스트 추가 없이 기존 스펙 재사용.
- Vercel Preview도 같은 headSha 기준 배포 성공 확인. PR #44는 OPEN·MERGEABLE·충돌 없음
  (main에는 merge하지 않음).
- 상세: `docs/TODO.md` P1-14(해결 완료로 갱신).

## 2026-08-10 — P1-14: attendance-policy.test.ts 대기예약 누적 원인 확정 + 재발 방지 코드, cleanup SQL 작성(미실행) (feature/social-auth-notifications-attendance-dashboard)

- P2-21 작업 중 발견한 `attendance-policy.test.ts`의 3~4연속 Integration 실패("이번 주
  대기예약 가능 횟수 초과")를 read-only 진단(임시 CI 진단 파일, 실행 후 삭제)으로 실측
  조사. memberB의 waitlisted 예약이 centerA에 13건 누적돼 있었고, 전부 정확히 같은 class
  title("P3 출결-대기거부")·profile·center — 단발 사고가 아니라 이 테스트를 실행할 때마다
  거의 매번 1건씩 쌓인 패턴.
- 근본 원인을 코드로 확정: `reservations`의 RLS DELETE 정책이 `status in
  ('cancelled','no_show')`만 허용하는데, 이 테스트가 검증 목적상 waitlisted 상태로 남기는
  예약을 매니저 세션(RLS 적용) 기반 `cleanupTestClass()`로 지우려 해 매번 에러 없이 조용히
  0건 삭제로 끝났다. 완전히 동일한 원인이 `private-class-capacity.test.ts`에서 이미 한 번
  발견·우회된 적이 있었는데(그 파일 자체 주석) 그 교훈이 이 파일에는 전파되지 않았던 것.
- 재발 방지: `tests/integration/setup.ts`에 admin(service_role) 기반 `cleanupTestClassAdmin()`
  추가, `attendance-policy.test.ts`의 `afterAll`을 이걸로 전환하고 `beforeAll`에 이 파일
  전용 잔여물 self-healing 정리를 추가.
- 과거 누적분(13건) 정리는 `cleanup_p1_14_waitlisted_test_pollution_draft_proposed.sql` +
  롤백 안내 파일로 작성(A. read-only preview / B. 단일 트랜잭션 atomic cleanup / C.
  post-commit 검증 구조, admin_action_logs FK NOT EXISTS 가드 포함) — static audit까지만
  진행하고 Supabase에는 실행하지 않음(사용자가 SQL Editor에서 직접 실행 예정).
- 상세: `docs/TODO.md` P1-14.

## 2026-08-10 — P2-21: PR #44 수동 QA 버그 재현 조사(진행 중, 종결 아님), TEST4/TEST5(구매 직후 즉시 사용 가능/goods 배제) 추가, 무관한 Integration 블로커 발견 (feature/social-auth-notifications-attendance-dashboard)

- PR #44 수동 QA로 보고된 "신규 수업은 회원이 유효한 수강권을 보유해도 사용 가능한
  수강권이 없다고 뜬다"는 증상을 read-only 진단 → admin client 직접 insert 비교 →
  실제 Playwright 브라우저로 관리자 UI 등록 재현(모든 수강권 허용/특정 pass 1개 허용
  둘 다) → RPC 직접 호출 → 회원 실제 브라우저 재현까지 전부 실측했으나 재현 실패.
  TEST_MANAGER_A/TEST_USER_A/centerA 기존 fixture로는 앱 버그를 찾지 못함.
- 조사 중 발견한 것은 앱 버그가 아니라 테스트 자체의 결함 3건(전부 코드 변경 없이
  테스트만 수정): Node 쪽 인증 안 된 세션으로 `class_allowed_products`를 조회해 RLS에
  항상 막힌 것, 테스트가 고른 90/91일 뒤 날짜가 예약 오픈 기한(기본 60일)을 초과해
  `reserve_with_membership()`이 설계대로 정확히 거부한 것, 재진입 클릭 전에 달력 날짜
  칸을 안 눌러 `.class-row`가 안 보였던 것.
- `tests/e2e/admin/new-class-creation.spec.ts`(신규): 관리자 UI로 실제 수업을 등록하는
  경로를 exercise하는 최초의 자동 테스트(기존엔 전부 admin client 직접 insert로 setup) —
  TEST1/TEST2(모든 수강권 허용/특정 pass 1개 허용)/TEST6(기존 방식 대조군)에 이어,
  사용자 지시로 TEST4(구매 직후 즉시 사용 가능 — 실제 결제 흐름 전체: 구매 버튼 →
  센터 구매 시트 → checkout mock 결제 → 예약창 복귀 → 새로고침 없이도 즉시
  `.pass-pick-list`에 반영 → 실제 예약 성공)와 TEST5(goods는 적용 가능 수강권/구매
  가능 목록 어디에도 노출 안 됨)까지 추가. 전부 실제 브라우저 3회 연속 통과.
- 구매 직후 상태 갱신 경로는 client-side 캐시 갱신이 아니라 전체 페이지 재로드
  (`window.location.href`)로 구현돼 있어 구조적으로 stale-cache 여지가 없음을 실측 확인.
- **주의(이전 기록 정정)**: 이 항목을 처음 기록했을 때 "전체 CI 3연속 Green"이라고 썼으나
  부정확했음 — 실제로는 E2E/Unit만 Green이고 Integration은 3회 연속 실패 중(무관한
  `attendance-policy.test.ts` 주간 대기예약 한도 이슈, `docs/TODO.md` P1-14 참고). PR #44는
  아직 merge하지 않음.
- 상세: `docs/TODO.md` P2-21, P1-14.

## 2026-08-09 — P2-20 최종 완료: cleanup SQL 적용, RPC 페이지네이션 개선 실측, 진단 계측 전체 제거 (feature/social-auth-notifications-attendance-dashboard)

- **cleanup SQL 적용 완료**: `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`을
  사용자가 Supabase SQL Editor에서 직접 실행. 첫 시도는 BEGIN+DELETE와 COMMIT을 서로 다른
  두 번의 Run으로 나눠 실행해 커넥션 풀링으로 세션이 갈리는 바람에 실제로는 아무것도
  커밋되지 않은 것을 사용자가 재조회로 발견(891/1557 그대로) — SQL을 A(read-only
  preview)/B(BEGIN~COMMIT을 한 번의 Run으로, 내부 4중 검증 후 자동 커밋/롤백)/C(post-commit
  verification) 구조로 재작성 후 재실행해 성공. 결과: centerA `"E2E 테스트 수강권"`
  891→5건(살아있는 예약이 참조하는 것만 보존), TEST_USER_A 전체 memberships 1557→730건.
- **RPC 페이지네이션 개선 실측 확인**: `.pass-pick-list` 미표시를 일으켰던
  `fetchUsableMembershipsByClass()`의 `.range()` 순차 왕복이 cleanup 후 36개 class
  기준 27페이지/12.4~13.9초 → 2페이지/1.07초로 12배 이상 단축됨을 CI에서 실측.
- **임시 진단 계측 전체 제거**: `lib/_diag220.ts`,
  `tests/integration/_diag_memberships.test.ts` 삭제, 4개 파일의 `diagEvent`
  호출/import 제거(goal1 수정 자체인 `openTokenRef`/`userEditedRef`는 유지),
  `.github/workflows/test.yml`의 `diag` job/`diag_only` input 제거해 원래 구조로 복원.
- **최종 검증**: class-allowed-products.spec.ts 3연속 Green(goal1/goal2 포함),
  전체 CI(E2E/Unit/Integration/Build) 3연속 Green, Vercel Preview 배포 성공,
  P4 sales dashboard 회귀 없음(`dashboard-summary.test.ts` 7/7 등).
- 상세: `docs/TODO.md` P2-20(해결됨 처리).

## 2026-08-09 — P2-20: 관리자 class_allowed_products 선택 소실 수정 + `.pass-pick-list` 원인 규명(cleanup SQL 적용 대기) (feature/social-auth-notifications-attendance-dashboard)

- **goal1 수정 완료**: `app/manager/classes/page.tsx`의 `openEdit()` — 초기
  `fetchClassProducts()` hydrate 응답이 사용자의 chip 선택보다 늦게 도착하면 무조건
  `setSelectedProducts(ids)`가 실행돼 방금 한 선택을 덮어쓰는 race condition이었다.
  `openTokenRef`(요청 세대)+`userEditedRef`(dirty flag) 가드를 추가해, 더 최신 요청이거나
  사용자가 이미 편집했으면 초기 hydrate 결과를 적용하지 않도록 구조적으로 수정. `window.__p220`
  in-memory 이벤트 버퍼(`lib/_diag220.ts`, `console.log` 대신 — CDP 라운드트립이 원래 race
  타이밍 자체를 바꿔버리는 것을 실측으로 확인해 대체)로 재현/수정을 CI에서 실측 검증함.
- **goal2 원인 규명**: `.pass-pick-list`가 회원 예약화면에서 안 뜨는 원인은
  `lib/reservations.ts`의 `fetchUsableMembershipsByClass()`가 `usable_memberships_for_classes`
  RPC 응답을 `.range()`로 1000행씩 순차 페이지네이션하는 구조 때문 — TEST_USER_A의 테스트
  센터 소속 membership 891건(`createTestMembershipAdmin()`이 get-or-create로 고쳐지기 전
  누적된 `"E2E 테스트 수강권"` historical duplicate)이 class당 ~744행의 RPC 응답을 만들어,
  실패 재현 조건(수업 36개)에서 27번 순차 왕복(총 12.4~13.9초)이 발생함을 CI 실측으로
  확인(단일 RPC 호출 자체는 항상 0.3~0.9초로 빠름 — "membership이 많으면 서버가 느리다"가
  아니라 "응답이 커져서 클라이언트 왕복이 늘어난다"가 정확한 인과관계).
- `cleanup_p2_20_e2e_test_pass_duplicates_draft_proposed.sql`(신규, 적용 대기): 정확한
  product_name+center_id로 대상 식별, 참조하는 FK 6개 테이블(reservations 포함, 살아있는
  waitlisted 예약 3건 발견돼 그 membership은 NOT EXISTS로 보존) 전부 방어, LOCK TABLE +
  미리보기/실삭제 건수 일치 검증. Claude는 실행하지 않음 — 사용자가 Supabase SQL Editor에서
  직접 실행 후 재검증 예정.
- 상세: `docs/TODO.md` P2-20.

## 2026-08-08 — P4: 매출/통계 대시보드 (manager_dashboard_summary RPC, SQL 적용 대기) (feature/social-auth-notifications-attendance-dashboard)

- **감사 결과**: `lib/sales.ts`의 기존 `summarize()`는 이미 불러온 결제 행 배열을 클라이언트에서
  reduce하는 방식뿐이라(DB 집계 아님), 이 세션에서 이미 두 번 실제로 겪은 PostgREST 기본 1000행
  응답 제한(`fetchClasses`/`fetchUsableMembershipsByClass`)과 같은 종류의 위험이 있었다. 또한
  **Mock(테스트) 결제와 실제 매출을 구조적으로 구분할 방법이 `payments` 테이블에 없었다** —
  유일한 단서는 `pg_transaction_id`가 `"mock_"`로 시작한다는 미문서화 문자열 관례뿐.
- `fix_payments_payment_provider_draft_proposed.sql`(신규, 적용 대기): `payments.payment_provider`
  컬럼 추가(nullable, mock/toss/portone) + `confirm_test_payment()`(유일한 실제 mock 발급
  경로, 8곳 중 나머지 7곳은 매니저 신뢰 경로라 손대지 않음)가 자기 결제 행에 `'mock'`을
  명시적으로 채우도록 재정의 + 기존 mock 행 백필(WHERE로 좁힌 UPDATE).
- `add_manager_dashboard_summary_draft_proposed.sql`(신규, 적용 대기): `manager_dashboard_summary
  (p_center_id, p_from, p_to)` RPC 신규 — 오늘/이번달/기간 매출, 결제 건수, 결제수단별,
  수강권/상품 매출(`payments.membership_id → memberships.product_id → products.product_kind`
  조인으로 구분 — `revenue_category`는 `registerPayment()`가 항상 `'membership'`만 저장해
  신뢰 불가능함을 코드 감사로 확인), 미수금, 일별 매출 배열을 SQL 집계(SUM/COUNT)로 DB
  안에서 직접 계산 — `payment_provider='mock'` 행은 모든 집계에서 명시적으로 제외.
- `lib/sales.ts`: `fetchDashboardSummary()` 추가(위 RPC 호출), `DashboardSummary` 타입 추가.
- `app/manager/page.tsx`: 센터 선택 바로 아래에 기간 선택(오늘/7일/30일) + 요약 카드(오늘 매출/
  이번달 매출/기간 매출·건수/미수금/수강권 매출/상품 매출) + 일별 매출 막대그래프 추가,
  `pass.sales.view` 권한으로 게이트(기존 "매출 관리" 메뉴 링크와 동일 권한 재사용). 로딩/에러
  상태 명시적으로 처리.
- `tests/integration/dashboard-summary.test.ts`(신규): 권한 차단, 결제수단별 매출 합계, 환불
  차감, 미수금, KST 자정 경계(오늘 00:05 vs 어제 23:55), Mock 결제 완전 제외(실제로 저장은 되지만
  통계에서 빠짐을 직접 증명), 수강권/상품 매출 구분을 전부 삽입 전/후 델타 비교로 검증(공유
  테스트 센터가 이전 실행 데이터를 계속 갖고 있어도 몇 번을 반복 실행해도 항상 성립).
- 위 SQL 두 파일이 Supabase에 적용되기 전까지는 `dashboard-summary.test.ts`의 모든 테스트가
  실패한다(RPC 없음/컬럼 없음) — 예상된 실패, 적용 후 재실행 필요.

## 2026-08-08 — P4 후속: manager_dashboard_summary() daily 필드 컬럼 별칭 버그 수정 (SQL 적용 대기) (feature/social-auth-notifications-attendance-dashboard)

- **분류: SQL 버그**(앱 코드/테스트 코드/인프라 문제 아님) — CI의
  `dashboard-summary.test.ts`가 SQL 적용 직후 재실행에서 6건 전부
  `"column d.date does not exist"`로 실패해 발견.
- 원인: `daily` 필드를 만드는 서브쿼리에서 날짜 목록 별칭은 `days`(컬럼 `date`), 결제
  합계 별칭은 `d`(컬럼 `pdate`/`revenue`)로 분리해뒀는데, `json_build_object`와
  `order by`에서 실수로 `d.date`를 참조했다(`days.date`였어야 함) —
  `add_manager_dashboard_summary_draft_proposed.sql` 작성 시점의 복붙 실수.
- `fix_manager_dashboard_summary_daily_bug_draft_proposed.sql`(신규, 적용 대기)로
  `days.date`를 참조하도록 함수 재정의(다른 필드는 전혀 변경 없음).

## 2026-08-09 — 공유 테스트 센터 정리 SQL(v4) 적용 완료 및 검증 (feature/social-auth-notifications-attendance-dashboard)

- `cleanup_shared_test_center_pollution_draft_proposed.sql`을 사용자가 v1→v4까지 반복 끝에
  최종 적용 완료(에러 없음). v1/v2는 `admin_action_logs`(add_admin_assignment.sql) FK를
  놓쳐 실패(둘 다 완전 롤백 확인), v3는 `LOCK TABLE`로 FK race는 해결했지만 지나치게 좁은
  `profile_id in (userA, managerA)` 하한 guard가 실제 모집단(시점에 따라 다른 TEST_*
  계정으로 옮겨다님, 실측 확인)과 어긋나 안전하게 중단됨 — v4에서 그 profile_id 제한과
  하한 guard를 제거하고 "정확한 문자열 + 정확한 center_id"라는 구조적 근거만으로 재작성.
- 적용 후 읽기 전용 진단(diag_only CI 모드)으로 정리 대상 6개(admin_action_logs, orphan
  profiles, "통합테스트 수강권"/"통합테스트 수강권(P3)"/"P0-6 테스트 무제한권" memberships,
  "USABLE-PASS-KIND 테스트 대여품" products) 전부 0건 확인.
- 진단 과정에서 쓴 임시 스캐폴딩(`_diag_pollution.test.ts`, `test.yml`의 `diag`/`diag_only`)
  은 검증 완료 후 전부 제거 — `test.yml`이 조사 시작 이전과 완전히 동일함을 `git diff`로 확인.
- 부수 발견: `accounts` 테이블도 `payments`/`admin_action_logs` 등과 같은 계열로 service_role
  SQL GRANT가 없음(P2-13 계열, `docs/TODO.md`에 기록만 하고 이번 배치에서는 안 고침).

## 2026-08-09 — class-allowed-products.spec.ts 간헐 실패 근본 원인 규명 및 fixture self-healing (SQL 적용 대기) (feature/social-auth-notifications-attendance-dashboard)

- **분류: 테스트 인프라 문제**(class_allowed_products 기능 자체·P4와 무관) — 읽기 전용 진단
  (`tests/integration/_diag_pollution.test.ts`, CI run 31268325509)으로 원인을 직접 확인.
  거의 모든 integration/e2e 테스트가 재사용하는 단일 공유 테스트 센터의 `memberships`가
  PostgREST 1000행 캡에 걸릴 만큼 누적돼 있었고, class-allowed-products.spec.ts는 그 프로필의
  "사용 가능한 수강권" 전체를 나열하는 화면이라 목록이 비대해지며 타임아웃/개수 불일치로
  간헐 실패했다.
- 근본 원인: `createTestMembership()`(tests/integration/setup.ts),
  `createTestMembershipAdmin()`/`createTestGoodsMembershipAdmin()`(tests/e2e/fixtures/testData.ts),
  class-allowed-products-enforcement.test.ts의 로컬 `createMembershipForProduct()`,
  usable-memberships-pass-kind.test.ts의 인라인 생성 — 전부 get-or-create 없이 호출마다 새
  행을 만들었고, `afterAll` 정리가 있어도 CI가 도중 취소되면(GitHub Actions
  concurrency.cancel-in-progress, 또는 재트리거) 실행되지 않아 계속 쌓였다.
- 코드 수정: 위 다섯 곳 전부 `createTestMembershipForProduct()`가 이미 증명한 get-or-create +
  self-healing refresh 패턴으로 교체. `tests/e2e/admin/attendance.spec.ts`는 `beforeAll`에
  고아 프로필("P3 출결-대기용") 자체 정리 스윕을 추가.
- `cleanup_shared_test_center_pollution_draft_proposed.sql`(신규, 적용 대기): 지금까지 이미
  쌓인 데이터의 1회성 정리 — 미리보기 카운트 + 예상 범위 가드 + FK 안전 순서 포함, 실제
  사용자/센터 데이터와 섞이지 않도록 정확한 문자열/계정으로만 범위를 좁힘.
- 범위 밖(별도 기록): 같은 진단에서 `classes` 테이블도 유사하게 누적된 것을 발견
  (`admin-assignment-security.test.ts` 등 다수 파일) — 이번 배치와 직접 관련 없어 `docs/TODO.md`
  P2-19에 별도 기록만 하고 손대지 않음.

## 2026-08-08 — P4 후속: service_role의 payments 테이블 GRANT 누락 (SQL·DB 인프라 문제, 적용 대기) (feature/social-auth-notifications-attendance-dashboard)

- **분류: SQL·DB 문제(인프라 설정)** — 앱 코드·테스트 로직·RPC 함수 자체와는 무관. daily 필드
  버그를 고친 뒤 CI를 재실행하니 `dashboard-summary.test.ts`의 결제 fixture 생성 단계에서
  전부 `"permission denied for table payments"`로 실패.
- 원인: 이 저장소의 기존 결제 생성 경로(`confirm_test_payment` 등)는 전부 `security definer`
  RPC라 호출자의 GRANT와 무관하게 동작해왔다 — 그래서 `payments` 테이블 자체에 service_role
  GRANT가 없다는 사실이 지금까지 드러나지 않았다. 이번 통합테스트가 정확한 집계 검증을 위해
  admin(service_role) 클라이언트로 `payments`에 **직접** insert를 시도한 것이 처음이라 이
  gap이 새로 드러남 — `fix_service_role_missing_grants_for_e2e_admin_draft_proposed.sql`/
  `fix_service_role_missing_grants_products.sql`과 같은 부류(그때도 payments는 대상에
  포함되지 않았음).
- `fix_service_role_missing_grants_payments_draft_proposed.sql`(신규, 적용 대기):
  `grant select, insert, update, delete on payments to service_role;` + 롤백 파일.

## 2026-08-08 — E2E 스위트 전체의 KST 자정 경계 취약점 전수 조사 및 일괄 수정 (feature/social-auth-notifications-attendance-dashboard)

- 직전 커밋에서 `reservation-cancel-grace-period.test.ts` 하나만 고치고 끝내지 않고,
  같은 부류의 버그(고정 `hoursFromNow` + 날짜상대 마감설정, 또는 "지금±N분"으로 계산한
  시각 문자열)가 있는 파일을 저장소 전체(`tests/integration/**`, `tests/e2e/**`)에서
  전수 조사했다. 그 결과 실제로 취약했던 파일 3개를 추가로 확인·수정:
  - `tests/e2e/settings/booking-deadline.spec.ts`, `tests/e2e/settings/cancel-deadline.spec.ts`:
    `kstTimeHHmm(±N)`(E2E fixture판, 이제 삭제)로 계산한 마감 시각과
    `createFutureTestClassAdmin({hoursFromNow: 소수시간})`을 함께 쓰고 있어, KST
    22:00~23:59(자정을 넘겨 수업이 내일 날짜가 됨) 또는 00:00~00:29(상대 시각 계산이
    어제로 역행) 근처에 실행되면 "이미 지남"/"아직 안 지남" 전제가 뒤집혔다.
    `createKstSameDayFutureClassAdmin`(기존 헬퍼, 항상 오늘 안으로 안전하게 클램프)과
    새 고정 상수 `ALWAYS_PAST_TODAY_TIME`("00:01")/`ALWAYS_FUTURE_TODAY_TIME`("23:58")로
    교체 — 상대 계산 자체를 없애 두 방향의 자정 경계 문제를 구조적으로 제거.
  - `tests/e2e/admin/holiday-restores-classes.spec.ts`: "기존 수업"과 "신규 수업"을
    각각 독립적으로 `hoursFromNow`(120시간, 121시간)로 계산했는데, 그 사이 여러 UI
    라운드트립을 거치며 시간이 흘러 두 수업이 다른 KST 날짜에 생길 수 있었다("신규
    수업"의 예약 가능 여부를 검증하는 마지막 단계가 그 행을 못 찾아 타임아웃). 새 헬퍼
    `createClassOnKstDateAdmin(centerId, {kstDate, kstTime})`(신규, testData.ts)로
    "기존 수업"에서 파생한 날짜(`holidayDate`)에 명시적으로 맞춰 생성하도록 변경 —
    상대 계산에 의존하지 않아 시간이 얼마나 흐르든 항상 같은 날짜.
- 전수 조사로 안전함이 이미 확인된 파일들(같은 헬퍼를 이미 쓰고 있거나, 고정 상수만
  쓰거나, `hoursFromNow`가 24시간을 훨씬 넘어 경계와 무관한 경우 등)은 건드리지 않음 —
  자세한 파일별 판단 근거는 이 커밋의 코드 리뷰 기록 참고.

## 2026-08-07 — reservation-cancel-grace-period.test.ts의 KST 자정 경계 취약점 수정 (feature/social-auth-notifications-attendance-dashboard)

- **증상**: CI를 KST 밤 늦게(22시 이후) 돌리면 이 파일의 두 테스트("10분을 초과하고 일반
  취소마감도 지났으면 취소가 차단된다", "deduct_on_late_cancel 켜져 있으면 환급만 안 된다")가
  실패했다. 두 테스트 모두 다른 파일이나 코드 변경과 무관하게, 순전히 실행 시각에 따라
  결과가 갈리는 pre-existing 취약점이었다(이번 배치 이전부터 있던 문제, 우연히 이 배치의
  CI 반복 실행 중 시간대가 걸려서 처음 드러남).
- **근본 원인(두 방향의 자정 경계 문제)**:
  1. `createFutureTestClass(hoursFromNow: 2)`로 수업을 만들면, "지금+2시간"이 KST 자정을
     넘길 때(22:00~23:59 실행) 수업이 "오늘"이 아니라 "내일" 날짜가 된다.
  2. 취소 마감 시각을 `kstTimeHHmm(-30)`("지금-30분")으로 계산했는데, 자정 직후(00:00~00:29
     실행)에는 이 계산이 어제 시각으로 넘어간다 — `group_cancel_days_before=0`(수업과 같은
     날짜)과 결합하면 "수업 날짜(오늘) + 그 시각"이 오히려 아직 지나지 않은 미래가 된다.
  두 경우 다 "취소 마감이 이미 지났다"는 이 테스트들의 전제가 깨져 취소가 차단돼야 할 게
  성공해버렸다(관측된 정확한 증상과 일치).
- **수정**: 단순히 자정 이후 재실행해서 우연히 통과시키는 대신, 시간대와 무관하게 항상
  성립하도록 두 방향 모두 구조적으로 제거했다.
  1. 수업 생성을 `createFutureTestClass(hoursFromNow: 2)`에서 이미 이 저장소에 있던
     `createKstSameDayFutureClass`(같은 파일의 다른 당일예약 테스트들이 이미 쓰는 헬퍼,
     자정 근처면 자동으로 여유를 줄여 항상 "오늘 안"을 보장함)로 교체.
  2. `kstTimeHHmm(-30)`(상대 계산, 자정을 역방향으로 넘을 수 있음) 대신 `"00:01"`(자정 1분
     후, 하루 중 가장 이른 고정 시각)을 상수로 사용 — 테스트가 자정 첫 1분 안에 실행되는
     경우만 빼고 항상 "이미 지났다"가 보장된다. 상대 계산 자체를 없애 문제의 원인을 제거.
  이제 더 이상 쓰지 않는 `kstTimeHHmm()` 헬퍼는 삭제.

## 2026-08-07 — P3 출석/체크인 감사 및 manager_set_attendance() 통합 (feature/social-auth-notifications-attendance-dashboard)

- **감사 결과(기존 구조, 새로 만들지 않음)**: 출석 기능은 스키마(`reservations.status`에
  이미 `attended`/`no_show` 포함)·RPC(`manager_set_attendance`)·관리자 UI(예약자 명단, 두
  화면에 각각 구현돼 있음: `app/manager/classes/page.tsx`, `app/manager/page.tsx`)·회원
  화면 상태 표시(`app/my-reservations/page.tsx`)까지 전부 이미 구현돼 있었다.
- **실제로 고친 문제 1 — `manager_set_attendance()` 4중 정의 통합**: 이 함수가 서로 다른
  버전으로 4곳(`add_attendance.sql`, `reservation_functions.sql` 안에 2개,
  `add_admin_assignment.sql`)에 정의돼 있었고, 어느 버전이 실제 운영 DB에 살아있는지 git
  파일만으로는 알 수 없었다(`docs/TODO.md` P0-3에 이미 알려진 migration ledger 갭과 동일
  종류). `fix_attendance_consolidate_and_guard_draft_proposed.sql`로 가장 최근 버전(v4,
  cancelled_by/cancelled_at audit 컬럼 포함)을 유일한 정의로 통합 — **사용자가 운영 DB에
  적용 완료(2026-08-07)**.
- **실제로 고친 문제 2 — 대기(waitlisted) 예약도 출석 처리가 가능했던 버그**: 대기는 아직
  확정된 적이 없어(수강권도 차감 안 됨) "출석했다/안 했다"를 매길 대상이 아닌데, RPC도
  관리자 UI도 이를 막지 않았다. 같은 SQL 파일에서 서버 가드 추가, 두 관리자 UI 모두에서
  대기 상태일 때 출석/결석 버튼을 숨김.
- **실제로 고친 문제 3 — "결석" 버튼 라벨이 실제 동작과 반대였던 버그**: `status` 타입에는
  애초에 "결석"이라는 값이 없다(`attended`/`no_show`만 존재) — "결석" 버튼은 실제로는
  `manager_set_attendance(id, 'confirmed')`를 호출해 출결 표시를 취소(되돌리기)하는
  동작이었다. 진짜 결석(no-show) 처리 버튼은 "노쇼"라는 별도 이름으로 존재했다. 두 관리자
  UI 모두에서 라벨을 "되돌리기"/"결석(노쇼)"로 정정(로직 변경 없음, 표시만 정정).
- **정책 확정(코드로 확인)**: 취소(cancelled)는 최종 상태 — 다시 출석/결석/노쇼로 못 바꿈.
  대기는 출석 대상 아님(위 버그 수정으로 강제). 지각(late) 상태는 이 시스템에 없고 이번
  MVP에도 추가하지 않음(스키마 확장이 필요한 별도 제품 결정, docs/TODO.md 기록).
- **테스트**: `tests/integration/attendance-policy.test.ts`(신규) — 취소 최종상태 확인(어느
  버전이 라이브였는지 실제 동작으로 확인), 대기 출석거부(SQL 가드, 미적용 시 예상된 실패),
  타 센터 매니저 차단, 프라이빗 수업 동일동작. `tests/e2e/admin/attendance.spec.ts`(신규) —
  출석→결석(노쇼)→되돌리기→예약취소 전체 흐름, 대기 예약 버튼 숨김, 프라이빗 수업 검증
  (전부 실브라우저).
- **범위 밖**: 노쇼 자동 처리, 일괄 출석 처리(`docs/23_Admin_Feature_Audit.md`에 이미
  기록된 기존 갭) — 이번 배치 요청 범위(최소 상태 관리 MVP) 밖.

## 2026-08-07 — P2 알림 시스템 감사 및 완성도 보강 (feature/social-auth-notifications-attendance-dashboard)

- **감사 결과(기존 구조, 새로 만들지 않음)**: 예약 확정/취소/대기승격/노쇼/문의답변 알림은
  전부 서버 SQL 트리거(`add_notification_triggers.sql`, `add_inquiries.sql`)로 원인 트랜잭션과
  원자적으로 이미 생성되고 있었다. 휴무일 취소 알림도 이미 라이브 상태임을 확인
  (`fix_holiday_history_and_notification_draft_proposed.sql`이라는 파일명과 달리 실제로는
  이미 적용돼 있음 — 같은 동작을 전제하는 `fix_holiday_delete_restores_classes.sql`이 이미
  merge된 P0 통합테스트로 검증됨). 딥링크 권한 안전성(없는/권한 없는 대상이면 조용히
  fallback), 센터 간 알림 격리(트리거가 항상 해당 센터 매니저만 대상)도 이미 안전하게
  설계돼 있음을 코드 감사로 확인.
- **고친 것**: `admin_assigned`/`admin_cancelled` 알림 종류(관리자 직접배치/취소, P1 이전
  배치에서 트리거에는 이미 추가됐지만)가 `lib/notifications.ts`의 `NotiKind` 타입/이모지
  매핑에는 빠져 있던 것을 추가(기능은 이미 동작했지만 표시가 불완전했음).
- **죽은 설정 연결**: 알림 설정(`app/settings/notifications`)의 예약/대기/리마인더 토글이
  localStorage에만 저장되고 아무 데도 연결되지 않은 죽은 설정이었다(서버 트리거는 항상
  알림을 만듦). 실시간 팝업(`NotificationToaster`)이 이 값을 읽어 팝업 표시 여부를 실제로
  거르도록 연결(`notiPrefKeyForKind`) — 꺼도 알림함에는 그대로 기록되니 나중에 확인 가능,
  서버 발송 자체를 막는 건 예약 트리거 SQL을 건드려야 해서 이번 범위 밖. "혜택·이벤트"
  토글은 그 알림을 만드는 기능 자체가 없어 준비 중으로 명확히 표시(비활성화).
- **회귀 가드 추가**: `tests/integration/notification-center-isolation.test.ts`(신규) —
  centerA에서 발생한 `new_reservation` 알림을 centerB 매니저가 볼 수 없는지 실제 DB로 검증.
  `tests/unit/notiPrefKeyForKind.test.ts`(신규) — 알림 설정 kind→카테고리 매핑 고정.
- **범위 밖(명시적 제외)**: SMS/카카오톡 알림톡/푸시/이메일 발송 — 외부 서비스 계약 필요,
  이번 배치는 앱 내 알림 완성도만 다룸(사용자 지시).

## 2026-08-07 — P1 소셜 로그인(Google/Kakao/Naver/Apple) 배관 보강 (feature/social-auth-notifications-attendance-dashboard)

- **감사 결과**: 소셜 로그인 버튼(Google/Kakao/Naver/Apple)과 `signInWithOAuth()` 호출,
  계정/프로필 부트스트랩 함수(`ensureAccountForCurrentUser()`, `lib/authAccount.ts`)는 이미
  이전 P1 배치에서 구현돼 있었다 — 새로 만들지 않고 실제 신뢰성 gap만 감사로 찾아 보강했다.
- **고친 것**: `ensureAccountForCurrentUser()` 호출이 `app/page.tsx`(홈 화면) `useEffect`에만
  있어, 소셜 로그인의 `redirectTo`가 항상 `/`였기 때문에 지금까지는 우연히 항상 호출됐다 —
  하지만 이건 로그인 방식과 무관하게 보장돼야 하는 로직이라 앱 전체에 한 번만 마운트되는
  `SessionWatcher.tsx`로 옮겨 `SIGNED_IN`/`INITIAL_SESSION` 이벤트에서 호출하도록 변경(멱등이라
  중복 호출 안전).
- **추가한 것**: 소셜 버튼 클릭 시 로딩 상태(중복 클릭·중복 콜백 실행 방지, 로딩 중 다른
  버튼도 비활성화), OAuth 콜백 실패(provider 거부/사용자 취소 시 URL 해시의
  `#error=...&error_description=...`) 감지 후 `/login?oauth_error=...`로 안내 문구와 함께
  되돌리는 처리(`app/page.tsx`, `app/login/page.tsx`).
- **정책 명문화**: 계정 연동(같은 이메일, 다른 로그인 방식) — `docs/08_Decision_Log.md`
  DEC-004로 "자동 병합하지 않는다"를 공식 결정으로 기록(스키마에 `accounts.email`이 없어
  애초에 안전한 자동 매칭이 불가능함을 확인).
- **검토했지만 적용 안 한 것**: "OAuth 후 원래 페이지로 복귀" — 현재 앱에는 email 로그인을
  포함해 "보호된 페이지 → 강제로 /login으로 리다이렉트" 패턴 자체가 어디에도 없어(항상 사용자가
  직접 `/login`으로 이동), 복귀할 "원래 페이지" 개념이 없다는 것을 코드 감사로 확인. 로그인 후
  항상 홈(`/`)으로 이동하는 기존 동작(이메일 로그인과 동일)을 그대로 유지.
- **미해결(외부 설정 필요)**: Google/Kakao/Apple은 Supabase 대시보드에서 아직 provider가
  활성화돼 있지 않아(콘솔 설정은 Claude가 대신 할 수 없음) 실제 OAuth 왕복은 미검증 —
  `docs/TODO.md` P2-1 참고. 네이버는 Supabase 기본 미지원이라 별도 Edge Function이 필요(P2-1b).

## 2026-08-07 — "모든 수강권 허용"인데 보유 pass가 안 보이는 버그 근본 수정 (feature/auth-private-class-membership, PR #41 머지 전 수정)

- **증상(실제 재현)**: `class_allowed_products` 0건(=모든 pass 허용)인 수업에서, 회원이 보유한
  특정 pass 하나가 "사용할 수강권" 목록에서 통째로 빠지고, 심하면 "현재 사용할 수 있는
  수강권이 없어요"까지 뜸.
- **근본 원인**: `app/manager/classes/page.tsx`의 class_allowed_products 저장 로직이
  `autoAddRulesForClass`/`removeRulesForClass`(P3 배치에서 만든 코드)로 `membership_schedule_
  rules`에도 부수효과를 쓰고 있었다. 이 테이블은 사실 `/manager/membership-rules`
  (`lib/passes.ts`)에서 관리자가 **완전히 독립적으로** 관리하는 기존 기능이었는데, 두 기능을
  자동 연동한 게 설계 실수였다 — 저장 타이밍/재시도/CI 취소 등으로 규칙이 완전히 지워지지
  않으면, 그 pass는 해당 규칙이 가리키는 옛 수업 조건에만 영원히 매칭되는 상태로 굳어버려
  이후 어떤 수업에서도 안 보이게 됐다(`usable_memberships_for_classes`의 "규칙이 하나라도
  있으면 그 조건에만 매칭" 의미론과 충돌).
- **수정**: `app/manager/classes/page.tsx`에서 `autoAddRulesForClass`/`removeRulesForClass`
  호출을 완전히 제거 — class_allowed_products 저장은 이제 `class_allowed_products` 테이블만
  건드린다. `lib/classes.ts`의 `autoAddRulesForClass`/`removeRulesForClass`/
  `fetchAllPassProductIds`/`dowFromDate`는 호출자가 없어져 삭제. `lib/classes.ts`의
  `setClassProducts`도 더 이상 이전 선택값을 반환할 필요가 없어 원래 시그니처(`Promise<void>`)로
  되돌림.
- **정책 확정**: `class_allowed_products`와 `membership_schedule_rules`는 이제부터 완전히 독립된
  두 기능이다 — 전자는 "이 수업에 어떤 pass를 쓸 수 있는가"(수업 화면에서 관리), 후자는 "이
  pass는 어떤 요일/시간/수업명에서만 쓸 수 있는가"(membership-rules 화면에서 직접 관리). 어느
  쪽도 서로의 데이터를 자동으로 만들거나 지우지 않는다.
- **후속 발견 1 — `fetchUsableMembershipsByClass()`의 1000행 응답 제한 누락(실제 앱 버그)**: 위
  수정 후에도 CI에서 증상이 재현돼 추적한 결과, 근본 원인은 하나 더 있었다 — 이 함수는
  `usable_memberships_for_classes()` RPC를 "선택된 날짜의 모든 수업 id"를 한 번에 넘겨
  호출하는데, 회원이 보유한 pass가 많고(공유 테스트 계정은 200개 넘게 누적) 같은 날짜에
  수업이 여러 개 있으면 합쳐진 응답 행 수가 PostgREST 기본 제한(1000행)을 넘을 수 있다 —
  `fetchClasses()`에서 이미 한 번 확인·수정한 것과 같은 종류의 문제다. `lib/classes.ts`의
  `.range()` 페이지 단위 반복 조회 패턴을 `lib/reservations.ts`의
  `fetchUsableMembershipsByClass()`에도 동일하게 적용해 수정.
- **후속 발견 2 — E2E 테스트 fixture의 "get-or-create가 소진된 수강권을 그대로 재사용"
  버그(테스트 버그)**: `createTestMembershipForProduct()`가 기존 활성 행을 `status='active'`만
  보고 재사용하면서 `remaining_count`/`expires_at`을 갱신하지 않았다. 이 계정은 전체 E2E
  스위트가 공유해서, 다른 스펙의 무제한 수업 자동매칭 예약(`reserve_class`, 만료 임박순으로
  아무 활성 수강권이나 선택)이 반복 실행되며 잔여횟수를 조용히 0까지 깎을 수 있었다 — 재사용
  시마다 잔여횟수/만료일을 갱신하도록 self-healing 처리.

## 2026-08-06 — P3 수업별 사용 가능 수강권(class_allowed_products) 관리 UI 감사 및 보강 (feature/auth-private-class-membership)

- **기존 구조 감사 결과**: `docs/08_Decision_Log.md` DEC-003("관리 UI 부재")이 2026-08-03에
  작성됐지만, 그 이후 프라이빗 수업 관리자 UI를 추가하던 배치에서 이미 Alternative A(수업
  등록/수정 화면에 다중 선택 UI)가 구현돼 있었음을 확인 — 등록/수정/반복등록
  (`setClassProductsBulk`)/스케줄 복사(`insertCopiedClasses`) 전부 `lib/classes.ts`의
  `setClassProducts`로 정상 연결돼 있었고, 회원 화면(`usable_memberships_for_classes`)도
  이미 정확히 반영하고 있었다. DEC-003을 Resolved로 갱신.
- **이번에 새로 발견해 고친 것**:
  1. `reserve_with_membership()`(회원이 수강권을 직접 선택해 예약하는 경로)만
     `class_allowed_products`를 전혀 확인하지 않았다 — 화면 목록 자체는 걸러져 있어 정상
     사용에선 안 드러나지만 RPC를 직접 호출하면 허용 안 된 수강권으로도 예약이 성립했다.
     `fix_class_allowed_products_enforcement_draft_proposed.sql`(SQL 미적용, 승인 대기)로
     `reserve_class()`/`usable_memberships_for_classes()`와 동일한 조건 추가.
  2. `class_allowed_products` INSERT RLS가 class의 센터만 확인하고 연결하려는 product가
     같은 센터의 pass인지는 확인하지 않아, 이론상 타 센터 상품·goods를 직접 API로 연결할
     수 있었다 — 같은 SQL 파일에서 RLS도 강화.
  3. `lib/reservations.ts`의 `fetchPurchasableProductsByClass()`("구매 가능한 수강권" 추천)가
     class_allowed_products 미지정 수업에서 goods까지 추천 목록에 섞을 수 있었다 — pass만
     조회하도록 쿼리 수정(순수 코드, SQL 무관).
  4. 관리자 선택 화면에 검색 입력(`app/manager/classes/page.tsx`)과 "선택 해제(모든 수강권
     허용으로 전환)" 버튼을 추가.

### 후속 — CI Green 확인 과정에서 추가로 발견·수정한 버그 (같은 날, 이어서)
- **`autoAddRulesForClass` "모든 수강권 허용" 오염 버그(실제 앱 버그, 회귀 심각도 높음)**:
  `app/manager/classes/page.tsx`의 `save()`가 "모든 수강권 허용"(선택 안 함)으로 저장할 때도
  센터의 전체 pass 상품에 `autoAddRulesForClass`를 호출해, 그 순간부터 그 pass들이 "무제한"에서
  "이 수업 조건에만 매칭"으로 조용히 좁혀지던 버그. 두 호출부 모두 `selectedProducts.length > 0`일
  때만 호출하도록 수정.
- **"특정 허용→전체 허용" 전환 시 규칙이 안 지워지는 버그(위 버그의 후속, 실제 앱 버그)**:
  위 버그를 고친 뒤에도, 한번 "특정 허용"으로 저장했다가 다시 "전체 허용"으로 되돌리면 이전
  저장이 자동 생성한 `membership_schedule_rules`가 그대로 남아 그 수강권이 계속 이전 수업
  조건에만 매칭된 상태가 풀리지 않았다. `lib/classes.ts`의 `setClassProducts()`가 교체 전
  기존 product_id 목록을 반환하도록 바꾸고, `removeRulesForClass()`를 신규 추가해 저장 시
  빠진 수강권의 규칙을 함께 정리하도록 수정.
- **`fetchClasses()` 1000행 페이지네이션 누락(실제 앱 버그)**: 관리자 수업 캘린더 조회
  (`lib/classes.ts`)가 PostgREST 기본 1000행 캡에 걸려, 한 달에 수업이 1000개를 넘는 센터는
  뒤쪽 수업이 캘린더에서 통째로 안 보였다. `lib/reservations.ts`의 `fetchMonthData` 페이지네이션
  패턴을 그대로 이식(`.range()` 루프 + `class_reservation_counts` 청크 조회).
- **`service_role` GRANT 누락 3건(권한/인프라 문제, 기존에 이미 있던 동일 부류 문제의 재발견)**:
  `membership_schedule_rules`/`profiles` 테이블에 `service_role` GRANT가 없어 테스트
  fixture(admin/service-role 클라이언트)가 "permission denied"로 실패했다 — `products`/
  `classes`/`memberships`/`reservations`/`center_settings`에 이미 있었던 것과 동일한 패턴.
  `fix_service_role_missing_grants_membership_schedule_rules_draft_proposed.sql`/
  `fix_service_role_missing_grants_profiles_draft_proposed.sql`로 추가(사용자가 적용 완료).
- **통합테스트 fixture 버그(테스트 버그, 앱 버그 아님)**: `class-allowed-products-enforcement.test.ts`의
  `createMembershipForProduct`가 회원 세션(RLS 적용 대상)으로 `memberships`에 직접 insert를
  시도해 RLS 위반으로 실패 — admin(service-role) 클라이언트로 수정.
- 위 수정 후 `fix_class_allowed_products_enforcement_draft_proposed.sql` 적용까지 완료,
  Playwright/Unit/Integration/Build 전 구간 **2회 연속 Green** 확인(CI run 31095072280,
  31096363412). Vercel Preview 배포도 성공 확인.

## 2026-08-05 — P0 실제 버그 4건 수정 + P1 로그인/계정 기능 보강 (feature/auth-private-class-membership)

- **P0-1 (휴무일 삭제 후 폐강 상태가 안 풀림)**: `add_holiday_safe()`가 휴무일 등록 시
  그날 수업들을 `classes.status='cancelled'`로 바꾸는데, 삭제 경로는 이를 되돌리는 코드가
  전혀 없었다 — 그래서 휴무일을 지워도 수업이 계속 "폐강된 수업이에요"로 막혀 있었다.
  신규 RPC `remove_holiday_safe()`(`fix_holiday_delete_restores_classes.sql`)로 휴무일 삭제와
  해당 날짜 cancelled 수업의 open 복구를 한 트랜잭션으로 처리.
- **P0-2 (수업별 예약마감이 당일예약 설정보다 낮은 우선순위였음)**: `reserve_class`/
  `reserve_with_membership`의 "예약 마감시간" 검사는 `booking_deadline_min`(수업별 override)을
  이미 최우선으로 썼지만, 바로 다음의 "당일 예약 허용 여부" 검사는 이 override를 무시하고
  항상 센터 운영설정만 확인했다 — 그래서 수업에 명시적으로 예약마감을 지정해도 센터의
  당일예약 토글이 꺼져 있으면 여전히 막혔다. `booking_deadline_min`이 있으면 당일예약
  검사를 건너뛰도록 수정(`fix_class_deadline_overrides_same_day_toggle.sql`).
- **P0-3 (goods 상품이 "사용 가능 수강권" 목록에 노출)**: 코드 감사 결과 현재 코드는 이미
  이전 세션의 `fix_usable_memberships_product_kind.sql`로 고쳐진 상태 — RPC/관리자
  선택기/reserveWithMembership 경로 모두 `product_kind='pass'`만 정확히 필터링함을
  실브라우저 E2E로 재확인하고 회귀 방지 테스트만 추가.
- **P0-4 (일일 예약 횟수 제한 재검증)**: 취소 시 한도가 다시 채워지는지, 대기 등록도
  한도에 포함되는지, 회원 A/B의 한도가 서로 독립적인지 실브라우저로 새로 검증(기존
  스펙은 "OFF→성공, ON+제한→3회째 실패"만 다뤘음). 로직 자체는 이미 정확했다(회귀 없음).
- **P1 로그인/계정 기능**: 코드 감사 결과 소셜 로그인(카카오/네이버/애플)으로 처음
  로그인하면 `accounts`/`profiles` 행이 아무도 만들어지지 않아 거의 모든 화면이
  "계정 정보를 찾을 수 없어요"로 막히는 심각한 버그를 발견 — `lib/authAccount.ts`의
  `ensureAccountForCurrentUser()`로 홈 화면 첫 로드 시 부트스트랩하도록 수정. 그 외
  완전히 빠져 있던 기능 추가: Google 로그인 버튼, 비밀번호 재설정(`/reset-password`,
  `/reset-password/confirm`), 로그인 상태에서 비밀번호 변경(`/settings/account`),
  "로그인 상태 유지" 체크박스(해제 시 세션을 localStorage 대신 sessionStorage에 저장),
  세션 만료 시 자동으로 로그인 화면으로 안내(`app/components/SessionWatcher.tsx`).
- **P2 프라이빗(1:1) 수업**: 관리자 UI(그룹/프라이빗 토글, capacity=1 고정)와 DB
  CHECK 제약, `calc_deadline()`의 프라이빗 전용 예약/취소/오픈 기한 등은 이전 배치에서
  이미 구현돼 있었으나, 실제 예약 경로에 세 가지 실제 버그가 남아 있었다(코드 감사로
  확인, `docs/TODO.md` P1-11/P1-12와 교차 확인): (1) 프라이빗 수업이 차 있으면 대기예약
  경로로 빠져 1:1 수업에 대기 순번이 생길 수 있었음, (2) 관리자 직접배치의 "정원 초과
  강제 배치" 옵션이 프라이빗 수업에도 그대로 적용돼 두 번째 확정 예약을 만들 수 있었음,
  (3) 운영설정 화면의 "프라이빗 동시 수업 최대 개수"(`private_max_concurrent`)가
  스키마·설정화면에만 있고 실제로 예약을 막는 코드가 전혀 없어 완전히 죽은 설정이었음.
  `fix_private_class_capacity_and_concurrency_draft_proposed.sql`(SQL 미적용, 승인 대기)로
  세 가지 모두 수정하고 `tests/integration/private-class-capacity.test.ts`로 검증 추가.

## 2026-08-05 — Playwright 관리자 세션 session_not_found 근본 원인 수정 + 전체 파이프라인 2회 연속 Green (PR #39)

- **session_not_found 정확한 원인**: `tests/integration/setup.ts`의 `switchToTestUser()`가
  매번 `supabase.auth.signOut()`을 scope 없이(기본값 `'global'`) 호출했다
  (`node_modules/@supabase/auth-js`에서 직접 확인: `signOut(options = {scope:'global'})`).
  `tests/e2e/auth.setup.ts`가 매니저→회원 순서로 이 함수를 두 번 호출하는데, 회원 차례의
  `signOut()`이 실행되는 시점에 Node의 공유 supabase 클라이언트는 아직 매니저 세션
  상태였다 — global scope라 이 호출이 매니저 계정의 `auth.sessions`를 서버에서 전부
  지워버려, 방금 브라우저로 로그인해 storageState까지 저장해둔 매니저 세션까지 함께
  죽었다. `signOut({scope:'local'})`로 수정.
  - "여러 BrowserContext가 storageState를 나눠 쓰는 것"(리프레시 토큰 회전 충돌) 가설은
    실측(worker-scoped fixture로 context를 1개로 줄여도 동일하게 재현)으로 배제했다.
- **함께 발견된, 훨씬 근본적인 문제**: E2E 테스트 수강권(`createTestMembershipAdmin`)이
  `product_id`를 채우지 않아 `usable_memberships_for_classes()`(products를 INNER JOIN)가
  그 수강권을 결과에서 통째로 제외했다 — 회원 화면의 "사용할 수강권" 목록이 항상 비어
  `doReserve()`가 `reserveWithMembership()`이 아니라 `reserveClass()`로 계속 폴백했다.
  즉 이번 세션 상당 부분의 "실제 회원 화면 검증"이 실제로는 `reserveClass()`만 반복
  검증하고 있었다. `getOrCreateTestPassProduct()`로 실제 `product_kind='pass'` 상품을
  만들어 연결하도록 수정 — 이제 `reserveWithMembership()`이 실제로 실행되며, 기존에
  통과하던 테스트들도 이 변경 이후 전부 그대로 통과함을 확인(회귀 없음, 원래 수정이
  올바르다는 증거).
- **테스트 데이터 오염 2건 추가 발견/수정**: (1) 공유 테스트 센터에 여러 세션에 걸쳐
  누적된 leftover 확정 예약이 일일예약 횟수 제한 검증의 기준선을 오염시켜
  `cleanupTodaysReservationsForProfile()` 신규(검증 전 오늘자 예약 전부 정리). (2)
  `reservation-cancel-grace-period.test.ts`(integration)가 "당일 수업 취소마감은 항상
  어제"라는 가정으로 pre-existing 설정값에 암묵 의존하다, 그 값이 다른 테스트에 의해
  0으로 바뀐 채 남아 실패 — 취소마감을 명시적 과거 절대시각으로 저장하도록 수정.
- `products` 테이블 service_role GRANT 누락도 함께 발견/수정
  (`fix_service_role_missing_grants_products.sql`, 사용자 적용 완료).
- **결과**: E2E(13개 시나리오: 당일예약/일일한도/예약오픈/예약마감/취소기한/시작후차단),
  Unit, Integration, Build 전체 파이프라인이 2회 연속 완전 Green.

## 2026-08-04 — reserve_with_membership() 운영설정 가드 누락 수정 + 관리자 UX 정리 (PR #39)

- **핵심 버그(실제 브라우저 재현)**: "당일예약 OFF/예약 가능 기한 등을 저장해도 회원
  화면에서 계속 예약이 통과된다"는 수동 QA 보고가 있었고, RPC(`reserve_class`)를 직접
  호출하는 테스트는 전부 정상이라 처음엔 "테스트 환경 문제"로 오판했다. 실제 원인은
  회원 화면(`app/reservation/page.tsx` `doReserve()`)이 사용 가능한 수강권이 하나라도
  있으면(거의 모든 실사용 케이스) `reserve_class()`가 아니라 `reserve_with_membership()`을
  호출한다는 것이었고, 이 함수(`add_admin_assignment.sql`)에는 당일예약 허용/일일
  예약 횟수 제한/예약 오픈·마감/수업 시작 후 차단/휴무일 가드가 전혀 없었다 —
  `reserve_class()`에만 있던 가드가 `reserve_with_membership()`에는 이식된 적이 없었던
  것. `fix_reserve_with_membership_operational_settings.sql`로 6개 가드를 전부 이식(사용자
  적용 완료).
- **함께 적용**: `add_tennis_category.sql`(종목에 "테니스" 추가), 이미 저장소에 있었지만
  미적용 상태였던 `fix_usable_memberships_product_kind.sql`(수강권 선택 목록에 goods
  상품이 섞여 보이던 버그) — 둘 다 사용자 확인 후 적용 완료.
- **수업 등록 검증 추가**: 종료시간이 시작시간 이후가 아니면(예: 10:00→09:00) 거부,
  단 자정을 넘기는 경우(예: 23:00→01:00, 6시간 이내)는 허용(`lib/classes.ts`
  `isValidClassTimeRange`/`classEndDate`, 생성/수정/반복등록/복사 7개 경로 전부 적용).
- **관리자 회원탭 정리**: "담당회원"/"상담고객" 탭 제거(둘 다 "준비 중" 플레이스홀더였고
  실제 데이터/로직이 없었음) — `app/manager/members/page.tsx`.
- **E2E**: 운영설정 스펙을 실제 관리자 화면 조작(admin client로 값만 덮어쓰는 방식이
  아니라 진짜 토글/입력 클릭) 기준으로 재작성. 신규 `booking-open-deadline.spec.ts`
  추가(예약 오픈 시점 검증) — 코드 추적 결과 "N일 전부터 예약이 열린다"가 실제 동작이라,
  더 먼 미래 수업이 아직 닫혀있고 더 가까운 수업이 열려있는 것이 정상임을 확인.

## 2026-08-03 (추가 2) — 회원 예약 캘린더 월 후반부 수업 누락 버그 수정 (PR #39)

- **원인**: `fetchMonthData()`(`lib/reservations.ts`)의 원시 `classes` 쿼리가 `center_id`
  조건도 `.range()`/`.limit()`도 없이 "이 달의 모든 센터" 수업을 한 번에 조회한 뒤
  클라이언트에서 멤버십 보유 센터로 필터링했다. 전체 집계 행 수가 Supabase 프로젝트의
  PostgREST 기본 응답 행 수 제한(실측 1000행)을 넘으면 `start_time` 오름차순 정렬
  특성상 반환분이 그 지점에서 끊겨 월 후반부 수업이 통째로 누락됐다(진단 테스트로 실측:
  1200개 중 1000개만 반환, 마지막 반환 행이 월말이 아니라 25일). 관리자용
  `fetchClasses()`(`lib/classes.ts`)는 `center_id`로 이미 좁혀 조회해 이 문제에 걸리지
  않아 "관리자 화면엔 정상, 회원 화면만 일부 누락"으로 나타났다.
- **수정**: `classes` 쿼리를 `.in("center_id", 회원의 활성 수강권 보유 센터)`로 DB
  단에서 직접 좁히고 `.range()`로 페이지 단위 반복 조회하도록 변경. 그 결과 한 센터가
  한 달에 매우 많은 수업(1300개 테스트)을 가질 수 있게 되면서, 뒤이어 `class_reservation_counts`/
  `reservations` 조회의 `.in("class_id", classIds)`가 UUID를 너무 많이 나열해 "Bad
  Request"로 실패하는 2차 문제가 드러나 150개 단위 배치 조회로 함께 수정.
- **테스트**: `classes-row-limit-regression.test.ts` 신규(내 센터 1300개 수업이 페이지
  경계 999/1000/1001 포함 전부 반환되는지, 승인된 다른 센터 700개는 여전히 제외되는지
  검증) — 진단 전용이던 `diagnose-classes-row-limit.test.ts`를 정식 회귀 테스트로 전환.
  전체 integration 82/82, 2회 연속 실행 안정성 확인, 기존 month-boundary-kst 등 회귀 없음.

## 2026-08-03 (추가) — 6트랙 후속: open-kind 마무리/픽스처 격리/환경검증/설정2차/프라이빗2차/전화인증조사 (PR #39)

- **Track 1**: `calc_deadline()` open-kind 수정 SQL을 그룹/프라이빗/KST 자정 경계까지
  검증하도록 통합테스트 보강(`operational-settings-wiring.test.ts`). 회귀 위험 재확인(book/
  cancel 분기는 건드리지 않음).
- **Track 2**: `sec009-batch-a1-rls.test.ts`의 `staff_salaries` fixture를 get-or-create
  패턴으로 전환해 중복키로 인한 실패를 근본 해결(재실행해도 안전). `acl-003-permission-read.test.ts`는
  이미 자기 fixture를 추적·정리하도록 설계돼 있었음을 재확인 — 남은 것은 과거(그 수정 이전)
  잔여 데이터 1건뿐이며 `cleanup_acl003_test_fixture_proposed.sql`(기존 준비된 파일)로 정리
  가능, 실행은 승인 대기.
- **Track 3**: 환경 비교 결과를 `docs/ENV_PARITY_CHECK.md`로 정리 — Vercel 환경변수는 도구로
  직접 확인 불가해 사용자 확인 절차를 안내.
- **Track 4**: 운영설정 전수 동작표를 `docs/OPERATIONAL_SETTINGS_AUDIT.md`로 정리.
  `show_group_reserved_count`(회원 앱 예약인원 표시)와 `auto_unpaid_input`(매출 등록 미수금
  자동계산)을 실제로 구현. 스케줄러가 필요한 항목(당일예약변경/자동폐강/대기자동확정)은
  UI에 "준비 중" 배지 추가 + 입력 비활성화.
- **Track 5**: 프라이빗 수업 그룹/프라이빗 선택·정원1 고정·회원앱 배지는 이미 정상 연결돼
  있음을 재확인. 지정회원 전용 정책·슬롯 시스템·`class_allowed_products` 관리 UI 부재는
  `docs/08_Decision_Log.md`(DEC-001~003)로 분리, 이번엔 구현하지 않음.
- **Track 6**: 휴대폰 인증 조사 문서(`docs/PHONE_AUTH_RESEARCH.md`) 작성, AUTH-001(#40)은
  P3 Deferred 유지, 구현/계약 없음.

⚠️ 신규 SQL(`fix_calc_deadline_open_kind_draft_proposed.sql`)은 사용자 승인 전까지 미실행.

## 2026-08-03 — QA 통합 배치: Nav/관리자UI/예약제한·10분취소/개별마감·프라이빗/알림 (PR #39)

회원의 실제 브라우저 QA에서 발견한 5개 트랙(NAV-001, UI-004, RES-001, CLASS-001, NOTIF-001,
SYNC-001)을 하나의 배치/PR(#39)로 진행. 이슈 #33~#38로 추적.

- **NAV-001/SYNC-001**: 사용 가능한 수강권이 없는 신규 회원의 하단 Nav "예약"/"내 예약" 탭
  숨김(구매 시 즉시 5탭 복원), Mock 결제 확정 시 `ensure_center_member` 호출 누락 수정.
- **UI-004**: 휴무일 버튼 캡슐형 통일, 수업 시작/종료 시간 오전오후·시·분(기본 00분)
  선택형 교체, 관리자 직접배치 화면 중복 텍스트 정리.
- **RES-001**: 예약 후 10분 이내 무료 취소 예외(`cancel_reservation` 재작성,
  `reservations.cancel_source` 컬럼 신설).
- **CLASS-001**: 개별 수업 예약마감이 운영설정 기본값보다 우선하도록 배선, 프라이빗 수업
  (`class_format`) 정원 1명 서버(CHECK 제약) 강제.
- **NOTIF-001**: 알림 채널 현황 문구 명확화, 1:1 문의 알림 딥링크, 휴무일 강제취소가
  예약/수업 행을 삭제 대신 `cancelled` 상태로 보존(`add_holiday_safe` DELETE→UPDATE 전환)
  + 회원 알림 문구 보강, 미사용 확인된 운영설정 메뉴(라운지/락커/문의게시판) UI 제거.

### 실브라우저 QA 후속 수정 (같은 PR #39에 추가 커밋)

1차 배치 완료 후 실제 브라우저 QA에서 7건의 추가 문제가 발견되어 같은 브랜치에서 수정:
- 이메일 인증을 실제로 쓰지 않는데도 "확인 메일이 발송됐어요"라고 안내하던 거짓 문구 제거
  (`app/login/page.tsx`).
- BottomNav 로딩 중 탭이 잠깐 보였다가 사라지는 깜빡임 수정(초기 상태를 "있음"으로 가정하지
  않음), "내 예약"을 항상 노출하던 자체 판단을 사용자 요구에 맞게 철회(수강권 없으면 둘 다
  숨김).
- 관리자 직접배치 "종료" 버튼의 세로 줄바꿈 실제 원인(`.ghost-btn`의 `width:100%`가 flex
  컨테이너에서 flex-basis로 해석돼 발생) 확인 후 전용 클래스로 수정.
- **실시간 알림 토스트(`NotificationToaster.tsx`)에 문의 딥링크 분기가 통째로 빠져 있던 것을
  발견** — 회원/매니저 알림 "목록" 페이지는 이미 정상 동작했지만 토스트 팝업만 별도 구현이라
  누락돼 있었음. 세 곳이 `notificationHref()` 하나를 공유하도록 통합.
- 관리자 1:1 문의 목록이 "센터이름 회원"으로만 보이던 문제 — 회원 이름을 조회하지 않고
  있었음을 확인, "회원이름 - 센터이름" 형식으로 수정.
- **운영설정 재검증 중 `calc_deadline()`이 `'open'` kind(예약 오픈 시점)를 처리하지 않고
  있었음을 발견** — 이전 배치의 "P1-12에서 정상 배선됨" 결론이 틀렸던 것으로, 관리자가 저장한
  예약 오픈 설정이 조용히 무시되고 취소 마감 설정이 대신 쓰이고 있었음
  (`fix_calc_deadline_open_kind_draft_proposed.sql`).
- 당일 예약 허용 OFF는 UI가 실제로 저장하는 경로(`saveSettings`)를 쓰는 신규 통합테스트로
  재검증(이전에는 이 항목에 자동 테스트 자체가 없었음).

⚠️ 이 배치의 SQL 파일들은 사용자 승인 전까지 미실행 상태이며, 관련 통합테스트는 그동안
의도적으로 RED입니다.

## 2026-08-02 — Track B: 관리자(Admin) 기능 전수 감사 + 예외처리/사용성 버그 수정

17개 관리자 기능 영역(대시보드/회원/스태프/권한/예약/출석/클래스/일정/수강권/상품/결제/매출/
문의/공지/알림/센터관리/운영설정 등)을 실제 코드 기준으로 전수 조사했습니다. 상세 결과는
[23_Admin_Feature_Audit.md](./23_Admin_Feature_Audit.md) 참고. SQL/RLS 변경이 필요한 발견
사항(휴무일 강제취소 시 수강권 미복구 P0, 운영설정 다수 필드 미시행 P1, 센터정보 권한 불일치
P1 등)은 이번 배치 규칙(SQL 실행 금지·새 RLS 수정 금지)에 따라 코드를 고치지 않고
`docs/TODO.md`(P0-6, P1-12, P1-13, P2-14)에만 기록했습니다.

**애플리케이션 코드만으로 고칠 수 있는 P0/P1 버그**를 수정했습니다(전부 예외처리·사용성 개선,
새 RLS/ACL 없음):
- `app/manager/page.tsx`: 예약자 명단/회원 상세 조회 실패 시 시트가 안 닫혀 "예약자 없음"으로
  오인되거나 무한 로딩으로 보이던 문제 — 실패 시 시트를 닫고 상단 에러로만 알리도록 수정.
- `app/manager/membership-rules/page.tsx`: 상품 생성 후 요일·시간 예약조건 등록이 실패해도
  `catch {/* 무시 */}`로 조용히 넘어가던 문제 — 실패 건수를 안내하도록 수정.
- `app/components/InquiryChat.tsx`(문의 채팅): 메시지 조회/전송/사진 업로드 실패가 전부 무언
  처리되어 매니저가 답장이 실패한 걸 몰랐던 문제 — 화면에 에러 메시지를 표시하도록 수정.
- `app/manager/notifications/page.tsx`: 알림 클릭 시 `window.location.href`로 전체 페이지를
  새로고침하던 것을 Next.js 라우터(`router.push`)로 교체(SPA 상태 유지).
- `lib/orders.ts`/`app/manager/orders/page.tsx`: `fulfill_order()` RPC가 실제로는
  `{already_done, membership_id, amount}`만 반환하는데 존재하지 않는 `auto_booked`/`remaining`
  필드를 기대해 항상 무시되던 죽은 분기를 제거 — 반환값을 안다고 가정하지 않는 정확한 안내로
  정리(RPC 자체는 변경하지 않음).
- `app/manager/progress/record/page.tsx`: 어디서도 호출되지 않는 `updateProgressNote` 죽은
  import 제거.
- `docs/ROUTES.md`: `/admin/categories`·`/admin/banners`의 `checkPlatformAdmin()` 가드 상태와
  `/manager/inquiries`·`/manager/notifications`의 `fetchMyCenters()` 상태가 실제로는 이미
  적용됐는데 문서만 stale하게 "미완성"으로 남아있던 것을 정정.

Track B 진행 중 별도로 발견: `tests/integration/acl-003-permission-read.test.ts`와
`docs/TODO.md` P0-4가 `fix_account_center_permissions_select_draft_proposed.sql`을 여전히
"미실행"으로 기술하고 있었으나, 실제로는 이미 실행·검증·병합 완료된 상태였습니다(문서 갱신
누락) — 위 CHANGELOG 첫 항목에서 별도로 정정했습니다.

## 2026-08-02 (Track B 감사 중 발견) — 문서 정정: ACL-003 fix SQL 실행 완료 기록 누락

Track B(관리자 기능 Audit) 진행 중 `tests/integration/acl-003-permission-read.test.ts`와
`docs/TODO.md` P0-4가 여전히 "`fix_account_center_permissions_select_draft_proposed.sql`
미실행"으로 기술돼 있는 것을 발견했습니다. 실제로는 이 SQL이 사용자에 의해 Supabase SQL
Editor에서 이미 실행됐고(Success), 그 결과 ACL-003 통합 테스트 3/3 통과, 전체 통합
테스트·PR #19 CI green까지 확인한 뒤 `feature/access-control-guards`(PR #19, ACL-001~005
Batch)에 포함되어 main에 병합됐습니다 — 다만 그 실행 완료 사실 자체를 CHANGELOG에 별도
기록하지 않아 두 문서가 "미실행"으로 정체돼 있었습니다. 코드/테스트/실제 라이브 정책은
이미 올바른 상태였고(실제 보안 결함이 남아있던 것이 아님), 이번엔 그 사실을 반영하도록
`docs/TODO.md`와 테스트 파일 헤더 주석만 갱신했습니다.

## 2026-08-02 (추가 3) — SEC-009: Batch A1 적용 후 messages SELECT 결함 발견 및 수정 SQL 준비

`proposed_rls_gap_batch_a1.sql`을 사용자가 직접 Supabase SQL Editor에서 실행(Success). 검증
결과 `staff_salaries`/`leads`는 정상 동작(각각 5/5, 3/3 통과)했지만, `messages`의 SELECT
정책이 channel로 분리되지 않아 `message.sms.view`만 가진 스태프도 push 채널 메시지를 볼 수
있는 결함이 실제로 발견됨(37/38 통과, 1건 실패 — INSERT/UPDATE/DELETE는 원래부터 channel로
정확히 분리돼 있어 영향 없음). 전체 rollback 대신 `messages` SELECT 정책만 최소 범위로
수정하는 `fix_messages_select_channel_scope_draft_proposed.sql`(짝 파일
`rollback_fix_messages_select_channel_scope_draft_proposed.sql`)을 준비 — **아직 실행하지
않음, 승인 대기 중.** 회귀 테스트도 lms 채널 케이스와 push 전용 권한 케이스를 추가해 보강.
SEC-009는 계속 Review 유지, PR #20은 merge하지 않음.

## 2026-08-02 (추가 2) — SEC-009: Batch A를 A1/A2로 분리 (SQL 실행은 아직 안 함)

바로 아래 항목(Batch A 5개 테이블 통합 준비)에 대한 사용자 검토 결과, "검증 안 된 2개 테이블을
검증된 3개와 함께 적용하면 회귀 시 원인 분리가 어렵다"는 지적에 따라 분리했습니다.

- **A1**(`proposed_rls_gap_batch_a1.sql`/`rollback_rls_gap_batch_a1.sql`, 신규) — `staff_salaries`/
  `leads`/`messages`. 기존 5개 테이블 통합본에서 정책 내용 변경 없이 이 3개만 그대로 분리.
  `tests/integration/sec007-batch-a-rls.test.ts` → `sec009-batch-a1-rls.test.ts`로 이름 변경(A1
  전용임을 명확히 함).
- **A2**(SQL 미확정, 조사만) — `contracts`/`notification_logs`. `docs/22_RLS_Gap_A2_Investigation.md`
  신규 작성 — 요청받은 10개 질문(앱/RPC 실사용 여부, 정상 INSERT/DELETE 주체, GRANT 필요성과
  노출면, fixture 전략 등)에 전부 답함. 결론: 두 테이블 다 앱/트리거 참조 0건(미구현 기능),
  service_role GRANT를 추가하는 것을 권장(앱 보안과 무관 — service_role 키는 클라이언트에
  노출되지 않음)하되, `contracts`의 INSERT 정책은 실제 계약 발급이 RPC로 설계되기 전까지
  보류할 것을 제안(SELECT 정책만 초안 포함). **SQL 초안만 작성, 실행하지 않음.**
- 읽기 전용 진단(anon/authenticated/service_role로 SELECT 시도, mutation 없음)으로 A1 3개
  테이블의 실제 GRANT 상태를 추가 확인: **anon/authenticated 둘 다 GRANT 정상**(SELECT 시도 시
  에러 없이 0건 반환 — RLS가 막고 있을 뿐 GRANT 자체는 있음). 즉 `proposed_rls_gap_batch_a1.sql`
  만으로 충분하고 추가 GRANT는 필요 없음(service_role 부재는 테스트 도구 전용 문제, 이미
  알려진 대로 A2에서만 필요). 이 결과를 `docs/21_RLS_Gap_Analysis.md`에 역할별 기대 결과
  매트릭스(A1 3개 테이블 × 7개 역할 × 4개 연산)로 정리.
- Issue #28(SEC-009)에 이 분리 내용을 코멘트로 기록, Status는 계속 Review 유지(A1도 아직
  미승인·미실행).

## 2026-08-02 (추가) — SEC-009: RLS Gap Batch A 적용 준비 완료 (SQL 실행은 아직 안 함)

`docs/rls-gap-design` 브랜치(PR #20)에서 진행. SEC-007/008에서 초안까지만 작성했던
`proposed_rls_gap_batch_a.sql`(staff_salaries/contracts/leads/messages/notification_logs)을
실제 적용 가능한 상태로 완성했습니다.

- 재검증: 5개 테이블의 `schema.sql` 컬럼 정의, 초안이 참조하는 permission key 17개 전부가
  실제 카탈로그에 존재하는지, `has_permission()`/`my_account_id()`/`is_platform_admin()`
  헬퍼 시그니처를 전수 재확인 — SEC-007/008 작성 이후 drift 없음.
- **중요 정정**: SEC-007은 이 5개 테이블을 "RLS가 없거나 정책 0건"으로 분류했으나, 실제
  개발(dev) Supabase에서 오너 권한 insert를 시도해본 결과 **RLS는 이미 활성화돼 있고
  정책만 0건**이었다(`42501: new row violates row-level security policy` 확인 — 이 저장소
  SQL 이력에 이걸 켠 기록 없음, 대시보드에서 직접 조작된 것으로 추정). "정책 0건"과 "RLS
  비활성화"는 서로 다른 별개 상태 — 실제로는 오너를 포함해 아무도 접근 못 하는 완전 차단
  상태였다(당초 우려했던 "누구나 접근 가능"보다 안전한 상태). `rollback_rls_gap_batch_a.sql`이
  `disable row level security`로 되돌리게 되어 있었는데, 그러면 원래보다 더 위험한(전체
  공개) 상태가 되므로 정책 제거만 하도록 수정했다. 테스트 fixture 생성도 일반 client로는
  지금 당장 불가능해(0 정책 = 오너도 차단) `getOrCreateOwnedTestCenter`와 동일한
  admin(service-role) client 패턴으로 전환했다. **Batch B/C/D의 12개 테이블과 production
  Supabase의 실제 상태는 아직 확인하지 못함** — 각각 다음 배치 적용 전, 그리고 실행 승인
  전에 반드시 별도 확인 필요. 상세: `docs/21_RLS_Gap_Analysis.md` 상단 정정 섹션.
- **두 번째 정정**: 위 발견과 별개로, service_role 자체에도 5개 테이블 전부 SQL GRANT가
  없다는 것도 확인했다(RLS와 무관한 별개 문제, `account_center_permissions`에서 이미 겪은
  것과 같은 패턴). `staff_salaries`/`leads`/`messages`는 오너에게 INSERT+DELETE 정책이 모두
  있어 일반 client(오너)로 fixture 관리가 가능하지만, `contracts`(DELETE 정책이 의도적으로
  없음 — 서명 후 불변)와 `notification_logs`(INSERT 정책이 의도적으로 없음 — 서버 트리거
  전용)는 일반 client·admin client 어느 쪽으로도 지금은 fixture를 만들거나 지울 방법이 없어,
  이 두 테이블은 `docs/TODO.md` P2-13(service_role GRANT 승인·실행 후 진행)으로 미루고
  이번 테스트 파일에서는 의도적으로 제외했다.
- `tests/integration/sec009-batch-a1-rls.test.ts` 신규 작성 — `staff_salaries`/`leads`/
  `messages` 3개 테이블에 "무권한 SELECT 차단/권한 보유자 SELECT 허용/무권한 쓰기 차단"
  최소 3~4종(`staff_salaries`는 own/other 권한 완전 분리라 조합 추가, `messages`는 channel별
  분리라 sms/push 조합 추가). Fixture 계정은 TEST_MANAGER_A(centerA 오너)/TEST_MANAGER_B
  (centerA에 권한 0개 스태프로 초대)/TEST_USER_A(무관 일반 회원)만 재사용, 새 Secret 없음.
  **이 테스트는 SQL이 실제 적용되기 전에는 의도적으로 RED**입니다(정책 0건이라 fixture 준비
  단계에서부터 막힘 — `tests/integration/acl-003-permission-read.test.ts`가 SQL 적용 전
  red였던 것과 같은 취지지만, 그쪽은 일부 정책이 이미 있어 fixture 준비까지는 됐다는 차이가 있음).
- SQL은 이번에도 **전혀 실행하지 않았습니다.** 실행은 사용자 승인 후 별도 단계에서 진행.
- Issue: [SEC-009](https://github.com/sonjw222/booking-app/issues/28)(신규, SEC-007/008과
  Related). Batch B/C/D는 아직 손대지 않음(다음 배치에서 순서대로 진행).

## 2026-08-02 — ACL-005 관리자 진입 SSOT 수정 + UI-003 센터 등록 흐름 개선 (PR #19)

일반 회원을 스태프로 등록해도 마이페이지 "관리자 모드로 전환"이 안 뜨고 `/manager` 접속이
차단되는 문제(1차 조사·수정은 커밋되지 않은 채 보류돼 있었고, 그 상태로 실브라우저 재현이
보고돼 2차로 전수 조사·수정함).

- **원인**: `accounts.is_manager`(스태프 초대와 별개로 저장되는 플래그)를 관리자 진입 판정
  기준으로 쓰고 있었는데, `inviteStaff()`가 이 플래그를 갱신하려는 UPDATE가 `accounts` RLS
  정책("본인 계정 수정", `auth_id = auth.uid()`)에 막혀 항상 조용히 실패했음(반환 `error`
  미확인). 전수 조사 결과 `account_type`/`signup_type` 같은 별도의 영구 차단 필드는 존재하지
  않았고, ID 연결(`auth_id`→`accounts.id`→`manager_centers.account_id`)에도 혼동이 없었음 —
  원인은 이 플래그 하나였음.
- **수정**: `lib/manager.ts`(`getMyAccountId()`)와 `lib/mypage.ts`(`getMyContext()`)가 이제
  `accounts.is_manager`가 아니라 active `manager_centers` 소속 존재를 라이브 조회로 판단(SSOT
  통일). `lib/roles.ts`의 `inviteStaff()`에서 항상 실패하던 `is_manager` 갱신 코드 제거. RLS/SQL
  변경 없음 — 기존 "본인 매니저센터 조회" SELECT 정책만으로 충분.
- **UI-003**: 회원가입 유형 문구 "회원"→"일반", "매니저"→"센터 운영자"로 변경(보조 설명 추가,
  내부 상태값은 불변). 마이페이지 "센터 운영하기(매니저 등록)"→"내 센터 등록하기"로 변경하고
  `/login`으로 되돌아가던 동작을 제거, 로그인된 사용자가 바로 센터 등록 폼(`/mypage/register-center`,
  신규)으로 이동하도록 함. "관리자 모드로 전환"과 동시에 노출 가능(상호 배제 조건 제거).
- **공용화**: `lib/centers.ts`(신규) — 센터 등록 검증(`validateCenterRegistrationInput`)·저장
  (`registerCenterForAccount`) 로직, `app/components/CenterRegistrationForm.tsx`(신규) — 입력
  UI. 회원가입("센터 운영자") 흐름과 마이페이지 "내 센터 등록하기" 흐름이 이 두 모듈만 공유하고
  로직을 복제하지 않음. 기존에 각 supabase 호출의 반환 error를 확인하지 않던 지점(센터 오너
  역할 연결)도 이번에 함께 고쳐 실패가 조용히 무시되지 않도록 함.
- Issue: [ACL-005](https://github.com/sonjw222/booking-app/issues/26)(재사용, 제목/범위 확장),
  [UI-003](https://github.com/sonjw222/booking-app/issues/27)(신규). `feature/access-control-guards`
  (PR #19)에 포함 — main 미병합.

## 2026-08-01 (추가) — SEC-007/008 단계 적용 준비 (ACL-003 재검증 반영)

ACL-003 서버 측 재검증에서 "센터 소속 = 무권한이라도 전체 접근 가능"이 실제 보안 결함으로
확인된 뒤, `add_rls_gap_tables_draft_proposed.sql`의 17개 테이블 정책 중 `my_managed_center_ids()`만으로
**쓰기**를 허용하던 6곳(class_types/lockers/locker_assignments/popup_notices의 쓰기,
notification_logs/change_logs의 조회)을 더 구체적인 `has_permission()` 권한 키로 좁혔습니다.
단일 파일을 4개 독립 배치(`proposed_rls_gap_batch_a/b/c/d.sql` + 짝 `rollback_rls_gap_batch_*.sql`)로
나눠, 배치별로 독립 적용·검증·rollback할 수 있게 했습니다. `staff_schedules`/`schedule_memos`의
조회는 낮은 민감도의 캘린더 조율 정보라는 이유로 센터 전체 조회를 의도적으로 유지했고, 이를
"정당화된 예외"로 문서에 명시했습니다. 17개 테이블 재분류표와 역할×테이블 접근 매트릭스(7번째
열 "타 센터 owner/staff" 추가 — 전부 차단됨을 명시)를 `docs/21_RLS_Gap_Analysis.md`에 반영했습니다.
Fixture 계획도 갱신: TEST-002에서 검증된 "TEST_MANAGER_A/B 두 계정만으로 오너+무권한 스태프
페르소나 생성" 패턴을 재사용해, platform admin 테스트 계정 1개를 제외하면 **새 GitHub Secrets가
전혀 필요 없습니다.** 이번 배치도 실제 SQL은 실행하지 않았습니다.

## 2026-08-01 — RLS 조사 및 설계 Batch (DB-001, SEC-007·008)

`docs/rls-gap-design` 브랜치(PR B)에서 진행. 조사·설계만 진행했고 운영 DB에는 아무것도
실행하지 않았습니다. 이 이슈들은 PR이 머지돼도 자동으로 닫히지 않습니다(Relates to만 연결) —
실제 정책 적용과 QA가 끝나기 전에는 Done으로 바뀌지 않습니다.

**DB-001 — `chat_messages` 조사**: app/lib 전체·모든 SQL 함수/트리거/뷰에서 참조 0건, RLS는
활성화돼 있으나 정책 0건(현재 완전 차단 상태). 1:1 채팅은 `inquiry_threads`/`inquiry_messages` +
RPC로 완전히 대체되어 있음을 확인. **결론: 정책 추가가 아니라 삭제 후보** — 이번 배치는 DROP을
실행하지 않았고, 사용자 승인 후 별도 배치에서 처리하도록 `docs/TODO.md` P3-9에 기록.

**SEC-007/SEC-008 — RLS 갭 분석 및 정책 설계**: `schema.sql` + 저장소의 모든 `*.sql`을 전수 매칭해
RLS가 없거나 정책이 0건인 테이블 18개를 찾았고, `chat_messages`(DB-001에서 별도 처리)를 제외한
17개(`change_logs`, `class_types`, `community_comments`, `competitions`, `contract_templates`,
`contracts`, `leads`, `locker_assignments`, `lockers`, `membership_transfers`, `messages`,
`notification_logs`, `popup_notices`, `schedule_memos`, `staff_salaries`, `staff_schedules`, `terms`)에
대해 목적/개인정보/tenant scope/현재 사용여부/예상 접근 역할/SELECT·INSERT·UPDATE·DELETE 정책초안/
기존 데이터 영향/회귀 가능성/테스트 시나리오/우선순위를 정리한 `docs/21_RLS_Gap_Analysis.md`를
작성했습니다. 17개 전부 app/lib 코드 참조 0건(미구현 기능)이라 지금 당장의 활성 위험은 아니지만,
Supabase는 anon key만으로 PostgREST를 통해 이 테이블에 직접 접근 가능하므로 "미사용 = 안전"이 아닌
잠재 위험으로 분류했습니다. `staff_salaries`(급여)와 `contracts`(서명 계약서)는 Critical로 표시.
정책 초안은 `add_rls_gap_tables_draft_proposed.sql`에 작성했으며 **이번 배치에서는 실행하지
않았습니다** — 실행은 별도 승인 후 후속 배치에서 진행합니다. RLS 통합 테스트 계획(6개 역할 ×
17개 테이블 CRUD 매트릭스 + fixture 요구사항)도 같은 문서에 설계만 해뒀고 실제 DB 테스트는
실행하지 않았습니다.

## 2026-08-01 (추가) — ACL-001~004 서버 측 권한 재검증 + PR 2개 분리

이전 Access Control + RLS Design Batch(바로 아래 항목)는 클라이언트 가드만 다뤘습니다. 이번
추가 작업은 "화면 가드만으로는 충분하지 않다"는 지적에 따라 실제 RLS/RPC를 전수 재검증했습니다.

- **ACL-001 (관리자 화면 쓰기 차단)**: **PASS**. `service_categories`/`home_banners`는 SELECT는
  공개(`true`, 홈 화면 노출용)지만 INSERT/UPDATE/DELETE는 `is_platform_admin()`으로 이미 막혀
  있어, 일반 회원이 쓰기 쿼리를 직접 호출해도 서버가 차단함을 확인.
- **ACL-002 (센터 미소속 사용자의 직접 접근)**: **PASS**. `inquiry_threads`/`inquiry_messages`는
  회원 본인(`member_account_id`) 또는 소속 센터(`my_managed_center_ids()`)로, `notifications`는
  `recipient_account_id = my_account_id()`로 이미 스코프되어 있어, 화면 가드 없이 RPC/REST를
  직접 호출해도 타인의 데이터는 보이지 않음을 확인. 매니저 화면 가드는 보조 방어선, RLS가 최종
  방어선이라는 원칙이 실제로 지켜지고 있었음.
- **ACL-003 (개인 권한 데이터 직접 접근)**: **FAIL**. `account_center_permissions`의 기존
  "개인권한 조회" SELECT 정책이 `manager_center_id in (select id from manager_centers where
  center_id in (select my_managed_center_ids()))`만 확인해, `facility.role_permission` 권한이
  없는 일반 스태프도 "같은 센터 소속"이기만 하면 다른 스태프의 개인 권한 예외(allow/deny)를
  Supabase SDK로 직접 조회할 수 있는 구조였음(화면 가드 `isOwnerOfCenter()`를 완전히 우회 가능).
  테이블/정책 주석에는 "오너만 조회 가능"이라고 적혀 있었지만 실제 SELECT 정책 구현에 그 권한
  체크가 빠져 있었던 것으로 확인됨. INSERT/UPDATE/DELETE 정책은 원래부터
  `has_permission(center_id,'facility.role_permission')`을 정확히 요구하고 있어 **쓰기는
  안전**했음(READ만 FAIL). 수정 SQL 초안을 `fix_account_center_permissions_select_draft_proposed.sql`에
  작성(본인 것 + facility.role_permission 보유자만 허용 — ACL-004의 `fetchMyEffectivePermissionKeys()`가
  본인 데이터를 읽어야 하므로 "본인 것" 허용은 반드시 유지). **이번에도 이 SQL은 실행하지
  않았음** — 실행 전 `tests/integration/acl-003-permission-read.test.ts`(신규, 현재는 실패해야
  정상 — 수정 SQL 적용 후에만 통과)를 통과시켜야 함. 정적 검토 테스트
  `tests/unit/acl003SqlFix.staticCheck.test.ts`로 SQL 파일 내용 자체를 회귀 검증함(둘 다 통과).
- **ACL-004 (메뉴 숨김이 실제 권한 제어의 전부가 아님)**: 메뉴에 대응하는 각 화면의 실제
  쓰기는 여전히 서버 RLS/RPC가 강제하며, 클라이언트 메뉴 숨김은 UX 보조 수단일 뿐임을 재확인.
  `effectiveState()`가 `has_permission()` SQL과 동일한 우선순위(개인 deny > 개인 allow > 역할)를
  따름을 role×override 2×3 전체 조합으로 단위 테스트 보강(신규 3건). center 전환 시
  `app/manager/page.tsx`의 `useEffect`가 새 fetch 시작 전에 `setMyPerms(null)`을 동기적으로
  호출해 이전 센터의 권한 캐시가 새 센터에 노출되지 않음, 권한 로딩 중에는 `canSeeManagerMenu()`가
  `myPerms === null`을 false로 처리해 메뉴가 순간적으로 전부 노출되지 않음을 코드 검토로 확인
  (이 저장소에 `@testing-library/react`가 없어 React effect 순서 자체를 렌더 테스트로 검증할 수는
  없음 — 로직은 순수 함수로 분리해 단위 테스트했고, effect 배선 자체는 코드 리뷰로 확인).

**PR 분리**: 위 결과에 따라 앱 코드(ACL-001~004 + 이번 수정)와 RLS 조사/설계 문서(DB-001,
SEC-007/008)를 별도 브랜치·PR로 분리함 — `feature/access-control-guards`(PR A),
`docs/rls-gap-design`(PR B). 상세는 아래 두 PR의 실제 커밋/링크 참고.

## 2026-08-01 — Access Control 구현 Batch (ACL-001~004)

`feature/access-control-guards` 브랜치(PR A)에서 진행. `feature/access-control-rls-design`
worktree(`booking-app-access-control`)에서 원래 함께 조사했던 6개 이슈(ACL-001~004,
DB-001, SEC-007/008) 중 실제 코드 구현이 필요한 4건만 이 PR에 포함하고, DB 조사·RLS 설계
2건은 별도 PR B(`docs/rls-gap-design`)로 분리했습니다 — 상세 사유는 바로 위 "ACL-001~004
서버 측 권한 재검증 + PR 2개 분리" 항목 참고.

**ACL-001 — 관리자 화면 가드 누락**: `app/admin/categories/page.tsx`, `app/admin/banners/page.tsx`에
`/admin/centers`와 동일한 `checkPlatformAdmin()` 가드를 추가(`isAdmin` 3상태: null=확인중/false=차단/true=허용).

**ACL-002 — 매니저 화면 센터 미보유 가드 누락**: `app/manager/inquiries/page.tsx`,
`app/manager/notifications/page.tsx`에 `fetchMyCenters()` + "운영 중인 센터가 없어요" 가드를 추가
(기존 9개 화면과 동일한 패턴). 두 화면 모두 기존에는 `fetchMyCenters()`를 아예 호출하지 않았음.

**ACL-003 — 개인 권한 설정 화면 오너십 미검증**: `app/manager/staff/page.tsx`의 스태프 상세 링크에
`&center=${centerId}`를 추가하고, `app/manager/staff/permissions/page.tsx`가 그 값을 읽어
`fetchMyCenters()` 결과로 "요청자가 그 센터의 오너인지"를 확인(`lib/manager.ts`의 신규
`isOwnerOfCenter()`)한 뒤에만 실제 권한 데이터를 불러오도록 수정. 기존에는 `mc`/`role` 파라미터만
있으면(형식만 맞으면) 소속 센터·오너 여부와 무관하게 접근 가능했음.

**ACL-004 — 매니저 홈 메뉴 권한 미반영**: `lib/manager.ts`의 `ManagedCenter`에 `managerCenterId`/
`roleId`를 추가하고, `lib/roles.ts`에 서버 SQL 함수 `has_permission()`과 동일한 우선순위
(오너 전권 → 개인 deny → 개인 allow → 역할)로 "내 유효 권한 키 집합"을 계산하는
`fetchMyEffectivePermissionKeys()`와, 메뉴 한 항목의 노출 여부를 판정하는 순수 함수
`canSeeManagerMenu()`를 추가. `app/manager/page.tsx`의 13개 메뉴 중 권한 카탈로그(`permissions`
테이블)에 대응 키가 있는 9개(수강권관리→`pass.create`, 회원진도기록→`customer.progress`,
스태프&권한→`facility.staff.view`, 매출관리→`pass.sales.view`, 공지사항→`board.notice.view`,
1:1문의→`board.inquiry.view`, 센터정보→`facility.info`, 룸관리→`facility.room`,
운영설정→`facility.operation`)를 이 함수들로 노출 제어. 나머지 4개(상품관리/후기관리/주문관리/
관리자배치내역)는 카탈로그에 대응 permission key가 없어 1차 범위에서 제외(새 key 추가는 스키마
변경이라 별도 승인 필요 — `docs/TODO.md` P2-11 참고). `ManagerNav`의 고정 탭 4개는 이번 범위 밖.

**테스트**: 새 로직(`checkPlatformAdmin`/`isOwnerOfCenter`/`fetchMyCenters`/
`fetchMyEffectivePermissionKeys`/`canSeeManagerMenu`/`effectiveState` 우선순위 일관성)을 검증하는
단위 테스트 22건 + 서버 측 재검증에서 보강한 회귀 테스트 7건(role×override 2×3 전체 조합 3건,
ACL-003 SQL 수정 초안 정적 검토 4건) = 총 29건. React 컴포넌트 렌더링 테스트는 이 저장소에
`@testing-library/react`가 없어(기존 테스트 전부 로직 단위 테스트) 이번에도 페이지를 직접
렌더링하지 않고, 가드가 의존하는 로직을 lib 함수로 분리해 단위 테스트했습니다.

## 2026-07-30 (추가) — 관리자 직접배치 통합 테스트 성공 경로 보강

이전 커밋의 `admin-assignment-security.test.ts`는 매니저 fixture가 없어 권한 차단·입력 검증만
다뤘습니다. 이번 추가 작업으로 서비스 역할 키 없이 테스트가 스스로 매니저/센터 fixture를 만들도록
`tests/integration/setup.ts`에 `getOrCreateOwnedTestCenter()`/`createFutureTestClass()`/
`createTestMembership()`/`cleanupTestClass()`를 추가했습니다(앱의 실제 매니저 가입 RLS 정책만
사용 — `centers`/`manager_centers` insert가 로그인 사용자면 허용되는 기존 정책을 그대로 활용).

- 신규 환경변수 `TEST_MANAGER_A_EMAIL`/`PASSWORD`, `TEST_MANAGER_B_EMAIL`/`PASSWORD` 추가
  (get-or-create, `tests/README.md`·`.env.test.local.example`·`.github/workflows/test.yml`에 반영).
- ADMIN_ASSIGNMENT/ADMIN_FREE 정상 생성, 이용권 없음/만료 회원 성공, 취소 시 수강권 복구/미변화,
  `admin_action_logs`·회원 알림 생성, 동시 요청 단일 생성, 다른 센터 관리자 차단 — 10개 성공 경로
  테스트 추가.
- 테스트 작성 중 실제 버그 발견 및 수정: `add_admin_assignment.sql`의 알림 트리거가 회원 알림
  `data` metadata에 `reservation_type`(ADMIN_ASSIGNMENT/ADMIN_FREE)을 그대로 담고 있어, 회원이
  자신의 알림 원본 데이터를 조회하면 무료 추가 배치 여부를 알 수 있는 정보 노출이 있었음
  (§16 정책 위반). `reservation_id`/`class_id`/`action`만 남기도록 수정하고, 회귀 테스트로 고정.
- 정원 초과 확인(`needs_capacity_confirm` → `p_force_capacity`) 2단계 흐름 자체는 이번에도
  자동화하지 못함 — `docs/TODO.md` P1-11에 남은 범위로 재기록.

## 2026-07-30 — 예약 UX 개선 + 관리자 직접배치/무료 추가 배치 (`feature/p1-reservation-ux`)

### 왜 바꿨는가

관리자가 미배치 요일반 수강권을 "다시배치"(자동 재시도)만 할 수 있고, 날짜·수업을 직접 골라
회원을 배치하거나 수강권 없이 무료로 추가 예약을 넣어줄 방법이 없었습니다. 또한 예약 화면에
구매용 상품(goods)이 "사용 가능한 수강권" 목록에 잘못 섞여 보이는 버그, 구매 완료 문구의 어색한
표현, 예약 화면의 중복 계정 조회 등 성능 이슈가 있었습니다.

### 무엇을 바꿨는가

- **예약 타입/출처 구조화**: `reservations.reservation_type`(MEMBER/ADMIN_ASSIGNMENT/ADMIN_FREE),
  `reservation_source`(USER/ADMIN/SYSTEM), `admin_reason_code`/`admin_reason_detail`,
  `is_capacity_override`, `membership_consumed`, `cancelled_by`/`cancel_reason`/`cancelled_at`,
  `created_by_account_id`, `updated_at` 컬럼 추가 (`add_admin_assignment.sql`, text+CHECK 방식 —
  기존 `status`/`pass_type`/`product_kind` 등 다른 모든 상태 컬럼과 동일한 관례).
- **관리자 직접배치/무료 추가 배치 RPC 신설**: `admin_assign_reservation`(일반 직접배치는 수강권
  종류·예약 가능 시간 제한 무시하고 기존 수강권/미배치건 차감, 무료 추가배치는 차감 없음),
  `admin_cancel_reservation`(타입별 정확한 복구 + 중복 취소 방지). 권한 검사는 기존
  `manager_book_member`와 동일한 "센터 활성 매니저 OR 플랫폼 운영자" 정책을 `can_manage_center_reservations()`
  헬퍼로 분리해 재사용 — 향후 세부 permission key 확장 지점으로 남겨둠. 회원 자격 검사도
  `is_profile_assignable()`로 분리(현재는 기존 셀프예약과 동일하게 프로필 존재 여부만 확인).
- **관리자 예약 작업 로그**: `admin_action_logs` 테이블 신설(append-only, 일반 매니저 UI에서
  수정·삭제 불가 — update/delete RLS 정책을 아예 만들지 않음).
- **기존 함수 확장(회귀 없음)**: `reserve_class`/`reserve_with_membership`/`manager_book_member`/
  `cancel_reservation`/`manager_set_attendance`는 반환값과 기존 로직을 그대로 두고 새 컬럼만 채우도록
  `create or replace`. `manager_book_member`(기존 "보강예약")는 수강권+차감 여부에 따라
  ADMIN_ASSIGNMENT/ADMIN_FREE로 자동 태깅.
- **알림 트리거 확장**: `trg_notify_reservation_insert`/`_update`가 `reservation_type`에 따라
  분기 — 관리자 배치/취소는 회원에게 "관리자가 예약을 등록/취소했습니다"만 안내(무료 여부·사유·
  관리자명·정원초과 등 내부 정보 비공개), 다른 매니저에게는 알리지 않음(소음 방지).
- **버그 수정** (`fix_usable_memberships_product_kind.sql`): `usable_memberships()`/
  `usable_memberships_for_classes()`가 `products.product_kind`를 확인하지 않아 구매용 상품(goods)이
  "사용 가능한 수강권" 목록과 예약 확인 팝업에 섞여 보이던 문제 수정. `remaining_count` NULL(기간권)
  처리도 함께 바로잡음.
- **구매 완료 문구 수정**: 기본 "상품 구매가 완료되었습니다.", 실제 이용 가능한 수강권이 즉시
  발급된 경우에만 "상품 구매가 완료되었으며 이용 가능한 수강권이 등록되었습니다." (`app/checkout/page.tsx`,
  `app/reservation/page.tsx`).
- **예약 화면 성능 개선** (`app/reservation/page.tsx`, `lib/reservations.ts`): `fetchMonthData`/
  `fetchMyProfiles`가 각각 중복으로 `auth.getUser()`+`accounts` 조회를 하던 것을 `getMyAccountId()`
  한 번 조회 후 `Promise.all`로 병렬화. `dayClasses`/`categoryCenterIds`를 `useMemo`로 감싸 매
  렌더링마다 새 배열·Set을 만들지 않게 함(특히 `categoryCenterIds`는 `dayClasses`의 `useMemo` 의존성으로
  쓰이므로, 메모이제이션하지 않으면 dayClasses 메모도 매번 무효화되는 연쇄 문제가 있었음). 수강권 이름
  Set을 매 행마다 새로 만들던 `usableProductNames`를 `usablePassesByClass` 변경 시 한 번만 계산하는
  `Map`으로 변경. `doReserve`/`handleCancel`에 재진입 방지 가드 추가. 로딩 텍스트에 은은한 shimmer
  애니메이션 추가.
- **관리자 UI** (`app/manager/classes/page.tsx`): "미배치 수강권" 시트의 각 행에 "직접배치" 버튼 추가,
  신규 "회원 직접배치" 진입 버튼으로 회원 검색 후 기존 캘린더 위에서 날짜·수업을 고르는 방식 지원,
  배치 방식(일반 직접배치/무료 추가 배치) 확인 팝업 + 사유 선택 + 정원 초과 추가 확인, 예약자 명단에
  관리자 배치 배지와 "관리자 배치 취소" 액션 추가.
- **관리자 배치 내역 조회 화면 신설**: `app/manager/admin-assignments/page.tsx` (기간/회원·관리자·수업
  검색/타입/작업/사유/정원초과 필터 — 통계·엑셀 다운로드는 이번 범위 제외).
- **회원 화면**: `app/my-reservations/page.tsx`에 관리자 배치 예약 배지 표시(ADMIN_ASSIGNMENT/ADMIN_FREE
  구분 없이 "관리자 배치 예약"으로만 노출).

### 알려진 제한 (docs/TODO.md에 항목으로 기록)

- 세부 permission key(`schedule.admin_assign` 등)와 회원 상태(이용정지/탈퇴/휴면) 차단 정책은 이번
  범위에서 결정하지 않고 확장 지점만 마련함 (사용자 확인 결과).
- 통합 테스트는 매니저/오너 테스트 계정 fixture가 없어 권한 차단·입력 검증 경로만 검증했고, 실제
  배치 성공·정원초과·취소 복구 경로는 수동 테스트로 확인함.

## 2026-07-28 — 프로젝트 문서 리팩터링 (커밋 전)

### 변경 성격

이번 작업은 **기능 변경이 아닌 문서 전용 리팩터링**입니다.

- `app/`, `lib/`, 루트 SQL, package·환경·배포 설정을 수정하지 않았습니다.
- 앱 기능, 라우트, 테이블, RPC, RLS 또는 trigger를 새로 구현하지 않았습니다.
- SQL migration을 생성하거나 Supabase에 적용하지 않았습니다.
- Git commit·push와 Vercel 배포를 수행하지 않았습니다.
- 문서의 기능 상태는 현재 코드와 SQL을 직접 확인해 재분류했으며, 운영 환경에서 확인할 수 없는 내용은 `확인 필요` 또는 `운영 설정 필요`로 유지했습니다.

### 변경 문서

| 문서 | 구조 개선 내용 |
|---|---|
| `docs/REQUIREMENTS.md` | 문서 역할과 판정 기준, 프로젝트 목표, 개발 상태, 사용자별 기능, 비즈니스·UX 요구사항, 로드맵과 AI 갱신 규칙으로 재구성. `구현됨`·`미완성`·`확인 필요`·`운영 설정 필요` 상태를 분리 |
| `docs/DATABASE.md` | `app/`·`lib/`가 직접 참조하는 테이블 36개를 검증하고 연결 상태를 구분. 향후 기능 후보 23개와 용도·존속 여부 확인이 필요한 미사용 테이블 5개를 분리하고 보호 테이블, 핵심 RPC·RLS·trigger와 SQL 적용 상태를 정리 |
| `docs/ROUTES.md` | 실제 `app/**/page.tsx` 41개를 기준으로 사용자 유형, 기능, 데이터 의존성, 권한 처리와 미완성 상태를 라우트별로 정리 |
| `docs/AI_PLAYBOOK.md` | ChatGPT, Claude Code/Codex, NotebookLM, Graphify, GitHub, Vercel의 책임·금지 작업·필수 인계 정보를 명확히 하고 기능·버그·DB 작업 절차를 재구성 |
| `docs/WORKFLOW.md` | `NotebookLM → ChatGPT → Claude Code/Codex → 로컬 테스트 → GitHub → Vercel → Graphify·문서 갱신` 표준 흐름과 단계별 입력물·작업·결과물·검수 기준을 정의 |
| `docs/DEVELOPMENT_RULES.md` | 현재 Next.js·TypeScript·Supabase 구조에 맞춰 SQL migration, 환경변수, 권한, 데이터 무결성, UI 상태, 로컬 검증, Git과 문서 갱신 규칙을 구체화 |
| `docs/TODO.md` | REQUIREMENTS와 DATABASE 및 기존 문서의 미완성·확인 필요·운영 설정 필요 항목을 P0~P3의 30개 작업으로 통합하고 각 항목에 근거와 완료 조건을 추가 |
| `docs/CHANGELOG.md` | 이번 문서 리팩터링의 범위와 비기능 변경 사실을 기록 |

### 검증과 정정

- 실제 라우트 41개와 ROUTES의 41개 항목이 일치하는지 확인했습니다.
- `app/`·`lib/`의 직접 참조를 기준으로 현재 사용 테이블과 코드 미사용 테이블을 다시 분류했습니다.
- 기존 문서의 “코드 미사용 테이블 27개”를 실제 목록 수인 28개로 정정했습니다.
- 요일반 자동예약 재시도는 `app/manager/classes/page.tsx`에 “다시 배치” UI가 존재하므로 구현된 기능으로 정정했습니다.
- SQL 파일 67개와 앱이 호출하는 핵심 RPC를 대조했으며, 여러 migration에서 재정의되는 함수와 운영 DB 적용 상태는 완료로 단정하지 않았습니다.
- 문서 간 상세 중복을 줄이고 REQUIREMENTS, DATABASE, ROUTES, TODO, 절차 문서가 각자의 책임을 갖도록 상호 링크를 정리했습니다.

## Git 커밋 이력 (실제 날짜 확인됨)

| 날짜 | 커밋 | 내용 |
|---|---|---|
| 2026-07-30 | (커밋 전, `feature/p0-test-payment`) | **fix(ci): GitHub Actions Node.js 20 → 22** — `PaymentProviderFactory.test.ts`가 CI에서만 실패(로컬 Node 24는 통과). 원인: `@supabase/supabase-js`(realtime-js)가 클라이언트 생성 시 native `WebSocket` 전역을 요구하는데 Node 20엔 없음 — 이 테스트는 mock 없이 `lib/supabaseClient.ts`까지 실제로 import하는 체인이라 import 단계에서 바로 실패함. `.github/workflows/test.yml`의 `node-version`을 22로, `package.json`에 `engines.node: ">=22"`, `.nvmrc` 신규 추가. 근본 원인(단위 테스트가 Supabase 클라이언트 초기화에 우연히 의존하는 구조)은 아직 안 고침 — `docs/TODO.md` P2-9에 기록 |
| 2026-07-30 | `64d3d67` | **P0-1 결제 시스템 자동 테스트 환경 구축** — Vitest 신규 도입(`vitest`/`dotenv` devDependency 추가). `npm run test`(단위, Supabase 불필요, `tests/unit/`)와 `npm run test:integration`(실제 개발용 Supabase에 실제 RPC 호출, `tests/integration/`), `npm run test:all` 3개 스크립트 신설. 단위 테스트는 `mockPaymentApi`를 mock해 `MockPaymentProvider`의 success/failed/cancelled 분기와 `PaymentProviderFactory`의 provider 선택 로직만 검증(12개, 항상 통과 가능). 통합 테스트는 실제 계정 2개(A/B, get-or-create 방식 — 없으면 자동 가입 후 `accounts`/`profiles` 생성, 있으면 재사용)로 로그인해 성공/취소 결제, 순차·동시(`Promise.all`) idempotency, RLS(본인 소유·mock 전용 가드), 존재하지 않는 주문 등 실제 DB 상태까지 검증. `.env.test.local.example` 템플릿 신설(`.gitignore`에 `.env*` 예외 추가로 커밋 대상 포함). `.github/workflows/test.yml` 신설 — 매 push/PR에 단위 테스트, 같은 저장소 브랜치 간 PR·push·수동실행에 통합 테스트(fork PR은 Secrets 미주입으로 제외). UI/UX 테스트는 자동화 범위에서 제외(사용자가 직접 수행) |
| 2026-07-30 | `c3bb9f2` | **P0-1 테스트 결제 환경 구축** — Payment Adapter Pattern(`Checkout → PaymentService → PaymentProviderFactory → PaymentProvider interface → {Mock\|Toss\|PortOne}`) 신설. `lib/payments/`(신규 7개 파일): `types.ts`(인터페이스+DTO), `MockPaymentProvider.ts`(success/failed/cancelled 3개 시나리오 실동작, `NEXT_PUBLIC_PAYMENT_SCENARIO` 또는 checkout `?mockScenario=` 쿼리로 선택), `TossPaymentProvider.ts`/`PortOnePaymentProvider.ts`(구조만), `PaymentProviderFactory.ts`(`NEXT_PUBLIC_PAYMENT_PROVIDER`로 전환), `PaymentService.ts`, `index.ts`. `add_payment_test_provider.sql` 신규 — 회원 본인 전용 `confirm_test_payment`/`cancel_test_payment` RPC 2개(`orders.payment_provider` 컬럼 1개 추가, `schema.sql`은 무수정). **`fulfill_order`(add_order_fulfillment.sql)는 절대 수정하지 않고 로직 중복을 의도적으로 허용** — 매니저 전용 권한 모델과 회원 본인 확정 모델이 근본적으로 다르기 때문(사유·공통화 방안·향후 계획은 `docs/TODO.md` P0-1 참고). `app/checkout/page.tsx`의 `handlePay()`만 수정(라우트/기존 UI 요소 불변) — Mock 결제 성공 시 실제로 수강권이 즉시 발급되도록 연결. `app/reservation/page.tsx`는 무수정(기존 "즉시 가능/발급 대기" 토스트 분기 로직이 실제 DB 상태를 재조회해 판단하도록 이미 설계돼 있어, Mock 성공 시 자동으로 "바로 예약 가능" 문구가 나옴). `lib/orders.ts`는 `createOrder()`에 선택적 `provider` 필드 1개만 추가(하위 호환, `app/cart/page.tsx` 등 기존 호출부 영향 없음) |
| 2026-07-28 | `e412cd9` | `fix_usable_memberships_shared.sql` 추가: 수강권 조회·예약 RPC를 계정 공유 기준으로 통일하고 `usable_memberships_for_classes()` 배치 RPC 정의. 운영 Supabase 적용 여부는 저장소만으로 확인할 수 없음. 관련 프로젝트 개요 문서 보강 |
| 2026-07-28 | `40f22b6` | 예약 → 수강권 구매 → 주문 접수 → 예약 화면 복귀 UX 개선. 구매 가능한 상품 배치 조회, 수강권·굿즈 조회 경합 방지, 기본 수강권 선택, 센터·checkout 복귀 URL 유지, 주문 후 발급 상태 안내를 포함. 실제 PG와 즉시 수강권 발급을 추가한 변경은 아님 |
| 2026-07-28 | `345d5e0` | AI 작업 규칙과 도구 협업 문서 추가 (`CLAUDE.md`, `AI_PLAYBOOK.md`, `WORKFLOW.md`) |
| 2026-07-28 | `f6058e7` | REQUIREMENTS, DATABASE, ROUTES, TODO, DEVELOPMENT_RULES, CHANGELOG 초기 문서 추가 |
| 2026-07-27 | `155fda1` | Fix sales product type error — `app/manager/sales/page.tsx`의 state 타입에 `kind`/`unlimited` 필드 누락으로 인한 빌드 실패 수정, `my-reservations` 페이지의 존재하지 않는 status 비교 제거, `useSearchParams()` 5개 페이지에 `Suspense` 경계 추가(Next.js 16 프리렌더 요구사항) |
| 2026-07-27 | `d5493d3` | Add package lock file |
| 2026-07-26 | `abd3b96` | Initial commit — 아래 "커밋 이전 기능 롤아웃"에 정리된 기능이 모두 포함된 최초 스냅샷 |

## 커밋 이전 기능 롤아웃 (SQL/체크리스트 근거, 상대적 순서)

`TEST_CHECKLIST*.md`에 남은 세션별 안내와 `schema.sql`/`add_*.sql`/`fix_*.sql` 파일명을 근거로 재구성한
개발 진행 순서입니다(정확한 날짜는 알 수 없음, 오래된 것부터).

### 1단계 — 기반 스키마
- 3계층 계정 구조 설계: `accounts`(로그인) → `profiles`(회원 프로필) / `manager_centers`(운영 소속)
- 센터, 수업(`classes`), 수강권(`memberships`), 예약(`reservations`), 결제(`payments`) 등 핵심 테이블 (`schema.sql`)
- 예약 처리 함수 및 관련 RLS 96개 정책 (`reservation_functions.sql`)
- 회원가입 RLS 오픈 (`auth_policies.sql`)

### 2단계 — 운영 기능 확장
- 룸/수업구분/운영설정(17항목) 도입, 결제수단 지정, 당일예약 설정
- 상품 체계 개편(수강권/굿즈 분리), 수업별 예약가능 수강권 제한
- 스태프 & 권한 관리(역할, 권한 카탈로그, 개인별 권한 예외) 도입
- 회원관리(등급/상태/메모/주소), 진도표(1단계 기술목록 → 2단계 기록)
  - `lockers`/`locker_assignments`(락커)는 `schema.sql`의 최초 설계에 테이블만 포함되었고, 재검증 결과 실제 화면/코드는 없는 것으로 확인됐습니다([DATABASE 5절](./DATABASE.md#5-향후-기능-후보-테이블)) — "커밋 이전 롤아웃"이 아니라 "설계됐지만 만들어지지 않은 기능"입니다
- 반복수업 그룹, 스케줄 복사(요일 기준/날짜 기준, 달력 미리보기) — `TEST_CHECKLIST_4.md` "A. 스케줄 복사" 항목

### 3단계 — 커머스/커뮤니케이션 확장
- 매출 관리(분할결제, 지출, 매출구분), 포인트 적립/사용
- 주문(`orders`)/장바구니/구매내역/환불 플로우 (실제 PG 미연동 — 매니저 수기 확인)
- 요일반 수강권 자동예약(`add_auto_booking.sql`) 및 하루 1회 제한 보정(`fix_auto_book_oneperday.sql`)
- 프로필 간 수강권 공유(`add_shared_passes.sql`) — `TEST_CHECKLIST_4.md` "B. 프로필 간 수강권 공유 ★신규"
- 미배치 수강권 관리 + 주문 발급 자동화(`add_unplaced_passes.sql`, `add_order_fulfillment.sql`)
- 후기(별점/사진) + 후기 기반 포인트, 센터 답변 (`add_reviews_points.sql`, `add_review_reply.sql`)
- 후기 테이블 명칭 충돌 긴급 수정(`fix_center_reviews.sql`)
- 공지사항(서식+사진), 1:1 문의 채팅, 알림 시스템(실시간 팝업 + 알림함), 예약/취소 관련 알림 트리거
- 플랫폼 운영자(센터 승인) 기능 도입 (`add_platform_admin.sql`)

### 반복적으로 발생한 RLS 버그 수정 (운영 중 발견)
다음은 실제 사용 중 발견되어 별도 `fix_*.sql`로 패치된 회귀 버그들입니다. 향후 관련 테이블 작업 시 참고:
- 프로필 조회 불가("프로필을 찾을 수 없어요") — `fix_profile_rls_restore.sql`, `fix_missing_primary_profile.sql`
- RLS `with check` 누락으로 쓰기 정책이 의도대로 동작하지 않음 — `fix_rls_policies.sql`
- 수강권 발급/회원 추가 시 RLS 차단 — `fix_membership_rls.sql`
- 스태프 검색 시 `accounts` 조회 정책 무한 재귀 — `fix_staff_search.sql`
- 예약자 명단 미노출 — `add_roster_rls.sql`
- 대기자 자동 승격 오류(v2 패치) — `fix_waitlist.sql`
- 수업 삭제 시 취소 예약 처리/오너 권한 문제 — `fix_class_delete.sql`
- 회원 만료/휴면 처리 권한 — `fix_member_status.sql`

## 참고
- 위 "커밋 이전" 항목은 상대적 순서 추정치이며, 정확한 완료일이 필요하면 SQL을 실제로 Supabase에 적용한 시점을 팀 내에서 별도로 기록해야 합니다.
- 앞으로는 [DEVELOPMENT_RULES.md](./DEVELOPMENT_RULES.md)의 "기능별 작은 커밋" 규칙에 따라 Git 커밋 로그 자체가 신뢰할 수 있는 변경 이력이 되도록 합니다.
