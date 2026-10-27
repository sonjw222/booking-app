# NICEPAY SQL 실행 런북 (2026-10-30 개정 3 — accounts 보호 INSERT 확장 반영) — 실행하지 않음, 승인 후에만

운영 Supabase `bxntqggkfwnhcczsbqtj` 는 **읽기 전용으로만** 조회했다(마이그레이션 이력 11건 본문 대조·스키마 존재 확인). 이 문서의 SQL 은 모두 미실행이다. 전문은 아래에 있다(경로는 저장소 루트).

## 운영 적용 이력 대조 (2026-10-29 읽기 전용)
| 항목 | 운영 이력 | 실제 텍스트 대조(주석 제거·공백 정규화) | 분류 |
|---|---|---|---|
| fix_refund_server_path_fail_closed_20261017 | 20261017101334 | 저장소 파일과 동일(차이는 말미 `;` 1자) | **이미 적용됨** |
| fix_refund_amount_integrity_20261017 | 20261017111807 | 동일 | **이미 적용됨** |
| fix_orders_insert_role_guard_20261017 | 20261017131436 | 동일 | **이미 적용됨** |
| add_nicepay_checkout_gate_20261017 | 20261017134256 | 동일 | **이미 적용됨**(게이트 mode=off 확인) |
| add_nicepay_provider_support_20261016(_v8) | 20261017151331 | 동일(v8 = 저장소 파일) | **이미 적용됨** |
| fix_create_order_secure_allow_nicepay_20261016(_v8) | 20261017151429 | 동일 | **이미 적용됨** |
| diag_nicepay_v8_rollback_only / diag_create_order_nicepay_v8_rollback | 20261017151255 / 20261017151426 | 롤백 전용 진단(저장소 외) | 이력만 있음(NICEPAY 기능 변경 아님) |
| fix_refund_pg_origin_guard_20261017 | **이력 없음**(운영 이력은 10/13 이후만 존재) | 후속 마이그레이션(server_path)이 이 패치를 전제로 하므로 적용됐을 가능성이 높음 | **이력은 없지만 운영 정의에 적용돼 있음(P0b PASS)** |
| fix_nicepay_claim_gate_20261017 | 이력 없음 | v8 provider_support 가 같은 검사(`nicepay_checkout_mode()`)를 이미 포함 | **불필요**(건너뜀) |
| preflight_nicepay_patch_targets_20261016 | 읽기 전용 | - | 필요 시 읽기 전용 실행 |
| add_public_storefront_product_periods_20261027 | 없음(운영에 `fetch_public_storefront_product_periods` 없음) | - | **아직 적용되지 않음**(선택) |
| add_nicepay_review_center_isolation_20261028 | 없음(`centers.is_nicepay_review` 없음) | - | **아직 적용되지 않음** |
| (신규) fix_nicepay_gate_reviewer_flag_20261029 | 없음 | 운영에 적용된 두 함수가 토스용 `pg_checkout_override` 로 심사관 판별 | **B안으로 인해 수정 필요** |
- 정의 해시(P0) 대조: **PASS** — 운영에서 읽기 전용(SELECT)으로 실행한 결과 `center_rows_visible`·`fetch_public_storefront_products`·`fetch_purchasable_products` 의 정의 해시 3개가 기대값과 모두 일치. P0b(`verify_fix_refund_pg_origin_guard_20261017`) 7개 항목 전부 true → PASS. 상세: `docs/payments/NICEPAY_PREFLIGHT_20261029.md`.
- 운영 실측(읽기 전용): 게이트 mode=`off`, NICEPAY 테이블 5개·RPC 11개 존재, `accounts.nicepay_review_access`·`centers.is_nicepay_review` 없음, `accounts.pg_checkout_override` 있음.

## 실제로 실행이 필요한 SQL(순서)
| # | 파일 | 효과 | 검증 | 롤백 |
|---|---|---|---|---|
| P0 | `preflight_nicepay_review_center_isolation_20261028.sql` | 읽기 전용: 정의 해시·전제·게이트 상태 | `matches` 전부 true, `not_yet_applied` true, `gate_mode_now`=off | - |
| P0b | `verify_fix_refund_pg_origin_guard_20261017.sql`(읽기 전용) | 이력 없는 환불 가드 패치의 실제 적용 확인 | 파일 기대값 | - |
| P1(선택) | `add_public_storefront_product_periods_20261027.sql` | 공개 기간 RPC | 같은 파일 말미 | `rollback_add_public_storefront_product_periods_20261027.sql` |
| P2 | `add_nicepay_review_center_isolation_20261028.sql` | 센터 분리 + **전용 권한 컬럼** | `verify_add_nicepay_review_center_isolation_20261028.sql` | `rollback_add_nicepay_review_center_isolation_20261028.sql`(공개 가능한 심사 센터 있으면 중단) |
| P2b | `fix_nicepay_gate_reviewer_flag_20261029.sql` | 운영 적용된 게이트 함수 2개의 심사관 판별을 전용 권한으로 | `verify_fix_nicepay_gate_reviewer_flag_20261029.sql` | `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql` |
| P3(별도 승인) | `seed_nicepay_review_center_20261028.sql` | 심사 센터 1·상품 3(값 확정 필요) | verify 의 review_centers=1 | 데이터 보존(삭제는 별도 승인) |
| P3(별도 승인) | `update accounts set nicepay_review_access = true where auth_id = (select id from auth.users where email = 'sonjw222@naver.com');` | 심사관 지정 | verify 의 reviewer_accounts=1 | `= false` |
| 심사 종료 | `close_nicepay_review_20261029.sql` | 권한 해제·게이트 off·센터 비공개·대기 주문 정리 | 파일 말미 확인 쿼리 | - |
**이미 적용돼 다시 실행하지 않는 SQL**: 준비 브랜치의 `fix_refund_server_path_fail_closed`·`fix_refund_amount_integrity`·`fix_orders_insert_role_guard`·`add_nicepay_checkout_gate`·`add_nicepay_provider_support`·`fix_create_order_secure_allow_nicepay`(위 표). 로컬 격리 DB 에서는 이 6개 + `fix_refund_pg_origin_guard` 를 이 순서로 적용한 뒤 P2·P2b 를 검증했다.
- **의존관계**: P2b 는 P2 의 `accounts.nicepay_review_access` 가 먼저 있어야 하고(없으면 중단), 운영에 이미 있는 게이트(`add_nicepay_checkout_gate`)·`add_nicepay_provider_support`(v8)가 있어야 한다. P2 는 `pg_checkout_override` 에 의존하지 않는다(B안). 게이트 mode 가 `off`(현재) 이면 P2b 는 동작 차이가 없다.
- **함께 닫아야 하는 순서**: 심사 종료 시 `close_…` 로 센터를 닫은 뒤에만 P2 를 롤백할 수 있다.

