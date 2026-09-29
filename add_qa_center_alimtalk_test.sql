-- ============================================================
-- QA용 센터 준비 — 알림톡 템플릿 테스트 전용(2026-09-29)
--
-- 목적: 최근 운영 DB 테스트 데이터 정리(2026-09-26/27 배치)로 등록된 센터가 사실상 없는
-- 상태다. 알림톡 템플릿 QA를 계속하려면 센터가 하나 필요한데, 앱이 이미 출시된 상태라
-- 일반 회원 검색/홈/추천에 노출되면 안 된다.
--
-- 새 컬럼을 추가하지 않는다 — 기존 스키마의 centers.status='pending'을 그대로 쓴다.
-- schema.sql 주석(19번째 줄 근처) 그대로: "pending 상태에서는 회원에게 센터/수업이
-- 노출되지 않음" — lib/home.ts/lib/center.ts의 모든 회원 대상 조회가 .eq("status",
-- "approved")로 걸려 있어(전수 확인), pending 센터는 홈/검색/추천 어디에도 나오지 않는다.
-- 매니저(오너) 쪽은 이 상태와 무관하게 수업/수강권/알림톡 설정을 전부 정상적으로 만들 수
-- 있다(app/components/PendingApprovalBanner.tsx — "승인 대기" 안내 배너만 뜨고 기능은
-- 막지 않음). 즉 "일반 사용자에게는 숨김 + 관리자 기능은 정상"이라는 목표에 기존 필드
-- 하나로 정확히 들어맞는다.
--
-- 대상 계정: sonjw8030@gmail.com (기존 운영 테스트 계정, 프로덕션 정리 후에도 보존된
-- 2개 계정 중 하나 — 다른 하나 sonjw222@naver.com은 Toss 심사용으로 예약돼 있어 쓰지 않는다).
-- 이 계정을 센터 오너(manager_centers)로 연결하고, 알림톡 실제 발송 테스트 대상이 필요할
-- 것을 대비해 같은 계정의 대표 프로필(is_primary=true)을 이 센터의 회원(center_members)
-- 으로도 등록한다(실제 전화번호가 있어 발송 테스트가 가능한 유일한 안전한 대상 — 새 가짜
-- 회원 계정을 만들지 않음).
--
-- 결제/실사용 예약 없음: products/classes/orders/payments를 전혀 만들지 않는다.
--
-- 실행 방식: 트랜잭션 하나. 중간에 어떤 전제(계정 존재, 계정이 실제로 sonjw8030인지,
-- 센터명이 아직 없는지 등)라도 어긋나면 즉시 rollback되고 아무것도 남지 않는다(raise
-- exception이 트랜잭션 전체를 되돌림 — 부분 삭제/부분 생성 없음).
--
-- 영향 예상 행 수: centers +1, center_roles +3(트리거 자동 생성, owner/manager/trainer),
-- manager_centers +1, center_members +1 = 총 6행 insert. 기존 행 UPDATE/DELETE 없음.
--
-- 실행 전 준비: 이 파일은 아직 production에 실행되지 않았다. 사용자가 검토 후 Supabase
-- SQL Editor(또는 `supabase db query --linked -f add_qa_center_alimtalk_test.sql`)에서
-- 직접 실행해야 한다. 실행 후 검증은 이 파일 맨 끝의 SELECT를 참고.
-- ============================================================

do $$
declare
    v_account_id uuid;
    v_profile_id uuid;
    v_center_id uuid := gen_random_uuid();
    v_owner_role_id uuid;
begin
    if exists (select 1 from centers where name = '[QA] 모하빗 알림톡 테스트 센터') then
        raise exception '이미 QA 센터가 존재해요 — 중복 생성을 막기 위해 중단합니다';
    end if;

    select a.id into v_account_id
    from accounts a
    join auth.users u on u.id = a.auth_id
    where lower(u.email) = 'sonjw8030@gmail.com';

    if v_account_id is null then
        raise exception 'sonjw8030@gmail.com 계정을 찾을 수 없어요 — 중단합니다(운영 데이터가 예상과 다름)';
    end if;

    -- 이 계정의 대표 프로필(본인) — 새 프로필을 만들지 않고 기존 것만 재사용.
    select id into v_profile_id
    from profiles
    where account_id = v_account_id and is_primary = true
    order by created_at asc
    limit 1;

    if v_profile_id is null then
        raise exception 'sonjw8030 계정의 대표 프로필을 찾을 수 없어요 — 중단합니다';
    end if;

    -- 센터 생성(트리거 trg_create_default_center_roles가 owner/manager/trainer 역할 3개를
    -- 같은 트랜잭션 안에서 자동 생성한다). status는 지정하지 않음 → 기본값 'pending'.
    insert into centers (id, name)
    values (v_center_id, '[QA] 모하빗 알림톡 테스트 센터');

    select id into v_owner_role_id
    from center_roles
    where center_id = v_center_id and role_key = 'owner';

    if v_owner_role_id is null then
        raise exception '오너 역할이 자동 생성되지 않았어요 — 트리거 확인 필요, 중단합니다';
    end if;

    insert into manager_centers (account_id, center_id, role_id, status)
    values (v_account_id, v_center_id, v_owner_role_id, 'active');

    -- 알림톡 템플릿 실제 발송 테스트 대상(최소 회원 1명) — 결제/수강권/예약은 만들지 않는다.
    insert into center_members (center_id, profile_id, status)
    values (v_center_id, v_profile_id, 'active');

    raise notice 'QA_CENTER_CREATED center_id=%', v_center_id;
end $$;

-- ============================================================
-- 실행 후 확인 — 아래를 그대로 다시 실행해 결과를 확인한다.
-- ============================================================
select
    c.id as center_id,
    c.name,
    c.status,                                    -- 기대값: pending(회원 화면에 노출 안 됨)
    (select count(*) from manager_centers mc where mc.center_id = c.id) as manager_links,  -- 기대값: 1
    (select count(*) from center_roles r where r.center_id = c.id) as roles,               -- 기대값: 3
    (select count(*) from center_members m where m.center_id = c.id) as members,           -- 기대값: 1
    (select count(*) from classes k where k.center_id = c.id) as classes,                  -- 기대값: 0
    (select count(*) from products p where p.center_id = c.id) as products,                -- 기대값: 0
    (select count(*) from orders o where o.center_id = c.id) as orders                     -- 기대값: 0
from centers c
where c.name = '[QA] 모하빗 알림톡 테스트 센터';
