-- ============================================================
-- NICEPAY 심사 종료 절차(2026-10-29) — 검토용 초안, 운영 미실행. 심사가 끝나면 SQL Editor 에서 위에서 아래로 실행한다.
-- 목적: 심사관 전용 권한을 해제하고, NICEPAY 결제 게이트를 닫고, 심사 센터를 일반 회원에게 보이지 않게 닫는다. 데이터는 삭제하지 않는다.
-- 순서가 중요하다: 센터를 먼저 닫은 뒤에만 분리 SQL 을 롤백할 수 있다(롤백 스크립트는 공개 가능한 심사 센터가 있으면 중단한다).
-- 이 파일이 바꾸는 것(실행 순서): ① 게이트 off ② 진행 중 승인(approving) 확인(알림만) ③ 심사관 권한 해제 ④ 심사 센터 비공개(is_internal=true — centers.status 는 플랫폼 관리자만 바꿀 수 있어 SQL Editor 로는 못 바꿈) ⑤ 남은 대기 주문 취소 ⑥ 일반 회원 노출 관계 확인(파일 끝 확인 쿼리).
-- 한 트랜잭션이라 중간에 실패하면 게이트·권한·센터·주문이 모두 원래대로 돌아온다. 반복 실행해도 안전하다(이미 닫힌 상태면 0건 갱신).
-- ⚠ 심사 센터에 일반 회원 관계(center_members 등)가 남아 있으면, 센터를 닫아도 P2 분리 정책을 롤백하는 순간 그 회원에게 심사 센터가 보인다(기존 센터 조회 정책: 내부 센터도 등록 회원에게 허용). 그 경우 P2 롤백 SQL 이 스스로 중단한다. 관계 데이터는 이 파일이 지우지 않는다.
-- 바꾸지 않는 것: 기존 운영 센터·상품·주문·수강권·예약, 토스 심사 계정(pg_checkout_override), 심사 중 생긴 주문·수강권·결제 기록(보존 — 환불은 기존 환불 절차).
-- ============================================================
begin;
-- ① NICEPAY 결제 게이트 닫기(신규 주문 생성·승인 선점 거부. 진행 중 거래의 마무리·취소·환불은 계속 가능) — 가장 먼저 닫아 이후 단계 동안 새 승인 선점이 시작되지 않게 한다
update nicepay_checkout_gate set mode = 'off', updated_at = now() where id;
-- ② 진행 중 승인 확인(알림만, 중단하지 않음): approving 주문은 승인/취소/release 로 해소돼야 하며 이 파일은 건드리지 않는다. 남아 있으면 P2b 롤백도 중단된다.
do $$ declare n int; begin select count(*) into n from orders where payment_provider = 'nicepay' and status = 'approving'; if n > 0 then raise notice '진행 중(approving) NICEPAY 주문 %건 — 해소(승인 확정·취소·release)된 뒤에 P2b/P2 롤백을 진행하세요.', n; end if; end $$;
-- ③ 심사관 전용 권한 해제 (이 컬럼은 NICEPAY 전용 — 토스 심사 계정의 pg_checkout_override 는 건드리지 않는다)
update accounts set nicepay_review_access = false where nicepay_review_access;
-- ④ 심사 센터 비공개: 일반 회원·비회원·옛 심사관 누구에게도 보이지 않는다(센터 하나를 닫으면 상품·수업 직접 조회도 막힌다)
update centers set is_internal = true where is_nicepay_review;
-- ⑤ 심사 센터의 미결제 대기 주문 정리. 진행 중인 결제·승인 선점에는 영향을 주지 않는다:
--    · NICEPAY 승인 선점(nicepay_claim_order)은 주문을 pending → approving 으로 바꾸고, 승인 결과 불명 검토(pg_review_at)·PG 거래번호(pg_tid)도 approving 상태에 붙는다.
--      아래 조건은 status = 'pending' 이고 선점·거래·검토 흔적(pg_claim_id·pg_tid·pg_review_at)이 전혀 없는 주문만 고른다 → approving/paid/done 은 건드리지 않는다.
--    · ① 에서 게이트를 이미 off 로 닫았으므로 새 승인 선점은 시작되지 않는다. 같은 행을 동시에 선점하려는 트랜잭션과는 행 잠금으로 직렬화되고, 선점이 먼저면 이 UPDATE 의 status 조건이 다시 평가돼 건너뛴다.
--    · 직접결제(direct) 대기 주문은 센터 확인 전 주문이라 같이 정리된다(결제 완료·확인된 주문은 status 가 달라 제외).
update orders set status = 'cancelled'
 where status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null
   and center_id in (select id from centers where is_nicepay_review);
commit;

-- 확인(읽기 전용) — 모두 기대값이어야 한다
select
  (select count(*) from accounts where nicepay_review_access)                                   as reviewers_must_be_0,
  (select mode from nicepay_checkout_gate where id)                                              as gate_mode_must_be_off,
  (select count(*) from centers where is_nicepay_review and not is_internal and status = 'approved') as publicly_visible_review_centers_must_be_0,
  (select count(*) from orders where status = 'pending' and pg_claim_id is null and pg_tid is null and pg_review_at is null and center_id in (select id from centers where is_nicepay_review)) as pending_review_orders_must_be_0,
  (select count(*) from orders where status = 'approving' and center_id in (select id from centers where is_nicepay_review)) as in_flight_approving_orders_info,   -- 0 이 아니면 진행 중 승인이 끝난 뒤(approving 이 해소된 뒤) 롤백을 진행한다
  (select count(*) from accounts where pg_checkout_override)                                     as toss_override_accounts_unchanged;
-- 심사 중 생긴 결제 기록(참고): 환불·보존 판단용
select o.status, count(*) from orders o join centers c on c.id = o.center_id where c.is_nicepay_review group by 1 order by 1;
-- ⑥ 일반 회원 노출 관계(읽기 전용): 0 이 아니면 P2 분리 정책 롤백이 차단된다(권장: 롤백하지 않고 P2 를 그대로 둔다. 롤백이 필요하면 관계 정리 방법을 먼저 승인받는다).
select
  (select count(*) from center_members cm join centers c on c.id = cm.center_id where c.is_nicepay_review) as review_center_member_rows_block_p2_rollback_if_nonzero,
  (select count(*) from memberships m join centers c on c.id = m.center_id where c.is_nicepay_review) as review_center_memberships_info,
  (select count(*) from manager_centers mc join centers c on c.id = mc.center_id where c.is_nicepay_review) as review_center_manager_rows_info_intended_access;
