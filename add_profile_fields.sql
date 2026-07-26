-- ============================================================
-- 프로필 선택 정보 + 프로필 사진
--
-- 하는 일:
--   1) profiles 에 선택 입력 컬럼 추가 (성별/발사이즈/연락처/사진/메모)
--   2) 프로필 사진용 Storage 버킷 안내
--
-- profiles 수정 정책은 기존 "본인 프로필 수정" 그대로 사용합니다.
-- ============================================================

alter table profiles add column if not exists nickname text;
alter table profiles add column if not exists gender text;
alter table profiles add column if not exists shoe_size text;
alter table profiles add column if not exists phone text;
alter table profiles add column if not exists avatar_url text;
alter table profiles add column if not exists memo text;


-- ============================================================
-- ⚠️ 프로필 사진 버킷 만들기 (대시보드에서, SQL 아님):
--   1. Supabase → Storage → New bucket
--   2. Name: avatars
--   3. Public bucket: ★켜기(ON)★  (사진은 공개 URL로 표시)
--   4. Create
--
-- 그 다음 아래 정책 SQL 실행 (버킷 만든 뒤에):
-- ============================================================

drop policy if exists "아바타 업로드" on storage.objects;
create policy "아바타 업로드"
    on storage.objects for insert
    with check (bucket_id = 'avatars' and auth.role() = 'authenticated');

drop policy if exists "아바타 조회" on storage.objects;
create policy "아바타 조회"
    on storage.objects for select
    using (bucket_id = 'avatars');


-- ============================================================
-- 확인
-- ============================================================
select column_name from information_schema.columns
where table_name = 'profiles'
  and column_name in ('nickname','gender','shoe_size','phone','avatar_url','memo');


-- ============================================================
-- 완료!
--   → 마이페이지 → 프로필 수정 → 사진·성별·발사이즈 등 입력
-- ============================================================