심사관 지정은 반드시 P2 → P2b 이후에 한다(P2b 이전에 켜면 게이트가 토스 계정 기준이라 NICEPAY 심사관이 결제 게이트를 통과하지 못한다).

## P0 사전 점검 — `preflight_nicepay_review_center_isolation_20261028.sql`
```sql
-- 읽기 전용 사전 점검 — add_nicepay_review_center_isolation_20261028.sql 을 운영에 적용하기 "전에" SQL Editor 에서 실행한다(변경 없음).
-- 분리 SQL 은 아래 3개 함수를 "현재 정의 + 한 줄 조건"으로 통째로 다시 만든다. 운영의 현재 정의가 아래 기대값(공유 DEV 와 같은 계보의 정의, 2026-10-28 로컬 측정)과 다르면
-- 운영에서 따로 바뀐 내용을 덮어쓸 수 있으므로 적용하지 말고 이 결과를 보내 정의 차이를 먼저 비교한다.
select 'center_rows_visible' as object, md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) as actual_md5, '2be0d75899571b973f43d213713053e3' as expected_md5,
       md5(pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) = '2be0d75899571b973f43d213713053e3' as matches
union all select 'fetch_public_storefront_products', md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)), 'fda8e1821f997e9879c757187ab35a84',
       md5(pg_get_functiondef('public.fetch_public_storefront_products(uuid)'::regprocedure)) = 'fda8e1821f997e9879c757187ab35a84'
union all select 'fetch_purchasable_products', md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)), '675be9c77818e1eb61552fc483e51b18',
       md5(pg_get_functiondef('public.fetch_purchasable_products(uuid)'::regprocedure)) = '675be9c77818e1eb61552fc483e51b18';
-- 전제 객체/컬럼(모두 true 여야 함)
select to_regprocedure('my_account_id()') is not null as my_account_id,
       to_regprocedure('my_managed_center_ids()') is not null as my_managed_center_ids,
       to_regprocedure('is_platform_admin()') is not null as is_platform_admin,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='pg_checkout_override') as pg_checkout_override_col,
       exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') as is_internal_col,
       not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review') as not_yet_applied,
       to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as periods_rpc_exists_now;
-- 현재 센터/상품/수업 조회 정책(눈으로 확인: 승인된 센터 + is_internal 규칙이어야 함)
select tablename, policyname, pg_get_expr(q.polqual, q.polrelid) as using_expr from pg_policies p join pg_policy q on q.polname = p.policyname and q.polrelid = ('public.' || p.tablename)::regclass
 where p.tablename in ('centers','classes','products') and p.cmd = 'SELECT' order by 1, 2;
-- 영향 범위 미리보기: 심사관 계정 수와 내부/심사 후보 센터
select (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as reviewer_accounts_now,
       (select string_agg(name, ' | ') from accounts where pg_checkout_override and deactivated_at is null) as reviewer_names,
       (select count(*) from centers) as centers_total, (select count(*) from centers where is_internal) as centers_internal;
-- NICEPAY 결제 DB 기반 적용 상태(운영 이력상 2026-10-17 적용): 모두 true 여야 하고, 게이트 mode 는 off 여야 안전하다.
select to_regprocedure('public.nicepay_checkout_mode()') is not null as gate_fn,
       to_regprocedure('public.nicepay_claim_order(uuid)') is not null as claim_fn,
       to_regprocedure('public.orders_guard_nicepay_create()') is not null as gate_trigger_fn,
       to_regclass('public.nicepay_checkout_gate') is not null as gate_table,
       (select mode from nicepay_checkout_gate where id) as gate_mode_now,
       position('pg_checkout_override' in pg_get_functiondef('public.orders_guard_nicepay_create()'::regprocedure)) > 0 as gate_uses_toss_flag_now,
       position('pg_checkout_override' in pg_get_functiondef('public.nicepay_claim_order(uuid)'::regprocedure)) > 0 as claim_uses_toss_flag_now;
```

