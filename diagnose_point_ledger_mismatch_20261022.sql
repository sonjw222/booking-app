-- 읽기 전용 점검(쓰기 없음) — 옛 장부(point_accounts/point_logs)와 통합 원장(point_transactions)의 차이.
-- 결과는 센터·프로필별 비교표다. 기존 포인트를 합산하거나 삭제·이관하지 않는다(이관안은 proposed_migrate_legacy_review_points_20261022.sql, 별도 승인).
select
  coalesce(pa.center_id, tx.center_id)   as center_id,
  coalesce(pa.profile_id, tx.profile_id) as profile_id,
  pa.balance                              as legacy_balance,                 -- 옛 장부 현재 잔액
  coalesce(lg.review_rewards, 0)          as legacy_review_reward_count,     -- 옛 장부에 기록된 후기 보상 횟수(point_logs.reason='review')
  coalesce(lg.review_amount, 0)           as legacy_review_reward_amount,
  coalesce(tx.balance, 0)                 as unified_balance,                -- 통합 원장 잔액(회원이 실제로 보는 값)
  coalesce(tx.review_rewards, 0)          as unified_review_reward_count,
  coalesce(tx.migrated_legacy, 0)         as already_migrated_from_legacy    -- 'P1-1 레거시 포인트 이관' 등으로 이미 옮겨진 합계
from (select center_id, profile_id, balance from point_accounts where balance <> 0) pa
full join (
  select center_id, profile_id, sum(amount) as balance,
         count(*) filter (where reason = '후기 작성 적립') as review_rewards,
         coalesce(sum(amount) filter (where reason like '%레거시%'), 0) as migrated_legacy
  from point_transactions group by center_id, profile_id
) tx on tx.center_id = pa.center_id and tx.profile_id = pa.profile_id
left join (
  select center_id, profile_id, count(*) as review_rewards, sum(amount) as review_amount
  from point_logs where reason = 'review' group by center_id, profile_id
) lg on lg.center_id = coalesce(pa.center_id, tx.center_id) and lg.profile_id = coalesce(pa.profile_id, tx.profile_id)
where coalesce(pa.balance, 0) <> 0 or coalesce(lg.review_rewards, 0) > 0
order by center_id, profile_id;
