-- ============================================================
-- P1-5b (Bucket 2) — center_reviews(후기) / center_announcements(공지사항)
--
-- 배경: 후기 답변/삭제, 공지 작성/수정/삭제 모두 카탈로그에 키
--   (facility.review.reply/delete, board.notice.write/delete)가 있지만 실제 RLS·RPC는
--   my_managed_center_ids()만 체크했다(P1-5 4차 조사). facility.review.view/board.notice.view는
--   이미 menu-gate로 쓰이고 있어 그대로 둔다 — 여기선 답변/삭제/작성/수정 액션만 좁힌다.
--   "새 공지" 작성은 클라이언트가 center_announcements에 직접 insert하지 않고
--   create_announcement() RPC(회원 알림 발송까지 처리)를 거쳐가므로, RLS insert 정책과
--   별개로 그 함수 내부의 권한 체크도 함께 고쳐야 실제로 막힌다.
--
-- ⚠ 동작 변경 주의: 이 권한을 아직 역할에 안 준 기존 스태프는 후기 답변/삭제,
--   공지 작성/수정/삭제를 더 이상 할 수 없게 된다. 오너는 영향 없음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- center_reviews: 답변(update) = facility.review.reply, 삭제 = facility.review.delete
-- ------------------------------------------------------------
drop policy if exists "센터후기 매니저 답변" on center_reviews;
create policy "센터후기 매니저 답변"
    on center_reviews for update
    using (has_permission(center_id, 'facility.review.reply') or is_platform_admin());

drop policy if exists "센터후기 매니저 삭제" on center_reviews;
create policy "센터후기 매니저 삭제"
    on center_reviews for delete
    using (has_permission(center_id, 'facility.review.delete') or is_platform_admin());

-- reply_review() RPC도 같은 조건으로 좁힌다 (직접 테이블 update 대신 이 함수를 거쳐가므로
-- RLS만으로는 안 막힘 — security definer라 함수 안에서 별도로 체크해야 함)
create or replace function reply_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
as $$
declare
    v_center uuid;
begin
    select center_id into v_center from center_reviews where id = p_review_id;
    if v_center is null then
        raise exception '후기를 찾을 수 없어요';
    end if;
    if not (has_permission(v_center, 'facility.review.reply') or is_platform_admin()) then
        raise exception '이 후기에 답변할 권한이 없어요';
    end if;

    update center_reviews
       set reply = nullif(trim(p_reply), ''),
           replied_at = case when nullif(trim(p_reply), '') is null then null else now() end
     where id = p_review_id;
end;
$$;

-- ------------------------------------------------------------
-- center_announcements: 작성/수정 = board.notice.write, 삭제 = board.notice.delete
-- ------------------------------------------------------------
drop policy if exists "공지 매니저 작성" on center_announcements;
create policy "공지 매니저 작성"
    on center_announcements for insert
    with check (has_permission(center_id, 'board.notice.write') or is_platform_admin());

drop policy if exists "공지 매니저 수정" on center_announcements;
create policy "공지 매니저 수정"
    on center_announcements for update
    using (has_permission(center_id, 'board.notice.write') or is_platform_admin());

drop policy if exists "공지 매니저 삭제" on center_announcements;
create policy "공지 매니저 삭제"
    on center_announcements for delete
    using (has_permission(center_id, 'board.notice.delete') or is_platform_admin());

-- create_announcement() RPC도 같은 조건으로 좁힌다 — 실제 "새 공지" 작성은 이 함수를 거쳐가고
-- (security definer라 RLS를 우회함) 위 "공지 매니저 작성" 정책은 직접 insert하는 경로에만
-- 적용되므로, 진짜 방어선은 이 함수 안의 체크다. 알림 발송 로직 등 나머지는 add_notifications.sql
-- 원문과 동일 — 권한 체크 한 줄만 바뀜.
create or replace function create_announcement(
    p_center_id uuid, p_title text, p_body text,
    p_photos text[] default null, p_pinned boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id uuid;
    v_center_name text;
    r record;
begin
    if not (has_permission(p_center_id, 'board.notice.write') or is_platform_admin()) then
        raise exception '이 센터에 공지할 권한이 없어요';
    end if;

    insert into center_announcements(center_id, title, body, photos, pinned, created_by)
    values (p_center_id, p_title, p_body, p_photos, p_pinned, my_account_id())
    returning id into v_id;

    select name into v_center_name from centers where id = p_center_id;

    -- 이 센터에 관계된 회원 전원(계정 단위 중복 제거)에게 알림
    for r in
        select distinct pr.account_id
          from memberships m
          join profiles pr on pr.id = m.profile_id
         where m.center_id = p_center_id
        union
        select distinct pr2.account_id
          from reservations rv
          join classes c on c.id = rv.class_id
          join profiles pr2 on pr2.id = rv.profile_id
         where c.center_id = p_center_id
    loop
        perform push_notification(
            r.account_id, 'announcement',
            coalesce(v_center_name, '센터') || ' 공지',
            p_title, p_center_id, '/notifications', jsonb_build_object('announcement_id', v_id)
        );
    end loop;

    return v_id;
end;
$$;

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies
 where tablename in ('center_reviews', 'center_announcements')
 order by tablename, cmd;
