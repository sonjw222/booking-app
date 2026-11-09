# 릴리스 SQL 점검 (2026-11-09) — 실행하지 않음, 읽기 전용 점검만 안내

Claude 는 운영 DB 에 접근하지 않았고 SQL 을 실행하지 않았다. 운영 적용 여부는 아래 **읽기 전용** 파일 `audit_release_sql_status_readonly_20261109.sql` 을 SQL Editor 에서 실행해 확인한다. 저장소 기록상(`docs/TODO.md` P0, `docs/payments/NICEPAY_REVIEW_PATH_20261106.md`) #265 의 운영 SQL 2개는 **승인 대기(미적용)** 이다.
코드(앱) 배포는 SQL 적용 전에도 안전하다 — 허용 테이블이 없으면 기존 심사 센터 동작 그대로(`reviewWindowRuntime.readTarget` 폴백).

## 이번 릴리스 후보가 새로 요구하는 SQL: 없음 (NO)
UX 변경(구매 시트·수강권 이름 병합·뒤로가기·결제창 복귀)과 #264 네이티브 변경은 DB 변경이 없다. 아래는 (A) 기존 #265 SQL 의 승인 대기 목록, (B) 별도 작업으로 분리한 서버 사이즈 검증 제안이다.

## (A) #265 에 포함된 SQL (운영 미적용 추정, 순서·절차는 NICEPAY_REVIEW_PATH_20261106.md)
| 순서 | 파일 | 효과 | 기존 데이터 영향 | 롤백 | 확인 |
|---|---|---|---|---|---|
| 0 | `audit_nicepay_review_path_readonly_20261106.sql`, `audit_nicepay_real_center_products_readonly_20261103.sql`, `audit_release_sql_status_readonly_20261109.sql` | SELECT 만 — 현재 상태 확인 | 없음 | 해당 없음 | 결과 확인 |
| 1 | `add_nicepay_review_real_center_grants_20261103.sql` | 새 테이블 `nicepay_review_center_grants`(RLS on, 정책 0) + 함수 정의 교체/신규(`nicepay_review_center_allowed`·`_member_allowed`·`_purchase_allowed`·`nicepay_review_guard_center`·`nicepay_my_review_center_ids`). 사전 MD5 preflight 가 어긋나면 중단 | 기존 센터·상품·주문·수강권·예약 읽기/수정/삭제 없음. 허용 행이 없으면 심사관 가시성은 기존과 동일 | `rollback_add_nicepay_review_real_center_grants_20261103.sql`(함수를 P2 정의로 복원·새 객체 삭제) | `verify_add_nicepay_review_real_center_grants_20261103.sql` |
| 2 | `grant_nicepay_review_real_center_20261106_proposed.sql` | `nicepay_review_center_grants` 에 정확히 1행(niceqa ↔ A10TION, can_purchase=false). 선행: 센터 운영자 동의 + 1번 verify + audit | 그 1행만 추가. 주문·결제는 열리지 않음(조회 + 승인 없는 인증창 확인) | `rollback_grant_nicepay_review_real_center_20261106.sql`(그 1행만 삭제) | 심사 계정 로그인 후 홈에 A10TION 표시, `select count(*) from nicepay_review_center_grants` = 1 |

## (B) 별도 SQL 작업(제안, 미실행): 주문 selected_size 서버 검증
- 문제: `selected_count`·금액은 `orders_snapshot_product_amount` 트리거가 서버에서 검증하지만 `selected_size` 는 검증이 없다(조작된 클라이언트가 우회 가능). 앱 쪽(`lib/orderOptions.ts`)은 이미 막는다.
- 해결: BEFORE INSERT 트리거 `orders_validate_selected_size`(클라이언트 세션만, `auth.uid()` 있을 때) — 사이즈 있는 상품은 목록 중 하나 필수, 없는 상품은 NULL. 새 함수·트리거만, 기존 데이터 불변.
- 파일: `add_orders_selected_size_validation_20261109_proposed.sql` / `rollback_…_proposed.sql` / `verify_…_proposed.sql`. PGlite 테스트 `tests/unit/ordersSelectedSizeValidation.pglite.test.ts`(5건)로 동작 확인.
- 적용 전: 파일 하단 "사전 점검 쿼리"로 최근 90일 어긋난 주문 건수 확인 → 서버 경로(RPC)가 사이즈 없이 주문을 만드는지 확인 후 격리 DB 에서 먼저 실행.

### (B) 격리 DB 실검증 (로컬 Supabase, 트랜잭션 후 ROLLBACK — 데이터 잔여 0)
제안 SQL 적용 후 `auth.uid()` 를 모사한 클라이언트 세션으로 INSERT: 사이즈 패키지 M/4회 → 성공 · 사이즈 없음 → `사이즈를 선택해주세요` · XXL → `선택할 수 없는 사이즈예요(XXL)` · 사이즈 없는 상품+사이즈 → `이 상품은 사이즈를 선택할 수 없어요` · 사이즈 없는 상품 정상 → 성공 · 대여 슈즈 245 → 성공. 적용 상태에서 격리 브라우저 QA 4종(61 PASS·1 BLOCKED)·심사경로 27/27 도 그대로 통과(`docs/qa/ux-final-20261109/`).

## SQL 전문

### (A) #265