## P2 적용 — `add_nicepay_review_center_isolation_20261028.sql`
```sql
-- ============================================================
-- NICEPAY 카드사 심사 전용 센터 분리 (2026-10-28) — 검토용 초안, 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 미실행.
--
-- 목적: NICEPAY 심사 전용 센터·수강권을 만들어도
--   · 일반 회원/비회원에게는 그 센터·수업·상품이 어떤 경로로도 보이지 않고(목록·직접 URL·RPC·구매·예약),
--   · NICEPAY 심사관 계정(accounts.nicepay_review_access = true — 신규 전용 권한. 기존 토스 심사용 pg_checkout_override 와 완전히 별개)에게는 심사 센터만 보이고 기존 운영 센터는 보이지 않게 한다.
--     기존 토스 심사 계정(pg_checkout_override)은 이 SQL 로 아무 영향도 받지 않는다.
--   기존 센터·상품·주문·수강권·예약 데이터는 읽기/수정/삭제하지 않는다(행 변경 0). 새 컬럼 2개(centers.is_nicepay_review, accounts.nicepay_review_access) + 함수 7개 + 정책 4개 + 트리거 12개 + 기존 함수 3~4개 정의 교체(center_rows_visible, 목록 RPC 2개, 선택적 기간 RPC).
--
-- 적용 순서(전제): ① (선택) add_public_storefront_product_periods_20261027.sql — 이 파일이 같은 함수를 조건 추가 버전으로 다시 만들므로 ①이 없어도 안전하다
--                   ② 이 파일  ③ (별도 승인, 데이터 생성) seed_nicepay_review_center_20261028.sql
-- 전제 객체: centers.is_internal(add_internal_qa_center_flag.sql),
--           my_account_id()/my_managed_center_ids()/is_platform_admin()/center_rows_visible()/product_rows_visible() — 운영에 없으면 아래 preflight 가 실패한다.
-- 되돌리기: rollback_add_nicepay_review_center_isolation_20261028.sql (기존 정의로 복원, 새 객체 삭제 — 컬럼은 데이터 보존을 위해 남긴다)
-- 확인(읽기 전용): verify_add_nicepay_review_center_isolation_20261028.sql
--
-- 접근 기준(요약)
--   · 플랫폼 관리자, 해당 센터의 활성 매니저: 항상 접근(기존 관리 기능 유지)
--   · 심사 센터(centers.is_nicepay_review): 심사관만. 그 외 회원/비회원은 불가
--   · 일반(운영) 센터: 심사관은 불가(심사관이 매니저/플랫폼 관리자인 센터는 예외), 그 외는 기존과 동일
--   · 기존 is_internal 규칙은 그대로 유지(추가로 AND 로 겹침 — 대체하지 않는다)
-- ============================================================
BEGIN;

-- 롤백이 이전 상태를 정확히 복원하도록, 기간 RPC 가 이 파일 적용 전에 있었는지 기록한다(없었으면 이 파일이 만든 것 → 롤백 시 삭제).
create temp table _nicepay_periods_existed on commit drop as select to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as existed;

-- preflight: 전제 객체가 없으면 중단(부분 적용 방지)
do $$
begin
  if to_regprocedure('my_account_id()') is null or to_regprocedure('my_managed_center_ids()') is null
     or to_regprocedure('is_platform_admin()') is null or to_regprocedure('center_rows_visible(uuid)') is null
     or to_regprocedure('fetch_public_storefront_products(uuid)') is null or to_regprocedure('fetch_purchasable_products(uuid)') is null then
    raise exception 'NICEPAY 심사 분리: 전제 함수가 없습니다(운영 정의 확인 필요)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_internal') then
    raise exception 'NICEPAY 심사 분리: centers.is_internal 이 없습니다';
  end if;
end $$;

-- NICEPAY 심사관 전용 권한(토스 심사용 pg_checkout_override 와 별개). 운영자만 지정 가능(본인이 스스로 켤 수 없음) — SQL Editor(auth.uid() is null)·서버(service_role)·플랫폼 관리자만.
-- ⚠ INSERT 도 막는다: "본인 계정 생성" RLS 정책은 auth_id = auth.uid() 만 보고 컬럼 값을 보지 않으므로, UPDATE 만 막으면 가입 시점에 `nicepay_review_access = true` 로 계정을 만들어 우회할 수 있다.
--   정상 가입(앱 가입 화면은 이 컬럼을 보내지 않아 기본값 false)은 그대로 통과한다. upsert(INSERT … ON CONFLICT DO UPDATE)는 INSERT·UPDATE 트리거를 모두 거치므로 같은 기준이다.
alter table accounts add column if not exists nicepay_review_access boolean not null default false;
comment on column accounts.nicepay_review_access is 'NICEPAY 카드사 심사관 전용 권한. true 이면 심사 센터만 보이고 NICEPAY 결제 게이트를 통과한다. pg_checkout_override(토스 심사용)와 독립.';
create or replace function enforce_nicepay_review_access_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.nicepay_review_access)
     or (tg_op = 'UPDATE' and new.nicepay_review_access is distinct from old.nicepay_review_access) then
    if auth.uid() is not null and not is_platform_admin() then raise exception '이 값은 운영자만 변경할 수 있어요'; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_accounts_nicepay_review_access_admin_only on accounts;
create trigger trg_accounts_nicepay_review_access_admin_only before insert or update on accounts
  for each row execute function enforce_nicepay_review_access_admin_only();

alter table centers add column if not exists is_nicepay_review boolean not null default false;
comment on column centers.is_nicepay_review is 'NICEPAY 카드사 심사 전용 센터. true 이면 NICEPAY 심사관 계정(accounts.nicepay_review_access)과 해당 센터 매니저/플랫폼 관리자에게만 보인다.';

-- 이 값은 운영자(플랫폼 관리자)/SQL Editor(auth.uid() is null)만 바꿀 수 있다 — 센터 매니저가 자기 센터를 심사 센터로 바꾸거나 심사 센터를 만들 수 없다.
create or replace function enforce_center_nicepay_review_admin_only()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'INSERT' and new.is_nicepay_review) or (tg_op = 'UPDATE' and new.is_nicepay_review is distinct from old.is_nicepay_review) then
    if auth.uid() is not null and not is_platform_admin() then
      raise exception '이 값은 운영자만 변경할 수 있어요';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create trigger trg_centers_nicepay_review_admin_only before insert or update on centers
  for each row execute function enforce_center_nicepay_review_admin_only();

-- 심사관 판정: 인증된 사용자(auth.uid())의 계정에 대해서만. 이메일 문자열은 쓰지 않는다. 비로그인은 false.
create or replace function nicepay_is_reviewer()
returns boolean language sql stable security definer set search_path = public as $$
    select coalesce((select a.nicepay_review_access from accounts a where a.id = my_account_id() and a.deactivated_at is null), false);
$$;
revoke all on function nicepay_is_reviewer() from public;
grant execute on function nicepay_is_reviewer() to anon, authenticated, service_role;

-- 센터 접근 판정(단일 기준). service_role 은 RLS 를 타지 않는다.
create or replace function nicepay_review_center_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() or p_center_id in (select my_managed_center_ids()) then true
        when exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review) then nicepay_is_reviewer()
        else not nicepay_is_reviewer()
    end;
$$;
revoke all on function nicepay_review_center_allowed(uuid) from public;
grant execute on function nicepay_review_center_allowed(uuid) to anon, authenticated, service_role;

-- 회원용(탐색 목록 RPC·구매·예약·주문) 접근 판정. 읽기 가시성(nicepay_review_center_allowed)과 달리 NICEPAY 심사관에게는 "매니저 예외"를 주지 않는다 —
-- 심사관이 기존 토스 심사 센터의 매니저여도 그 센터는 관리 화면에서만 쓰고, 상품 목록·구매·예약은 심사 센터에서만 가능하다. 플랫폼 관리자는 예외.
create or replace function nicepay_review_center_member_allowed(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select case
        when p_center_id is null then true
        when is_platform_admin() then true
        when nicepay_is_reviewer() then exists (select 1 from centers c where c.id = p_center_id and c.is_nicepay_review)
        else nicepay_review_center_allowed(p_center_id)
    end;
$$;
revoke all on function nicepay_review_center_member_allowed(uuid) from public;
grant execute on function nicepay_review_center_member_allowed(uuid) to anon, authenticated, service_role;

-- center_rows_visible 에 같은 기준을 AND 로 추가 → 이 함수를 쓰는 정책(휴무일·리뷰·커뮤니티·룸·상담채널·설정·센터항목·센터후기·진도카테고리)과 class_rows_visible/product_rows_visible 이 한 번에 따라온다.
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        (
            p_center_id is null
            or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
            or p_center_id in (select public.my_member_center_ids())
            or p_center_id in (select public.my_managed_center_ids())
            or public.is_platform_admin()
        ) and public.nicepay_review_center_allowed(p_center_id),
        false);
$$;

-- 기존 허용 정책에 AND 로 겹치는 제한 정책(대체 아님 — 기존 정책은 그대로 둔다)
drop policy if exists "nicepay_review_isolation" on centers;
create policy "nicepay_review_isolation" on centers as restrictive for select using (nicepay_review_center_allowed(id));
drop policy if exists "nicepay_review_isolation" on classes;
-- 수업은 예외 1가지: 내 프로필의 예약이 이미 걸린 수업은 센터가 숨겨져도 읽을 수 있다(심사관이 되기 전에 만든 기존 예약을 내 예약 화면에서 보고 취소할 수 있게 — 사후 처리 보존).
-- 센터·상품 목록/구매에는 영향 없음(센터·상품 정책은 예외 없음, 새 예약은 INSERT 트리거가 막는다).
create or replace function nicepay_class_has_my_reservation(p_class_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from reservations r where r.class_id = p_class_id and r.profile_id in (select my_profile_ids()));
$$;
revoke all on function nicepay_class_has_my_reservation(uuid) from public;
grant execute on function nicepay_class_has_my_reservation(uuid) to anon, authenticated, service_role;
create policy "nicepay_review_isolation" on classes as restrictive for select using (nicepay_review_center_allowed(center_id) or nicepay_class_has_my_reservation(id));
-- 기존 허용 정책("승인된 센터 수업 조회")은 centers 를 서브쿼리로 읽는데 그 centers 가 심사관에게 숨겨지므로, 내 예약이 걸린 수업만 읽는 허용 정책을 추가한다(내 예약만 — 다른 수업은 그대로 숨김).
drop policy if exists "nicepay_own_reservation_class" on classes;
create policy "nicepay_own_reservation_class" on classes for select using (nicepay_class_has_my_reservation(id));
drop policy if exists "nicepay_review_isolation" on products;
create policy "nicepay_review_isolation" on products as restrictive for select using (nicepay_review_center_allowed(center_id));

-- 구매·예약·수강권 발급 경로(RPC 는 SECURITY DEFINER 라 RLS 를 우회하고, orders INSERT 정책은 클라이언트가 보낸 center_id 와 product_id 의 일치를 보지 않는다).
-- 그래서 행이 가리키는 "모든" 센터(행의 center_id + 상품의 실제 센터 + 수업의 센터 + 수강권의 센터)가 호출자에게 허용된 센터인지 테이블 트리거로 확인한다.
-- 클라이언트가 보낸 center_id 만 믿지 않는다. auth.uid() is null(서버/service_role)은 통과. UPDATE 는 해당 컬럼이 실제로 바뀔 때만 검사한다.
create or replace function nicepay_review_guard_center()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_centers uuid[] := '{}'; v_c uuid; v_row jsonb := to_jsonb(new);
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'reservations' then
    select c.center_id into v_c from classes c where c.id = (v_row->>'class_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
    select m.center_id into v_c from memberships m where m.id = (v_row->>'membership_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  else
    if (v_row->>'center_id') is not null then v_centers := v_centers || (v_row->>'center_id')::uuid; end if;
    select p.center_id into v_c from products p where p.id = (v_row->>'product_id')::uuid;
    if v_c is not null then v_centers := v_centers || v_c; end if;
  end if;
  foreach v_c in array v_centers loop
    if not nicepay_review_center_member_allowed(v_c) then raise exception '이 센터의 상품·수업은 이용할 수 없어요'; end if;
  end loop;
  return new;
end $$;
do $$
declare t text; ins text := 'trg_%s_nicepay_review_guard'; upd text := 'trg_%s_nicepay_review_guard_upd';
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests'] loop
    execute format('drop trigger if exists %I on %I', format(ins, t), t);
    execute format('create trigger %I before insert on %I for each row execute function nicepay_review_guard_center()', format(ins, t), t);
    execute format('drop trigger if exists %I on %I', format(upd, t), t);
    execute format('create trigger %I before update of center_id, product_id on %I for each row when (old.center_id is distinct from new.center_id or old.product_id is distinct from new.product_id) execute function nicepay_review_guard_center()', format(upd, t), t);
  end loop;
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard before insert on reservations for each row execute function nicepay_review_guard_center()';
  execute 'drop trigger if exists trg_reservations_nicepay_review_guard_upd on reservations';
  execute 'create trigger trg_reservations_nicepay_review_guard_upd before update of class_id, membership_id on reservations for each row when (old.class_id is distinct from new.class_id or old.membership_id is distinct from new.membership_id) execute function nicepay_review_guard_center()';
end $$;

-- 목록 RPC 3개(SECURITY DEFINER — RLS 우회). 현재 정의 + nicepay_review_center_allowed 조건만 추가.
CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리] 심사 센터는 심사관에게만, 심사관에게는 심사 센터만
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      and nicepay_review_center_member_allowed(p.center_id)   -- [NICEPAY 심사 분리]
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and nicepay_review_center_member_allowed(c.id)   -- [NICEPAY 심사 분리]
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;
revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;
do $$ begin
  if not (select existed from _nicepay_periods_existed) then
    comment on function fetch_public_storefront_product_periods(uuid) is 'created_by:add_nicepay_review_center_isolation_20261028 (rollback 시 삭제)';
  end if;
end $$;

COMMIT;
```

