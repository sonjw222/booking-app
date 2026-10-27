-- ============================================================
-- NICEPAY 주문 생성 DB 게이트(2026-10-17) — 검토용 초안, DEV/Production 미실행. 새 테이블/함수/트리거만 추가한다(기존 데이터·함수 정의 불변).
--
-- 문제: 결제 기능이 꺼져 있어도(앱의 4중 잠금) DB는 클라이언트가 만든 payment_provider='nicepay' 대기 주문을 받아들인다.
--   · orders INSERT RLS("주문 본인 생성")는 provider 값을 제한하지 않는다 → add_nicepay_provider_support로 CHECK가 'nicepay'를 허용하는 순간 로그인 회원이 PostgREST로 직접 NICEPAY 대기 주문을 만들 수 있다.
--   · create_order_secure(authenticated 실행 가능, 라이브 전용 정의)에 'nicepay'를 허용(fix_create_order_secure_allow_nicepay)하면 RPC로도 가능하다.
--   앱 잠금(코드 상수/환경변수/API 계열/자격증명)은 서버 코드의 잠금이라 DB 입구를 막지 못한다. 비활성 상태의 NICEPAY 대기 주문은 포인트·쿠폰을 점유한 채 남고, 활성화 순간 승인 가능한 주문이 된다.
-- 해결(주문 생성 정책 = DB 게이트): nicepay_checkout_gate.mode ∈ off(기본) / reviewer / public (클라이언트 롤 접근 불가). orders BEFORE INSERT 트리거가
--   "클라이언트 요청(auth.uid() 있음 또는 요청 롤 anon/authenticated)이 provider='nicepay' 주문을 만들려 할 때" 모드로 판단한다(위반 시 42501):
--     off      : 아무도 못 만든다.
--     reviewer : 심사용 계정(accounts.pg_checkout_override = true, 관리자만 설정 가능 — add_pg_checkout_reviewer_override.sql)의 프로필 주문만 허용. 일반 회원에게는 NICEPAY 주문이 만들어지지 않는다.
--     public   : 모든 로그인 회원 허용.
--   앱의 노출 정책(runtime.ts nicepayGate)과 같다: NEXT_PUBLIC_PG_CHECKOUT_ENABLED="true" ↔ public, 그 외 + 심사 계정 override ↔ reviewer.
--   트리거는 RLS 직접 INSERT와 create_order_secure(SECURITY DEFINER여도 `role` 설정값은 호출 롤 유지)를 모두 덮는다. RPC가 INSERT 전에 포인트·쿠폰을 처리했더라도 같은 트랜잭션이라 예외로 전부 롤백된다.
--   서버(service_role/롤 미설정 소유자)의 주문 생성은 막지 않는다 — 서버 경로는 앱의 4중 잠금이 담당한다.
-- 5중 잠금의 일치: 앱 4중(코드 상수 · NICEPAY_CHECKOUT_ENABLED · API_FAMILY · 계열 자격증명/반환 URL) + DB 게이트. DB 모드는 항상 앱 노출보다 넓지 않게(앱이 reviewer 범위면 DB도 reviewer) 맞춘다. 끄면(off) 새 클라이언트 주문이 즉시 막힌다.
-- 게이트 변경은 소유자(SQL Editor)만 한다(service_role에도 UPDATE 권한 없음). 모든 변경은 추가 전용 감사 테이블에 남는다.
--   심사 오픈: update nicepay_checkout_gate set mode = 'reviewer', updated_at = now() where id;   전체 오픈: mode = 'public';   끄기: mode = 'off'
-- 변경하지 않는 것: 기존 주문/결제 데이터, mock·toss·portone·직접결제 주문 생성(provider가 nicepay가 아니면 통과), create_order_secure 본문, 다른 트리거.
-- 순서: 이 파일 → add_nicepay_provider_support → fix_create_order_secure_allow_nicepay (뒤 둘은 이 게이트가 없으면 스스로 중단). 독립 적용 가능(NICEPAY CHECK 유무와 무관).
-- 롤백: rollback_add_nicepay_checkout_gate_20261017.sql. 검증: verify_add_nicepay_checkout_gate_20261017.sql(읽기 전용).
-- ============================================================
begin;

