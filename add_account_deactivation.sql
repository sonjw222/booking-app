-- 계정 탈퇴(소프트 삭제) 지원.
--
-- accounts/profiles/reservations/orders 등 기존 행은 전혀 지우지 않는다(회계·환불 근거,
-- 매니저 쪽 매출/출석 통계가 탈퇴 이후에도 깨지지 않게 하기 위함 — CLAUDE.md 규칙 3:
-- 사용자 승인 없이 기존 데이터를 지우지 않는다). 대신 accounts.deactivated_at만 채운다.
--
-- 실제 로그인 차단(auth.users의 banned_until, Admin API)과 활성 세션 종료는
-- supabase/functions/delete-account가 service_role로 처리한다 — 이 컬럼은 그 결과를 앱이
-- UI에서 판단(재로그인 유도, "탈퇴한 계정이에요" 안내, 향후 명단 노출 여부 등)하는 용도다.
--
-- RLS: 기존 "본인 계정 수정" 정책(auth_id = auth.uid())이 이 컬럼도 그대로 허용하므로
-- 별도 정책 추가가 필요 없다.

alter table accounts
    add column if not exists deactivated_at timestamptz;

comment on column accounts.deactivated_at is
    '계정 탈퇴(소프트 삭제) 시각. null이면 활성 계정. 실제 로그인 차단은 auth.users.banned_until(Admin API)로 별도 처리됨(supabase/functions/delete-account, add_account_deactivation.sql).';
