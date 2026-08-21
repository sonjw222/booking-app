-- ============================================================
-- P1-5b (Bucket 2) — inquiry_messages(1:1 문의 댓글) / orders(주문 확정)
--
-- 배경: 문의 댓글 작성은 board.inquiry.comment 키가 카탈로그에 있지만 실제로는
--   my_managed_center_ids()만 체크했다(P1-5 4차 조사). board.inquiry.comment_other
--   (다른 스태프 댓글 삭제)는 대응하는 삭제 기능 자체가 DB에 없어(inquiry_messages에
--   delete 정책도 RPC도 없음) 이번에도 그대로 미구현 상태로 둔다 — 새 기능을 만드는 건
--   이 배치 범위 밖.
--
-- ⚠ fulfill_order() 함수는 이 파일에서 건드리지 않는다 — pg_get_functiondef로 라이브
--   정의를 직접 확인한 결과, 이미 has_permission(center_id, 'pass.payment.create')로
--   막혀 있었고(SEC-116 주석 확인) 정적 파일(add_order_fulfillment.sql 등)에는 없던
--   가격 검증(SEC-118)·ensure_center_member 자동등록·auto_book_membership 자동예약
--   로직까지 포함돼 있어, 애초에 P1-5 4차 조사가 "카탈로그 키만 있고 RLS는 열려있다"고
--   본 게 이 함수에 한해서는 틀렸다(정적 파일이 최신이 아니었음). 그래서 "확정·발급"
--   버튼은 pass.order.fulfill이 아니라 fulfill_order가 이미 쓰는 pass.payment.create로
--   게이팅한다 — 그래야 지금 결제 등록 권한이 있는 스태프가 새 키를 안 받았다고 갑자기
--   주문 확정을 못 하게 되는 혼선이 없다. 이 파일은 "취소"(orders 직접 update, RPC를
--   거치지 않는 유일한 경로)에만 같은 키로 RLS를 새로 건다.
--
-- ⚠ 동작 변경 주의: board.inquiry.comment/pass.payment.create를 아직 역할에 안 준 기존
--   스태프는 더 이상 문의에 답하거나 주문을 취소하지 못하게 된다. 오너는 영향 없음.
--
-- 파일 전체를 SQL Editor에 붙여넣고 Run 하세요. 여러 번 실행해도 안전.
-- ============================================================

-- ------------------------------------------------------------
-- send_inquiry_message: 회원 발신 분기는 그대로 두고, 매니저 발신 분기에만
-- board.inquiry.comment 체크를 추가한다 (이 함수는 회원/매니저 공용이라 조건부로 좁혀야 함).
-- 나머지 로직은 add_inquiries.sql 원문과 동일 — 권한 체크 한 줄만 바뀜.
-- ------------------------------------------------------------
create or replace function send_inquiry_message(
    p_thread_id uuid, p_body text, p_photos text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account uuid := my_account_id();
    v_center uuid;
    v_member uuid;
    v_role text;
    v_id uuid;
    v_preview text;
    v_center_name text;
    m record;
begin
    select center_id, member_account_id into v_center, v_member
      from inquiry_threads where id = p_thread_id;
    if v_center is null then
        raise exception '문의방을 찾을 수 없어요';
    end if;

    -- 발신자 역할 판별
    if v_account = v_member then
        v_role := 'member';
    elsif has_permission(v_center, 'board.inquiry.comment') or is_platform_admin() then
        v_role := 'manager';
    else
        raise exception '이 문의방에 메시지를 보낼 권한이 없어요';
    end if;

    insert into inquiry_messages(thread_id, sender_account_id, sender_role, body, photos)
    values (p_thread_id, v_account, v_role, coalesce(p_body, ''), p_photos)
    returning id into v_id;

    -- 미리보기 텍스트
    v_preview := left(coalesce(p_body, ''), 40);
    if v_preview = '' and p_photos is not null and array_length(p_photos, 1) > 0 then
        v_preview := '(사진)';
    end if;

    update inquiry_threads
       set last_message = v_preview,
           last_message_at = now(),
           member_unread = case when v_role = 'manager' then member_unread + 1 else member_unread end,
           manager_unread = case when v_role = 'member' then manager_unread + 1 else manager_unread end
     where id = p_thread_id;

    return v_id;
end;
$$;

-- ------------------------------------------------------------
-- orders: "매니저 수정"(취소 등 직접 update) = pass.payment.create
--   (fulfill_order()가 이미 이 키로 발급을 막고 있어, 취소도 같은 키로 맞춘다)
-- ------------------------------------------------------------
drop policy if exists "주문 매니저 수정" on orders;
create policy "주문 매니저 수정"
    on orders for update
    using (has_permission(center_id, 'pass.payment.create') or is_platform_admin());

-- ============================================================
-- 확인
-- ============================================================
select tablename, policyname, cmd from pg_policies where tablename = 'orders' order by cmd;
