-- 격리 환경 baseline: Storage 정책 (공유 DEV mwhabit-ci-dev 의 storage.objects 정책 구조를 읽기 전용으로 확인해 재작성. 데이터 없음)
-- 버킷(avatars, alimtalk-images 공개 / business-licenses 비공개)은 config.toml 의 [storage.buckets.*] 가 만든다.
create policy "사업자등록증 업로드" on storage.objects for insert to public with check (bucket_id = 'business-licenses' and auth.role() = 'authenticated');
create policy "사업자등록증 조회" on storage.objects for select to public using (bucket_id = 'business-licenses' and (public.is_platform_admin() or owner = auth.uid()));
create policy "아바타 삭제" on storage.objects for delete to public using (bucket_id = 'avatars' and owner = auth.uid());
create policy "아바타 업로드" on storage.objects for insert to public with check (bucket_id = 'avatars' and auth.role() = 'authenticated');
create policy "아바타 조회" on storage.objects for select to public using (bucket_id = 'avatars');
create policy "알림톡사진 업로드" on storage.objects for insert to public with check (bucket_id = 'alimtalk-images' and auth.role() = 'authenticated');
create policy "알림톡사진 조회" on storage.objects for select to public using (bucket_id = 'alimtalk-images');