## P2 검증 — `verify_add_nicepay_review_center_isolation_20261028.sql`
```sql
-- 읽기 전용 확인(SQL Editor/postgres 로 실행 — 변경 없음). 역할별 가시성은 아래 "역할 시뮬레이션"으로 확인한다.
-- 1) 객체
select
  (select count(*) from information_schema.columns where table_schema='public'
     and ((table_name='centers' and column_name='is_nicepay_review') or (table_name='accounts' and column_name='nicepay_review_access'))) as columns_must_be_2,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation','nicepay_review_guard_center','enforce_center_nicepay_review_admin_only','enforce_nicepay_review_access_admin_only')) as new_functions_must_be_7,
  (select count(*) from pg_policies where policyname='nicepay_review_isolation') as restrictive_policies_must_be_3,
  (select count(*) from pg_policies where policyname='nicepay_own_reservation_class') as own_reservation_policy_must_be_1,
  (select count(*) from pg_trigger where not tgisinternal and tgname ~ '^trg_(centers|accounts|orders|memberships|cart_items|purchase_requests|reservations)_nicepay_review_') as triggers_must_be_12,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('fetch_public_storefront_products','fetch_purchasable_products','fetch_public_storefront_product_periods')
     and position('nicepay_review_center_member_allowed' in pg_get_functiondef(p.oid)) > 0) as list_rpcs_replaced_must_be_3,
  position('nicepay_review_center_allowed' in pg_get_functiondef('public.center_rows_visible(uuid)'::regprocedure)) > 0 as center_rows_visible_replaced_must_be_true,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
     and p.proname in ('nicepay_is_reviewer','nicepay_review_center_allowed','nicepay_review_center_member_allowed','nicepay_class_has_my_reservation')
     and has_function_privilege('public', p.oid, 'execute')) as helpers_executable_by_public_must_be_0;
-- 2) 기존 센터 보존: 아래 두 값은 적용 전후 같아야 한다(적용 전에 먼저 기록).
select (select count(*) from centers where not is_nicepay_review) as existing_centers,
       (select count(*) from products p join centers c on c.id=p.center_id where not c.is_nicepay_review) as existing_products;
-- 3) 심사 센터/심사관 현황(심사관 수는 의도한 1명인지 확인)
select (select count(*) from centers where is_nicepay_review) as review_centers,
       (select count(*) from accounts where nicepay_review_access and deactivated_at is null) as nicepay_reviewer_accounts,
       (select count(*) from accounts where pg_checkout_override and deactivated_at is null) as toss_override_accounts_unchanged;
-- 4) 역할 시뮬레이션(트랜잭션 안에서만, 마지막에 ROLLBACK). <일반회원_auth_id>/<심사관_auth_id> 를 실제 값으로 바꿔 실행.
-- begin;
--   set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub','<일반회원_auth_id>','role','authenticated')::text, true);
--   select count(*) as normal_sees_review_center_must_be_0 from centers where is_nicepay_review;
--   select count(*) as normal_sees_operating_centers from centers where not is_nicepay_review;
--   select set_config('request.jwt.claims', json_build_object('sub','<심사관_auth_id>','role','authenticated')::text, true);
--   select count(*) as reviewer_sees_review_center_must_be_1 from centers where is_nicepay_review;
--   select count(*) as reviewer_sees_operating_centers_must_be_0 from centers where not is_nicepay_review;
-- rollback;
```

