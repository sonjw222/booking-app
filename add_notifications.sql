-- ============================================================
-- 알림 시스템 (회원 + 매니저)
--
-- 하는 일:
--   1) notifications 테이블 (범용: 공지/수강권만료/예약임박/신규구매 등)
--   2) 회원용 알림: 공지, 수강권 소진·만료 재등록, 예약 3일전/당일
--   3) 매니저용 알림: 신규 구매/주문, 신규 후기, 예약/취소 등
--   4) 실시간 팝업은 Supabase Realtime 구독으로 프런트에서 처리
--
-- ⚠ add_announcements.sql 을 먼저 실행하세요 (my_related_center_ids 함수 필요).
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- 알림 테이블
--   recipient_account_id : 받는 사람(계정). 회원/매니저 공통.
--   kind    : 종류 (announcement / pass_expired / pass_used_up /
--             reservation_3days / reservation_today /
--             new_order / new_review / new_reservation / reservation_canceled ...)
--   title, body : 표시 내용
--   center_id   : 관련 센터 (있으면)
--   link        : 탭 시 이동할 앱 내 경로 (예: /center/xxx, /my-reservations)
--   data        : 부가 정보 (jsonb)
--   read_at     : 읽은 시각 (null = 안읽음)
-- ------------------------------------------------------------
create table if not exists notifications (
    id                    uuid primary key default gen_random_uuid(),
    recipient_account_id  uuid not null references accounts(id) on delete cascade,
    kind                  text not null,
    title                 text not null,
    body                  text not null default '',
    center_id             uuid references centers(id) on delete set null,
    link                  text,
    data                  jsonb,
    read_at               timestamptz,
    created_at            timestamptz not null default now()
);

create index if not exists idx_notifications_recipient
    on notifications(recipient_account_id, created_at desc);
create index if not exists idx_notifications_unread
    on notifications(recipient_account_id) where read_at is null;

alter table notifications enable row level security;

-- 본인 알림만 조회
drop policy if exists "알림 본인 조회" on notifications;
create policy "알림 본인 조회"
    on notifications for select
    using (recipient_account_id = my_account_id());

-- 본인 알림만 수정 (읽음 처리)
drop policy if exists "알림 본인 수정" on notifications;
create policy "알림 본인 수정"
    on notifications for update
    using (recipient_account_id = my_account_id());

-- 본인 알림 삭제
drop policy if exists "알림 본인 삭제" on notifications;
create policy "알림 본인 삭제"
    on notifications for delete
    using (recipient_account_id = my_account_id());

-- insert 는 security definer 함수(아래)에서만 하므로 정책 불필요
-- (RLS 켜진 상태에서 함수가 definer 권한으로 삽입)

-- 실시간 구독 활성화
alter publication supabase_realtime add table notifications;


-- ------------------------------------------------------------
-- 내부 헬퍼: 알림 한 건 생성
-- ------------------------------------------------------------
create or replace function push_notification(
    p_recipient uuid, p_kind text, p_title text, p_body text,
    p_center uuid default null, p_link text default null, p_data jsonb default null
)
returns void
language sql
security definer
set search_path = public
as $$
    insert into notifications(recipient_account_id, kind, title, body, center_id, link, data)
    values (p_recipient, p_kind, p_title, p_body, p_center, p_link, p_data);
$$;


