-- ============================================================
-- P2-31 — pass.autobook(요일반 자동배치) 실제 권한 연결
--
-- 배경: "미배치 목록에서 재배치" 버튼(retryAutoBook)이 auto_book_membership()을 직접
-- 호출하는데, 이 함수는 my_managed_center_ids()(그 센터 관리자면 누구나)로만 막혀
-- 있어서 pass.autobook 카탈로그 키가 지금까지 아무 효과가 없었다.
--
-- auto_book_membership() 자체는 건드리지 않는다 — 이 함수는 fulfill_order() 내부
-- 호출(주문 확정 시 요일반 수강권 자동 예약) 경로도 같이 쓰는데, 그 경로는 이미
-- pass.payment.create로 보호돼 있다(P1-5b). 여기에 pass.autobook을 추가로 요구하면
-- pass.autobook을 못 받은 스태프가 주문 확정 자체를 못 하게 되는 의도치 않은
-- 회귀가 생긴다. 대신 "수동 재시도" 액션만 별도 wrapper RPC로 감싸 그 경로에만
-- 권한을 건다 — auto_book_membership()/fulfill_order()의 라이브 정의는 완전히
-- 그대로 유지한다.
--
-- ⚠ 동작 변경 주의: pass.autobook을 아직 역할에 안 준 기존 스태프는 더 이상
--   "미배치 목록에서 재배치" 버튼을 못 쓰게 된다. 오너는 영향 없음(자동 부여됨,
--   add_new_permissions.sql). 주문 확정 시 자동배치는 이 변경과 무관하게 그대로 동작.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

create or replace function retry_auto_book_membership_safe(p_membership_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id uuid;
begin
    select center_id into v_center_id from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    if not (has_permission(v_center_id, 'pass.autobook') or is_platform_admin()) then
        raise exception '요일반 자동배치를 실행할 권한이 없어요';
    end if;

    return auto_book_membership(p_membership_id);
end;
$$;

revoke all on function retry_auto_book_membership_safe(uuid) from public;
revoke all on function retry_auto_book_membership_safe(uuid) from anon;
grant execute on function retry_auto_book_membership_safe(uuid) to authenticated;

-- ============================================================
-- 확인
-- ============================================================
select proname from pg_proc where proname = 'retry_auto_book_membership_safe';
