-- ============================================================
-- Storage 버킷 파일 크기 제한 (P2, 2026-10-08) — ⚠ 값은 사용자 결정 필요(아래 근거 참고). MIME 제한(fix_storage_bucket_mime_limits_20261008.sql)과 별개로 실행한다.
-- ============================================================
-- 문제: avatars / alimtalk-images / business-licenses의 file_size_limit이 비어 있어 가입한 누구나 무제한 크기를 올려 저장 한도를 소모할 수 있다.
-- 근거와 한계(정직하게): 앱 코드에는 크기 검사/압축/리사이즈가 전혀 없고 휴대폰 사진 선택기의 원본 File을 그대로 올린다(lib/profiles.ts, lib/center.ts, lib/storage.ts 등).
--   따라서 repo에서 "정확히 이 값"을 증명할 수는 없다. 아래 값은 원본 사진/스캔이 거부되지 않도록 넉넉하게 잡은 제안값이다:
--     avatars 10 MB, alimtalk-images 10 MB, business-licenses 20 MB(스캔 PDF 포함).
--   적용 전에 반드시 verify_fix_storage_bucket_size_limits_20261008.sql 의 1번(기존 객체 크기 분포, READ-ONLY)으로 실제 최대/상위 크기를 확인하고 값을 조정하라.
--   크기 초과 업로드는 앱에서 "파일 업로드에 실패했어요: ...exceeded the maximum allowed size"로 보인다(전용 안내 문구는 없음 — 별도 UX 개선 대상).
-- 수정: 버킷의 file_size_limit(bytes)만 설정한다. 정책/공개 여부/MIME은 건드리지 않는다. 이미 올라간 객체에는 영향 없음.
-- 롤백: rollback_fix_storage_bucket_size_limits_20261008.sql / 확인: verify_fix_storage_bucket_size_limits_20261008.sql
-- ⚠ Claude Code 세션에서 실행되지 않았다 — 사용자가 값을 결정하고 SQL Editor에서 직접 확인 후 실행.
-- ============================================================

update storage.buckets set file_size_limit = 10485760 where id in ('avatars', 'alimtalk-images');     -- 10 MB
update storage.buckets set file_size_limit = 20971520 where id = 'business-licenses';                  -- 20 MB