-- ------------------------------------------------------------
-- 읽음 처리
-- ------------------------------------------------------------
create or replace function mark_notifications_read(p_ids uuid[] default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if p_ids is null then
        update notifications set read_at = now()
         where recipient_account_id = my_account_id() and read_at is null;
    else
        update notifications set read_at = now()
         where recipient_account_id = my_account_id() and id = any(p_ids);
    end if;
end;
$$;


-- ============================================================
-- [1] 공지 작성 → 회원 전원에게 알림
--     (announcements.ts 의 createAnnouncement 가 호출)
-- ============================================================
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
    if not (p_center_id in (select my_managed_center_ids()) or is_platform_admin()) then
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
-- [2] 예약 임박 알림 (3일 전 / 당일)
--     매일 1회 실행 (Supabase Scheduled Function / cron / 외부 스케줄러)
--     같은 예약·같은 종류는 중복 발송 안 함
-- ============================================================
create or replace function notify_upcoming_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
    v_count int := 0;
    v_kind text;
    v_when text;
    v_days int;
begin
    for r in
        select rv.id as reservation_id, rv.profile_id, pr.account_id,
               c.center_id, c.title, c.start_time,
               (c.start_time at time zone 'Asia/Seoul')::date as class_date
          from reservations rv
          join classes c on c.id = rv.class_id
          join profiles pr on pr.id = rv.profile_id
         where rv.status = 'confirmed'
           and (c.start_time at time zone 'Asia/Seoul')::date
               in ( (now() at time zone 'Asia/Seoul')::date,
                    (now() at time zone 'Asia/Seoul')::date + 3 )
    loop
        v_days := r.class_date - (now() at time zone 'Asia/Seoul')::date;
        if v_days = 0 then
            v_kind := 'reservation_today'; v_when := '오늘';
        else
            v_kind := 'reservation_3days'; v_when := '3일 뒤';
        end if;

        -- 중복 방지: 같은 예약/같은 종류 알림이 이미 있으면 건너뜀
        if exists (
            select 1 from notifications
             where recipient_account_id = r.account_id
               and kind = v_kind
               and data->>'reservation_id' = r.reservation_id::text
        ) then
            continue;
        end if;

        perform push_notification(
            r.account_id, v_kind,
            v_when || ' 수업이 있어요',
            r.title || ' · ' || to_char(r.start_time at time zone 'Asia/Seoul', 'MM/DD HH24:MI'),
            r.center_id, '/my-reservations',
            jsonb_build_object('reservation_id', r.reservation_id)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;


-- ============================================================
-- [3] 수강권 소진 / 만료 → 재등록 알림
--     매일 1회 실행. 같은 수강권은 한 번만.
-- ============================================================
create or replace function notify_expiring_passes()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
    v_count int := 0;
    v_kind text;
    v_msg text;
begin
    for r in
        select m.id as membership_id, m.profile_id, pr.account_id, m.center_id,
               ct.name as center_name,
               m.remaining_count, m.expires_at,
               coalesce(m.product_name, ct.name || ' 수강권') as pass_name
          from memberships m
          join profiles pr on pr.id = m.profile_id
          join centers ct on ct.id = m.center_id
         where m.status = 'active'
           and (
                (m.remaining_count is not null and m.remaining_count <= 0)
             or (m.expires_at is not null
                 and (m.expires_at at time zone 'Asia/Seoul')::date
                     <= (now() at time zone 'Asia/Seoul')::date)
           )
    loop
        if (r.remaining_count is not null and r.remaining_count <= 0) then
            v_kind := 'pass_used_up';
            v_msg := r.pass_name || ' 횟수를 모두 사용했어요. 재등록하고 계속 이용해보세요.';
        else
            v_kind := 'pass_expired';
            v_msg := r.pass_name || ' 이용 기간이 만료됐어요. 재등록하고 계속 이용해보세요.';
        end if;

        if exists (
            select 1 from notifications
             where recipient_account_id = r.account_id
               and kind = v_kind
               and data->>'membership_id' = r.membership_id::text
        ) then
            continue;
        end if;

        perform push_notification(
            r.account_id, v_kind, '재등록 안내', v_msg,
            r.center_id, '/center/' || r.center_id::text,
            jsonb_build_object('membership_id', r.membership_id)
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;


-- ============================================================
-- [4] 매니저 알림: 신규 주문 / 신규 후기
--     주문·후기 생성 시 트리거로 담당 매니저 전원에게 발송
-- ============================================================

-- 신규 주문(구매) → 매니저 알림
create or replace function trg_notify_new_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    m record;
    v_center_name text;
    v_buyer text;
begin
    select name into v_center_name from centers where id = new.center_id;
    select coalesce(pr.nickname, pr.name, '회원') into v_buyer
      from profiles pr where pr.id = new.profile_id;

    for m in
        select account_id from manager_centers
         where center_id = new.center_id and status = 'active'
    loop
        perform push_notification(
            m.account_id, 'new_order',
            '새 구매가 있어요',
            coalesce(v_buyer,'회원') || '님이 ' || coalesce(new.product_name, '상품') || ' 구매',
            new.center_id, '/manager/orders',
            jsonb_build_object('order_id', new.id)
        );
    end loop;
    return new;
end;
$$;

drop trigger if exists notify_new_order on orders;
create trigger notify_new_order
    after insert on orders
    for each row execute function trg_notify_new_order();


-- 신규 후기 → 매니저 알림
create or replace function trg_notify_new_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    m record;
begin
    for m in
        select account_id from manager_centers
         where center_id = new.center_id and status = 'active'
    loop
        perform push_notification(
            m.account_id, 'new_review',
            '새 후기가 등록됐어요',
            '별점 ' || coalesce(new.rating, 0) || '점 후기가 달렸어요',
            new.center_id, '/manager/reviews',
            jsonb_build_object('review_id', new.id)
        );
    end loop;
    return new;
end;
$$;

drop trigger if exists notify_new_review on center_reviews;
create trigger notify_new_review
    after insert on center_reviews
    for each row execute function trg_notify_new_review();


-- ============================================================
-- 완료!
--
-- 정기 알림(예약 임박 / 수강권 만료)은 하루 한 번 아래를 호출하세요:
--   select notify_upcoming_reservations();
--   select notify_expiring_passes();
--
-- Supabase 대시보드 → Database → Cron (pg_cron) 에서 예약하거나,
-- 외부 스케줄러(예: GitHub Actions, Vercel Cron)에서 RPC 호출.
-- 예) pg_cron 매일 오전 9시(KST=UTC+9 → UTC 0시):
--   select cron.schedule('daily-noti', '0 0 * * *',
--     $$ select notify_upcoming_reservations(); select notify_expiring_passes(); $$);
-- ============================================================
