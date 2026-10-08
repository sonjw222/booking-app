-- ============================================================
-- Storage 버킷 허용 MIME 제한 (P2, 2026-10-08) — 크기 제한은 별도 파일(fix_storage_bucket_size_limits_20261008.sql)
-- ============================================================
-- 문제: avatars / alimtalk-images / business-licenses 버킷의 allowed_mime_types가 비어 있어(Production 읽기 전용 export 기준) 가입한 누구나(alimtalk-images는 로그인
--       사용자 누구나) 임의 형식(HTML/실행파일 등)을 올려 공개 CDN으로 호스팅할 수 있다. 공개 버킷(avatars, alimtalk-images)은 URL로 그대로 열린다.
-- 근거(앱의 실제 업로드 형식 — 코드 확인):
--   · avatars: 프로필/센터/공지/문의/후기 사진 — 모든 file input이 accept="image/*" (app/profiles, app/center/[id], app/manager/center-info, app/manager/announcements, app/components/InquiryChat 등)
--   · alimtalk-images: 알림톡/문자 컴포저 사진 — accept="image/*" (app/components/AlimtalkComposer.tsx)
--   · business-licenses: 사업자등록증 — accept="image/*,.pdf" (app/components/CenterRegistrationForm.tsx), 업로드는 lib/storage.ts uploadBusinessLicense(File)
-- 수정: 앱이 이미 제한하는 형식과 똑같이 맞춘다(Storage는 'image/*' 와일드카드를 지원). 정책(storage.objects policy)과 버킷 공개 여부는 건드리지 않는다.
-- 참고: 이미 올라간 객체에는 영향 없음(새 업로드부터 적용). 파일 content-type이 비어 있는 업로드는 거부될 수 있다(휴대폰 사진 선택은 항상 type이 있다) — 첫 적용 후 사진 업로드 1회 확인.
-- 롤백: rollback_fix_storage_bucket_mime_limits_20261008.sql / 확인: verify_fix_storage_bucket_mime_limits_20261008.sql
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

update storage.buckets set allowed_mime_types = array['image/*']                      where id in ('avatars', 'alimtalk-images');
update storage.buckets set allowed_mime_types = array['image/*', 'application/pdf']   where id = 'business-licenses';