## P2 롤백 — `rollback_add_nicepay_review_center_isolation_20261028.sql`
```sql
-- add_nicepay_review_center_isolation_20261028.sql 되돌리기: 정책·트리거·신규 함수 삭제, 함수 4개를 이전 정의로 복원. centers.is_nicepay_review 컬럼과 심사 센터 데이터는 남긴다(데이터 보존).
-- ⚠ 안전장치: 롤백하면 분리 규칙이 사라져 심사 센터·상품·수업이 일반 회원에게 보일 수 있다. 일반 공개 가능 상태(승인된 비내부 심사 센터)가 하나라도 있으면 이 스크립트는 아무것도 바꾸지 않고 중단한다.
--   먼저 심사 센터를 비공개로 돌린다. 센터 하나만 닫으면 그 센터의 상품·수업 직접 조회까지 같이 막힌다(기존 "상품 조회"/"승인된 센터 수업 조회" 정책이 승인된 비내부 센터만 허용).
--   방법 ① SQL Editor: update centers set is_internal = true where is_nicepay_review;   -- 심사 센터 행만. 기존 운영 센터 변경 없음(is_internal 은 별도 보호 트리거가 없다)
--   방법 ② 플랫폼 관리자 계정으로 센터 승인 상태를 되돌림(status 는 guard_center_status_change 트리거가 플랫폼 관리자만 변경 허용 — SQL Editor 의 postgres 로는 변경 불가).
--   그 뒤 이 스크립트를 실행한다. (심사 센터 데이터는 삭제하지 않는다.)
-- 남기는 것: accounts.nicepay_review_access 컬럼·보호 트리거(INSERT·UPDATE 모두 보호, 값이 있을 수 있어 데이터 보존. 완전 제거는 별도 승인), centers.is_nicepay_review 컬럼.
-- 복원 규칙(기간 RPC): 분리 SQL 이 그 함수를 새로 만들었다면(함수 주석 표식) 삭제, 분리 SQL 적용 전부터 있었다면 add_public_storefront_product_periods_20261027.sql 정의로 복원.
BEGIN;
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='centers' and column_name='is_nicepay_review')
     and exists (select 1 from centers where is_nicepay_review and status = 'approved' and not is_internal) then
    raise exception '롤백 중단: 일반 사용자에게 공개될 수 있는 심사 센터가 있어요. 먼저 update centers set is_internal = true where is_nicepay_review; 를 실행하세요(또는 플랫폼 관리자가 센터 승인 상태를 되돌리세요).';
  end if;
end $$;
drop policy if exists "nicepay_review_isolation" on centers;
drop policy if exists "nicepay_review_isolation" on classes;
drop policy if exists "nicepay_own_reservation_class" on classes;
drop policy if exists "nicepay_review_isolation" on products;
do $$
declare t text;
begin
  foreach t in array array['orders','memberships','cart_items','purchase_requests','reservations'] loop
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard', t), t);
    execute format('drop trigger if exists %I on %I', format('trg_%s_nicepay_review_guard_upd', t), t);
  end loop;
end $$;
drop trigger if exists trg_centers_nicepay_review_admin_only on centers;
create or replace function public.center_rows_visible(p_center_id uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
    select coalesce(
        p_center_id is null
        or not exists (select 1 from public.centers c where c.id = p_center_id and c.is_internal)
        or p_center_id in (select public.my_member_center_ids())
        or p_center_id in (select public.my_managed_center_ids())
        or public.is_platform_admin(),
        false);
$$;

CREATE OR REPLACE FUNCTION public.fetch_public_storefront_products(p_center_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, center_id uuid, center_name text, name text, price integer, product_kind text, description text, total_count integer, unlimited boolean, unlimited_pass boolean, group_label text, remaining integer, purchase_count_selectable boolean, min_purchase_count integer, max_purchase_count integer, min_tier_price integer, max_tier_price integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select
        p.id,
        p.center_id,
        c.name,
        p.name,
        p.price,
        p.product_kind,
        p.description,
        p.total_count,
        p.unlimited,
        p.unlimited_pass,
        p.group_label,
        case
            when p.max_quantity is null then null
            else greatest(
                0,
                p.max_quantity - (
                    select count(*)::int from memberships m
                    where m.product_id = p.id and m.status <> 'refunded'
                )
            )
        end,
        coalesce(p.purchase_count_selectable, false),
        (select min(t.count) from product_count_prices t where t.product_id = p.id),
        (select max(t.count) from product_count_prices t where t.product_id = p.id),
        (select min(t.price) from product_count_prices t where t.product_id = p.id),
        (select max(t.price) from product_count_prices t where t.product_id = p.id)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal   -- QA/내부 센터는 공개 목록에 절대 나오지 않는다
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      -- 횟수 선택형인데 가격표가 아직 없으면(설정 중) 공개하지 않는다
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    order by c.name asc, p.product_kind asc, p.price asc
    limit 500;
$function$;
revoke all on function fetch_public_storefront_products(uuid) from public;
grant execute on function fetch_public_storefront_products(uuid) to anon, authenticated;

CREATE OR REPLACE FUNCTION public.fetch_purchasable_products(p_center_id uuid)
 RETURNS SETOF products
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    select p.* from products p
    where p.center_id = p_center_id
      -- QA/내부 센터(centers.is_internal)는 그 센터의 회원/관리자만 상품을 조회할 수 있다(UUID를 알아도 일반 계정은 빈 목록)
      and (
        not exists (select 1 from centers c where c.id = p.center_id and c.is_internal)
        or p.center_id in (select my_member_center_ids())
        or p.center_id in (select my_managed_center_ids())
      )
      and p.is_active
      and p.is_on_sale
      and (
        p.visibility_type = 'all'
        or (
            p.visibility_type = 'grades' and exists (
                select 1 from membership_product_grades mpg
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.grade_id = mpg.grade_id
                where mpg.product_id = p.id
            )
        )
        or (
            p.visibility_type = 'selected_members' and exists (
                select 1 from membership_product_members mpm
                join center_members cm
                  on cm.center_id = p.center_id
                 and cm.profile_id in (select my_profile_ids())
                 and cm.id = mpm.center_member_id
                where mpm.product_id = p.id
            )
        )
      )
    order by p.product_kind asc, p.price asc;
$function$;
revoke all on function public.fetch_purchasable_products(uuid) from public, anon;
grant execute on function public.fetch_purchasable_products(uuid) to authenticated, service_role;

-- 기간 RPC: 분리 SQL 이 만든 것이면 삭제, 이전부터 있었으면 이전 정의로 복원
do $do$ begin
  if to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null then
    if coalesce(obj_description('fetch_public_storefront_product_periods(uuid)'::regprocedure, 'pg_proc'), '') like 'created_by:add_nicepay_review_center_isolation_20261028%' then
      drop function fetch_public_storefront_product_periods(uuid);
    else
      execute $f$create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;$f$;
    end if;
  end if;
end $do$;
drop function if exists nicepay_class_has_my_reservation(uuid);
drop function if exists nicepay_review_guard_center();
drop function if exists enforce_center_nicepay_review_admin_only();
drop function if exists nicepay_review_center_member_allowed(uuid);
drop function if exists nicepay_review_center_allowed(uuid);
drop function if exists nicepay_is_reviewer();
COMMIT;
```