#### `add_nicepay_review_real_center_grants_20261103.sql`
```sql
-- ============================================================
-- NICEPAY 심사관에게 "지정한 실제 센터"의 상품을 보여 주는 최소 권한 구조 (2026-11-03) — 검토용 초안.
-- 운영/공유 DEV 미실행. 로컬 격리 Supabase 에서만 실행·검증했다. 실행은 사용자가 전문과 영향을 검토·승인한 뒤 SQL Editor 에서만.
--
-- 배경: add_nicepay_review_center_isolation_20261028.sql(P2) 때문에 NICEPAY 심사관(accounts.nicepay_review_access)은 is_nicepay_review 센터만 보고 구매할 수 있다.
--       카드사 심사에서 실제 판매 중인 센터(예: A10TION 피겨팀)의 실제 수강권을 확인시켜야 해서, "심사관 계정 ↔ 실제 센터"를 명시적으로 연결하는 허용 목록을 둔다.
--
-- 하는 일(모두 새 객체 + 함수 4개 정의 교체. 기존 센터·상품·주문·수강권·예약·정산 데이터는 읽기/수정/삭제하지 않는다):
--   1) nicepay_review_center_grants (account_id, center_id, can_purchase) — 심사관 계정별 허용 센터. 클라이언트 접근 정책 없음(RLS 켬, 정책 0개): SQL Editor/서버(service_role)로만 기록.
--      can_purchase 기본 false = "조회만" 허용(상품·가격·이용조건·환불 안내 확인). 주문·장바구니·구매신청·예약·수강권 발급은 can_purchase=true 로 별도 지정해야 한다.
--   2) nicepay_review_center_allowed       — 읽기 가시성: 심사관은 (심사 센터 + 허용 목록 센터)만 보이고 그 밖의 운영 센터는 기존처럼 숨김. 비심사관·매니저·관리자 규칙은 불변.
--   3) nicepay_review_center_member_allowed — 목록 RPC(fetch_public_storefront_products·fetch_purchasable_products·기간 RPC)가 쓰는 판정: 같은 기준. (RPC 정의는 건드리지 않는다.)
--   4) nicepay_review_center_purchase_allowed(신규) + nicepay_review_guard_center(교체) — 쓰기 가드(orders·memberships·cart_items·purchase_requests·reservations): 심사관은 (심사 센터 + can_purchase=true 센터)만.
--   5) nicepay_my_review_center_ids()(신규) — 앱의 탐색 화면이 "내 허용 센터 id" 를 중앙(DB)에서 읽는 RPC. 센터 UUID 를 코드에 넣지 않는다.
--
-- 바뀌지 않는 것:
--   · 카드 결제 게이트(nicepay_order_is_review_target — is_nicepay_review 센터의 주문만 NICEPAY 심사관 결제 허용)는 그대로 → 허용 목록 센터에서는 can_purchase=true 여도 NICEPAY 카드 결제는 열리지 않는다(결제 활성화 아님).
--   · 일반 회원/비회원/매니저/플랫폼 관리자/토스 심사관의 가시성과 구매 규칙, 기존 심사 센터 규칙, is_internal 규칙.
--   · 만료 상품 숨김(fix_expired_fixed_date_products_20261031.sql)과 적용 순서 무관 — 이 파일은 그 RPC 를 다시 만들지 않는다.
--
-- 적용 전제: add_nicepay_review_center_isolation_20261028.sql(P2) 적용 완료. 교체 대상 함수 3개의 정의 MD5 가 (운영 적용 전 값 | 이 파일 적용본)과 다르면 preflight 가 중단한다.
-- 적용 후 데이터 지정은 이 파일에 없다(권한 부여는 별도 INSERT — 파일 하단 주석 예시, 사용자 승인 후).
-- 되돌리기: rollback_add_nicepay_review_real_center_grants_20261103.sql (함수 정의를 P2 정의로 복원, 새 객체 삭제). 확인: verify_add_nicepay_review_real_center_grants_20261103.sql
-- ============================================================
BEGIN;

-- preflight: 이 파일이 교체할 함수 3개의 "현재 정의"가 (적용 전 운영 정의) 또는 (이 파일 적용본)과 MD5 로 정확히 같을 때만 진행한다.
--   문자열 포함 여부가 아니라 pg_get_functiondef 전체 해시 비교다. 운영에서 따로 바뀌었으면 아무것도 바꾸지 않고 중단한다(재실행은 적용본 해시를 허용 → 멱등).
--   적용 전 기준값 = 2026-11-03 운영 읽기 전용 조회 MD5(로컬 격리 DB 에 P2 를 적용해 측정한 값과 동일함을 확인).
do $$
declare r record; v_h text;
begin
  if to_regprocedure('public.nicepay_is_reviewer()') is null or to_regprocedure('public.my_account_id()') is null
     or to_regprocedure('public.my_managed_center_ids()') is null or to_regprocedure('public.is_platform_admin()') is null
     or to_regprocedure('public.nicepay_is_client_request()') is null then
    raise exception 'NICEPAY 실제 센터 허용: P2(add_nicepay_review_center_isolation_20261028.sql) 객체가 없습니다 — 먼저 적용하세요';
  end if;
  for r in select * from (values
      ('public.nicepay_review_center_allowed(uuid)', '636cb33ff0feaf95244ef0c41c3eb923', '078ffecea883196dd869512aa1cbc938'),
      ('public.nicepay_review_center_member_allowed(uuid)', 'a3a299f743087d104ebf41948e464d94', '030f304bb08fbc2efb67e8ecbc40669f'),
      ('public.nicepay_review_guard_center()', '0e8dc90f9da6cb921225657ba6ae4fb4', '7b5c7ca9333d0e7a90fdc559690ab07e')
    ) as t(sig, pre_md5, post_md5)
  loop
    if to_regprocedure(r.sig) is null then raise exception 'NICEPAY 실제 센터 허용: % 가 없어요 — P2 가 적용돼 있어야 해요', r.sig; end if;
    v_h := md5(pg_get_functiondef(to_regprocedure(r.sig)));
    if v_h <> r.pre_md5 and v_h <> r.post_md5 then
      raise exception 'NICEPAY 실제 센터 허용: % 의 현재 정의가 예상(적용 전 운영 정의/이 파일 적용본)과 달라요(해시 %) — 덮어쓰지 않고 중단합니다. 운영 정의 차이를 먼저 확인하세요.', r.sig, v_h;
    end if;
  end loop;
end $$;

-- 1) 심사관 계정 ↔ 허용 센터
create table if not exists nicepay_review_center_grants (
  account_id   uuid not null references accounts(id) on delete cascade,
  center_id    uuid not null references centers(id)  on delete cascade,
  can_purchase boolean not null default false,
  note         text,
  created_at   timestamptz not null default now(),
  primary key (account_id, center_id)
);
comment on table nicepay_review_center_grants is 'NICEPAY 심사관 계정별로 허용한 "실제 운영 센터". can_purchase=false(기본)=조회만. 클라이언트 정책 없음 — SQL Editor/서버만 기록.';
alter table nicepay_review_center_grants enable row level security;   -- 정책을 만들지 않는다 → anon/authenticated 는 읽기·쓰기 불가(함수가 security definer 로만 읽는다)
revoke all on table nicepay_review_center_grants from public, anon, authenticated;
grant select, insert, update, delete on table nicepay_review_center_grants to service_role;

-- 허용 가능한 센터 제한: 승인된 비내부 운영 센터만(심사 센터는 자체 규칙, 내부/QA 센터는 대상 아님). 계정은 심사관 권한이 있어야 한다.
create or replace function enforce_nicepay_review_center_grant_valid()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from centers c where c.id = new.center_id and c.status = 'approved' and not c.is_internal and not c.is_nicepay_review) then
    raise exception '허용 목록에는 승인된 운영 센터(내부·심사 센터 제외)만 넣을 수 있어요';
  end if;
  if not exists (select 1 from accounts a where a.id = new.account_id and a.nicepay_review_access) then
    raise exception '허용 목록은 NICEPAY 심사관 권한(accounts.nicepay_review_access)이 있는 계정에만 지정할 수 있어요';
  end if;
  return new;
end $$;
drop trigger if exists trg_nicepay_review_center_grant_valid on nicepay_review_center_grants;
create trigger trg_nicepay_review_center_grant_valid before insert or update on nicepay_review_center_grants for each row execute function enforce_nicepay_review_center_grant_valid();

-- 호출자(심사관)에게 허용된 센터인지 / 구매까지 허용됐는지. 효력 조건(전부 "판정 시점"에 다시 확인 — 허용 행이 남아 있어도 아래가 깨지면 즉시 무효):
--   · 심사관 권한이 켜져 있고 계정이 활성(nicepay_is_reviewer)
--   · 센터가 지금도 승인(status='approved')이고 내부 센터가 아니며 심사 센터가 아님 — 센터가 승인 취소·내부 전환되면 조회·구매 허용이 즉시 사라진다(다시 승인되면 허용 행이 그대로 되살아남).
create or replace function nicepay_review_center_granted(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select nicepay_is_reviewer() and exists (
        select 1 from nicepay_review_center_grants g join centers c on c.id = g.center_id
        where g.account_id = my_account_id() and g.center_id = p_center_id
          and c.status = 'approved' and not c.is_internal and not c.is_nicepay_review);
$$;
create or replace function nicepay_review_center_purchase_granted(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select nicepay_is_reviewer() and exists (
        select 1 from nicepay_review_center_grants g join centers c on c.id = g.center_id
        where g.account_id = my_account_id() and g.center_id = p_center_id and g.can_purchase
          and c.status = 'approved' and not c.is_internal and not c.is_nicepay_review);
$$;
revoke all on function nicepay_review_center_granted(uuid) from public;
revoke all on function nicepay_review_center_purchase_granted(uuid) from public;
grant execute on function nicepay_review_center_granted(uuid) to anon, authenticated, service_role;
grant execute on function nicepay_review_center_purchase_granted(uuid) to anon, authenticated, service_role;

-- 2) 읽기 가시성: 심사관에게 운영 센터는 "허용 목록에 있는 센터만" 추가로 보인다. 나머지 분기는 P2 와 동일.
create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer() or nicepay_review_center_granted(p_center_id)
    end;
$$;

-- 3) 회원용 목록/조회 판정(목록 RPC 가 사용): 심사관은 (심사 센터 + 허용 목록 센터). 매니저 예외는 심사관에게 주지 않는 P2 규칙 유지.
create or replace function nicepay_review_center_member_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) or nicepay_review_center_granted(p_center_id)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;

-- 4) 쓰기(구매·예약) 판정: 심사관은 (심사 센터 + can_purchase=true 로 허용된 센터)만. 그 밖은 member_allowed 와 같다.
create or replace function nicepay_review_center_purchase_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) or nicepay_review_center_purchase_granted(p_center_id)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;
revoke all on function nicepay_review_center_purchase_allowed(uuid) from public;
grant execute on function nicepay_review_center_purchase_allowed(uuid) to anon, authenticated, service_role;

create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_a uuid; v_b uuid; v_row jsonb := to_jsonb(new);
begin
  if not nicepay_is_client_request() then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_a from classes c where c.id = (v_row->>'class_id')::uuid;           -- 수업의 센터
    select m.center_id into v_b from memberships m where m.id = (v_row->>'membership_id')::uuid;  -- 수강권의 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '수업과 수강권의 센터가 일치하지 않아요'; end if;
  else
    v_a := nullif(v_row->>'center_id', '')::uuid;                                                  -- 행이 주장하는 센터
    select p.center_id into v_b from products p where p.id = (v_row->>'product_id')::uuid;        -- 상품의 실제 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '센터와 상품이 일치하지 않아요'; end if;
  end if;
  if v_a is not null and not nicepay_review_center_purchase_allowed(v_a) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  if v_b is not null and not nicepay_review_center_purchase_allowed(v_b) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  return new;
end $$;

-- 5) 앱 탐색 화면용: 내(심사관) 허용 센터 id 목록. 심사관이 아니면 빈 결과. 센터 UUID 는 이 테이블(중앙)에서만 관리한다.
create or replace function nicepay_my_review_center_ids()
returns table (center_id uuid, can_purchase boolean)
language sql stable security definer set search_path = public as $$
    select g.center_id, g.can_purchase from nicepay_review_center_grants g
    where nicepay_is_reviewer() and g.account_id = my_account_id()
      and exists (select 1 from centers c where c.id = g.center_id and c.status = 'approved' and not c.is_internal and not c.is_nicepay_review);
$$;
revoke all on function nicepay_my_review_center_ids() from public;
grant execute on function nicepay_my_review_center_ids() to authenticated, service_role;

COMMIT;

-- ─────────────────────────────────────────────────────────────
-- (참고 — 이 파일은 실행하지 않는다) 권한 부여 예시: 사용자 승인 후 SQL Editor 에서 별도로, 심사관 계정 이메일과 센터를 확인한 뒤.
--   insert into nicepay_review_center_grants (account_id, center_id, can_purchase, note)
--   select a.id, '<허용할 실제 센터 UUID>', false, 'NICEPAY 카드사 심사: 실제 수강권 조회 (조회만)'
--   from accounts a join auth.users u on u.id = a.auth_id where u.email = '<심사관 이메일>' and a.nicepay_review_access;
-- 해제: delete from nicepay_review_center_grants where account_id = '<심사관 account id>' and center_id = '<센터 UUID>';
-- ─────────────────────────────────────────────────────────────
```

