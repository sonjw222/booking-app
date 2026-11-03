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
-- 적용 전제: add_nicepay_review_center_isolation_20261028.sql(P2) 적용 완료. 없으면 아래 preflight 가 중단한다.
-- 적용 후 데이터 지정은 이 파일에 없다(권한 부여는 별도 INSERT — 파일 하단 주석 예시, 사용자 승인 후).
-- 되돌리기: rollback_add_nicepay_review_real_center_grants_20261103.sql (함수 정의를 P2 정의로 복원, 새 객체 삭제). 확인: verify_add_nicepay_review_real_center_grants_20261103.sql
-- ============================================================
BEGIN;

-- preflight: P2 객체가 있어야 하고, 이 파일이 교체할 함수 정의가 "P2 정의 또는 이 파일 적용본" 이어야 한다(운영에서 따로 바뀌었으면 덮어쓰지 않고 중단).
do $$
declare v_allowed text; v_member text; v_guard text;
begin
  if to_regprocedure('public.nicepay_review_center_allowed(uuid)') is null or to_regprocedure('public.nicepay_review_center_member_allowed(uuid)') is null
     or to_regprocedure('public.nicepay_review_guard_center()') is null or to_regprocedure('public.nicepay_is_reviewer()') is null
     or to_regprocedure('public.my_account_id()') is null or to_regprocedure('public.my_managed_center_ids()') is null or to_regprocedure('public.is_platform_admin()') is null then
    raise exception 'NICEPAY 실제 센터 허용: P2(add_nicepay_review_center_isolation_20261028.sql) 객체가 없습니다 — 먼저 적용하세요';
  end if;
  v_allowed := pg_get_functiondef(to_regprocedure('public.nicepay_review_center_allowed(uuid)'));
  v_member  := pg_get_functiondef(to_regprocedure('public.nicepay_review_center_member_allowed(uuid)'));
  v_guard   := pg_get_functiondef(to_regprocedure('public.nicepay_review_guard_center()'));
  -- P2 정의의 핵심 표식(심사 센터 + nicepay_is_reviewer 분기)이 없으면 운영에서 따로 바뀐 것 → 중단. 이 파일 적용본(grants 참조)도 통과(재실행 멱등).
  if v_allowed not like '%is_nicepay_review%' or v_allowed not like '%nicepay_is_reviewer()%'
     or v_member not like '%is_nicepay_review%' or v_member not like '%nicepay_is_reviewer()%'
     or v_guard not like '%nicepay_review_center_member_allowed%' and v_guard not like '%nicepay_review_center_purchase_allowed%' then
    raise exception 'NICEPAY 실제 센터 허용: 교체 대상 함수의 현재 정의가 예상과 달라요 — 덮어쓰지 않고 중단합니다(운영 정의 확인 필요)';
  end if;
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

-- 호출자(심사관)에게 허용된 센터인지 / 구매까지 허용됐는지. 심사관 권한이 꺼지면(또는 계정이 비활성) 허용 목록도 효력이 없다.
create or replace function nicepay_review_center_granted(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select nicepay_is_reviewer() and exists (select 1 from nicepay_review_center_grants g where g.account_id = my_account_id() and g.center_id = p_center_id);
$$;
create or replace function nicepay_review_center_purchase_granted(p_center_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select nicepay_is_reviewer() and exists (select 1 from nicepay_review_center_grants g where g.account_id = my_account_id() and g.center_id = p_center_id and g.can_purchase);
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
      and exists (select 1 from centers c where c.id = g.center_id and c.status = 'approved' and not c.is_internal);
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
