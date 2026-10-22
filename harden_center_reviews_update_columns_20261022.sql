-- ============================================================
-- [감사 F13 부수 발견 — 별도 승인용 제안] 후기 작성자가 관리자 답변 컬럼을 직접 UPDATE 할 수 있음
--
-- 격리 PostgREST 재현: 정책 "센터후기 본인 수정"(using profile_id in my_profile_ids(), with check 없음)에 컬럼 제한이 없어
-- 작성자가 PATCH /center_reviews 로 reply / replied_at / hidden 같은 컬럼을 직접 바꿀 수 있다.
-- 앱은 center_reviews 를 직접 UPDATE 하지 않는다(수정=update_my_review, 답변=reply_review: 둘 다 security definer 함수).
-- 그래서 authenticated 의 UPDATE 권한을 "작성자가 실제로 바꿔야 하는 컬럼"으로 제한해도 앱 동작은 그대로다.
-- 적용 전 확인: 운영에서 다른 클라이언트(스크립트·대시보드)가 authenticated 로 center_reviews 를 직접 UPDATE 하는지.
-- 되돌리기: grant update on center_reviews to authenticated;
-- ============================================================
revoke update on center_reviews from authenticated;
grant update (rating, content, photos) on center_reviews to authenticated;
notify pgrst, 'reload schema';