#### `verify_add_nicepay_review_real_center_grants_20261103.sql`
```sql
-- 읽기 전용 확인: add_nicepay_review_real_center_grants_20261103.sql 적용 후 SQL Editor 에서 실행(데이터를 바꾸지 않는다). 기대값은 각 줄 주석.
select 'table_exists' as check, to_regclass('public.nicepay_review_center_grants') is not null as ok;                                       -- true
select 'rls_enabled_no_policies' as check, c.relrowsecurity and not exists (select 1 from pg_policies p where p.tablename='nicepay_review_center_grants') as ok
  from pg_class c where c.oid = 'public.nicepay_review_center_grants'::regclass;                                                              -- true
select 'no_client_privileges' as check, not has_table_privilege('anon','public.nicepay_review_center_grants','select')
  and not has_table_privilege('authenticated','public.nicepay_review_center_grants','select') as ok;                                         -- true
select 'functions' as check, to_regprocedure('nicepay_review_center_granted(uuid)') is not null and to_regprocedure('nicepay_review_center_purchase_allowed(uuid)') is not null
  and to_regprocedure('nicepay_my_review_center_ids()') is not null as ok;                                                                   -- true
select 'guard_uses_purchase_allowed' as check, pg_get_functiondef('nicepay_review_guard_center()'::regprocedure) like '%nicepay_review_center_purchase_allowed%' as ok;  -- true
select 'gate_unchanged' as check, pg_get_functiondef('nicepay_order_is_review_target(uuid,uuid)'::regprocedure) like '%is_nicepay_review%' as ok;                    -- true (카드 결제 게이트는 심사 센터만)
select 'function_state' as check, t.name,
       case md5(pg_get_functiondef(to_regprocedure('public.'||t.name))) when t.pre then 'BEFORE(적용 전 운영 정의)' when t.post then 'APPLIED(이 파일 적용본)' else 'UNKNOWN — 확인 필요' end as state   -- 적용 후 3줄 모두 APPLIED
from (values ('nicepay_review_center_allowed(uuid)','636cb33ff0feaf95244ef0c41c3eb923','078ffecea883196dd869512aa1cbc938'),
             ('nicepay_review_center_member_allowed(uuid)','a3a299f743087d104ebf41948e464d94','030f304bb08fbc2efb67e8ecbc40669f'),
             ('nicepay_review_guard_center()','0e8dc90f9da6cb921225657ba6ae4fb4','7b5c7ca9333d0e7a90fdc559690ab07e')) as t(name, pre, post);
select 'grants_valid_center_conditions' as check, pg_get_functiondef('nicepay_review_center_granted(uuid)'::regprocedure) like '%c.status = ''approved'' and not c.is_internal and not c.is_nicepay_review%' as ok;   -- true (승인 취소·내부 전환 시 즉시 무효)
select 'grants_rows' as check, count(*) as rows, count(*) filter (where can_purchase) as purchase_rows from nicepay_review_center_grants;  -- 지정 전 0/0
select 'review_flag_accounts' as check, count(*) as reviewers from accounts where nicepay_review_access;
select 'grants_target_centers' as check, c.name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id=g.center_id order by c.name;
```

