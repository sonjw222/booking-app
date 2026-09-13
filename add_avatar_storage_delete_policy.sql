-- ============================================================
-- avatars 버킷에 DELETE RLS 정책 추가 (Privacy 배치 #6/#7)
--
-- 배경: add_profile_fields.sql이 avatars 버킷을 만들 때 INSERT("아바타 업로드")/
-- SELECT("아바타 조회") 정책만 추가하고 DELETE 정책은 아예 만들지 않았다 — 그 결과
-- 사용자 클라이언트(anon/authenticated 키)로는 avatar object를 지울 방법이 없었다.
-- supabase/functions/delete-account/index.ts(계정 탈퇴)가 그동안 avatar를 지울 수
-- 있었던 건 그 함수가 RLS를 완전히 우회하는 service_role(admin) 클라이언트를 쓰기
-- 때문이다 — 사용자 세션으로 직접 호출하는 lib/profiles.ts의 avatar 재업로드(#6)/
-- 가족 프로필 삭제(#7) 정리 로직은 이 정책이 없으면 전부 조용히 실패한다(RLS
-- deny-by-default).
--
-- storage.objects.owner는 Storage API로 업로드할 때 auth.uid()가 자동으로 채워진다
-- (읽기 전용 확인 쿼리로 avatars 버킷의 기존 7개 object 전부 owner/owner_id가 이미
-- 채워져 있음을 확인함, 2026-09-11) — "본인이 올린 object만" 지울 수 있게 owner로
-- 제한하면 다른 사용자의 avatar를 실수로/악의적으로 지울 수 없다.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

drop policy if exists "아바타 삭제" on storage.objects;
create policy "아바타 삭제"
    on storage.objects for delete
    using (bucket_id = 'avatars' and owner = auth.uid());

-- ------------------------------------------------------------
-- 확인
-- ------------------------------------------------------------
select policyname, cmd
from pg_policies
where schemaname = 'storage' and tablename = 'objects' and policyname = '아바타 삭제';