## P2b 게이트 판별 패치 — `fix_nicepay_gate_reviewer_flag_20261029.sql`
```sql
-- ============================================================
-- NICEPAY 결제 게이트의 "심사관" 판별을 전용 권한(accounts.nicepay_review_access)으로 변경(2026-10-29) — 검토용 초안, 운영 미실행.
--
-- 배경: 운영에 이미 적용된 두 함수가 mode='reviewer' 일 때 심사관을 accounts.pg_checkout_override(토스 심사용)로 판별한다.
--   · orders_guard_nicepay_create()  — 20261017134256_add_nicepay_checkout_gate_20261017 (NICEPAY 대기 주문 생성 트리거)
--   · nicepay_claim_order(uuid)      — 20261017151331_add_nicepay_provider_support_20261016_v8 (승인 선점)
--   NICEPAY 전용 권한을 분리하면(B안) 토스 심사 계정(override=true)이 실제 센터에서 NICEPAY 주문을 만들 수 있는 구멍이 남는다 → 두 함수의 판별을 새 권한으로 바꾼다.
-- 방식: 운영의 현재 함수 정의(pg_get_functiondef)를 읽어 `pg_checkout_override` 를 `nicepay_review_access` 로 제자리 치환(함수 통째 덮어쓰기 금지).
--   치환 위치가 예상(코드 1곳 이상, 총 3곳 이하)이 아니면 예외로 중단, 이미 바뀌었으면 건너뜀(멱등). 다른 로직은 한 글자도 바꾸지 않는다.
-- 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 accounts.nicepay_review_access 가 있어야 한다(없으면 중단).
-- 영향: mode 가 'off'(현재 기본)이면 동작 차이 없음. 'reviewer' 모드에서 NICEPAY 주문 생성·승인 선점이 nicepay_review_access 계정에만 허용된다. 'public' 모드는 영향 없음.
-- 롤백: rollback_fix_nicepay_gate_reviewer_flag_20261029.sql(역치환). 검증: verify_fix_nicepay_gate_reviewer_flag_20261029.sql(읽기 전용).
-- ============================================================
begin;
do $$
declare
    v_sig text; v_def text; v_new text; v_n int; v_code int;
begin
    if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='accounts' and column_name='nicepay_review_access') then
        raise exception 'accounts.nicepay_review_access 가 없어요 — add_nicepay_review_center_isolation_20261028.sql 을 먼저 적용하세요';
    end if;
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then raise exception '% 가 없어요 — NICEPAY 게이트/지원 SQL 이 적용돼 있어야 해요', v_sig; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        v_n := (length(v_def) - length(replace(v_def, 'pg_checkout_override', ''))) / length('pg_checkout_override');
        v_code := (length(v_def) - length(replace(v_def, '.pg_checkout_override', ''))) / length('.pg_checkout_override');
        if v_n = 0 and position('nicepay_review_access' in v_def) > 0 then raise notice '%: 이미 전용 권한으로 바뀜 — 건너뜀', v_sig; continue; end if;
        if v_code < 1 or v_n > 3 then raise exception '% 정의가 예상과 달라요(pg_checkout_override 총 %곳 / 코드 %곳) — 중단', v_sig, v_n, v_code; end if;
        v_new := replace(v_def, 'pg_checkout_override', 'nicepay_review_access');
        execute v_new;
    end loop;
end $$;
commit;
```