#### `rollback_add_nicepay_review_real_center_grants_20261103.sql`
```sql
-- add_nicepay_review_real_center_grants_20261103.sql 되돌리기: 함수 3개를 P2(add_nicepay_review_center_isolation_20261028.sql) 정의로 복원하고, 이 파일이 만든 객체를 삭제한다.
-- 안전장치(전부 한 트랜잭션 — 하나라도 어긋나면 아무것도 바뀌지 않는다):
--   ① 시작 시: 복원할 함수 3개의 "현재 정의 MD5"가 (이 파일 적용본) 또는 (이미 복원된 적용 전 원본)과 같아야 한다. 운영에서 따로 바뀌었으면 변경 없이 중단.
--   ② 허용 행이 있으면 중단(데이터 보존). 중단 메시지에 현재 허용 행(계정·센터)을 보여 준다. 전체 삭제는 권장하지 않는다 — 아래 "개별 해제"로 계정·센터를 지정해 해제한 뒤 다시 실행한다.
--   ③ 복원 직후: 함수 3개의 MD5 가 적용 전 운영 정의(2026-11-03 읽기 전용 조회 값)와 다르면 EXCEPTION → 트랜잭션 전체 취소(함수 복원·테이블 삭제 모두 되돌아감).
-- 개별 해제(허용 행 확인 → 특정 계정·센터만 삭제):
--   select g.account_id, g.center_id, c.name as center_name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id = g.center_id;
--   delete from nicepay_review_center_grants where account_id = '<심사관 account id>' and center_id = '<센터 UUID>';   -- 한 행씩, 지정한 계정·센터만
--   (기존 센터·상품·주문 데이터는 이 롤백이 건드리지 않는다.)
-- 롤백 순서: 이 파일 → (필요하면) rollback_add_nicepay_review_center_isolation_20261028.sql. 반대로 P2 를 먼저 롤백하면 이 파일의 함수가 의존 대상을 잃는다.
BEGIN;
do $$
declare r record; v_n bigint; v_h text; v_rows text;
begin
  -- ① 현재 정의 검증(복원 전, 아무것도 바꾸기 전)
  for r in select * from (values
      ('public.nicepay_review_center_allowed(uuid)',        '636cb33ff0feaf95244ef0c41c3eb923', '078ffecea883196dd869512aa1cbc938'),
      ('public.nicepay_review_center_member_allowed(uuid)', 'a3a299f743087d104ebf41948e464d94', '030f304bb08fbc2efb67e8ecbc40669f'),
      ('public.nicepay_review_guard_center()',              '0e8dc90f9da6cb921225657ba6ae4fb4', '7b5c7ca9333d0e7a90fdc559690ab07e')) as t(sig, pre_md5, post_md5)
  loop
    if to_regprocedure(r.sig) is null then raise exception '롤백 중단: % 가 없어요 — 변경 없이 중단합니다', r.sig; end if;
    v_h := md5(pg_get_functiondef(to_regprocedure(r.sig)));
    if v_h <> r.pre_md5 and v_h <> r.post_md5 then
      raise exception '롤백 중단: % 의 현재 정의가 예상(이 파일 적용본/이미 복원된 원본)과 달라요(해시 %) — 변경 없이 중단합니다. 운영 정의 차이를 먼저 확인하세요.', r.sig, v_h;
    end if;
  end loop;
  -- ② 허용 행 확인
  if to_regclass('public.nicepay_review_center_grants') is not null then
    execute 'select count(*) from nicepay_review_center_grants' into v_n;   -- 테이블이 없을 때(재실행)도 안전하도록 동적 SQL
    if v_n > 0 then
      execute 'select string_agg(g.account_id::text || '' / '' || g.center_id::text, '', '' order by g.created_at) from nicepay_review_center_grants g' into v_rows;
      raise exception '롤백 중단: 허용 목록에 행이 있어요(% 건: 계정 / 센터 = %). 필요 없는 행을 계정·센터를 지정해 개별 삭제(delete … where account_id = … and center_id = …)한 뒤 다시 실행하세요.', v_n, v_rows;
    end if;
  end if;
end $$;

-- P2 정의 복원 (가드 트리거 함수가 purchase_allowed 를 더 이상 참조하지 않도록 먼저 복원). 목록 RPC·주문 정책은 이 파일이 바꾸지 않았으므로 여기서 복원하지 않는다.
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_a uuid; v_b uuid; v_row jsonb := to_jsonb(new);
begin
  if not nicepay_is_client_request() then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_a from classes c where c.id = (v_row->>'class_id')::uuid;           -- 수업의 센터
    select m.center_id into v_b from memberships m where m.id = (v_row->>'membership_id')::uuid;  -- 수강권의 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '수업과 수강권의 센터가 일치하지 않아요'; end if;
  else
    v_a := nullif(v_row->>'center_id', '')::uuid;                                                  -- 행이 주장하는 센터
    select p.center_id into v_b from products p where p.id = (v_row->>'product_id')::uuid;        -- 상품의 실제 센터
    if v_a is not null and v_b is not null and v_a <> v_b then raise exception '센터와 상품이 일치하지 않아요'; end if;
  end if;
  if v_a is not null and not nicepay_review_center_member_allowed(v_a) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  if v_b is not null and not nicepay_review_center_member_allowed(v_b) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  return new;
end $$;

create or replace function nicepay_review_center_member_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;

create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer()
    end;
$$;

drop function if exists nicepay_my_review_center_ids();
drop function if exists nicepay_review_center_purchase_allowed(uuid);
drop function if exists nicepay_review_center_purchase_granted(uuid);
drop function if exists nicepay_review_center_granted(uuid);
drop table if exists nicepay_review_center_grants;   -- 테이블과 함께 트리거도 삭제된다(테이블이 이미 없어도 재실행 가능)
drop function if exists enforce_nicepay_review_center_grant_valid();

-- ③ 복원 확인: 복원한 함수 3개의 정의 MD5 가 "적용 전 운영 정의"와 정확히 같아야 한다. 다르면 EXCEPTION — 이 트랜잭션 전체가 취소된다(함수 복원·테이블 삭제 포함, 롤백 이전 상태 그대로).
do $$
declare r record;
begin
  for r in select * from (values
      ('public.nicepay_review_center_allowed(uuid)',        '636cb33ff0feaf95244ef0c41c3eb923'),
      ('public.nicepay_review_center_member_allowed(uuid)', 'a3a299f743087d104ebf41948e464d94'),
      ('public.nicepay_review_guard_center()',              '0e8dc90f9da6cb921225657ba6ae4fb4')) as t(sig, pre_md5)
  loop
    if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.pre_md5 then
      raise exception '롤백 취소: 복원한 % 의 정의가 적용 전 운영 값과 달라요(해시 %) — 트랜잭션 전체를 취소합니다(아무것도 바뀌지 않음)', r.sig, md5(pg_get_functiondef(to_regprocedure(r.sig)));
    end if;
  end loop;
end $$;
COMMIT;
```

