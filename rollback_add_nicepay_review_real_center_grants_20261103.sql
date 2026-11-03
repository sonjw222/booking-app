-- add_nicepay_review_real_center_grants_20261103.sql 되돌리기: 함수 3개를 P2(add_nicepay_review_center_isolation_20261028.sql) 정의로 복원하고, 이 파일이 만든 객체를 삭제한다.
-- ⚠ 허용 목록 테이블(nicepay_review_center_grants)은 지정 이력이 들어 있을 수 있어 행이 있으면 기본적으로 중단한다(데이터 보존). 지워도 좋다고 판단하면 먼저
--   delete from nicepay_review_center_grants;  를 사용자가 직접 실행한 뒤 이 스크립트를 다시 실행한다. (기존 센터·상품·주문 데이터는 이 롤백이 건드리지 않는다.)
-- 롤백 순서: 이 파일 → (필요하면) rollback_add_nicepay_review_center_isolation_20261028.sql. 반대로 P2 를 먼저 롤백하면 이 파일의 함수가 의존 대상을 잃는다.
BEGIN;
do $$
declare v_n bigint;
begin
  if to_regclass('public.nicepay_review_center_grants') is not null then
    execute 'select count(*) from nicepay_review_center_grants' into v_n;   -- 테이블이 없을 때(재실행)도 안전하도록 동적 SQL
    if v_n > 0 then
      raise exception '롤백 중단: 허용 목록에 행이 있어요(% 건). 내용을 확인하고 필요 없으면 delete from nicepay_review_center_grants; 를 먼저 실행하세요.', v_n;
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

-- 복원 확인: 복원한 함수 3개의 정의 MD5 가 "적용 전 운영 정의"(2026-11-03 운영 읽기 전용 조회 값)와 같아야 한다. 다르면 경고만 낸다(롤백 자체는 막지 않음 — 급한 복구를 막지 않기 위해).
do $$
declare r record;
begin
  for r in select * from (values
      ('public.nicepay_review_center_allowed(uuid)',        '636cb33ff0feaf95244ef0c41c3eb923'),
      ('public.nicepay_review_center_member_allowed(uuid)', 'a3a299f743087d104ebf41948e464d94'),
      ('public.nicepay_review_guard_center()',              '0e8dc90f9da6cb921225657ba6ae4fb4')) as t(sig, pre_md5)
  loop
    if md5(pg_get_functiondef(to_regprocedure(r.sig))) <> r.pre_md5 then raise warning '롤백 복원 확인: % 의 정의가 적용 전 운영 값과 달라요(해시 %) — 확인이 필요해요', r.sig, md5(pg_get_functiondef(to_regprocedure(r.sig))); end if;
  end loop;
end $$;
COMMIT;