## P2b 검증 — `verify_fix_nicepay_gate_reviewer_flag_20261029.sql`
```sql
-- 읽기 전용 확인: 두 함수가 전용 권한을 보는지(둘 다 true, old_flag 는 false 여야 함)
select p.proname,
       position('nicepay_review_access' in pg_get_functiondef(p.oid)) > 0 as uses_new_flag,
       position('pg_checkout_override' in pg_get_functiondef(p.oid)) > 0 as still_uses_old_flag_must_be_false
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('orders_guard_nicepay_create', 'nicepay_claim_order');
```

## P2b 롤백 — `rollback_fix_nicepay_gate_reviewer_flag_20261029.sql`
```sql
-- fix_nicepay_gate_reviewer_flag_20261029.sql 되돌리기: 두 함수의 심사관 판별을 다시 accounts.pg_checkout_override 로 역치환(그 외 로직 불변).
-- 주의: 되돌리면 토스 심사 계정(override)이 mode='reviewer' 에서 NICEPAY 주문을 만들 수 있다.
begin;
do $$
declare v_sig text; v_def text;
begin
    foreach v_sig in array array['public.orders_guard_nicepay_create()', 'public.nicepay_claim_order(uuid)'] loop
        if to_regprocedure(v_sig) is null then continue; end if;
        select pg_get_functiondef(to_regprocedure(v_sig)) into v_def;
        if position('nicepay_review_access' in v_def) > 0 then execute replace(v_def, 'nicepay_review_access', 'pg_checkout_override'); end if;
    end loop;
end $$;
commit;
```

## P3 시드(값 확정 필요) — `seed_nicepay_review_center_20261028.sql`
```sql
-- ============================================================
-- NICEPAY 카드사 심사 전용 센터·수강권 데이터 (2026-10-28) — 초안. 로컬 격리 DB 에서만 실행·검증했다. 운영/공유 DEV 에는 실행하지 않았다.
-- 운영 실행은 반드시 별도 승인이 필요하다(데이터 생성). 전제: add_nicepay_review_center_isolation_20261028.sql 이 먼저 적용돼 있어야 한다(그렇지 않으면 이 센터가 일반 회원에게 공개된다 — 아래 가드가 중단시킨다).
--
-- ⚠ 사용자 확정 필요 값(아래 v_* 값은 제안 placeholder):
--   · 센터 표시명, 상품 3종의 가격·이용기간, 서비스 내용 문구(실제 제공 가능한 서비스 또는 NICEPAY 가 승인한 심사용 거래만 허용)
--   · 센터 주소·사업자번호는 임의로 만들지 않는다(null). 필요하면 사업자등록증 기준으로 사용자가 채운다.
-- 이 센터는 "심사 환경"임을 이름·소개·상품 설명에 그대로 밝힌다(정상 운영 센터처럼 보이게 하지 않는다).
-- 기존 센터·상품·회원 데이터는 읽거나 바꾸지 않는다. 같은 이름의 센터가 이미 있으면 아무것도 하지 않는다(멱등).
-- 취소·환불 기준은 새로 정하지 않고 기존 환불 정책(/legal/refund)을 그대로 따른다고만 안내한다.
-- ============================================================
BEGIN;
do $$
begin
  if not exists (select 1 from information_schema.columns where table_name='centers' and column_name='is_nicepay_review')
     or to_regprocedure('nicepay_review_center_allowed(uuid)') is null then
    raise exception '먼저 add_nicepay_review_center_isolation_20261028.sql 을 적용하세요(분리 없이 심사 센터를 만들면 일반 회원에게 노출됩니다)';
  end if;
end $$;

with c as (
  insert into centers(name, status, is_nicepay_review, is_internal, intro, categories)
  select '[심사 전용] MWHABIT NICEPAY 카드사 심사 환경', 'approved', true, false,
         'NICEPAY 카드사 심사를 위해 심사관에게만 제공되는 심사 전용 센터입니다. 일반 회원에게는 노출되지 않으며, 표시된 상품은 심사용 거래입니다. 취소·환불은 모하빗 환불 정책(환불정책 페이지)을 따릅니다.',
         '{}'
  where not exists (select 1 from centers where is_nicepay_review and name like '[심사 전용]%')
  returning id
), s as (insert into center_settings(center_id) select id from c returning center_id)
insert into products(center_id, name, price, product_kind, pass_type, total_count, unlimited_pass, expiry_mode, expiry_days, purchase_count_selectable, is_active, is_on_sale, visibility_type, description)
select c.id, v.name, v.price, 'pass', v.pt, v.cnt, v.unl, 'days', v.days, false, true, true, 'all', v.descr
from c, (values
  -- (이름, 가격 ⚠확정 필요, 유형, 횟수, 무제한, 이용기간(일), 설명)
  ('[심사용] 1회 수업 이용권',  1000, 'count',  1, false,  7, 'NICEPAY 심사용 상품 · 1회 수업 이용. 결제일부터 7일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 4주 수업 이용권',  4000, 'period', null, true, 28, 'NICEPAY 심사용 상품 · 4주(28일) 기간제 이용. 결제일부터 28일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.'),
  ('[심사용] 3개월 수업 이용권', 10000, 'period', null, true, 90, 'NICEPAY 심사용 상품 · 3개월(90일) 기간제 이용. 결제일부터 90일간 이용(이용 시작일=결제일, 사전예약 없음). 취소·환불: 환불정책 페이지 기준.')
) as v(name, price, pt, cnt, unl, days, descr);
COMMIT;
```