#### `grant_nicepay_review_real_center_20261106_proposed.sql`
```sql
-- NICEPAY 심사 계정(niceqa)에게 실제 센터(A10TION 피겨팀) 상품 "조회 + 카드 결제창 확인(승인 없음)" 허용 — 제안(2026-11-06), ⚠ 실행하지 않았다. 사용자 승인 후 SQL Editor 에서 실행.
-- 선행 조건: ① 센터 운영자(A10TION)의 동의 ② add_nicepay_review_real_center_grants_20261103.sql 적용 + verify 통과 ③ audit_nicepay_review_path_readonly_20261106.sql 결과 확인.
-- 변경: nicepay_review_center_grants 에 정확히 1행 INSERT (account=niceqa 계정, center=A10TION, can_purchase=false). 다른 테이블·행은 바꾸지 않는다. 조회 전용이라 주문·장바구니·구매신청·예약은 서버가 거부하고, 카드 결제 승인은 열리지 않는다.
-- 효과: 심사관의 홈·검색은 허용 센터(A10TION)만 보이고(별도 심사 센터는 탐색에서 제외), 앱의 "카드 결제창 확인(승인 없음)"이 A10TION 판매 중 상품에서 열린다(인증창만, 주문·이용권 없음).
-- 되돌리기: rollback_grant_nicepay_review_real_center_20261106.sql (이 1행만 삭제). 센터 상태가 바뀌어 승인 취소·내부 전환되면 허용은 즉시 무효.
begin;
do $g$
declare
    c_center  constant uuid := '8965e09c-0d2b-44c6-ab26-40a85507f8b5';
    c_auth    constant uuid := '7ffcf57d-b6d1-4562-a260-33be15f66ee5';
    v_account uuid;
    v_n int;
begin
    perform pg_advisory_xact_lock(hashtext('nicepay-review-grant-20261106'));
    if to_regclass('public.nicepay_review_center_grants') is null then
        raise exception '중단: 허용 목록 테이블이 없어요 — 먼저 add_nicepay_review_real_center_grants_20261103.sql 을 적용하세요';
    end if;
    select a.id into v_account from accounts a join auth.users u on u.id = a.auth_id
     where u.id = c_auth and lower(u.email) = 'niceqa@mwhabit.com' and u.email_confirmed_at is not null
       and a.nicepay_review_access and a.is_member and a.deactivated_at is null and a.merged_into is null;
    if v_account is null then
        raise exception '중단: niceqa 계정이 예상 조건(UID·이메일 인증·심사 권한·회원·비탈퇴)과 달라요';
    end if;
    if exists (select 1 from manager_centers where account_id = v_account and status = 'active') then
        raise exception '중단: 심사 계정이 센터 매니저로도 등록돼 있어요(권한 과다) — audit SQL 결과를 확인하세요';
    end if;
    if not exists (select 1 from centers where id = c_center and name = 'A10TION 피겨팀' and status = 'approved' and not is_internal and not is_nicepay_review) then
        raise exception '중단: A10TION 센터가 예상 값과 달라요(이름/승인/비내부/비심사 센터)';
    end if;
    select count(*) into v_n from products p where p.center_id = c_center and p.is_active and p.is_on_sale
       and not coalesce(p.expiry_mode = 'date' and p.expiry_date < (now() at time zone 'Asia/Seoul')::date, false);
    if v_n < 1 then
        raise exception '중단: A10TION 에 현재 판매 중인(미만료) 상품이 없어요 — 보여 줄 상품이 없습니다';
    end if;
    if exists (select 1 from nicepay_review_center_grants where account_id = v_account and center_id = c_center) then
        raise exception '중단: 이미 허용되어 있어요(중복 실행 방지). 아무것도 바꾸지 않았어요';
    end if;
    insert into nicepay_review_center_grants (account_id, center_id, can_purchase, note)
    values (v_account, c_center, false, 'NICEPAY 카드사 심사: 실제 수강권 조회·결제창 확인(승인 없음) — 2026-11-06');
    raise notice '허용 1행 추가: account=%, center=%, 판매 중 상품 %개', v_account, c_center, v_n;
end
$g$;
commit;
-- 확인(읽기 전용): 정확히 1행, can_purchase=false
select g.account_id, g.center_id, c.name, g.can_purchase from nicepay_review_center_grants g join centers c on c.id = g.center_id;
```

