-- ============================================================
-- 알림톡 첨부 사진 Storage 설정 (add_profile_fields.sql의 avatars 버킷과 동일한 패턴)
--
-- ⚠️ 먼저 버킷을 만들어야 해요 (SQL Editor 아님, 대시보드에서):
--   1. Supabase 대시보드 → 왼쪽 메뉴 Storage
--   2. "New bucket" 클릭
--   3. Name: alimtalk-images
--   4. Public bucket: ★켜기(ON)★ (알림톡/SMS 대체발송 텍스트에 공개 URL로 실어 보내야 함)
--   5. Create
--
-- 그 다음, 아래 SQL을 SQL Editor에서 실행해 접근 정책을 추가하세요.
-- 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "알림톡사진 업로드" on storage.objects;
create policy "알림톡사진 업로드"
    on storage.objects for insert
    with check (bucket_id = 'alimtalk-images' and auth.role() = 'authenticated');

drop policy if exists "알림톡사진 조회" on storage.objects;
create policy "알림톡사진 조회"
    on storage.objects for select
    using (bucket_id = 'alimtalk-images');

-- ============================================================
-- 확인
-- ============================================================
select policyname, cmd from pg_policies
where schemaname = 'storage' and tablename = 'objects'
  and policyname like '알림톡사진%';
