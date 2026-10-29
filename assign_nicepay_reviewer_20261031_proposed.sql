-- NICEPAY 심사관 전용 권한 지정 — 제안(2026-10-31), ⚠ 실행하지 않았다. 별도 승인 후 SQL Editor 에서 실행.
-- 이 컬럼은 NICEPAY 전용이다: 토스 심사 계정(pg_checkout_override)은 건드리지 않는다. 이메일은 사용자가 확정한다(아래 placeholder).
-- ⚠ 주의: 심사관 계정은 센터를 "회원으로" 볼 때 심사 센터만 보인다(운영 센터는 회원 화면·탐색에서 숨겨짐). 평소 운영자가 쓰는 계정(예: 센터를 관리하는 계정)에 지정하면 그 계정의 회원 화면 사용이 심사 기간 동안 제한된다 → 심사 전용 별도 계정 권장.
begin;
update accounts set nicepay_review_access = true
 where auth_id = (select id from auth.users where lower(email) = lower('<심사관 이메일 확정 필요>'));
commit;
-- 확인(읽기 전용): 정확히 1행, 다른 계정 변화 없음
select (select count(*) from accounts where nicepay_review_access) as reviewer_accounts_must_be_1,
       (select count(*) from accounts where pg_checkout_override) as toss_override_accounts_unchanged;
-- 되돌리기(심사 종료): close_nicepay_review_20261029.sql 이 권한 해제·게이트 off·센터 비공개를 한 번에 처리한다.