#### `rollback_grant_nicepay_review_real_center_20261106.sql`
```sql
-- 롤백 — grant_nicepay_review_real_center_20261106_proposed.sql 이 넣은 허용 1행만 삭제한다(⚠ 실행하지 않았다). 계정·센터 UUID 로 한 행만 지정, 전체 삭제 없음.
begin;
do $r$
declare
    c_center constant uuid := '8965e09c-0d2b-44c6-ab26-40a85507f8b5';
    c_auth   constant uuid := '7ffcf57d-b6d1-4562-a260-33be15f66ee5';
    v_account uuid;
    v_row record;   -- %rowtype 은 테이블이 없으면 선언 단계에서 오류가 나므로 record 사용(테이블이 없는 상태에서도 정상 종료)
    v_n int;
begin
    perform pg_advisory_xact_lock(hashtext('nicepay-review-grant-20261106'));
    if to_regclass('public.nicepay_review_center_grants') is null then raise notice '허용 테이블이 없어요(이미 정리됨) — 아무것도 바꾸지 않음'; return; end if;
    select a.id into v_account from accounts a where a.auth_id = c_auth;
    if v_account is null then raise exception '롤백 중단: 심사 계정을 찾지 못했어요'; end if;
    select * into v_row from nicepay_review_center_grants where account_id = v_account and center_id = c_center for update;
    if not found then raise notice '이미 없음: 삭제할 허용 행이 없어요(아무것도 바꾸지 않음)'; return; end if;
    if v_row.can_purchase then raise exception '롤백 중단: 이 행은 구매 허용(can_purchase=true)으로 바뀌어 있어요 — 의도한 변경인지 확인 후 직접 처리하세요'; end if;
    delete from nicepay_review_center_grants where account_id = v_account and center_id = c_center;
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception '롤백 취소: 삭제 행이 1개가 아니에요(%개)', v_n; end if;
    raise notice '허용 1행 삭제 완료';
end
$r$;
commit;
```

