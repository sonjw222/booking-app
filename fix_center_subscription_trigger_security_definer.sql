-- ============================================================
-- create_default_center_subscription() 트리거 함수에 security definer 추가
--
-- [배경] add_center_platform_subscription.sql(2026-08-26, 라이브 적용 완료 —
-- center_subscriptions 466행으로 백필 확인됨)의 원래 판단: "센터 생성이 이미
-- security definer RPC인 register_center_for_account_safe() 안에서만 일어나므로
-- create_default_center_roles()와 동일하게 security definer가 필요 없다."
--
-- 이 가정이 실제로는 깨져 있었다 — CI에서 2026-08-25~26 하루 동안 완전히 무관한
-- PR 5개(#99, #102, #103, #104, main push 검증)에서 전부
-- tests/integration/manager-centers-privilege-escalation.test.ts의 다음 케이스들이
-- 동일하게 42501(permission denied)로 실패:
--   - "D+K: 막 만든 센터에 self-insert(role_id null, status active) 후 오너 role로
--      self-UPDATE 전환까지 성공한다"
--   - "부트스트랩 재시도 방지: 이미 자기 오너 행이 있는 센터에 같은 계정으로 다시
--      self-insert하면 거부된다"
--   - "J: userB가 자기 소유의 다른 센터를 새로 만들어 그 오너 role_id를 얻은 뒤,
--      centerA의 자기 행에 그 role_id를 주입해도 거부된다"
-- 각 PR의 diff는 CSS/문서/confirm() 마이그레이션뿐이라 코드 회귀가 아님을 확인했고,
-- 조사 결과 원인은 이 트리거였다: 테스트가 register_center_for_account_safe() RPC를
-- 거치지 않고 일반 인증 클라이언트로 centers에 직접 insert하는 시나리오를 검증하는데,
-- 이 트리거가 발동하며 center_subscriptions에 insert를 시도하고 그 테이블엔 INSERT
-- policy가 전혀 없어(의도적 설계 — service_role/security definer RPC 전용) 42501로
-- 막혔다. AFTER ROW 트리거의 미처리 예외는 원본 centers INSERT 전체를 롤백시켜,
-- "정상적인 최초 오너 bootstrap" 시나리오까지 연쇄로 실패시켰다.
--
-- [수정] security definer로 바꿔 함수 소유자(postgres, BYPASSRLS) 권한으로 실행되게
-- 한다 — 이 함수는 새 센터에 기본 구독 행 하나를 넣는 것 외 다른 입력을 받지 않고,
-- 외부 인자 없이 트리거 컨텍스트(NEW.id)만 쓰므로 안전하다. WHERE/로직은 원문과
-- 완전히 동일 — 오직 함수 실행 권한 컨텍스트만 바뀐다.
--
-- 프로젝트 규칙(CLAUDE.md)에 따라 이미 적용된 add_center_platform_subscription.sql을
-- 직접 고치지 않고 이 fix 파일로 CREATE OR REPLACE만 다시 실행한다(여러 번 실행해도
-- 안전 — 함수 재정의뿐, 테이블/데이터 변경 없음).
-- ============================================================

create or replace function create_default_center_subscription()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_plan_id uuid;
begin
    select id into v_plan_id
    from subscription_plans
    where is_active
    order by created_at asc
    limit 1;

    if v_plan_id is not null then
        insert into center_subscriptions (center_id, plan_id, status)
        values (new.id, v_plan_id, 'pending_billing_setup')
        on conflict (center_id) do nothing;
    end if;

    return new;
end;
$$;

-- ------------------------------------------------------------
-- 적용 후 확인 (read-only)
-- ------------------------------------------------------------
select pg_get_functiondef('create_default_center_subscription()'::regprocedure);
