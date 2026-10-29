-- 읽기 전용 검증 (적용 후) — 첫 번째 결과는 모두 true 여야 한다.
select
  (select d like '%-- pg_refund_amount begin%' and d like '%-- pg_refund_amount end%' from (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d) x) as refund_amount_patch_present_must_be_true,
  (select d like '%-- pg_unknown_origin_guard begin%' and d like '%-- pg_server_path_guard begin%' from (select pg_get_functiondef('public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure) d) x)  as prior_guards_still_present_must_be_true,
  (select d like '%-- pg_origin_ambiguity begin%' and d like '%-- pg_origin_context begin%' from (select pg_get_functiondef('public.pg_refund_context(uuid,uuid)'::regprocedure) d) x)                          as context_patch_present_must_be_true,
  (select prosecdef and 'search_path=public' = any (proconfig) from pg_proc where oid = 'public._refund_membership_core(uuid,uuid,boolean,boolean)'::regprocedure)                                             as core_secdef_pinned_must_be_true,
  (select prosecdef and 'search_path=public' = any (proconfig) from pg_proc where oid = 'public.pg_refund_context(uuid,uuid)'::regprocedure)                                                                    as context_secdef_pinned_must_be_true,
  not has_function_privilege('authenticated', 'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')
    and not has_function_privilege('service_role', 'public._refund_membership_core(uuid,uuid,boolean,boolean)', 'execute')                                                                                     as core_not_directly_callable_must_be_true;

-- 참고(읽기 전용 점검, 데이터는 바꾸지 않는다): 과거에 이미 환불된 PG 수강권 중 "환불 행 금액 합 ≠ -(PG 원거래 금액)" 인 건.
-- 0행이 이상적이다. 행이 나오면 이번 패치 이전의 최근-행 계산 때문일 수 있으니 개별 확인(PG 콘솔 취소 금액과 대조)하세요.
select m.id as membership_id, m.profile_id, o.pg_amount, r.refund_amount
from memberships m
join lateral (select pa.total_amount as pg_amount from payments pa left join orders oa on oa.id = pa.order_id
               where pa.membership_id = m.id and pa.sale_type is distinct from 'refund' and pa.total_amount > 0
                 and ((oa.payment_provider is not null and oa.payment_provider <> 'mock')
                      or (pa.payment_provider is not null and pa.payment_provider <> 'mock')
                      or (pa.pg_transaction_id is not null and pa.pg_transaction_id not like 'mock!_%' escape '!'))
               order by pa.paid_at desc limit 1) o on true
join lateral (select coalesce(sum(-pr.total_amount), 0) as refund_amount from payments pr where pr.membership_id = m.id and pr.sale_type = 'refund') r on true
where m.status = 'refunded' and r.refund_amount <> o.pg_amount;