### (0) 읽기 전용 점검

#### `audit_release_sql_status_readonly_20261109.sql`
```sql
-- 읽기 전용(SELECT 만) — 운영 SQL Editor 에서 사용자가 실행. 릴리스 후보(integration/ux-native-review-20261109)가 기대하는 DB 객체의 적용 여부를 본다. 데이터·권한을 바꾸지 않는다.
-- Claude 는 운영 DB 에 접근하지 않았다(접근 수단 없음). 아래 결과로 "미적용(false/0)" 항목만 해당 SQL 을 승인 절차에 따라 적용한다.
select 'P2 심사관 분리(add_nicepay_review_center_isolation_20261028)'      as item, (to_regprocedure('public.nicepay_review_center_allowed(uuid)') is not null) as applied
union all select 'P2b 게이트 reviewer 플래그(fix_nicepay_gate_reviewer_flag_20261029)', (to_regprocedure('public.nicepay_order_is_review_target(uuid,uuid)') is not null)
union all select '#265 허용 목록 테이블(add_nicepay_review_real_center_grants_20261103)', (to_regclass('public.nicepay_review_center_grants') is not null)
union all select '#265 허용 목록 RPC nicepay_my_review_center_ids()', (to_regprocedure('public.nicepay_my_review_center_ids()') is not null)
union all select '#265 쓰기 가드 nicepay_review_center_purchase_allowed(uuid)', (to_regprocedure('public.nicepay_review_center_purchase_allowed(uuid)') is not null)
union all select '횟수 선택형 가격표(add_selectable_count_pricing) — orders 트리거', exists (select 1 from pg_trigger where tgname='orders_snapshot_product_amount' and not tgisinternal)
union all select '[제안] 주문 사이즈 검증(add_orders_selected_size_validation_20261109_proposed)', exists (select 1 from pg_trigger where tgname='orders_validate_selected_size' and not tgisinternal);
-- #265 허용 행 현황(있을 때만): 정확히 1행(심사 계정 ↔ A10TION, can_purchase=false)이어야 승인된 상태.
-- select count(*) as grants, count(*) filter (where can_purchase) as purchasable from nicepay_review_center_grants;   -- 테이블이 있을 때만 실행
-- 만료 상품 숨김(fix_expired_fixed_date_products_20261031.sql)은 RPC 정의 교체라 존재 여부 쿼리로 구분되지 않는다 — 해당 SQL 자체의 preflight(정의 MD5 비교)가 적용 여부를 판단하며, 운영 적용 상태는 docs/TODO.md 기준으로 사용자가 확인한다.
```

### (B) 제안

