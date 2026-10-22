-- ⚠ 제안안 — 자동 적용 금지. 검토·승인 후 별도 실행(포인트 이관은 스키마 수정과 분리).
-- 옛 장부(point_accounts)에 남은 후기 보상 잔액을 통합 원장으로 옮겨 회원이 쓸 수 있게 한다.
-- 중복·이중 지급 방지 설계:
--   · 이관액 = 옛 잔액 − 이미 이관된 합계(reason 에 '레거시'가 들어간 point_transactions). 재실행해도 0원이면 삽입하지 않는다(멱등).
--   · 옛 잔액이 이미 사용(use_points 옛 경로)돼 줄어든 경우는 줄어든 현재 잔액만 옮기므로 사용분을 되살리지 않는다.
--   · 이관 직후 옛 장부를 수정·삭제하지 않는다(별도 승인 전 보존). 같은 행을 두 번 합산하지 않도록 이관 이력은 reason 으로 구분한다.
--   · QA 회원(2000P/보상 2건)을 포함해 어떤 행을 옮길지는 diagnose_point_ledger_mismatch_20261022.sql 결과를 보고 사람이 정한다 — 아래 where 에서 대상을 명시 지정.
-- 실행 전: 동시 쓰기(결제 중 포인트 사용)가 없는 시간대에, 한 트랜잭션으로.
begin;
insert into point_transactions (profile_id, center_id, amount, reason)
select pa.profile_id, pa.center_id,
       pa.balance - coalesce((select sum(pt.amount) from point_transactions pt
                              where pt.profile_id = pa.profile_id and pt.center_id = pa.center_id and pt.reason like '%레거시%'), 0),
       'F13 레거시 후기 보상 이관'
from point_accounts pa
where pa.balance > 0
  -- and (pa.center_id, pa.profile_id) in ( ... 승인된 대상만 ... )   ← 반드시 대상을 지정할 것
  and pa.balance - coalesce((select sum(pt.amount) from point_transactions pt
                             where pt.profile_id = pa.profile_id and pt.center_id = pa.center_id and pt.reason like '%레거시%'), 0) > 0;
-- 확인 후 commit; 이상하면 rollback;
-- commit;
