-- 후기 관리자 답글·식별 컬럼 보호 (2026-10-23) — 후속 SQL, 운영 직접 적용 금지(Codex 검토·적용 대상).
-- harden_center_reviews_update_columns_20261022.sql(제안)을 대체한다. 그 파일은 적용하지 않는다.
--
-- 격리 PostgREST 재현(권한 결함):
--  · 정책 "센터후기 본인 수정"에는 WITH CHECK 도, 컬럼 제한도 없다. 작성자가 PATCH /center_reviews 로 자기 후기의
--    reply / replied_at / hidden / center_id / profile_id / created_at 을 직접 바꿀 수 있다(답글 위조, 후기를 다른 센터로 이동 등).
--  · 정책 "센터후기 매니저 답변"에는 컬럼 제한이 없어 센터의 아무 직원이 회원의 rating/content 를 직접 고쳐 쓸 수 있다.
--  · INSERT 도 컬럼 제한이 없어 reply/hidden 을 채운 채로 직접 작성할 수 있다.
-- 앱은 center_reviews 를 직접 INSERT/UPDATE 하지 않는다: 작성 = write_review, 수정 = update_my_review, 답변 = reply_review
--   (모두 SECURITY DEFINER). 그래서 authenticated/anon 의 직접 UPDATE 를 전부 걷고, INSERT 는 작성자 입력 컬럼으로만 제한한다.
--   SELECT/DELETE 와 기존 RLS 정책은 건드리지 않는다. 정책은 남아 있어도 GRANT 가 없으면 직접 쓰기가 막힌다.
-- 답변 권한 모델은 그대로다: reply_review 는 "그 센터의 활성 직원(my_managed_center_ids)" 또는 플랫폼 관리자.
--   (후기 답변 전용 권한 키는 저장소에 없다 — 도입 여부는 정책 결정.) reply_review 는 정의 본문을 유지하고 search_path 만 고정한다.
-- 호환: 앱 경로는 모두 definer RPC 라 구버전/신버전 앱 모두 영향 없음. 다른 클라이언트가 직접 UPDATE 하는지는 적용 전 확인.

revoke update on center_reviews from public, anon, authenticated;
do $$
declare c text;
begin
    for c in select column_name from information_schema.columns where table_schema = 'public' and table_name = 'center_reviews' loop
        execute format('revoke update (%I) on center_reviews from public, anon, authenticated', c);
    end loop;
end $$;

revoke insert on center_reviews from public, anon, authenticated;
do $$
declare c text;
begin
    for c in select column_name from information_schema.columns where table_schema = 'public' and table_name = 'center_reviews' loop
        execute format('revoke insert (%I) on center_reviews from public, anon, authenticated', c);
    end loop;
end $$;
grant insert (center_id, profile_id, rating, content, photos) on center_reviews to authenticated;

create or replace function reply_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (v_center in (select my_managed_center_ids()) or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$$;
revoke execute on function reply_review(uuid, text) from public, anon;
grant execute on function reply_review(uuid, text) to authenticated;
notify pgrst, 'reload schema';