#### `add_orders_selected_size_validation_20261109_proposed.sql`
```sql
-- ============================================================
-- 주문 생성 시 "선택 사이즈" 서버 검증 (2026-11-09) — 제안(PROPOSED)·운영/공유 DEV 미실행. 사용자가 전문과 영향을 검토·승인한 뒤에만 SQL Editor 에서 실행한다.
--
-- 배경: orders 는 클라이언트가 직접 INSERT 한다. 횟수(selected_count)·금액은 orders_snapshot_product_amount 트리거(add_selectable_count_pricing.sql)가 서버에서 검증·확정하지만,
--       selected_size 는 서버가 검사하지 않아 조작된 클라이언트는 (a) 사이즈 필수 상품을 사이즈 없이 (b) 상품에 없는 사이즈로 (c) 사이즈 없는 상품에 임의 값으로 주문할 수 있다.
--       앱(lib/orderOptions.ts)은 막지만 서버 방어선이 없다.
--
-- 하는 일(새 함수 1개 + 새 트리거 1개 — 기존 데이터는 읽기만 하고 수정/삭제하지 않는다):
--   BEFORE INSERT ON orders: products.sizes 가 비어 있지 않으면 selected_size 는 그 목록 중 하나여야 하고(필수),
--   비어 있으면 selected_size 는 NULL/빈 문자열이어야 한다. 위반 시 예외로 INSERT 를 거부한다(한국어 메시지).
--   적용 범위: 로그인한 클라이언트 세션(auth.uid() 있음)만. 서버 함수/service_role/cron(auth.uid() 없음)은 영향 없음 — orders_guard_snapshot_update 와 같은 기준.
-- 바뀌지 않는 것: 기존 orders·products·memberships·결제 데이터, 기존 트리거, RLS 정책, 횟수/금액 검증.
-- 영향: 이미 만들어진 주문은 그대로(UPDATE 검증 없음). 적용 후 "사이즈 정보가 어긋난 새 주문"만 거부된다. 앱의 정상 흐름(사이즈 선택 후 주문)은 영향 없음.
-- 적용 전 확인(읽기): 아래 파일 하단 주석의 "사전 점검 쿼리" — 최근 주문 중 사이즈가 어긋난 건수.
-- 되돌리기: rollback_add_orders_selected_size_validation_20261109_proposed.sql / 확인: verify_add_orders_selected_size_validation_20261109_proposed.sql
-- ============================================================
BEGIN;

do $$
begin
  if to_regclass('public.orders') is null or to_regclass('public.products') is null then
    raise exception '주문 사이즈 검증: orders/products 테이블이 없습니다 — 중단';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='sizes' and data_type='ARRAY') then
    raise exception '주문 사이즈 검증: products.sizes(text[]) 가 없습니다 — add_product_extras.sql 먼저';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='selected_size') then
    raise exception '주문 사이즈 검증: orders.selected_size 가 없습니다 — 중단';
  end if;
  if to_regprocedure('public.orders_snapshot_product_amount()') is null then
    raise exception '주문 사이즈 검증: orders_snapshot_product_amount() 가 없습니다(add_selectable_count_pricing.sql 미적용) — 중단';
  end if;
end $$;

create or replace function public.orders_validate_selected_size()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sizes text[];
  v_size  text := nullif(btrim(coalesce(new.selected_size, '')), '');
begin
  if auth.uid() is null or new.product_id is null then
    return new;   -- 서버 경로/service_role/cron 은 대상 아님, FK 가 product_id 를 처리
  end if;
  select sizes into v_sizes from products where id = new.product_id;
  if not found then
    return new;
  end if;
  if coalesce(cardinality(v_sizes), 0) > 0 then
    if v_size is null then
      raise exception '사이즈를 선택해주세요';
    end if;
    if not (v_size = any (v_sizes)) then
      raise exception '선택할 수 없는 사이즈예요(%)', v_size;
    end if;
  elsif v_size is not null then
    raise exception '이 상품은 사이즈를 선택할 수 없어요';
  end if;
  return new;
end;
$$;
revoke all on function public.orders_validate_selected_size() from public, anon, authenticated;

drop trigger if exists orders_validate_selected_size on public.orders;
create trigger orders_validate_selected_size
  before insert on public.orders
  for each row execute function public.orders_validate_selected_size();

COMMIT;

-- (읽기 전용) 사전 점검 쿼리 — 적용 전에 SQL Editor 에서 실행해 영향 범위를 본다:
--   select count(*) filter (where coalesce(cardinality(p.sizes),0) > 0 and nullif(btrim(coalesce(o.selected_size,'')),'') is null)                              as 사이즈필수인데_없음,
--          count(*) filter (where coalesce(cardinality(p.sizes),0) > 0 and o.selected_size is not null and not (o.selected_size = any (p.sizes)))              as 상품에_없는_사이즈,
--          count(*) filter (where coalesce(cardinality(p.sizes),0) = 0 and nullif(btrim(coalesce(o.selected_size,'')),'') is not null)                         as 사이즈없는_상품에_값
--     from orders o join products p on p.id = o.product_id where o.created_at > now() - interval '90 days';
--   (0 이 아니면 어떤 경로가 어긋난 주문을 만들었는지 먼저 확인한다. 이 SQL 은 새 INSERT 만 막으며 기존 행은 건드리지 않는다.)
```

#### `rollback_add_orders_selected_size_validation_20261109_proposed.sql`
```sql
-- 롤백: 주문 사이즈 서버 검증 제거(트리거·함수만 삭제 — 데이터 무관, 멱등). 제안·미실행.
BEGIN;
drop trigger if exists orders_validate_selected_size on public.orders;
drop function if exists public.orders_validate_selected_size();
COMMIT;
```

#### `verify_add_orders_selected_size_validation_20261109_proposed.sql`
```sql
-- 적용 확인(읽기 전용): 기대값 — trigger_cnt=1, fn_cnt=1, fn_security_definer=true, fn_not_executable_by_clients=true
select (select count(*) from pg_trigger where tgname = 'orders_validate_selected_size' and not tgisinternal) as trigger_cnt,
       (select count(*) from pg_proc where proname = 'orders_validate_selected_size') as fn_cnt,
       (select bool_and(prosecdef) from pg_proc where proname = 'orders_validate_selected_size') as fn_security_definer,
       not (has_function_privilege('anon', 'public.orders_validate_selected_size()', 'execute')
         or has_function_privilege('authenticated', 'public.orders_validate_selected_size()', 'execute')) as fn_not_executable_by_clients;
```