## 심사 종료 — `close_nicepay_review_20261029.sql`
```sql
-- ============================================================
-- NICEPAY 심사 종료 절차(2026-10-29) — 검토용 초안, 운영 미실행. 심사가 끝나면 SQL Editor 에서 위에서 아래로 실행한다.
-- 목적: 심사관 전용 권한을 해제하고, NICEPAY 결제 게이트를 닫고, 심사 센터를 일반 회원에게 보이지 않게 닫는다. 데이터는 삭제하지 않는다.
-- 순서가 중요하다: 센터를 먼저 닫은 뒤에만 분리 SQL 을 롤백할 수 있다(롤백 스크립트는 공개 가능한 심사 센터가 있으면 중단한다).
-- 이 파일이 바꾸는 것: ① 심사관 권한 해제 ② 게이트 off ③ 심사 센터 비공개(is_internal=true — centers.status 는 플랫폼 관리자만 바꿀 수 있어 SQL Editor 로는 못 바꿈) ④ 남은 대기 주문 취소.
-- 바꾸지 않는 것: 기존 운영 센터·상품·주문·수강권·예약, 토스 심사 계정(pg_checkout_override), 심사 중 생긴 주문·수강권·결제 기록(보존 — 환불은 기존 환불 절차).
-- ============================================================
begin;
-- ① 심사관 전용 권한 해제 (이 컬럼은 NICEPAY 전용 — 토스 심사 계정의 pg_checkout_override 는 건드리지 않는다)
update accounts set nicepay_review_access = false where nicepay_review_access;
-- ② NICEPAY 결제 게이트 닫기(신규 주문 생성·승인 선점 거부. 진행 중 거래의 마무리·취소·환불은 계속 가능)
update nicepay_checkout_gate set mode = 'off', updated_at = now() where id;
-- ③ 심사 센터 비공개: 일반 회원·비회원·옛 심사관 누구에게도 보이지 않는다(센터 하나를 닫으면 상품·수업 직접 조회도 막힌다)
update centers set is_internal = true where is_nicepay_review;
-- ④ 심사 센터의 미결제 대기 주문 정리(결제 완료 건은 건드리지 않는다)
update orders set status = 'cancelled' where status = 'pending' and center_id in (select id from centers where is_nicepay_review);
commit;

-- 확인(읽기 전용) — 모두 기대값이어야 한다
select
  (select count(*) from accounts where nicepay_review_access)                                   as reviewers_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                              as gate_mode_must_be_off,
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved') as publicly_visible_review_centers_must_be_0,
  (select count(*) from orders where status = 'pending' and center_id in (select id from centers where is_nicepay_review)) as pending_review_orders_must_be_0,
  (select count(*) from accounts where pg_checkout_override)                                     as toss_override_accounts_unchanged;
-- 심사 중 생긴 결제 기록(참고): 환불·보존 판단용
select o.status, count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review group by 1 order by 1;
```

## P1 선행 기간 RPC(`026175a`) — `add_public_storefront_product_periods_20261027.sql`
```sql
-- ============================================================
-- 공개 판매상품의 이용기간 원본 조회 RPC (추가 전용, 검토용 — 실행하지 않음)
--
-- 배경: NICEPAY 카드사 심사 사전 보완 요청 — "서비스 제공기간(시작일~종료일)과 사전예약기간(결제일~서비스 시작일)을 고객이 확인할 수 있게 명시".
-- 로그인 회원용 상품 목록(fetch_purchasable_products = select p.*)은 이미 expiry_* 컬럼을 반환하므로 앱만 고치면 된다.
-- 비로그인 공개 목록(fetch_public_storefront_products)은 반환 컬럼이 고정돼 있고 RETURNS TABLE 시그니처는 create or replace 로 바꿀 수 없다(바꾸려면 DROP 필요).
-- 그래서 기존 함수는 건드리지 않고, 같은 노출 조건으로 "상품 id + 이용기간 원본 5개 컬럼"만 돌려주는 새 함수를 추가한다.
--
-- 안전:
--  · 새 함수만 추가한다. 테이블/컬럼/기존 함수/정책을 바꾸거나 지우지 않는다. 데이터 변경 없음.
--  · 노출 조건은 fetch_public_storefront_products 와 동일하다(승인된 센터, 내부 QA 센터 제외, 활성·판매중·전체공개, 횟수 선택형은 가격표가 있는 것만).
--  · 반환 컬럼은 이용기간 원본뿐이다(가격·설명·판매 수량 등 다른 정보를 추가로 공개하지 않는다).
--  · SECURITY DEFINER + search_path 고정, PUBLIC 권한 회수 후 anon/authenticated 에만 실행 허용.
--  · 앱은 이 함수가 없거나 실패하면 조용히 무시하고 "기간 공통 안내"만 보인다(앱이 먼저 배포돼도 안전).
-- 되돌리기: rollback_add_public_storefront_product_periods_20261027.sql
-- 확인(읽기 전용): verify_add_public_storefront_product_periods_20261027.sql
-- ============================================================

create or replace function fetch_public_storefront_product_periods(p_center_id uuid default null)
returns table (
    product_id uuid,
    expiry_mode text,
    expiry_days integer,
    expiry_date date,
    rolling_month_cutoff_day integer,
    rolling_month_allow_early_use boolean
)
language sql
stable
security definer
set search_path = public
as $$
    select
        p.id,
        p.expiry_mode,
        p.expiry_days,
        p.expiry_date,
        p.rolling_month_cutoff_day,
        coalesce(p.rolling_month_allow_early_use, false)
    from products p
    join centers c on c.id = p.center_id
    where c.status = 'approved'
      and not c.is_internal
      and p.is_active
      and p.is_on_sale
      and p.visibility_type = 'all'
      and (not coalesce(p.purchase_count_selectable, false)
           or exists (select 1 from product_count_prices t where t.product_id = p.id))
      and (p_center_id is null or p.center_id = p_center_id)
    limit 500;
$$;

revoke all on function fetch_public_storefront_product_periods(uuid) from public;
grant execute on function fetch_public_storefront_product_periods(uuid) to anon, authenticated;

comment on function fetch_public_storefront_product_periods(uuid) is
  '비로그인 포함 누구나 호출 가능. fetch_public_storefront_products 와 같은 노출 조건의 상품에 대해 이용기간 원본(expiry_mode/days/date, rolling_month 컷오프/early-use)만 반환한다.';

-- 확인(읽기 전용)
select
    to_regprocedure('fetch_public_storefront_product_periods(uuid)') is not null as function_exists,
    has_function_privilege('anon', 'fetch_public_storefront_product_periods(uuid)', 'execute') as anon_can_execute,
    has_function_privilege('authenticated', 'fetch_public_storefront_product_periods(uuid)', 'execute') as authenticated_can_execute;
```


## 별도 보안 초안(NICEPAY 와 독립 · 미실행) — accounts INSERT 특권 컬럼 보호
파일: `fix_accounts_insert_privileged_columns_20261030.sql`(+`rollback_…`, `verify_…`). 가입 시점에 `is_platform_admin`·`pg_checkout_override`·`merged_into` 를 지정하는 우회를 막는다. 상세·재현 결과: `docs/payments/NICEPAY_SQL_FINAL_REVIEW.md` §8. 적용 여부·시점은 별도 결정(권장: NICEPAY 와 무관하게 우선 검토).
