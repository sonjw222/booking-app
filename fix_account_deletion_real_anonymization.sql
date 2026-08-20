-- ============================================================
-- 계정 탈퇴 정책 변경: 소프트 비활성화 → 실제 개인정보 익명화 + auth 계정 삭제
--
-- 배경: 기존 탈퇴(add_account_deactivation.sql)는 accounts.deactivated_at만 채우고
-- auth.users를 100년 밴하는 방식이었다 — 로그인만 막힐 뿐 이름/전화번호/이메일 등
-- 개인정보는 그대로 DB에 남아있었다. Apple/Google 앱스토어 심사 가이드라인은 "계정
-- 삭제"가 단순 비활성화로 끝나면 안 되고 개인정보를 실제로 지우거나 식별 불가능하게
-- 만들 것을 요구한다. supabase/functions/delete-account를 그렇게 재작성했고(별도 배포
-- 필요, 이 SQL과 무관), 이 파일은 **이미 그 예전 방식으로 탈퇴한 기존 계정**을 새 정책에
-- 맞춰 소급 적용한다(사용자 결정, 2026-08-19).
--
-- 재가입 정책(사용자 결정): 탈퇴 후 같은 전화번호/이메일/소셜 계정으로 재가입 허용 —
-- 그래서 익명화뿐 아니라 auth.users 행 자체를 삭제해 그 이메일/전화번호를 실제로
-- 풀어준다(대기기간 없음).
--
-- 지우지 않는 것(CLAUDE.md 규칙 3, 회계·법적 근거): reservations/orders/payments/
-- memberships는 그대로 유지 — 전자상거래법상 결제·청약철회 기록 보관 의무, 매니저 쪽
-- 매출/출석 통계 보존 목적. 이 기록들은 이제 익명화된 accounts/profiles를 통해
-- "탈퇴한 회원"으로만 보인다. center_members.app_email 같은 센터 자체 CRM 데이터는
-- 건드리지 않는다(우리 플랫폼이 아니라 센터가 자체 수집한 정보라 범위 밖).
--
-- ⚠️ 이 파일은 auth.users 행을 실제로 삭제합니다 — 되돌릴 수 없습니다(하단 rollback
-- 파일 설명 참고). 실행 전 아래 1번 결과로 대상이 몇 명인지, 누구인지 먼저 확인하세요.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전(멱등) — 이미
-- 익명화된 계정은 같은 값으로 다시 덮어쓸 뿐이고, 이미 삭제된 auth.users 행은 대상에서
-- 자연히 빠집니다.
-- ============================================================

-- 1) 대상 확인 (참고용 — 실행 결과를 먼저 눈으로 확인하세요)
select a.id, a.name, a.phone, a.deactivated_at, a.auth_id
from accounts a
where a.deactivated_at is not null;

-- 2) accounts 개인정보 익명화
update accounts
set name = '탈퇴한 회원', phone = null, address = null
where deactivated_at is not null;

-- 3) 그 계정들의 profiles 개인정보 익명화(가족 프로필 포함)
update profiles
set name = '탈퇴한 회원', nickname = null, phone = null, address = null,
    avatar_url = null, memo = null, birth_date = null, label = null
where account_id in (select id from accounts where deactivated_at is not null);

-- 4) auth.users 행 삭제 — 이메일/전화번호/소셜 계정을 실제로 풀어줌(재가입 허용).
--    auth 스키마 내부 테이블(identities/sessions 등)은 전부 ON DELETE CASCADE라
--    자동으로 함께 정리됨. accounts.auth_id는 FK 제약이 없어 안전하게 그대로 남는다.
delete from auth.users
where id in (select auth_id from accounts where deactivated_at is not null);

-- 5) 확인
select a.id, a.name, a.phone, a.address, a.deactivated_at,
       (select count(*) from auth.users u where u.id = a.auth_id) as auth_user_still_exists
from accounts a
where a.deactivated_at is not null;
