-- 격리 환경 baseline 선행 단계: 로컬 Supabase 이미지는 public 스키마의 새 함수/테이블/시퀀스에 anon·authenticated 권한을 기본으로 부여한다.
-- 공유 DEV(및 baseline 덤프의 REVOKE/GRANT)는 객체마다 명시적으로 권한을 정하므로, 기본 부여를 먼저 걷어내 덤프의 ACL 이 그대로 재현되게 한다
-- (예: confirm_real_payment 는 service_role 만 실행 가능해야 한다). baseline 덤프 끝의 ALTER DEFAULT PRIVILEGES 가 DEV 의 기본 권한을 다시 세운다.
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;