create table if not exists nicepay_checkout_gate (
    id          boolean primary key default true check (id),
    mode        text not null default 'off' check (mode in ('off', 'reviewer', 'public')),
    updated_at  timestamptz not null default now(),
    updated_by  text not null default current_user
);
alter table nicepay_checkout_gate enable row level security;
revoke all on table nicepay_checkout_gate from public, anon, authenticated;
grant select on table nicepay_checkout_gate to service_role;

create table if not exists nicepay_checkout_gate_audit (
    id           bigint generated always as identity primary key,
    mode         text not null,
    changed_at   timestamptz not null default now(),
    changed_by   text not null default current_user,
    session_role text not null default coalesce(nullif(current_setting('role', true), ''), 'none')
);
alter table nicepay_checkout_gate_audit enable row level security;
revoke all on table nicepay_checkout_gate_audit from public, anon, authenticated;
grant select on table nicepay_checkout_gate_audit to service_role;
revoke all on sequence nicepay_checkout_gate_audit_id_seq from public, anon, authenticated;

create or replace function nicepay_checkout_gate_audit_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into nicepay_checkout_gate_audit (mode) values (new.mode);
    return new;
end;
$$;
revoke all on function nicepay_checkout_gate_audit_fn() from public, anon, authenticated;
drop trigger if exists nicepay_checkout_gate_audit on nicepay_checkout_gate;
create trigger nicepay_checkout_gate_audit
    after insert or update on nicepay_checkout_gate
    for each row execute function nicepay_checkout_gate_audit_fn();

create or replace function nicepay_checkout_gate_immutable_fn()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    raise exception '게이트 행/감사 기록은 삭제하거나(감사 기록은 수정도) 할 수 없어요' using errcode = '42501';
end;
$$;
revoke all on function nicepay_checkout_gate_immutable_fn() from public, anon, authenticated;
drop trigger if exists nicepay_checkout_gate_no_delete on nicepay_checkout_gate;
create trigger nicepay_checkout_gate_no_delete before delete on nicepay_checkout_gate for each row execute function nicepay_checkout_gate_immutable_fn();
drop trigger if exists nicepay_checkout_gate_audit_append_only on nicepay_checkout_gate_audit;
create trigger nicepay_checkout_gate_audit_append_only before update or delete on nicepay_checkout_gate_audit for each row execute function nicepay_checkout_gate_immutable_fn();

insert into nicepay_checkout_gate (id, mode) values (true, 'off') on conflict (id) do nothing;   -- (감사 트리거 설치 뒤에 시드 — 시드도 감사 기록에 남는다) 새로 만들 때만 off로 시드, 이미 있으면 값 보존

create or replace function nicepay_checkout_mode()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select mode from nicepay_checkout_gate where id), 'off');
$$;
revoke all on function nicepay_checkout_mode() from public, anon, authenticated;
grant execute on function nicepay_checkout_mode() to service_role;

create or replace function orders_guard_nicepay_create()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_mode text;
begin
    if new.payment_provider = 'nicepay'
       and (auth.uid() is not null or coalesce(nullif(current_setting('role', true), ''), 'none') in ('anon', 'authenticated')) then
        v_mode := nicepay_checkout_mode();
        if v_mode = 'public' then
            return new;
        end if;
        if v_mode = 'reviewer' and exists (select 1 from profiles p join accounts a on a.id = p.account_id where p.id = new.profile_id and a.pg_checkout_override) then
            return new;
        end if;
        raise exception 'NICEPAY 결제는 아직 사용할 수 없어요' using errcode = '42501';
    end if;
    return new;
end;
$$;
revoke all on function orders_guard_nicepay_create() from public, anon, authenticated;
drop trigger if exists orders_guard_nicepay_create on orders;
create trigger orders_guard_nicepay_create
    before insert on orders
    for each row execute function orders_guard_nicepay_create();

commit;
