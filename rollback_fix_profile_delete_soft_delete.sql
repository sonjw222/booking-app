-- fix_profile_delete_soft_delete.sql 롤백
-- 주의: 컬럼을 지우면 그 사이 삭제(익명화)된 프로필들의 deleted_at 기록이 사라진다
-- (개인정보 필드는 이미 익명화돼 되돌릴 수 없으므로, 이 롤백은 "삭제됨" 표시만 잃는다).
alter table profiles drop column if exists deleted_at;
