-- ============================================================
-- 수업매출 캘린더 기능 [2/4]: 회차별 금액 커스텀 RPC
--
-- set_membership_session_amounts(p_membership_id, p_amounts): 매니저가 횟수제
-- 수강권의 회차별(1회차..N회차) 금액을 비대칭으로 지정한다(예: "1~2회차는 5만5천원,
-- 3~5회차는 3만원"). p_amounts[i]가 (i+1)회차 금액(1-based, 배열은 postgres 기준
-- 1-indexed이므로 p_amounts[1]이 1회차).
--
-- 검증 두 가지(둘 다 실패 시 트랜잭션 전체 롤백):
--   1) 배열 길이 = memberships.total_count (회차 수가 정확히 맞아야 함)
--   2) sum(p_amounts) = 그 membership_id에 연결된 payments.total_amount 합계
--      (매출 총액이 회차별 분배 후에도 원래 결제금액과 정확히 일치해야 함 — 안 맞으면
--      캘린더에 표시되는 합계가 실제 매출과 어긋나는 회계 오류가 된다)
-- 통과하면 기존 오버라이드를 지우고 새로 전부 insert(부분 업데이트 아님 — 항상 전체
-- 회차를 다시 지정).
--
-- 권한: has_permission(membership.center_id, 'pass.payment.update') — 기존 "결제
-- 수정" 권한을 그대로 재사용(회차별 금액도 결제 관련 데이터 수정이라 새 권한 키를
-- 만들지 않음).
--
-- [영향받는 기존 데이터] 없음(신규 함수 추가만).
-- [위험도] 낮음 — 위 두 검증이 통과해야만 쓰기가 일어나고, 실패 시 전체 롤백.
--
-- 여러 번 실행해도 안전.
-- ============================================================

BEGIN;

create or replace function set_membership_session_amounts(p_membership_id uuid, p_amounts int[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center_id  uuid;
    v_total_count int;
    v_paid_total  int;
    v_amounts_sum int;
    i             int;
begin
    select center_id, total_count into v_center_id, v_total_count
    from memberships where id = p_membership_id;
    if v_center_id is null then
        raise exception '수강권을 찾을 수 없어요';
    end if;

    if not has_permission(v_center_id, 'pass.payment.update') then
        raise exception '이 수강권의 회차별 매출을 수정할 권한이 없어요';
    end if;

    if v_total_count is null or v_total_count < 1 then
        raise exception '횟수제가 아닌 수강권은 회차별 금액을 지정할 수 없어요';
    end if;
    if coalesce(array_length(p_amounts, 1), 0) <> v_total_count then
        raise exception '회차 수(%)가 이 수강권의 총 횟수(%)와 일치하지 않아요', coalesce(array_length(p_amounts, 1), 0), v_total_count;
    end if;

    v_amounts_sum := 0;
    for i in 1 .. array_length(p_amounts, 1) loop
        if p_amounts[i] is null or p_amounts[i] < 0 then
            raise exception '회차별 금액은 0 이상이어야 해요(%회차)', i;
        end if;
        v_amounts_sum := v_amounts_sum + p_amounts[i];
    end loop;

    select coalesce(sum(total_amount), 0) into v_paid_total
    from payments where membership_id = p_membership_id;

    if v_amounts_sum <> v_paid_total then
        raise exception '회차별 금액 합계(%)가 이 수강권의 총 결제금액(%)과 일치하지 않아요', v_amounts_sum, v_paid_total;
    end if;

    delete from membership_session_amounts where membership_id = p_membership_id;
    for i in 1 .. array_length(p_amounts, 1) loop
        insert into membership_session_amounts (membership_id, session_index, amount)
        values (p_membership_id, i, p_amounts[i]);
    end loop;
end;
$$;

revoke all on function set_membership_session_amounts(uuid, int[]) from public;
revoke all on function set_membership_session_amounts(uuid, int[]) from anon;
grant execute on function set_membership_session_amounts(uuid, int[]) to authenticated;

COMMIT;

-- ============================================================
-- 확인(읽기 전용)
-- ============================================================
select pg_get_functiondef('set_membership_session_amounts(uuid, int[])'::regprocedure);
select grantee, privilege_type
  from information_schema.routine_privileges
 where routine_name = 'set_membership_session_amounts';
